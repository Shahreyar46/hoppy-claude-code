import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { belongsToOpenProject, Chat, chatFromFile, chatTokens, forkChat, pickChat, summarizeChat, syncChatsInto } from './chats';
import { ccrStatus, isCcrInstalled, isGatewayUp, startGateway, stopGateway } from './gateway';
import { LimitHit, LimitRadar, resetLabel } from './limits';
import { log } from './log';
import { claudeConfigDirs, expandHome, routerDir } from './paths';
import { folderSummary, isRemovable, sizeLabel, withoutDir } from './removeAccount';
import { applyToCcr, fetchFreeModels, runSetup } from './setup';
import { exportSettings, importSettings } from './portable';
import { modelContext, SettingsPanel } from './settings';
import { installSkill } from './skill';
import { colorFor, createAccountDir, currentDir, currentTarget, describe, isCurrent, applyProjectPin, isProjectPinned, listTargets, pinProject, sameDir, setLabel, setTarget, Target, unpinProject } from './targets';
import { cachedUsage, formatTokens, initUsage, refreshUsage, usageLine } from './usage';
import { learn, leftLabel, loadCaps, raiseIfPassed, saveCaps } from './caps';
import { buildCards, buildRows, cardsMarkdown, openRouterQuota, Quota, quotaDetail, renderCards, rowLevel, statusUsageText, UsageRow, UsageViewProvider } from './usageView';
import { cachedQuota, fetchQuota, setQuotaLog } from './quota';
import { Voice } from './voice';
import { initRating, noteWin, REVIEW_URL } from './rating';
import { applyLook } from './statusItem';

let statusItem: vscode.StatusBarItem;
let usageItem: vscode.StatusBarItem;
let radar: LimitRadar | undefined;
let globalState: vscode.Memento | undefined;
let usageView: UsageViewProvider | undefined;
/** Last OpenRouter free-request count, refreshed in the background (the status bar never waits for it). */
let lastQuota: Quota | undefined;
let usageLogged = false;

function usageRows(): UsageRow[] {
    const exact = vscode.workspace.getConfiguration('hoppy').get<boolean>('claudeQuota', true);
    return buildRows(listTargets(), currentDir(), (d) => (showUsage() ? cachedUsage(d) : undefined), limitOf, globalState ? loadCaps(globalState) : {}, exact ? cachedQuota : undefined);
}

/** Exact 5h/week % from Anthropic for each logged-in account (read-only token; cached 3 min inside). */
async function updateClaudeQuotas(): Promise<void> {
    if (!vscode.workspace.getConfiguration('hoppy').get<boolean>('claudeQuota', true)) {
        return;
    }
    for (const t of listTargets().filter((x) => x.kind === 'claude' && x.loggedIn)) {
        await fetchQuota(t.dir);
    }
}

function limitOf(t: Target): LimitHit | undefined {
    return t.kind === 'claude' ? radar?.limitFor(t.dir) : undefined;
}

/** Menu/tooltip detail for a target: limit first, since it decides whether the account is usable now. */
function targetDetail(t: Target): string {
    const limit = limitOf(t);
    if (limit) {
        return `$(watch) ${resetLabel(limit)}`;
    }
    return t.kind === 'claude' ? (t.email ?? (t.loggedIn ? '' : 'needs login')) : 'models from your API keys';
}

function showUsage(): boolean {
    return vscode.workspace.getConfiguration('hoppy').get<boolean>('showUsage', true);
}

/** Second line in the menu: tokens used, from local chat files. Empty until the first scan finished. */
function usageDetail(t: Target): string | undefined {
    const u = showUsage() ? cachedUsage(t.dir) : undefined;
    return u ? `$(pulse) ${usageLine(u)}` : undefined;
}

function refreshAllUsage(maxAgeMs: number, maxScans = Infinity): boolean {
    if (!showUsage()) {
        return false;
    }
    return refreshUsage(listTargets().map((t) => ({ dir: t.dir, claudeOnly: t.kind === 'claude' })), maxAgeMs, maxScans);
}

/** Usable accounts first; limited ones sink to the bottom of the Claude list. */
function sortedTargets(): Target[] {
    const all = listTargets();
    const rank = (t: Target) => (t.kind === 'other' ? 1 : limitOf(t) ? 2 : 0);
    return all.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

/** Hover for the usage item: the same cards as the Hoppy Usage view, within what VS Code hovers can render. */
function usageTooltip(rows: UsageRow[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    md.isTrusted = { enabledCommands: ['hoppy.usageView.focus', 'hoppy.refreshUsage'] };
    md.appendMarkdown('**Hoppy · Usage** &nbsp; [$(refresh)](command:hoppy.refreshUsage "Refresh")\n\n---\n\n');
    md.appendMarkdown(cardsMarkdown(buildCards(rows, lastQuota)));
    md.appendMarkdown('\n---\n\n[Open Hoppy Usage](command:hoppy.usageView.focus) &nbsp; [$(info)](command:hoppy.usageView.focus "% used comes from Anthropic (same as /usage). Tokens are counted from local chat files; ~ means an estimate.")');
    return md;
}

async function refreshStatus(): Promise<void> {
    const t = currentTarget();
    const gatewayUp = await isGatewayUp();
    const up = t.kind === 'other' ? gatewayUp : true;
    const limited = !!limitOf(t);
    const rows = usageRows();
    const currentRow = rows.find((r) => r.current);
    const statusText = t.kind === 'claude' ? `$(sparkle) Claude · ${t.label}${limited ? ' $(watch)' : ''}` : up ? '$(globe) Other AI' : '$(warning) Other AI (stopped)';
    const statusBg = up && !limited ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    // A warning background already carries its own foreground; a custom color would fight it.
    const statusColor = t.kind === 'claude' && !limited ? colorFor(t.dir) : undefined;

    // Separate compact usage item: "5h 5% · wk 85%". 80% used turns yellow, 95% or a limit turns red
    // (VS Code status items only offer these two backgrounds).
    const usageText = showUsage() && up ? statusUsageText(currentRow, lastQuota).replace(/^ · /, '') : '';
    if (usageText) {
        const level = t.kind === 'claude' ? rowLevel(currentRow) : 'ok';
        // VS Code allows extensions only two backgrounds: yellow (warning) and red (error).
        // hoppy.usageBackground: auto = yellow from 80%, red from 95%; yellow/red = always that box (red still wins at 95%).
        const cfg = vscode.workspace.getConfiguration('hoppy');
        const bgMode = cfg.get<string>('usageBackground', 'auto');
        const bg = level === 'critical' || bgMode === 'red' ? 'error' : level === 'warn' || bgMode === 'yellow' ? 'warning' : undefined;
        const usageBg = bg ? new vscode.ThemeColor(`statusBarItem.${bg}Background`) : undefined;
        // Font: a hex in hoppy.usageColor always wins; "auto" colors the text only when there is no box
        // (green, amber from 70%), since a box brings its own readable foreground.
        const custom = cfg.get<string>('usageColor', 'auto');
        const top = Math.max(currentRow?.h5Left === undefined ? 0 : 1 - currentRow.h5Left, currentRow?.weekLeft === undefined ? 0 : 1 - currentRow.weekLeft);
        const usageColor = /^#[0-9a-f]{3,8}$/i.test(custom) ? custom : custom === 'auto' && !bg ? new vscode.ThemeColor(top >= 0.7 ? 'charts.orange' : 'charts.green') : undefined;
        applyLook(usageItem, { text: `$(dashboard) ${usageText}`, tooltip: usageTooltip(rows), color: usageColor, backgroundColor: usageBg });
        usageItem.show();
    } else {
        usageItem.hide();
    }

    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = { enabledCommands: ['hoppy.settings', 'hoppy.handoff', 'hoppy.gatewayRestart'] };
    tip.appendMarkdown('**Hoppy** · the Claude panel uses:\n\n');
    for (const x of listTargets()) {
        const icon = x.kind === 'other' ? '$(globe)' : '$(sparkle)';
        const limit = limitOf(x);
        const detail = x.kind === 'other' ? (gatewayUp ? 'ready' : 'stopped') : limit ? `$(watch) ${resetLabel(limit)}` : x.email ?? (x.loggedIn ? '' : 'needs login');
        const row = rows.find((r) => r.dir === x.dir);
        const pctLine = row && quotaDetail(row);
        const used = usageDetail(x) && `${usageDetail(x)}${pctLine ? `  \n　　$(dashboard) ${pctLine}` : ''}${x.kind === 'other' && lastQuota ? ` · OpenRouter free ${lastQuota.remaining}/${lastQuota.limit} left today` : ''}`;
        tip.appendMarkdown(`${isCurrent(x) ? '**▶**' : '　'} ${icon} ${isCurrent(x) ? `**${describe(x)}**` : describe(x)} ${detail ? `· ${detail}` : ''}${used ? `  \n　　${used}` : ''}\n\n`);
    }
    if (isProjectPinned()) {
        tip.appendMarkdown('$(pinned) This project always uses this choice\n\n');
    }
    tip.appendMarkdown('---\n\nClick to switch · [Continue a chat](command:hoppy.handoff) · [Settings](command:hoppy.settings)');
    if (t.kind === 'other' && !up) {
        tip.appendMarkdown(' · [Restart Other AI](command:hoppy.gatewayRestart)');
    }
    applyLook(statusItem, { text: statusText, tooltip: tip, color: statusColor, backgroundColor: statusBg });
    statusItem.show();
    void usageView?.refresh();
}

/** At a limit, the tokens counted in that window become the account's learned cap (see caps.ts). */
async function learnCapFromHit(hit: LimitHit): Promise<void> {
    if (!globalState || hit.kind === 'other') {
        return;
    }
    refreshUsage([{ dir: hit.dir, claudeOnly: true }], 0);
    const u = cachedUsage(hit.dir);
    if (!u) {
        return;
    }
    const used = hit.kind === 'session' ? u.last5h.tokens : u.last7d.tokens;
    await saveCaps(globalState, learn(loadCaps(globalState), hit.dir, hit.kind, used));
    log(`learned ${hit.kind} cap for ${hit.dir}: ${formatTokens(used)} tokens`);
}

/** An account still answering past its learned cap: the cap was too low, raise it. */
async function raisePassedCaps(): Promise<void> {
    if (!globalState) {
        return;
    }
    let store = loadCaps(globalState);
    const before = JSON.stringify(store);
    for (const t of listTargets().filter((x) => x.kind === 'claude' && !limitOf(x))) {
        const u = cachedUsage(t.dir);
        if (u) {
            store = raiseIfPassed(store, t.dir, 'session', u.last5h.tokens);
            store = raiseIfPassed(store, t.dir, 'weekly', u.last7d.tokens);
        }
    }
    if (JSON.stringify(store) !== before) {
        await saveCaps(globalState, store);
    }
}

/**
 * Claude Code reads CLAUDE_CONFIG_DIR each time it starts a session, so a new Claude tab uses the
 * new target right away. Tabs that are already open keep their account until closed or reloaded.
 */
async function openFreshClaudeTab(message: string, session?: string): Promise<void> {
    let opened: 'session' | 'tab' | false = false;
    if (session) {
        try {
            await vscode.commands.executeCommand('claude-vscode.editor.open', session);
            opened = 'session';
        } catch {
            // Older Claude Code without session arguments: fall back to a plain new tab.
        }
    }
    if (!opened) {
        try {
            await vscode.commands.executeCommand('claude-vscode.editor.open');
            opened = 'tab';
        } catch {
            opened = false;
        }
    }
    const text =
        opened === 'session'
            ? `${message} It is open in a new tab; send a message to carry on. (Tab empty? Type /resume there and pick it.)`
            : opened === 'tab'
              ? `${message}${session ? ' Type /resume in the new tab and pick it.' : ''} A new Claude tab is open on it; tabs that were already open stay as they were.`
              : `${message} Reload to apply.`;
    const choice = await vscode.window.showInformationMessage(text, 'Reload all tabs');
    if (choice) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** Makes sure Other AI is usable before switching to it. */
async function prepareOtherAi(context: vscode.ExtensionContext): Promise<boolean> {
    const status = await ccrStatus(context.extensionPath);
    if (!status.exists || !status.providers?.some((p) => p.hasKey)) {
        const pick = await vscode.window.showWarningMessage('Set up at least one API key for Other AI first.', 'Set up now');
        if (pick) {
            await vscode.commands.executeCommand('hoppy.setup');
        }
        return false;
    }
    if (!(await startGateway())) {
        vscode.window.showErrorMessage('Other AI did not start. Open the Hoppy menu → More → Restart Other AI.');
        return false;
    }
    return true;
}

/** Points the panel at a target and remembers where it was, for the flip shortcut. */
async function pointPanelAt(context: vscode.ExtensionContext, t: Target): Promise<void> {
    const before = currentDir();
    if (!sameDir(before, t.dir)) {
        await context.globalState.update('hoppy.previousDir', before);
    }
    await setTarget(t);
}

async function switchTo(context: vscode.ExtensionContext, t: Target, note = ''): Promise<void> {
    if (t.kind === 'other' && !(await prepareOtherAi(context))) {
        return;
    }
    let synced = 0;
    if (vscode.workspace.getConfiguration('hoppy').get<boolean>('syncChatsOnSwitch')) {
        try {
            synced = syncChatsInto(t);
        } catch (err) {
            vscode.window.showWarningMessage(`Could not copy chats: ${String(err)}`);
        }
    }
    await pointPanelAt(context, t);
    await refreshStatus();
    SettingsPanel.refresh();
    const login = t.kind === 'claude' && !t.loggedIn ? ' Log in there to finish adding it.' : '';
    const chats = synced ? ` ${synced} chat(s) from your other accounts are in /resume.` : '';
    await openFreshClaudeTab(`${note || `Now on ${describe(t)}.`}${chats}${login}`);
    noteWin();
}

function targetItems(title: string, exclude?: Target) {
    return vscode.window.showQuickPick(
        sortedTargets()
            .filter((t) => !exclude || !sameDir(t.dir, exclude.dir))
            .map((t) => ({
                label: `${t.kind === 'other' ? '$(globe)' : '$(sparkle)'} ${describe(t)}${isCurrent(t) ? '  (current)' : ''}`,
                description: targetDetail(t),
                target: t,
            })),
        { title },
    );
}

/** Copies a chat to another account or Other AI, points the panel there and opens the chat. */
/**
 * Other AI models often hold far less than a long Claude chat. Sending it whole fails or loses the start
 * of the task, so above 80% of the model's window (or 120k tokens when the window is unknown) offer a
 * hand-over summary instead. Returns 'full', 'summary' or undefined when cancelled.
 */
async function fitCheck(chat: Chat, dest: Target): Promise<'full' | 'summary' | undefined> {
    if (dest.kind !== 'other') {
        return 'full';
    }
    const tokens = chatTokens(chat.file);
    const main = vscode.workspace.getConfiguration('hoppy').get<string>('mainModel') || '';
    const ctx = main ? await modelContext(main) : undefined;
    const limit = ctx ? ctx * 0.8 : 120000;
    if (!tokens || tokens <= limit) {
        return 'full';
    }
    const summary = 'Continue with a summary';
    const full = 'Send the whole chat';
    const pick = await vscode.window.showWarningMessage(
        `This chat is about ${formatTokens(tokens)} tokens. ${ctx ? `${main.split('/').pop()} holds ${formatTokens(ctx)}.` : 'Many Other AI models hold 128k or less.'}`,
        { modal: true, detail: 'A summary carries the goal, the files changed and the latest messages into a new chat. The full chat may fail or lose its beginning on this model.' },
        summary,
        full,
    );
    return pick === summary ? 'summary' : pick === full ? 'full' : undefined;
}

async function continueChatOn(context: vscode.ExtensionContext, chat: Chat, dest: Target): Promise<void> {
    if (dest.kind === 'other' && !(await prepareOtherAi(context))) {
        return;
    }
    const mode = await fitCheck(chat, dest);
    if (!mode) {
        return;
    }
    if (mode === 'summary') {
        const prompt = summarizeChat(chat.file);
        if (!isCurrent(dest)) {
            await pointPanelAt(context, dest);
            await refreshStatus();
            SettingsPanel.refresh();
        }
        // Older Claude Code builds ignore the prompt argument without an error, so the summary also goes
        // to the clipboard: it is never lost.
        await vscode.env.clipboard.writeText(prompt);
        try {
            await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
        } catch {
            // the clipboard copy is the fallback
        }
        vscode.window.showInformationMessage(`New chat on ${describe(dest)} with a summary of "${chat.preview.slice(0, 40)}". Check it and send. (Message box empty? The summary is on your clipboard: paste it.)`);
        return;
    }
    const id = forkChat(chat, dest);
    log(`continue chat "${chat.preview.slice(0, 40)}" on ${describe(dest)} as session ${id}`);
    if (!isCurrent(dest)) {
        await pointPanelAt(context, dest);
        await refreshStatus();
        SettingsPanel.refresh();
    }
    await openFreshClaudeTab(`"${chat.preview.slice(0, 40)}" continues on ${describe(dest)}.`, id);
}

/** A Claude account just hit a plan limit: offer the quickest way to keep working. */
async function onLimitHit(context: vscode.ExtensionContext, hit: LimitHit): Promise<void> {
    await refreshStatus();
    SettingsPanel.refresh();
    // Every open window watches the same folders. Only the window that has this chat's project open
    // asks; the others just mark the account as limited.
    if (!vscode.workspace.getConfiguration('hoppy').get<boolean>('suggestOnLimit', true)) {
        log('limit hit: suggestions are turned off (hoppy.suggestOnLimit)');
        return;
    }
    if (!belongsToOpenProject(hit.sessionFile)) {
        log(`limit hit in another project's chat (${hit.sessionFile}); this window does not ask`);
        return;
    }
    log(`limit hit: ${hit.kind} limit on ${hit.dir}, ${resetLabel(hit)}; asking where to continue`);
    const all = listTargets();
    const from = all.find((t) => sameDir(t.dir, hit.dir));
    const nextClaude = sortedTargets().find((t) => t.kind === 'claude' && !sameDir(t.dir, hit.dir) && t.loggedIn && !limitOf(t));
    const other = all.find((t) => t.kind === 'other');
    const what = hit.kind === 'other' ? 'a usage limit' : `its ${hit.kind} limit`;
    const fromName = from ? describe(from) : 'Claude';
    const chat = chatFromFile(hit.sessionFile, from ?? currentTarget());
    const go = async (dest: Target) => (chat ? continueChatOn(context, chat, dest) : switchTo(context, dest));

    // The user opted in to skip the question: continue right away and say how to undo it.
    const mode = vscode.workspace.getConfiguration('hoppy').get<string>('onLimit', 'ask');
    const auto = mode === 'nextAccount' ? nextClaude ?? other : mode === 'otherAi' ? other : undefined;
    if (auto) {
        void vscode.window
            .showInformationMessage(`${fromName} hit ${what} (${resetLabel(hit)}). Continuing on ${describe(auto)}.`, 'Switch back', 'Ask me next time')
            .then(async (choice) => {
                if (choice === 'Switch back') {
                    await vscode.commands.executeCommand('hoppy.flip');
                } else if (choice === 'Ask me next time') {
                    await vscode.workspace.getConfiguration('hoppy').update('onLimit', 'ask', vscode.ConfigurationTarget.Global);
                }
            });
        await go(auto);
        return;
    }

    const onClaude = nextClaude ? `Continue on ${nextClaude.label}` : undefined;
    const onOther = 'Continue on Other AI';
    const choose = 'Choose…';
    const pick = await vscode.window.showWarningMessage(
        `${fromName} hit ${what} (${resetLabel(hit)}). Keep this chat going somewhere else?`,
        ...[onClaude, onOther, choose].filter((x): x is string => !!x),
    );
    if (!pick) {
        return;
    }
    const dest = pick === onClaude ? nextClaude : pick === onOther ? other : (await targetItems('Continue this chat on…', from))?.target;
    if (!dest) {
        return;
    }
    await go(dest);
    // Offer to skip the question next time, once, after a successful hop.
    if ((pick === onClaude || pick === onOther) && !context.globalState.get<boolean>('hoppy.offeredAutoLimit')) {
        await context.globalState.update('hoppy.offeredAutoLimit', true);
        const always = pick === onClaude ? 'Always continue on another account' : 'Always continue on Other AI';
        const choice = await vscode.window.showInformationMessage('Next time a limit hits, do this without asking?', always, 'Keep asking');
        if (choice === always) {
            await vscode.workspace.getConfiguration('hoppy').update('onLimit', pick === onClaude ? 'nextAccount' : 'otherAi', vscode.ConfigurationTarget.Global);
        }
    }
}

/** Limited accounts whose window has ended since the last check: tell the user they can go back. */
let limitedBefore = new Set<string>();
async function checkLimitsEnded(context: vscode.ExtensionContext): Promise<void> {
    const now = new Set(listTargets().filter((t) => limitOf(t)).map((t) => t.dir.toLowerCase()));
    const ended = [...limitedBefore].filter((d) => !now.has(d));
    limitedBefore = now;
    if (!ended.length || !vscode.workspace.getConfiguration('hoppy').get<boolean>('suggestOnLimit', true)) {
        return;
    }
    for (const dir of ended) {
        const t = listTargets().find((x) => x.dir.toLowerCase() === dir);
        if (!t) {
            continue;
        }
        if (isCurrent(t)) {
            vscode.window.showInformationMessage(`${describe(t)} is available again.`);
            continue;
        }
        const pick = await vscode.window.showInformationMessage(`${describe(t)} is available again.`, `Switch to ${t.label}`);
        if (pick) {
            await switchTo(context, t);
        }
    }
}

/**
 * Status bar click. The most common job, switching, is one pick: targets come first.
 * Everything else sits below a separator; rarely used tools live in "More".
 */
async function showMenu(context: vscode.ExtensionContext): Promise<void> {
    type Item = vscode.QuickPickItem & { target?: Target; command?: string };
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    // After the first background scan this only reads appended bytes, so it is quick enough to do inline.
    if (listTargets().every((t) => cachedUsage(t.dir))) {
        refreshAllUsage(60000);
    }
    const items: Item[] = [
        sep('Use in the Claude panel'),
        ...sortedTargets().map<Item>((t) => ({
            label: `${t.kind === 'other' ? '$(globe)' : '$(sparkle)'} ${describe(t)}`,
            description: isCurrent(t) ? `$(check) in use${limitOf(t) ? ` · ${targetDetail(t)}` : ''}` : targetDetail(t),
            detail: usageDetail(t),
            target: t,
        })),
        sep('Actions'),
        { label: '$(history) Continue a chat on another account or model…', command: 'hoppy.handoff' },
        { label: '$(add) Add Claude account', command: 'hoppy.addAccount' },
        ...(vscode.workspace.workspaceFolders?.length
            ? [
                  isProjectPinned()
                      ? { label: `$(pinned) This project always uses ${describe(currentTarget())}`, description: 'click to stop', command: 'hoppy.unpinProject' }
                      : { label: `$(pin) Always use ${describe(currentTarget())} in this project`, description: 'Hoppy switches back to it when you open this project', command: 'hoppy.pinProject' },
              ]
            : []),
        { label: '$(settings-gear) Settings', description: 'keys, models, fallback', command: 'hoppy.settings' },
        { label: '$(ellipsis) More', description: 'guide, skill, restart, status', command: 'hoppy.more' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Hoppy', placeHolder: 'Switch the Claude panel, or pick an action' });
    if (!pick) {
        return;
    }
    if (pick.target) {
        if (!isCurrent(pick.target)) {
            await switchTo(context, pick.target);
        }
        return;
    }
    if (pick.command) {
        await vscode.commands.executeCommand(pick.command);
    }
}

const VIDEOS = [
    { label: '$(play-circle) Overview', description: '2 min', detail: 'What Hoppy does: switch accounts and models, keep going when a limit hits', url: 'https://youtu.be/zhqcQeih3do' },
    { label: '$(play-circle) Full tutorial', description: '4 min', detail: 'Every feature step by step, on real screens', url: 'https://youtu.be/Sl9I1QzJ-zs' },
];

async function showVideos(): Promise<void> {
    const pick = await vscode.window.showQuickPick(VIDEOS, { title: 'Hoppy · Video guides' });
    if (pick) {
        await vscode.env.openExternal(vscode.Uri.parse(pick.url));
    }
}

async function showMore(): Promise<void> {
    const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: '$(book) Getting started guide', command: 'hoppy.guide' },
        { label: "$(star-empty) Rate Hoppy", detail: 'A rating on the Marketplace helps other Claude Code users find Hoppy', command: 'hoppy.rate' },
        { label: "$(sparkle) What's new", detail: 'Usage in the status bar, Voice to text, remove accounts and everything in this version', command: 'hoppy.whatsNew' },
        { label: '$(play-circle) Video guides', detail: 'Watch the 2-minute overview or the full tutorial', command: 'hoppy.videos' },
        { label: '$(lightbulb) Install /second-opinion skill', detail: 'Ask other models from inside a Claude chat', command: 'hoppy.installSkill' },
        { label: '$(sync) Refresh model list', command: 'hoppy.syncFreeModels' },
        { label: '$(debug-restart) Restart Other AI', detail: 'Use this if Other AI shows "stopped"', command: 'hoppy.gatewayRestart' },
        { label: '$(edit) Rename an account', command: 'hoppy.renameAccount' },
        { label: '$(trash) Remove an account', detail: 'Moves its folder to the Recycle Bin after you confirm', command: 'hoppy.removeAccount' },
        { label: '$(export) Export settings', detail: 'Model choices and account names, never keys. Share with a teammate or another PC', command: 'hoppy.exportSettings' },
        { label: '$(cloud-download) Import settings', command: 'hoppy.importSettings' },
        { label: '$(info) Show status', command: 'hoppy.status' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Hoppy · More' });
    if (pick) {
        await vscode.commands.executeCommand(pick.command);
    }
}

/** The extension was called ModelHop before; carry its user settings over to the Hoppy names once. */
async function migrateModelHopSettings(): Promise<void> {
    const oldCfg = vscode.workspace.getConfiguration('modelhop');
    const newCfg = vscode.workspace.getConfiguration('hoppy');
    const keys = ['autoStartGateway', 'syncChatsOnSwitch', 'accountLabels', 'routerConfigDir', 'claudeConfigDirs', 'fallbackModels', 'mainModel', 'smallModel'];
    for (const key of keys) {
        const old = oldCfg.inspect(key)?.globalValue;
        if (old === undefined || newCfg.inspect(key)?.globalValue !== undefined) {
            continue;
        }
        await newCfg.update(key, old, vscode.ConfigurationTarget.Global);
        try {
            await oldCfg.update(key, undefined, vscode.ConfigurationTarget.Global);
        } catch {
            // The old key is no longer registered; leaving it in settings.json is harmless.
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await migrateModelHopSettings().catch(() => undefined);
    initRating(context.globalState);
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'hoppy.menu';
    // Just right of the account item: compact "5h 5% · wk 85%"; click opens the Hoppy Usage view.
    usageItem = vscode.window.createStatusBarItem('hoppy.usage', vscode.StatusBarAlignment.Right, 99.9);
    usageItem.name = 'Hoppy Usage';
    usageItem.command = 'hoppy.usageView.focus';
    context.subscriptions.push(statusItem, usageItem);
    // Voice to text: "Voice" item next to usage; click, speak, click again.
    context.subscriptions.push(new Voice(context));

    const register = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    register('hoppy.menu', () => showMenu(context));
    register('hoppy.more', () => showMore());
    register('hoppy.videos', () => showVideos());
    register('hoppy.rate', () => vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL)));
    register('hoppy.whatsNew', () =>
        vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(context.extensionPath, 'CHANGELOG.md'))),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('hoppy.settings', (tab?: string) => SettingsPanel.show(context, tab)),
    );
    register('hoppy.guide', () =>
        vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#getStarted`, false),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hoppy.switchToDir', async (dir: string) => {
            const t = listTargets().find((x) => x.dir === dir);
            if (t && !isCurrent(t)) {
                await switchTo(context, t);
            }
        }),
    );

    register('hoppy.switch', async () => {
        const pick = await targetItems('Switch the Claude panel to…');
        if (pick && !isCurrent(pick.target)) {
            await switchTo(context, pick.target);
        }
    });

    register('hoppy.useClaude', async () => {
        const pick = await targetItems('Which Claude account?');
        if (pick) {
            await switchTo(context, pick.target);
        }
    });

    register('hoppy.useOtherAi', async () => {
        const other = listTargets().find((t) => t.kind === 'other');
        if (other) {
            await switchTo(context, other);
        }
    });

    register('hoppy.handoff', async () => {
        const chat = await pickChat('Which chat do you want to continue?');
        if (!chat) {
            return;
        }
        const dest = await targetItems('Continue it on…', chat.source);
        if (!dest) {
            return;
        }
        await continueChatOn(context, chat, dest.target);
    });

    register('hoppy.exportSettings', () => exportSettings(context));
    register('hoppy.importSettings', () => importSettings(context));

    register('hoppy.pinProject', async () => {
        const t = currentTarget();
        await pinProject(t);
        await refreshStatus();
        vscode.window.showInformationMessage(`This project now always uses ${describe(t)}. When you come back to this window, Hoppy switches to it for you.`);
    });

    register('hoppy.unpinProject', async () => {
        await unpinProject();
        await refreshStatus();
        await openFreshClaudeTab(`This project follows your global choice again: ${describe(currentTarget())}.`);
    });

    register('hoppy.flip', async () => {
        const prev = context.globalState.get<string>('hoppy.previousDir');
        const t = prev ? listTargets().find((x) => sameDir(x.dir, prev)) : undefined;
        if (!t) {
            vscode.window.showInformationMessage('Nothing to switch back to yet. Switch once from the Hoppy menu, then Ctrl+Alt+H flips between the last two.');
            return;
        }
        if (isCurrent(t)) {
            vscode.window.showInformationMessage(`Already on ${describe(t)}. Ctrl+Alt+H flips after your next switch.`);
            return;
        }
        await switchTo(context, t);
    });

    register('hoppy.addAccount', async () => {
        const label = await vscode.window.showInputBox({
            title: 'Add Claude account',
            prompt: 'A short name for this account, e.g. Work or Personal',
            ignoreFocusOut: true,
        });
        if (!label) {
            return;
        }
        const dir = createAccountDir();
        const t: Target = { kind: 'claude', dir, label, loggedIn: false };
        await setLabel(t, label);
        radar?.start(claudeConfigDirs());
        await switchTo(context, t, `Created account "${label}".`);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('hoppy.renameAccount', async (dir?: string) => {
            const target = dir ? listTargets().find((x) => x.dir === dir) : (await targetItems('Rename which account?'))?.target;
            if (!target || target.kind !== 'claude') {
                return;
            }
            const label = await vscode.window.showInputBox({ title: 'New name', value: target.label, ignoreFocusOut: true });
            if (label) {
                await setLabel(target, label);
                await refreshStatus();
                SettingsPanel.refresh();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hoppy.removeAccount', async (dir?: string) => {
            const removable = (x: Target) => x.kind === 'claude' && isRemovable(x.dir, os.homedir(), routerDir());
            let target = dir ? listTargets().find((x) => sameDir(x.dir, dir)) : undefined;
            if (!dir) {
                const items = listTargets()
                    .filter(removable)
                    .map((x) => ({ label: `$(sparkle) ${x.label}`, description: x.email || x.dir, target: x }));
                if (!items.length) {
                    vscode.window.showInformationMessage('No extra Claude accounts to remove. Main (~/.claude) is Claude Code\'s default and stays.');
                    return;
                }
                target = (await vscode.window.showQuickPick(items, { title: 'Remove which Claude account?' }))?.target;
            }
            if (!target) {
                return;
            }
            if (!removable(target)) {
                vscode.window.showWarningMessage(`${target.label} can't be removed: it is Claude Code's default account (~/.claude).`);
                return;
            }
            const sum = folderSummary(target.dir);
            const current = isCurrent(target);
            const pick = await vscode.window.showWarningMessage(
                `Remove the Claude account "${target.label}"${target.email ? ` (${target.email})` : ''}?`,
                {
                    modal: true,
                    detail: [
                        'This moves its folder to the Recycle Bin:',
                        target.dir,
                        `${sizeLabel(sum.bytes)}${sum.capped ? '+' : ''} · ${sum.chats}${sum.capped ? '+' : ''} chat file(s) · its login`,
                        '',
                        'Hoppy also forgets its name, color, project pins and usage numbers.',
                        current ? 'It is in use now, so the Claude panel switches to Main first.' : '',
                        'Close Claude tabs that use this account first. You can restore the folder from the Recycle Bin.',
                    ]
                        .filter((l, i, a) => l || a[i - 1])
                        .join('\n'),
                },
                'Move to Recycle Bin',
            );
            if (pick !== 'Move to Recycle Bin') {
                return;
            }
            if (current) {
                const main = listTargets().find((x) => x.kind === 'claude' && sameDir(x.dir, path.join(os.homedir(), '.claude')));
                if (main) {
                    await pointPanelAt(context, main);
                }
            }
            // Hoppy's own folder watcher holds the folder open; Windows will not delete it while watched.
            radar?.start(claudeConfigDirs().filter((d) => !sameDir(d, target!.dir)));
            try {
                await vscode.workspace.fs.delete(vscode.Uri.file(target.dir), { recursive: true, useTrash: true });
            } catch (err) {
                log(`remove account: could not delete ${target.dir}: ${String(err)}`);
                vscode.window.showErrorMessage(
                    `Could not move ${target.dir} to the Recycle Bin (${err instanceof Error ? err.message : err}). A Claude tab may still be using it: close it and try again.`,
                );
                radar?.start(claudeConfigDirs());
                await refreshStatus();
                return;
            }
            // Forget everything Hoppy stored for this folder.
            const cfg = vscode.workspace.getConfiguration('hoppy');
            const G = vscode.ConfigurationTarget.Global;
            await cfg.update('accountLabels', withoutDir(cfg.get<Record<string, string>>('accountLabels') || {}, target.dir), G);
            await cfg.update('accountColors', withoutDir(cfg.get<Record<string, string>>('accountColors') || {}, target.dir), G);
            await cfg.update('projectAccounts', withoutDir(cfg.get<Record<string, string>>('projectAccounts') || {}, target.dir, true), G);
            const extra = (cfg.get<string[]>('claudeConfigDirs') || []).filter((d) => !sameDir(expandHome(d), target!.dir));
            await cfg.update('claudeConfigDirs', extra.length ? extra : undefined, G);
            await saveCaps(context.globalState, withoutDir(loadCaps(context.globalState), target.dir));
            await context.globalState.update('hoppy.limits', withoutDir(context.globalState.get<Record<string, LimitHit>>('hoppy.limits') || {}, target.dir));
            if (sameDir(context.globalState.get<string>('hoppy.previousDir') || '', target.dir)) {
                await context.globalState.update('hoppy.previousDir', undefined);
            }
            radar?.start(claudeConfigDirs());
            log(`remove account: moved ${target.dir} to the Recycle Bin`);
            await refreshStatus();
            SettingsPanel.refresh();
            vscode.window.showInformationMessage(`Removed "${target.label}". Its folder is in the Recycle Bin if you need it back.`);
        }),
    );

    register('hoppy.setup', async () => {
        const switchNow = await runSetup(context);
        if (switchNow) {
            await vscode.commands.executeCommand('hoppy.useOtherAi');
        }
        await refreshStatus();
    });

    register('hoppy.syncFreeModels', () =>
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refreshing model list…' }, async () => {
            const freeModels = await fetchFreeModels();
            const result = await applyToCcr(context, { freeModels });
            vscode.window.showInformationMessage(`Model list updated (${freeModels.length} free OpenRouter models, plus any paid ones you turned on). ${result.lines.slice(-1)[0]}`);
            await refreshStatus();
        }),
    );

    register('hoppy.gatewayRestart', () =>
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting Other AI…' }, async () => {
            await stopGateway();
            const ok = await startGateway();
            vscode.window[ok ? 'showInformationMessage' : 'showErrorMessage'](ok ? 'Other AI is ready.' : 'Other AI did not start. Open Settings → AI Providers and run setup again.');
            await refreshStatus();
        }),
    );

    register('hoppy.installSkill', () => {
        const dirs = installSkill(context);
        vscode.window.showInformationMessage(`Installed /second-opinion in ${dirs.length} Claude account(s). Start a new chat and say "ask nemotron to review this".`);
    });

    register('hoppy.status', async () => {
        const status = await ccrStatus(context.extensionPath);
        const lines = [
            `Now: ${describe(currentTarget())}`,
            '',
            'Claude accounts:',
            ...listTargets().filter((t) => t.kind === 'claude').map((t) => `  ${isCurrent(t) ? '▶' : ' '} ${t.label}: ${t.email ?? (t.loggedIn ? 'logged in' : 'not logged in')}  (${t.dir})`),
            '',
            `Other AI: ${(await isGatewayUp()) ? 'ready' : 'stopped'}`,
            ...(status.providers || []).map((p) => `  ${p.hasKey ? '✔' : '✖'} ${p.name}: ${p.models.length} models`),
            `Fallback: ${status.fallback?.mode === 'model-chain' ? status.fallback.models.join(' → ') : 'off'}`,
        ];
        vscode.window.showInformationMessage('Hoppy status', { modal: true, detail: lines.join('\n') });
    });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeCode.environmentVariables') || e.affectsConfiguration('hoppy')) {
                refreshStatus();
            }
            if (e.affectsConfiguration('hoppy.claudeConfigDirs') || e.affectsConfiguration('hoppy.routerConfigDir')) {
                radar?.start(claudeConfigDirs());
            }
        }),
    );

    globalState = context.globalState;
    // Quota results in View > Output > Hoppy, only when they change per account.
    const lastQuotaLine = new Map<string, string>();
    setQuotaLog((line) => {
        const who = line.split(':')[0];
        if (lastQuotaLine.get(who) !== line) {
            lastQuotaLine.set(who, line);
            log(line);
        }
    });
    usageView = new UsageViewProvider(async () => renderCards(buildCards(usageRows(), lastQuota)));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(UsageViewProvider.id, usageView));
    register('hoppy.refreshUsage', async () => {
        refreshAllUsage(0);
        lastQuota = await openRouterQuota(context.extensionPath, 0);
        for (const t of listTargets().filter((x) => x.kind === 'claude' && x.loggedIn)) {
            await fetchQuota(t.dir, true);
        }
        await refreshStatus();
    });
    radar = new LimitRadar(context.globalState);
    SettingsPanel.limitLabel = (dir) => {
        const hit = radar?.limitFor(dir);
        return hit && resetLabel(hit);
    };
    context.subscriptions.push(
        radar,
        radar.onHit((hit) => learnCapFromHit(hit).catch(() => undefined).then(() => onLimitHit(context, hit))),
        radar.onDidChange(() => {
            // Remember every account seen at its limit, so its reset can be announced later.
            for (const t of listTargets().filter((x) => limitOf(x))) {
                limitedBefore.add(t.dir.toLowerCase());
            }
            refreshStatus();
            SettingsPanel.refresh();
        }),
    );
    radar.start(claudeConfigDirs());
    // A limit window ending changes the menu and status bar without any file event.
    limitedBefore = new Set(listTargets().filter((t) => limitOf(t)).map((t) => t.dir.toLowerCase()));
    const tick = setInterval(() => {
        refreshStatus();
        void checkLimitsEnded(context);
    }, 60000);
    context.subscriptions.push({ dispose: () => clearInterval(tick) });

    // Usage numbers: the first scan reads up to 7 days of chats, so it waits until VS Code has settled.
    initUsage(context.globalStorageUri.fsPath);
    // One account per step, with a pause between, so a big first scan never freezes VS Code for long.
    const updateUsage = (maxAgeMs: number) => {
        const step = () => {
            if (refreshAllUsage(maxAgeMs, 1)) {
                if (!usageLogged) {
                    usageLogged = true;
                    log(`usage ready: ${usageRows().map((r) => `${r.label}${r.current ? ' (in use)' : ''} 5h ${r.h5 === undefined ? '-' : formatTokens(r.h5)}`).join(', ')}`);
                }
                void raisePassedCaps().then(() => refreshStatus());
                SettingsPanel.refresh();
                setTimeout(step, 1500);
            }
        };
        step();
    };
    // Cached 5 minutes inside, so this is at most one small request per 5 minutes.
    const updateQuota = async () => {
        lastQuota = await openRouterQuota(context.extensionPath);
    };
    const firstScan = setTimeout(() => (updateUsage(60000), void updateQuota().then(() => refreshStatus())), 8000);
    // Every minute: the status bar shows live numbers while you work. After the first scan only new lines are read.
    const usageTick = setInterval(() => (updateUsage(55000), void updateQuota(), void updateClaudeQuotas().then(() => refreshStatus())), 60000);
    setTimeout(() => void updateClaudeQuotas().then(() => refreshStatus()), 3000);
    context.subscriptions.push({ dispose: () => (clearTimeout(firstScan), clearInterval(usageTick)) });

    // A pinned project opens on its account, and wins again whenever its window gets focus.
    const followPin = async () => {
        const before = currentDir();
        const t = await applyProjectPin();
        if (t) {
            await context.globalState.update('hoppy.previousDir', before);
            await refreshStatus();
            SettingsPanel.refresh();
            // Claude Code has one global account setting, so say it out loud when a pin changes it.
            vscode.window.setStatusBarMessage(`$(pinned) Hoppy: this project uses ${describe(t)}; new Claude tabs open on it`, 6000);
        }
    };
    await followPin();
    context.subscriptions.push(vscode.window.onDidChangeWindowState((w) => w.focused && followPin()));

    await refreshStatus();

    const version = String(context.extension.packageJSON.version || '');
    const seenVersion = context.globalState.get<string>('hoppy.lastVersion');
    await context.globalState.update('hoppy.lastVersion', version);
    if (!context.globalState.get<boolean>('hoppy.welcomed')) {
        await context.globalState.update('hoppy.welcomed', true);
        vscode.commands.executeCommand('hoppy.guide');
    } else if (isNewerMinor(version, seenVersion)) {
        // Once per feature release (not for fixes): a short note with a link to the full list.
        void vscode.window
            .showInformationMessage(`Hoppy ${version}: Claude usage in the status bar, Voice to text (Bangla too), remove accounts and more.`, "What's new", 'Try Voice')
            .then((pick) => pick && vscode.commands.executeCommand(pick === 'Try Voice' ? 'hoppy.voiceToggle' : 'hoppy.whatsNew'));
    }

    const ccrReady = (await isCcrInstalled()) && (await ccrStatus(context.extensionPath)).exists;
    const status = ccrReady ? await ccrStatus(context.extensionPath) : undefined;
    // Lets the guide tick "Connect other AI models" once a key exists.
    vscode.commands.executeCommand('setContext', 'hoppy.hasProvider', !!status?.providers?.some((p) => p.hasKey));

    if (ccrReady && vscode.workspace.getConfiguration('hoppy').get<boolean>('autoStartGateway')) {
        await startGateway();
        await refreshStatus();
    }
}

/** True when `now` is a newer major or minor release than `before` (patch releases stay quiet). */
export function isNewerMinor(now: string, before: string | undefined): boolean {
    if (!before) {
        return false;
    }
    const [a, b] = [now, before].map((v) => v.split('.').map((n) => parseInt(n, 10) || 0));
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

export function deactivate(): void {
    // The gateway keeps running for other windows; nothing to clean up.
}
