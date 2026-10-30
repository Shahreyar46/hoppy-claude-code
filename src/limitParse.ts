// Pure parsing for Claude Code's limit notices. No VS Code imports, so it can be unit tested in plain Node.
//
// When a Claude plan limit is reached, Claude Code appends a synthetic assistant entry to the chat file:
//   {"type":"assistant","isApiErrorMessage":true,"message":{"model":"<synthetic>","content":[{"type":"text",
//    "text":"You've hit your session limit · resets 12:50am (Asia/Dhaka)"}]},"timestamp":"..."}
// Seen wordings: "resets 9:20pm (Tz)", "resets 6pm (Tz)", "resets Oct 31, 6am (Tz)". Older builds wrote
// "Claude AI usage limit reached|<unix seconds>".

export type LimitKind = 'session' | 'weekly' | 'other';

export interface ParsedLimit {
    kind: LimitKind;
    text: string;
    hitAt: number;
    /** Epoch ms; undefined when the reset time could not be read. */
    resetsAt?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Milliseconds the zone is ahead of UTC at the given instant. Throws RangeError for an unknown zone. */
function zoneOffset(timeZone: string, at: number): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(new Date(at));
    const p: Record<string, number> = {};
    for (const x of parts) {
        p[x.type] = Number(x.value);
    }
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return asUtc - Math.floor(at / 1000) * 1000;
}

/** Calendar date (year, month, day) of an instant as seen in the zone, or in local time without one. */
function dateIn(at: number, timeZone?: string): { y: number; m: number; d: number } {
    const shifted = new Date(timeZone ? at + zoneOffset(timeZone, at) : at - new Date(at).getTimezoneOffset() * 60000);
    return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

/** Epoch ms for a wall-clock time in the zone (local time without one). Date.UTC handles day overflow. */
function wallClock(y: number, m: number, d: number, h: number, min: number, timeZone?: string): number {
    const guess = Date.UTC(y, m, d, h, min);
    if (!timeZone) {
        return guess + new Date(guess).getTimezoneOffset() * 60000;
    }
    let t = guess - zoneOffset(timeZone, guess);
    const second = zoneOffset(timeZone, t);
    if (guess - second !== t) {
        t = guess - second;
    }
    return t;
}

/** Reads the reset instant out of a limit notice. hitAt anchors times that carry no date. */
export function parseResetTime(text: string, hitAt: number): number | undefined {
    const legacy = /limit reached\|(\d{9,})/i.exec(text);
    if (legacy) {
        return Number(legacy[1]) * 1000;
    }
    const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(text);
    if (!m) {
        return undefined;
    }
    const [, mon, day, hh, mm, ampm, zone] = m;
    let timeZone: string | undefined = zone?.trim();
    try {
        if (timeZone) {
            zoneOffset(timeZone, hitAt);
        }
    } catch {
        timeZone = undefined;
    }
    const hour = (Number(hh) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    const minute = mm ? Number(mm) : 0;
    const today = dateIn(hitAt, timeZone);

    if (mon) {
        const month = MONTHS.indexOf(mon.toLowerCase());
        if (month < 0) {
            return undefined;
        }
        let t = wallClock(today.y, month, Number(day), hour, minute, timeZone);
        if (t < hitAt - 86400000) {
            t = wallClock(today.y + 1, month, Number(day), hour, minute, timeZone);
        }
        return t;
    }
    let t = wallClock(today.y, today.m, today.d, hour, minute, timeZone);
    if (t <= hitAt) {
        t = wallClock(today.y, today.m, today.d + 1, hour, minute, timeZone);
    }
    return t;
}

export function limitKind(text: string): LimitKind {
    const m = /hit your (\w+) limit/i.exec(text);
    const word = m?.[1].toLowerCase();
    return word === 'session' || word === 'weekly' ? word : 'other';
}

function isLimitText(text: string): boolean {
    return /hit your .{0,40}limit/i.test(text) || /usage limit reached/i.test(text);
}

/** Returns the limit notice in one chat-file line, or undefined. Only Claude Code's own synthetic entries count. */
export function parseLimitLine(line: string): ParsedLimit | undefined {
    if (!line.includes('limit')) {
        return undefined;
    }
    let entry: any;
    try {
        entry = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (entry?.type !== 'assistant' || !(entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>')) {
        return undefined;
    }
    const content = entry.message?.content;
    const text: string | undefined = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c: any) => c?.type === 'text')?.text : undefined;
    if (!text || !isLimitText(text)) {
        return undefined;
    }
    const hitAt = Date.parse(entry.timestamp) || Date.now();
    return { kind: limitKind(text), text, hitAt, resetsAt: parseResetTime(text, hitAt) };
}

/** The last limit notice in a chunk of chat-file text (e.g. the tail of a file). */
export function lastLimitIn(chunk: string): ParsedLimit | undefined {
    const lines = chunk.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const hit = parseLimitLine(lines[i]);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

/** Time of the newest real reply (not a notice) in a chunk of chat-file text, or 0. */
export function lastReplyIn(chunk: string): number {
    const lines = chunk.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"assistant"') || line.includes('"isApiErrorMessage":true')) {
            continue;
        }
        try {
            const e = JSON.parse(line);
            if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>') {
                return Date.parse(e.timestamp) || 0;
            }
        } catch {
            // partial line
        }
    }
    return 0;
}
