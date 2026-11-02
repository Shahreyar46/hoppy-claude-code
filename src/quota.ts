// Exact 5-hour and weekly usage % per Claude account, from the same Anthropic endpoint Claude Code's /usage reads.
// Read-only by design: Hoppy reads the account's current access token from its .credentials.json and never
// refreshes, rewrites or logs it. An expired token, a 429 or any change in the endpoint simply means "no exact
// number"; the UI then falls back to the local estimate. Setting: hoppy.claudeQuota.
import * as fs from 'fs';
import * as path from 'path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 3 * 60000;
const COOL_MS = 60000;

export interface QuotaWindow {
    /** 0..100, share of the window already used. */
    used: number;
    resetsAt?: number;
}

export interface ClaudeQuota {
    h5?: QuotaWindow;
    week?: QuotaWindow;
    at: number;
}

const key = (dir: string) => path.normalize(dir).replace(/[\\/]+$/, '').toLowerCase();
const cache = new Map<string, ClaudeQuota>();
const coolUntil = new Map<string, number>();

/** Access token of a Claude account, only while it is still valid. Never refreshed here. */
export function readToken(dir: string, now = Date.now()): string | undefined {
    try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth;
        if (typeof o?.accessToken !== 'string' || !o.accessToken) {
            return undefined;
        }
        return typeof o.expiresAt === 'number' && o.expiresAt - 60000 < now ? undefined : o.accessToken;
    } catch {
        return undefined;
    }
}

function window(w: any): QuotaWindow | undefined {
    const used = Number(w?.utilization);
    if (!w || !Number.isFinite(used)) {
        return undefined;
    }
    const reset = w.resets_at ? Date.parse(w.resets_at) : NaN;
    return { used: Math.max(0, Math.min(100, used)), resetsAt: Number.isFinite(reset) ? reset : undefined };
}

export function parseQuota(body: any, now = Date.now()): ClaudeQuota | undefined {
    const h5 = window(body?.five_hour);
    const week = window(body?.seven_day);
    return h5 || week ? { h5, week, at: now } : undefined;
}

/** Last known exact numbers for an account (up to 30 minutes old), without network. */
export function cachedQuota(dir: string): ClaudeQuota | undefined {
    const q = cache.get(key(dir));
    return q && Date.now() - q.at < 30 * 60000 ? q : undefined;
}

/** Optional logger (no token is ever passed to it). Set by the extension. */
export let quotaLog: (line: string) => void = () => undefined;
export function setQuotaLog(fn: (line: string) => void): void {
    quotaLog = fn;
}

/** Fetches when the cached value is older than 3 minutes. Returns undefined on any problem. */
export async function fetchQuota(dir: string, force = false): Promise<ClaudeQuota | undefined> {
    const k = key(dir);
    const hit = cache.get(k);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        return hit;
    }
    if ((coolUntil.get(k) || 0) > Date.now()) {
        return hit;
    }
    const token = readToken(dir);
    if (!token) {
        quotaLog(`quota ${path.basename(dir)}: no valid login token (expired or signed out); using local estimate`);
        return hit;
    }
    try {
        const r = await fetch(USAGE_URL, {
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (r.status === 429) {
            const after = Number(r.headers.get('retry-after'));
            coolUntil.set(k, Date.now() + (Number.isFinite(after) && after > 0 ? Math.min(after, 1800) * 1000 : COOL_MS));
            quotaLog(`quota ${path.basename(dir)}: 429 rate limited, retry in ${Number.isFinite(after) && after > 0 ? after : COOL_MS / 1000}s`);
            return hit;
        }
        if (!r.ok) {
            quotaLog(`quota ${path.basename(dir)}: HTTP ${r.status}`);
            return hit;
        }
        const q = parseQuota(await r.json());
        if (q) {
            cache.set(k, q);
        }
        quotaLog(`quota ${path.basename(dir)}: ${q ? `5h ${q.h5?.used ?? '-'}%, week ${q.week?.used ?? '-'}%` : 'unexpected answer'}`);
        return q ?? hit;
    } catch (err) {
        quotaLog(`quota ${path.basename(dir)}: request failed (${String((err as Error)?.message || err).slice(0, 80)})`);
        return hit;
    }
}

/** Status-bar color level from the higher of the two windows: 80% warns, 95% is critical. */
export function level(q: ClaudeQuota | undefined): 'ok' | 'warn' | 'critical' {
    const top = Math.max(q?.h5?.used ?? 0, q?.week?.used ?? 0);
    return top >= 95 ? 'critical' : top >= 80 ? 'warn' : 'ok';
}
