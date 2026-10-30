import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { lastLimitIn, lastReplyIn, ParsedLimit } from './limitParse';
import { log } from './log';

/** A limit notice for one Claude account folder. */
export interface LimitHit extends ParsedLimit {
    dir: string;
    /** The main chat file the notice belongs to (a subagent's notice maps to its parent chat). */
    sessionFile: string;
}

const STATE_KEY = 'hoppy.limits';
/** Without a readable reset time, treat the account as limited for one session window. */
const UNKNOWN_RESET_MS = 5 * 3600000;
/** Only notices this fresh pop up a notification; older ones just mark the account in the menu. */
const FRESH_MS = 3 * 60000;
const REMIND_MS = 10 * 60000;
const TAIL_BYTES = 48 * 1024;
const RECENT_MS = 8 * 86400000;

function key(dir: string): string {
    return path.normalize(dir).toLowerCase();
}

function readTail(file: string): string {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

/** projects/<p>/<session>/subagents/agent-x.jsonl belongs to projects/<p>/<session>.jsonl */
export function mainSessionFile(file: string): string {
    const parts = file.split(path.sep);
    const i = parts.lastIndexOf('subagents');
    return i > 1 ? `${parts.slice(0, i).join(path.sep)}.jsonl` : file;
}

/**
 * A notice older than the file it sits in was copied there from another account (Hoppy 1.0 carried
 * notices along with chats). It says nothing about this account.
 */
function isCopiedNotice(file: string, hitAt: number): boolean {
    try {
        const born = fs.statSync(file).birthtimeMs;
        return !!born && hitAt < born - 5 * 60000;
    } catch {
        return false;
    }
}

function endTime(hit: LimitHit): number {
    return hit.resetsAt ?? hit.hitAt + UNKNOWN_RESET_MS;
}

/**
 * Watches every Claude account's chat files for limit notices. Reads only the last few KB of a file
 * when it changes, so large histories cost nothing. Nothing leaves the machine.
 */
export class LimitRadar implements vscode.Disposable {
    private watchers: fs.FSWatcher[] = [];
    private timers = new Map<string, NodeJS.Timeout>();
    private readonly hitEmitter = new vscode.EventEmitter<LimitHit>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** A fresh limit notice: worth a notification. */
    readonly onHit = this.hitEmitter.event;
    /** Any change to which accounts are limited. */
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly state: vscode.Memento) {}

    /** Active limits by folder; expired ones are dropped. */
    all(): Record<string, LimitHit> {
        const now = Date.now();
        const saved = this.state.get<Record<string, LimitHit>>(STATE_KEY) || {};
        const live: Record<string, LimitHit> = {};
        for (const [k, hit] of Object.entries(saved)) {
            if (endTime(hit) > now && !isCopiedNotice(hit.sessionFile, hit.hitAt)) {
                live[k] = hit;
            }
        }
        return live;
    }

    limitFor(dir: string): LimitHit | undefined {
        return this.all()[key(dir)];
    }

    async clear(dir: string): Promise<void> {
        const live = this.all();
        delete live[key(dir)];
        await this.state.update(STATE_KEY, live);
        this.changeEmitter.fire();
    }

    private queue: Promise<unknown> = Promise.resolve();

    /** Stores a notice. Returns true when it is new for this account's current limit window. */
    private record(hit: LimitHit): Promise<boolean> {
        // One read-modify-write at a time; parallel file checks would otherwise drop each other's entries.
        const next = this.queue.then(() => this.recordNow(hit));
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async recordNow(hit: LimitHit): Promise<boolean> {
        if (endTime(hit) <= Date.now()) {
            return false;
        }
        const live = this.all();
        const prev = live[key(hit.dir)];
        // Several tabs on one account hit the same limit together: tell the user once, and again only
        // if they keep trying well after that.
        const isNew = !prev || (hit.hitAt > prev.hitAt && (prev.resetsAt !== hit.resetsAt || hit.hitAt - prev.hitAt > REMIND_MS));
        if (!prev || hit.hitAt >= prev.hitAt) {
            live[key(hit.dir)] = hit;
            await this.state.update(STATE_KEY, live);
            this.changeEmitter.fire();
        }
        return isNew;
    }

    /** When the user was last asked, per chat file and overall. */
    private askedForChat = new Map<string, number>();
    private lastAsked = 0;

    /**
     * Ask once per chat that hits a limit; ask again in that chat only if the user keeps trying well after
     * (REMIND_MS). Several tabs hitting the limit together give one question (30 s window). Older notices
     * found at startup never block a new question.
     */
    private shouldAsk(hit: LimitHit): boolean {
        const now = Date.now();
        const chatKey = hit.sessionFile.toLowerCase();
        const lastForChat = this.askedForChat.get(chatKey) || 0;
        if (now - this.lastAsked < 30000 || now - lastForChat < REMIND_MS) {
            return false;
        }
        this.askedForChat.set(chatKey, now);
        this.lastAsked = now;
        return true;
    }

    /** Newest real reply seen per account: a reply after a limit notice means the limit is over. */
    private lastReply = new Map<string, number>();

    private async check(file: string, dir: string, notify: boolean): Promise<void> {
        let tail: string;
        try {
            tail = readTail(file);
        } catch {
            return;
        }
        // Replies copied in from another account say nothing about this one.
        const reply = lastReplyIn(tail);
        if (reply && !isCopiedNotice(file, reply) && reply > (this.lastReply.get(key(dir)) || 0)) {
            this.lastReply.set(key(dir), reply);
        }
        const answeredSince = this.lastReply.get(key(dir)) || 0;
        const stored = this.limitFor(dir);
        if (stored && answeredSince > stored.hitAt + 60000) {
            // The account answered after its limit notice: the limit was lifted early (extra usage,
            // a model-only limit, a plan change). Stop marking it.
            log(`${dir} answered after its limit notice; no longer marked as limited`);
            await this.clear(dir);
        }
        const parsed: ParsedLimit | undefined = lastLimitIn(tail);
        if (!parsed || isCopiedNotice(file, parsed.hitAt) || answeredSince > parsed.hitAt + 60000) {
            return;
        }
        const hit: LimitHit = { ...parsed, dir, sessionFile: mainSessionFile(file) };
        await this.record(hit);
        const fresh = Date.now() - hit.hitAt < FRESH_MS;
        const ask = notify && fresh && this.shouldAsk(hit);
        if (notify) {
            log(`limit notice in ${file}: "${hit.text}" fresh=${fresh} ask=${ask}`);
        }
        if (ask) {
            this.hitEmitter.fire(hit);
        }
    }

    /** Marks accounts that are still limited from notices written before this window started. */
    private scanRecent(dir: string): void {
        const projects = path.join(dir, 'projects');
        const since = Date.now() - RECENT_MS;
        const visit = (folder: string, depth: number) => {
            let names: string[];
            try {
                names = fs.readdirSync(folder);
            } catch {
                return;
            }
            for (const name of names) {
                const full = path.join(folder, name);
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(full);
                } catch {
                    continue;
                }
                if (stat.isDirectory() && depth < 3) {
                    visit(full, depth + 1);
                } else if (name.endsWith('.jsonl') && stat.mtimeMs > since) {
                    void this.check(full, dir, false);
                }
            }
        };
        visit(projects, 0);
    }

    /** (Re)starts watching the given Claude account folders. */
    start(dirs: string[]): void {
        this.stopWatching();
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                continue;
            }
            setTimeout(() => this.scanRecent(dir), 1500);
            try {
                // Watch the account folder, not projects/, so a brand-new account is covered from its first chat.
                const w = fs.watch(dir, { recursive: true }, (_event, name) => {
                    const rel = name ? String(name) : '';
                    if (!rel.endsWith('.jsonl') || !/^projects[\\/]/i.test(rel)) {
                        return;
                    }
                    const file = path.join(dir, rel);
                    clearTimeout(this.timers.get(file));
                    this.timers.set(
                        file,
                        setTimeout(() => {
                            this.timers.delete(file);
                            void this.check(file, dir, true);
                        }, 400),
                    );
                });
                w.on('error', () => undefined);
                this.watchers.push(w);
            } catch {
                // Folder vanished or cannot be watched; the menu still works without limit hints.
            }
        }
    }

    private stopWatching(): void {
        for (const w of this.watchers) {
            w.close();
        }
        this.watchers = [];
        for (const t of this.timers.values()) {
            clearTimeout(t);
        }
        this.timers.clear();
    }

    dispose(): void {
        this.stopWatching();
        this.hitEmitter.dispose();
        this.changeEmitter.dispose();
    }
}

/** "resets 12:50am" style text for the UI, in the user's local time. */
export function resetLabel(hit: LimitHit): string {
    if (!hit.resetsAt) {
        return 'limit reached';
    }
    const at = new Date(hit.resetsAt);
    const sameDay = at.toDateString() === new Date().toDateString();
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `resets ${sameDay ? time : `${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`}`;
}
