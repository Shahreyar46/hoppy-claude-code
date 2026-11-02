import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();

/**
 * Only extra Claude accounts can be removed: never ~/.claude (Claude Code's default, which also keeps
 * state in ~/.claude.json), never the Other AI folder, never the home folder itself or anything outside it.
 */
export function isRemovable(dir: string, home = os.homedir(), router?: string): boolean {
    const d = norm(dir);
    const h = norm(home);
    if (!d.startsWith(h + path.sep.toLowerCase()) && !d.startsWith(h + '/')) {
        return false;
    }
    if (d === norm(path.join(home, '.claude')) || (router && d === norm(router))) {
        return false;
    }
    // A direct child of home whose name says it is a Claude config folder.
    return norm(path.dirname(dir)) === h && /^\.claude[-_.]?.+/i.test(path.basename(dir.replace(/[\\/]+$/, '')));
}

/** Size and chat count of an account folder, for the confirmation. Stops counting after `limit` entries. */
export function folderSummary(dir: string, limit = 200000): { bytes: number; chats: number; files: number; capped: boolean } {
    let bytes = 0;
    let chats = 0;
    let files = 0;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (++files > limit) {
                return { bytes, chats, files: limit, capped: true };
            }
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile()) {
                try {
                    bytes += fs.statSync(p).size;
                } catch {
                    // vanished while counting
                }
                if (e.name.endsWith('.jsonl') && /[\\/]projects[\\/]/i.test(p)) {
                    chats++;
                }
            }
        }
    }
    return { bytes, chats, files, capped: false };
}

export function sizeLabel(bytes: number): string {
    if (bytes < 1024 * 1024) {
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Drops every entry whose key (or, with `byValue`, whose value) is this folder. */
export function withoutDir<T>(map: Record<string, T>, dir: string, byValue = false): Record<string, T> {
    const home = os.homedir();
    const same = (p: unknown) => typeof p === 'string' && norm(p.replace(/^~/, home)) === norm(dir);
    return Object.fromEntries(Object.entries(map).filter(([k, v]) => !(byValue ? same(v) : same(k))));
}
