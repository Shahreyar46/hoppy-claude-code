import * as fs from 'fs';
import * as path from 'path';

/**
 * Tokens each Claude account used, read from Claude Code's local chat files. Nothing leaves the machine.
 *
 * Counting rules:
 * - One reply = one message.id. Claude Code writes a line per content block with the same id and usage,
 *   so ids are counted once per account.
 * - "<synthetic>" entries (limit and error notices) are not replies.
 * - Chats Hoppy copied from another account must not count twice. Two guards:
 *   1. Ledger: when Hoppy copies a chat, the reply ids that are new to the destination are recorded as
 *      imported for it.
 *   2. File birth time: a copied file is created at copy time, so replies older than the file
 *      (minus a little clock slack) came from elsewhere. This also covers copies made before 1.1.
 */

export interface UsageBucket {
    tokens: number;
    replies: number;
}

export interface UsageSummary {
    last5h: UsageBucket;
    today: UsageBucket;
    last7d: UsageBucket;
    /** Tokens in the last 7 days by model, largest first. */
    models: { model: string; tokens: number }[];
    scannedAt: number;
}

/** [timestamp ms, message id, tokens, model] */
type Reply = [number, string, number, string];

interface FileCache {
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
    /** Byte offset after the last complete line parsed. */
    offset: number;
    replies: Reply[];
}

interface CacheFile {
    version: 1;
    files: Record<string, FileCache>;
}

const WINDOW_MS = 7 * 86400000;
const KEEP_MS = 8 * 86400000;
const BIRTH_SLACK_MS = 5 * 60000;

let storageDir: string | undefined;
let cache: CacheFile | undefined;
let ledger: Record<string, Record<string, number>> | undefined;
let cacheDirty = false;

function dirKey(dir: string): string {
    return path.normalize(dir).toLowerCase();
}

/** Where the scan cache and import ledger live (the extension's global storage folder). */
export function initUsage(dir: string): void {
    storageDir = dir;
    fs.mkdirSync(dir, { recursive: true });
}

function load<T>(name: string, fallback: T): T {
    if (!storageDir) {
        return fallback;
    }
    try {
        return JSON.parse(fs.readFileSync(path.join(storageDir, name), 'utf8')) as T;
    } catch {
        return fallback;
    }
}

function save(name: string, data: unknown): void {
    if (!storageDir) {
        return;
    }
    try {
        fs.writeFileSync(path.join(storageDir, name), JSON.stringify(data));
    } catch {
        // Storage is a cache only; the next scan rebuilds it.
    }
}

function getLedger(): Record<string, Record<string, number>> {
    if (!ledger) {
        ledger = load('imported.json', {});
    }
    return ledger;
}

function replyIds(content: string): Map<string, number> {
    const ids = new Map<string, number>();
    for (const line of content.split('\n')) {
        if (!line.includes('"assistant"') || !line.includes('"usage"')) {
            continue;
        }
        try {
            const e = JSON.parse(line);
            const id = e.message?.id;
            if (e.type === 'assistant' && id && e.message?.model !== '<synthetic>') {
                ids.set(id, Date.parse(e.timestamp) || Date.now());
            }
        } catch {
            // partial line
        }
    }
    return ids;
}

/**
 * Called by Hoppy right before it writes a copied chat. Replies the destination did not already have
 * were made by another account and are not counted for the destination.
 */
export function noteImported(destDir: string, newContent: string, previousContent: string): void {
    const before = replyIds(previousContent);
    const all = getLedger();
    const forDir = (all[dirKey(destDir)] ||= {});
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, ts] of replyIds(newContent)) {
        if (!before.has(id) && ts > cutoff) {
            forDir[id] = ts;
        }
    }
    for (const [id, ts] of Object.entries(forDir)) {
        if (ts < cutoff) {
            delete forDir[id];
        }
    }
    save('imported.json', all);
}

function parseReplies(text: string): Reply[] {
    const out: Reply[] = [];
    for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) {
            continue;
        }
        let e: any;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const m = e.message;
        if (e.type !== 'assistant' || !m?.id || !m.usage || m.model === '<synthetic>') {
            continue;
        }
        const u = m.usage;
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        out.push([Date.parse(e.timestamp) || 0, m.id, tokens, String(m.model || 'unknown')]);
    }
    return out;
}

/** Reads only what was appended since the last scan; re-reads a file that shrank or was replaced. */
function scanFile(file: string, stat: fs.Stats, prev: FileCache | undefined): FileCache {
    const sameFile = prev && prev.birthtimeMs === stat.birthtimeMs && stat.size >= prev.offset;
    if (prev && sameFile && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
        return prev;
    }
    const start = sameFile && prev ? prev.offset : 0;
    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        chunk = buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
    const lastNl = chunk.lastIndexOf('\n');
    const complete = lastNl >= 0 ? chunk.slice(0, lastNl + 1) : '';
    const cutoff = Date.now() - KEEP_MS;
    const replies = [...(sameFile && prev ? prev.replies : []), ...parseReplies(complete)].filter((r) => r[0] > cutoff);
    return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
        offset: start + Buffer.byteLength(complete, 'utf8'),
        replies,
    };
}

function listRecentChatFiles(dir: string, since: number): string[] {
    const found: string[] = [];
    const visit = (folder: string, depth: number) => {
        let names: string[];
        try {
            names = fs.readdirSync(folder);
        } catch {
            return;
        }
        for (const name of names) {
            const full = path.join(folder, name);
            if (name.endsWith('.jsonl')) {
                found.push(full);
            } else if (depth < 3 && !name.includes('.')) {
                visit(full, depth + 1);
            }
        }
    };
    visit(path.join(dir, 'projects'), 0);
    return found.filter((f) => {
        try {
            return fs.statSync(f).mtimeMs > since;
        } catch {
            return false;
        }
    });
}

function startOfToday(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Usage for one Claude account folder. Fast after the first call: unchanged files are not read. */
export function scanUsage(dir: string, opts: { claudeOnly: boolean }, now = Date.now()): UsageSummary {
    if (!cache) {
        cache = load<CacheFile>('usage-cache.json', { version: 1, files: {} });
        if (cache.version !== 1) {
            cache = { version: 1, files: {} };
        }
    }
    const imported = getLedger()[dirKey(dir)] || {};
    const seen = new Set<string>();
    const models = new Map<string, number>();
    const empty = (): UsageBucket => ({ tokens: 0, replies: 0 });
    const sum = { last5h: empty(), today: empty(), last7d: empty() };
    const t5h = now - 5 * 3600000;
    const tDay = startOfToday(now);
    const t7d = now - WINDOW_MS;
    const prefix = dirKey(dir) + path.sep;

    const listed = new Set<string>();
    for (const file of listRecentChatFiles(dir, t7d)) {
        listed.add(file.toLowerCase());
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            continue;
        }
        const key = file.toLowerCase();
        let fc: FileCache;
        try {
            fc = scanFile(file, stat, cache.files[key]);
        } catch {
            continue;
        }
        if (cache.files[key] !== fc) {
            cacheDirty = true;
        }
        cache.files[key] = fc;
        const born = fc.birthtimeMs ? fc.birthtimeMs - BIRTH_SLACK_MS : 0;
        for (const [ts, id, tokens, model] of fc.replies) {
            // Plan limits are about Claude models; old Other AI chats in a Claude folder do not count there.
            if (ts < t7d || ts < born || imported[id] || seen.has(id) || (opts.claudeOnly && !model.startsWith('claude'))) {
                continue;
            }
            seen.add(id);
            const add = (b: UsageBucket) => {
                b.tokens += tokens;
                b.replies++;
            };
            add(sum.last7d);
            if (ts >= tDay) {
                add(sum.today);
            }
            if (ts >= t5h) {
                add(sum.last5h);
            }
            models.set(model, (models.get(model) || 0) + tokens);
        }
    }
    // Forget files of this account that are gone or older than the window.
    for (const key of Object.keys(cache.files)) {
        if (key.startsWith(prefix) && !listed.has(key)) {
            delete cache.files[key];
            cacheDirty = true;
        }
    }
    if (cacheDirty) {
        save('usage-cache.json', cache);
        cacheDirty = false;
    }
    return {
        ...sum,
        models: [...models].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens),
        scannedAt: now,
    };
}

/** 1234 → "1.2k", 3456789 → "3.5M" */
export function formatTokens(n: number): string {
    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    }
    if (n >= 1e3) {
        return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    }
    return String(n);
}

export function usageLine(u: UsageSummary): string {
    if (!u.last7d.replies) {
        return 'no use in the last 7 days';
    }
    return `${formatTokens(u.last5h.tokens)} tokens in 5h · ${formatTokens(u.today.tokens)} today · ${formatTokens(u.last7d.tokens)} this week`;
}

const latest = new Map<string, UsageSummary>();

/** Last computed usage for a folder, without touching the disk. */
export function cachedUsage(dir: string): UsageSummary | undefined {
    return latest.get(dirKey(dir));
}

/** Rescans folders whose numbers are older than maxAgeMs. Cheap after the first scan. */
export function refreshUsage(targets: { dir: string; claudeOnly: boolean }[], maxAgeMs = 60000, maxScans = Infinity): boolean {
    let changed = false;
    let scans = 0;
    const now = Date.now();
    for (const t of targets) {
        if (scans >= maxScans) {
            break;
        }
        const prev = latest.get(dirKey(t.dir));
        if (prev && now - prev.scannedAt < maxAgeMs) {
            continue;
        }
        try {
            latest.set(dirKey(t.dir), scanUsage(t.dir, { claudeOnly: t.claudeOnly }, now));
            changed = true;
            scans++;
        } catch {
            // unreadable folder; keep the old numbers
        }
    }
    return changed;
}

/** Short model name for the UI: "claude-opus-5-5" → "Opus 5.5". */
export function modelLabel(model: string): string {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model);
    if (m) {
        return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ''}`;
    }
    return model.replace(/^openrouter\//, '').replace(/:free$/, '');
}
