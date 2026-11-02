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
    email?: string;
    /** Other AI: tokens per model in the last 7 days, largest first. */
    models?: { model: string; tokens: number }[];
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
                email: t.email,
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
            email: t.kind === 'claude' ? t.email : undefined,
            models: t.kind === 'other' ? u?.models : undefined,
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
    const h5 = pct(row.h5Left, row.exact) ?? (row.h5 ? `${formatTokens(row.h5)} tok` : '…');
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

// ---- Card model, shared by the sidebar view and the status bar hover ----

export type CardStatus = 'in-use' | 'idle' | 'unused' | 'limit';

export interface CardLine {
    label: string;
    /** 0..100 used; undefined = no bar. */
    used?: number;
    /** Right-hand value, e.g. "60%" or "37/50 left". */
    value: string;
    /** Second, muted line. */
    detail: string;
    /** Absolute reset time, for a tooltip. */
    resetAt?: number;
}

export interface Card {
    dir?: string;
    title: string;
    email?: string;
    status?: CardStatus;
    lines: CardLine[];
    hint?: string;
    /** Other AI: per-model breakdown for the expandable section. */
    models?: { model: string; tokens: number; share: number }[];
}

/** "rahim.hossain@gm…" for long emails; the full one goes in a tooltip. */
export function shortEmail(email: string | undefined, max = 22): string {
    if (!email) {
        return '';
    }
    return email.length > max ? `${email.slice(0, max - 1)}…` : email;
}

/** Bar color step: green, amber from 70%, red from 90%. */
export function barLevel(used: number): 'ok' | 'warn' | 'critical' {
    return used >= 90 ? 'critical' : used >= 70 ? 'warn' : 'ok';
}

/** "in 4d 7h", "in 3h 38m", "in 12m", "now". */
export function relTime(at: number | undefined, now = Date.now()): string {
    if (!at) {
        return '';
    }
    const m = Math.max(0, Math.round((at - now) / 60000));
    if (m < 1) {
        return 'now';
    }
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const min = m % 60;
    return d ? `in ${d}d ${h}h` : h ? `in ${h}h ${min}m` : `in ${min}m`;
}

/** "76M of ~127M tokens" when the % allows an estimate, "1.4M tokens", or "Nothing used yet". */
export function tokenText(tokens: number | undefined, used: number | undefined): string {
    if (!tokens) {
        return 'Nothing used yet';
    }
    if (used !== undefined && used >= 10) {
        return `${formatTokens(tokens)} of ~${formatTokens(Math.round(tokens / (used / 100)))} tokens`;
    }
    return `${formatTokens(tokens)} tokens`;
}

/** Next 00:00 UTC, when OpenRouter's free counter resets. */
function nextUtcMidnight(now: number): number {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function buildCards(rows: UsageRow[], quota: Quota | undefined, now = Date.now()): Card[] {
    const claude: Card[] = [];
    const unused: Card[] = [];
    for (const r of rows.filter((x) => x.kind === 'claude')) {
        const lines: CardLine[] = [];
        const add = (label: string, left: number | undefined, reset: number | undefined, tokens: number | undefined) => {
            if (left === undefined) {
                return;
            }
            const used = Math.round((1 - left) * 100);
            const when = relTime(reset, now);
            lines.push({ label, used, value: `${r.exact ? '' : '~'}${used}%`, detail: `${tokenText(tokens, used)}${when ? ` · resets ${when}` : ''}`, resetAt: reset });
        };
        add('Session (5h)', r.h5Left, r.h5Reset, r.h5);
        add('Weekly', r.weekLeft, r.weekReset, r.week);
        const full = !!r.limit || lines.some((l) => (l.used ?? 0) >= 100);
        if (!lines.length && !full && r.current) {
            // The account in use is never "not used yet": its numbers are just not in yet.
            lines.push({ label: 'Session (5h)', value: '', detail: `${r.h5 ? `${formatTokens(r.h5)} tokens · ` : ''}Waiting for usage numbers…` });
        }
        if (!lines.length && !full) {
            unused.push({ dir: r.dir, title: r.label, email: r.email, status: 'unused', lines: [] });
            continue;
        }
        claude.push({ dir: r.dir, title: r.label, email: r.email, status: full ? 'limit' : r.current ? 'in-use' : 'idle', lines });
    }
    // Active account first.
    const currentDir = rows.find((r) => r.current && r.kind === 'claude')?.dir;
    claude.sort((a, b) => Number(b.dir === currentDir) - Number(a.dir === currentDir));
    // Running low: point at the account with the most weekly room.
    const active = claude.find((c) => c.dir === currentDir);
    if (active && active.lines.some((l) => (l.used ?? 0) >= 90)) {
        const best = rows
            .filter((r) => r.kind === 'claude' && r.dir !== currentDir && r.weekLeft !== undefined && !r.limit)
            .sort((a, b) => (b.weekLeft as number) - (a.weekLeft as number))[0];
        if (best && (best.weekLeft as number) > 0.1) {
            active.hint = `Running low → ${best.label} has ${Math.round((best.weekLeft as number) * 100)}% weekly left`;
        }
    }
    const cards = [...claude];
    const other = rows.find((r) => r.kind === 'other');
    if (other) {
        const lines: CardLine[] = [];
        if (quota && quota.limit > 0) {
            const reset = nextUtcMidnight(now);
            lines.push({ label: 'OpenRouter (free)', used: Math.round(((quota.limit - quota.remaining) / quota.limit) * 100), value: `${quota.remaining}/${quota.limit} left`, detail: `resets ${relTime(reset, now)} (00:00 UTC)`, resetAt: reset });
        }
        lines.push({ label: 'Local tokens', value: '', detail: other.today === undefined ? 'No data yet' : `${formatTokens(other.today)} today · ${formatTokens(other.week ?? 0)} this week` });
        const total = (other.models || []).reduce((n, m) => n + m.tokens, 0);
        const models = (other.models || []).filter((m) => m.tokens > 0).map((m) => ({ ...m, share: total ? Math.round((m.tokens / total) * 100) : 0 }));
        cards.push({ dir: other.dir, title: 'Other AI', status: other.current ? 'in-use' : undefined, lines, models });
    }
    return [...cards, ...unused];
}

const STATUS_TEXT: Record<CardStatus, string> = { 'in-use': '● In use', idle: 'Idle', unused: 'Not used yet', limit: 'Limit reached' };

/** Sidebar view: full card design (theme colors, dividers, 6px bars, tabular numbers). */
export function renderCards(cards: Card[]): string {
    const at = (ms?: number) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
    const body = cards
        .map((c) => {
            const badge = c.status ? `<span class="badge ${c.status}">${STATUS_TEXT[c.status]}</span>` : '';
            const switchLink = c.dir && c.status !== 'in-use' ? `<a href="#" data-dir="${esc(c.dir)}" title="Switch the Claude panel to ${esc(c.title)}">Switch</a>` : '';
            const lines = c.lines
                .map(
                    (l) => `<div class="row" title="${esc(l.resetAt ? `Resets ${at(l.resetAt)}` : '')}">
                <div class="l1"><span class="k">${esc(l.label)}</span>${l.used === undefined ? '<span></span>' : `<span class="bar ${barLevel(l.used)}"><span style="width:${Math.min(100, l.used)}%"></span></span>`}<b class="v">${esc(l.value)}</b></div>
                <div class="l2">${esc(l.detail)}</div></div>`,
                )
                .join('');
            const email = c.email ? `<span class="email" title="${esc(c.email)}">· ${esc(shortEmail(c.email))}</span>` : '';
            const models = c.models?.length
                ? `<details class="models"${c.models.length ? ' data-remember="other-models"' : ''}><summary><span class="chev">▸</span> Models this week <span class="count">${c.models.length}</span></summary><div class="mlist">${c.models
                      .map(
                          (m, i) =>
                              `<div class="row m${i >= 5 ? ' more' : ''}"><span class="k mname" title="${esc(m.model)}">${esc(m.model)}</span><span class="bar"><span style="width:${m.share}%"></span></span><b class="v">${formatTokens(m.tokens)}</b></div>`,
                      )
                      .join('')}${c.models.length > 5 ? `<a href="#" class="showall">Show all (${c.models.length})</a>` : ''}</div></details>`
                : '';
            return `<section class="${c.status || ''}"><div class="head"><b>${esc(c.title)}</b>${email}${badge}<span class="grow"></span>${switchLink}</div>${lines}${models}${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ''}</section>`;
        })
        .join('');
    return `${body}<div class="foot" title="% used comes from Anthropic (the same numbers as /usage). Tokens are counted from local chat files; &quot;~&quot; means an estimate.">ⓘ Where these numbers come from</div>`;
}

/** Hover version: VS Code hovers keep only color/background-color, so bars are colored spans and dividers are rules. */
export function cardsMarkdown(cards: Card[]): string {
    const hex = { ok: '#4caf50', warn: '#ff9800', critical: '#f44336' };
    const bar = (used: number) => {
        // Narrow on purpose: VS Code caps the hover width, and wider bars pushed % and reset text off the edge.
        const total = 10;
        const filled = Math.max(used > 0 ? 1 : 0, Math.min(total, Math.round((used / 100) * total)));
        const sp = (n: number) => '&nbsp;'.repeat(n);
        return `<span style="background-color:${hex[barLevel(used)]};">${sp(filled)}</span><span style="background-color:#80808044;">${sp(total - filled)}</span>`;
    };
    const muted = (s: string) => `<span style="color:#8b8b8b;">${s}</span>`;
    // Model share bars stay green: a share is not a limit.
    const modelBar = (share: number) => {
        const total = 10;
        const filled = Math.max(share > 0 ? 1 : 0, Math.min(total, Math.round((share / 100) * total)));
        return `<span style="background-color:${hex.ok};">${'&nbsp;'.repeat(filled)}</span><span style="background-color:#80808044;">${'&nbsp;'.repeat(total - filled)}</span>`;
    };
    const badge = (st?: CardStatus) =>
        !st ? '' : st === 'in-use' ? ` <span style="color:#4caf50;">● In use</span>` : st === 'limit' ? ` <span style="color:#f44336;"><b>Limit reached</b></span>` : ` ${muted(STATUS_TEXT[st])}`;
    return cards
        .map((c) => {
            // "@" as an entity, so the hover does not turn the email into a blue mailto link.
            const email = c.email ? ` ${muted(`· ${esc(shortEmail(c.email)).replace(/@/g, '&#64;')}`)}` : '';
            const head = `**${esc(c.title)}**${email}${badge(c.status)}`;
            if (!c.lines.length) {
                return `${head}\n`;
            }
            const rows = c.lines
                .map(
                    (l) =>
                        `<tr><td>${esc(l.label)}&nbsp;</td><td>${l.used === undefined ? '' : bar(l.used)}</td><td align="right">&nbsp;<b>${esc(l.value)}</b></td></tr>` +
                        `<tr><td></td><td colspan="2">${muted(esc(l.detail))}</td></tr>`,
                )
                .join('\n');
            // Other AI: top 5 models right in the hover (share of this week's Other AI tokens), the rest in the view.
            const top = (c.models || []).slice(0, 5);
            const modelRows = top.length
                ? `\n<tr><td colspan="3">${muted('Models this week')}</td></tr>\n` +
                  top
                      .map((m) => {
                          const name = m.model.length > 24 ? `${m.model.slice(0, 23)}…` : m.model;
                          return `<tr><td>${esc(name)}&nbsp;</td><td>${modelBar(m.share)}</td><td align="right">&nbsp;<b>${formatTokens(m.tokens)}</b></td></tr>`;
                      })
                      .join('\n')
                : '';
            const rest = (c.models?.length || 0) - top.length;
            const more = rest > 0 ? `\n${muted(`+${rest} more ·`)} [Details ▸](command:hoppy.usageView.focus)\n` : '';
            return `${head}\n\n<table>\n${rows}${modelRows}\n</table>\n${more}${c.hint ? `\n<span style="color:#ff9800;">${esc(c.hint)}</span>\n` : ''}`;
        })
        .join('\n---\n\n');
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
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:2px 12px 10px;margin:0;font-variant-numeric:tabular-nums}
section{padding:12px 0;border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 8%,transparent)}
section:first-child{border-top:0;padding-top:6px}
.head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.grow{flex:1}
.badge{font-size:.85em;color:var(--vscode-descriptionForeground)}
.badge.in-use{color:var(--vscode-charts-green,#4caf50)}
.badge.limit{color:#fff;background:var(--vscode-charts-red,#f44336);padding:0 6px;border-radius:8px}
section.unused{padding:8px 0;opacity:.6}
section.unused .head{margin:0}
a{color:var(--vscode-textLink-foreground);text-decoration:none;font-size:.9em}
.row{margin-top:6px;display:grid;grid-template-columns:9.6em 1fr 5.2em;column-gap:8px;align-items:center}
.l1{display:contents}
.k{white-space:nowrap}
.v{text-align:right;white-space:nowrap}
.l2{grid-column:2/4;font-size:.88em;color:var(--vscode-descriptionForeground)}
.bar{height:6px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--vscode-foreground) 8%,transparent)}
.bar>span{display:block;height:100%;border-radius:3px;background:var(--vscode-charts-green,#4caf50)}
.bar.warn>span{background:var(--vscode-charts-orange,#ff9800)}
.bar.critical>span{background:var(--vscode-charts-red,#f44336)}
.hint{margin-top:8px;font-size:.9em;color:var(--vscode-charts-orange,#ff9800)}
.foot{margin-top:10px;font-size:.85em;color:var(--vscode-descriptionForeground);cursor:help}
.email{font-size:.85em;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.models{margin-top:8px}
.models summary{list-style:none;cursor:pointer;font-size:.9em;color:var(--vscode-descriptionForeground);user-select:none}
.models summary::-webkit-details-marker{display:none}
.chev{display:inline-block;transition:transform .18s ease}
.models[open] .chev{transform:rotate(90deg)}
.count{opacity:.8}
.mlist{animation:hoppyOpen .18s ease}
@keyframes hoppyOpen{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.mname{overflow:hidden;text-overflow:ellipsis;font-size:.92em}
.mlist .more{display:none}
.mlist.all .more{display:grid}
.showall{display:block;margin-top:6px}
</style></head><body>${await this.content()}
<script nonce="${nonce}">
const vs=acquireVsCodeApi();const st=vs.getState()||{};
document.querySelectorAll('details[data-remember]').forEach(d=>{d.open=!!st[d.dataset.remember];d.addEventListener('toggle',()=>{st[d.dataset.remember]=d.open;vs.setState(st);});});
if(st.allModels)document.querySelectorAll('.mlist').forEach(m=>m.classList.add('all'));
document.addEventListener('click',e=>{const a=e.target.closest('a[data-dir]');if(a){e.preventDefault();vs.postMessage({type:'switch',dir:a.dataset.dir});return;}
const s=e.target.closest('a.showall');if(s){e.preventDefault();const m=s.closest('.mlist');m.classList.toggle('all');st.allModels=m.classList.contains('all');vs.setState(st);s.textContent=st.allModels?'Show less':s.textContent.replace('Show less','Show all');}});
</script>
</body></html>`;
    }
}
