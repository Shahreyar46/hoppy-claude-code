// "Hoppy Usage" view in the Explorer sidebar and the short usage text in the status bar. Tokens come from Claude
// Code's chat files. The 5h/week % comes from Anthropic (quota.ts, read-only) when available, else from caps
// learned at limit hits (caps.ts, marked "~"). OpenRouter's free-request counter is read with the user's key.
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { capFor, CapStore, fractionLeft, leftLabel } from './caps';
import { runHelper } from './gateway';
import { LimitHit, resetLabel } from './limits';
import { sameDir, Target } from './targets';
import { formatTokens, UsageSummary } from './usage';
import { ClaudeQuota } from './quota';

export interface UsageRow {
    dir: string;
    label: string;
    kind: 'claude' | 'other';
    current: boolean;
    /** Tokens in the last 5 hours / 7 days. */
    h5?: number;
    week?: number;
    today?: number;
    /** 0..1 left of the learned cap, when one is known. */
    h5Left?: number;
    weekLeft?: number;
    /** True when the % comes from Anthropic, not from a learned cap. */
    exact?: boolean;
    h5Reset?: number;
    weekReset?: number;
    limit?: string;
}

/** Color level from the fuller window: 80% used warns, 95% is critical. */
export function rowLevel(r: UsageRow | undefined): 'ok' | 'warn' | 'critical' {
    const used = Math.max(r?.h5Left === undefined ? 0 : 1 - r.h5Left, r?.weekLeft === undefined ? 0 : 1 - r.weekLeft);
    return r?.limit || used >= 0.95 ? 'critical' : used >= 0.8 ? 'warn' : 'ok';
}

const pct = (left: number | undefined, exact?: boolean) => (left === undefined ? undefined : `${exact ? '' : '~'}${Math.round((1 - left) * 100)}%`);

function clock(ms: number | undefined): string | undefined {
    if (!ms) {
        return undefined;
    }
    const at = new Date(ms);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export function buildRows(
    targets: Target[],
    current: string,
    usage: (dir: string) => UsageSummary | undefined,
    limitOf: (t: Target) => LimitHit | undefined,
    caps: CapStore,
    quotaOf: (dir: string) => ClaudeQuota | undefined = () => undefined,
): UsageRow[] {
    return targets.map((t) => {
        const u = usage(t.dir);
        const hit = limitOf(t);
        const q = t.kind === 'claude' ? quotaOf(t.dir) : undefined;
        if (q && (q.h5 || q.week)) {
            return {
                dir: t.dir,
                label: t.label,
                kind: t.kind,
                current: sameDir(t.dir, current),
                h5: u?.last5h.tokens,
                today: u?.today.tokens,
                week: u?.last7d.tokens,
                h5Left: q.h5 ? 1 - q.h5.used / 100 : undefined,
                weekLeft: q.week ? 1 - q.week.used / 100 : undefined,
                exact: true,
                h5Reset: q.h5?.resetsAt,
                weekReset: q.week?.resetsAt,
                limit: hit ? resetLabel(hit) : undefined,
            };
        }
        return {
            dir: t.dir,
            label: t.kind === 'other' ? 'Other AI' : t.label,
            kind: t.kind,
            current: sameDir(t.dir, current),
            h5: u?.last5h.tokens,
            today: u?.today.tokens,
            week: u?.last7d.tokens,
            h5Left: t.kind === 'claude' && u ? fractionLeft(u.last5h.tokens, capFor(caps, t.dir, 'session')) : undefined,
            weekLeft: t.kind === 'claude' && u ? fractionLeft(u.last7d.tokens, capFor(caps, t.dir, 'weekly')) : undefined,
            limit: hit ? resetLabel(hit) : undefined,
        };
    });
}

/** Short text for the status bar: " · 5h 5% · wk 85%" (used), "~" when estimated, tokens when no % is known. */
export function statusUsageText(row: UsageRow | undefined, quota?: Quota): string {
    if (!row) {
        return '';
    }
    if (row.kind === 'other') {
        return quota ? ` · OpenRouter free ${quota.remaining}/${quota.limit}` : row.today !== undefined ? ` · ${formatTokens(row.today)} today` : '';
    }
    const h5 = pct(row.h5Left, row.exact) ?? (row.h5 !== undefined ? formatTokens(row.h5) : undefined);
    const wk = pct(row.weekLeft, row.exact);
    const parts = [h5 && `5h ${h5}`, wk && `wk ${wk}`].filter(Boolean);
    if (row.limit) {
        return ` · ${[...(row.exact ? parts : []), row.limit].join(' · ')}`;
    }
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** One hover line, e.g. "5 h 5% used, resets 6:00 AM · week 85% used, resets Fri 8:00 AM". */
export function quotaDetail(row: UsageRow): string | undefined {
    const one = (name: string, left: number | undefined, reset: number | undefined) =>
        left === undefined ? undefined : `${name} ${pct(left, row.exact)} used${clock(reset) ? `, resets ${clock(reset)}` : ''}`;
    const lines = [one('5 h', row.h5Left, row.h5Reset), one('week', row.weekLeft, row.weekReset)].filter(Boolean);
    return lines.length ? `${lines.join(' · ')}${row.exact ? '' : ' (estimate)'}` : undefined;
}

export interface Quota {
    remaining: number;
    limit: number;
}

let quotaCache: { at: number; value?: Quota } | undefined;

/** OpenRouter free requests left today (shared by all its free models). Cached 5 minutes. */
export async function openRouterQuota(extensionPath: string, maxAgeMs = 5 * 60000): Promise<Quota | undefined> {
    if (quotaCache && Date.now() - quotaCache.at < maxAgeMs) {
        return quotaCache.value;
    }
    let value: Quota | undefined;
    try {
        const exported = await runHelper(extensionPath, 'export-key openrouter');
        if (exported?.key) {
            const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${exported.key}` }, signal: AbortSignal.timeout(8000) });
            const free = ((await r.json()) as any)?.data?.free_model_daily_requests;
            value = free ? { remaining: Number(free.remaining), limit: Number(free.limit) } : undefined;
        }
    } catch {
        value = undefined;
    }
    quotaCache = { at: Date.now(), value };
    return value;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** One bar: filled = used share of the learned cap; without a cap, no bar, just the number. */
function bar(label: string, tokens: number | undefined, left: number | undefined, exact?: boolean, reset?: number): string {
    if (tokens === undefined && left === undefined) {
        return '';
    }
    const used = left === undefined ? undefined : 1 - left;
    const level = used === undefined ? '' : used >= 0.95 ? 'hot' : used >= 0.8 ? 'warm' : '';
    return `<div class="line">
        <span class="k">${label}</span>
        ${used === undefined ? '<span class="nobar"></span>' : `<span class="bar ${level}" title="${exact ? 'From Anthropic' : 'Estimate from the last limit'}"><span style="width:${Math.round(used * 100)}%"></span></span>`}
        <span class="v">${exact && left !== undefined ? `${Math.round((1 - left) * 100)}%` : tokens === undefined ? '' : formatTokens(tokens)}</span>
        <span class="left">${esc(exact ? (clock(reset) ? `resets ${clock(reset)}` : 'used') : leftLabel(left) || '')}</span>
    </div>`;
}

export function renderRows(rows: UsageRow[], quota: Quota | undefined): string {
    const cards = rows.map((r) => {
        const head = `<div class="head"><b>${esc(r.label)}</b>${r.current ? '<span class="tag">in use</span>' : `<a href="#" data-dir="${esc(r.dir)}" title="Switch the Claude panel to ${esc(r.label)}">switch</a>`}</div>`;
        if (r.kind === 'other') {
            const q = quota
                ? `<div class="line wide"><span class="k">OpenRouter free</span><span class="bar ${quota.remaining <= 5 ? 'hot' : ''}"><span style="width:${quota.limit ? Math.round(((quota.limit - quota.remaining) / quota.limit) * 100) : 0}%"></span></span><span class="v">${quota.remaining}/${quota.limit}</span><span class="left">left today</span></div>`
                : '';
            return `<section class="${r.current ? 'cur' : ''}">${head}${q}${bar('today', r.today, undefined)}${bar('week', r.week, undefined)}</section>`;
        }
        const limit = r.limit ? `<div class="limit">At its limit · ${esc(r.limit)}</div>` : '';
        return `<section class="${r.current ? 'cur' : ''}">${head}${limit}${bar('5 h', r.h5, r.h5Left, r.exact, r.h5Reset)}${bar('week', r.week, r.weekLeft, r.exact, r.weekReset)}</section>`;
    });
    const note = rows.some((r) => r.exact)
        ? '% used comes from Anthropic (same numbers as /usage). "~" means an estimate from local chat files.'
        : 'Tokens from your local chat files. "~%" is an estimate learned from each account last limit.';
    return `${cards.join('')}<p class="note">${note}</p>`;
}

export class UsageViewProvider implements vscode.WebviewViewProvider {
    static readonly id = 'hoppy.usageView';
    private view?: vscode.WebviewView;

    constructor(private readonly content: () => Promise<string>) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.onDidReceiveMessage((m) => {
            if (m?.type === 'switch' && typeof m.dir === 'string') {
                vscode.commands.executeCommand('hoppy.switchToDir', m.dir);
            }
        });
        view.onDidChangeVisibility(() => view.visible && this.refresh());
        void this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.view?.visible) {
            return;
        }
        const nonce = crypto.randomBytes(16).toString('base64');
        this.view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:4px 10px 8px;margin:0}
section{padding:6px 0;border-bottom:1px solid var(--vscode-panel-border,transparent)}
section.cur b{color:var(--vscode-textLink-foreground)}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.tag{font-size:.85em;opacity:.75}
a{color:var(--vscode-textLink-foreground);text-decoration:none;font-size:.9em}
.line{display:grid;grid-template-columns:3.2em 1fr auto auto;gap:6px;align-items:center;font-size:.92em;line-height:1.7}
.line .k{opacity:.75;white-space:nowrap}
.line.wide{grid-template-columns:auto 1fr auto auto}
.bar,.nobar{height:6px;border-radius:3px;overflow:hidden}
.bar{background:color-mix(in srgb,var(--vscode-foreground) 15%,transparent)}
.bar>span{display:block;height:100%;background:var(--vscode-charts-green,#89d185)}
.bar.warm>span{background:var(--vscode-charts-yellow,#e5c07b)}
.bar.hot>span{background:var(--vscode-charts-red,#f48771)}
.v{font-variant-numeric:tabular-nums;text-align:right}
.left{opacity:.75;font-size:.9em;white-space:nowrap}
.limit{color:var(--vscode-editorWarning-foreground);font-size:.9em;margin-bottom:2px}
.note{opacity:.6;font-size:.85em;margin:8px 0 0}
</style></head><body>${await this.content()}
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.addEventListener('click',e=>{const a=e.target.closest('a[data-dir]');if(a){e.preventDefault();vs.postMessage({type:'switch',dir:a.dataset.dir});}});</script>
</body></html>`;
    }
}
