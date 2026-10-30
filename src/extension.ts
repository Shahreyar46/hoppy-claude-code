import * as vscode from 'vscode';
import { belongsToOpenProject, Chat, chatFromFile, chatTokens, forkChat, pickChat, summarizeChat, syncChatsInto } from './chats';
import { ccrStatus, isCcrInstalled, isGatewayUp, startGateway, stopGateway } from './gateway';
import { LimitHit, LimitRadar, resetLabel } from './limits';
import { log } from './log';
import { claudeConfigDirs } from './paths';
import { applyToCcr, fetchFreeModels, runSetup } from './setup';
import { exportSettings, importSettings } from './portable';
import { modelContext, SettingsPanel } from './settings';
import { installSkill } from './skill';
import { colorFor, createAccountDir, currentDir, currentTarget, describe, isCurrent, applyProjectPin, isProjectPinned, listTargets, pinProject, sameDir, setLabel, setTarget, Target, unpinProject } from './targets';
import { cachedUsage, formatTokens, initUsage, refreshUsage, usageLine } from './usage';

let statusItem: vscode.StatusBarItem;
let radar: LimitRadar | undefined;

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

async function refreshStatus(): Promise<void> {
    const t = currentTarget();
    const gatewayUp = await isGatewayUp();
    const up = t.kind === 'other' ? gatewayUp : true;
    const limited = !!limitOf(t);
    statusItem.text = t.kind === 'claude' ? `$(sparkle) Claude · ${t.label}${limited ? ' $(watch)' : ''}` : up ? '$(globe) Other AI' : '$(warning) Other AI (stopped)';
    statusItem.backgroundColor = up && !limited ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    // A warning background already carries its own foreground; a custom color would fight it.
    statusItem.color = t.kind === 'claude' && !limited ? colorFor(t.dir) : undefined;

    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = { enabledCommands: ['hoppy.settings', 'hoppy.handoff', 'hoppy.gatewayRestart'] };
    tip.appendMarkdown('**Hoppy** · the Claude panel uses:\n\n');
    for (const x of listTargets()) {
        const icon = x.kind === 'other' ? '$(globe)' : '$(sparkle)';
        const limit = limitOf(x);
        const detail = x.kind === 'other' ? (gatewayUp ? 'ready' : 'stopped') : limit ? `$(watch) ${resetLabel(limit)}` : x.email ?? (x.loggedIn ? '' : 'needs login');
        const used = usageDetail(x);
        tip.appendMarkdown(`${isCurrent(x) ? '**▶**' : '　'} ${icon} ${isCurrent(x) ? `**${describe(x)}**` : describe(x)} ${detail ? `· ${detail}` : ''}${used ? `  \n　　${used}` : ''}\n\n`);
    }
    if (isProjectPinned()) {
        tip.appendMarkdown('$(pinned) This project always uses this choice\n\n');
    }
    tip.appendMarkdown('---\n\nClick to switch · [Continue a chat](command:hoppy.handoff) · [Settings](command:hoppy.settings)');
    if (t.kind === 'other' && !up) {
        tip.appendMarkdown(' · [Restart Other AI](command:hoppy.gatewayRestart)');
    }
    statusItem.tooltip = tip;
    statusItem.show();
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

async function showMore(): Promise<void> {
    const items: (vscode.QuickPickItem & { command: string })[] = [
        { label: '$(book) Getting started guide', command: 'hoppy.guide' },
        { label: '$(lightbulb) Install /second-opinion skill', detail: 'Ask other models from inside a Claude chat', command: 'hoppy.installSkill' },
        { label: '$(sync) Refresh model list', command: 'hoppy.syncFreeModels' },
        { label: '$(debug-restart) Restart Other AI', detail: 'Use this if Other AI shows "stopped"', command: 'hoppy.gatewayRestart' },
        { label: '$(edit) Rename an account', command: 'hoppy.renameAccount' },
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
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'hoppy.menu';
    context.subscriptions.push(statusItem);

    const register = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    register('hoppy.menu', () => showMenu(context));
    register('hoppy.more', () => showMore());
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

    radar = new LimitRadar(context.globalState);
    SettingsPanel.limitLabel = (dir) => {
        const hit = radar?.limitFor(dir);
        return hit && resetLabel(hit);
    };
    context.subscriptions.push(
        radar,
        radar.onHit((hit) => onLimitHit(context, hit)),
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
                refreshStatus();
                SettingsPanel.refresh();
                setTimeout(step, 1500);
            }
        };
        step();
    };
    const firstScan = setTimeout(() => updateUsage(60000), 8000);
    const usageTick = setInterval(() => updateUsage(4 * 60000), 5 * 60000);
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

    if (!context.globalState.get<boolean>('hoppy.welcomed')) {
        await context.globalState.update('hoppy.welcomed', true);
        vscode.commands.executeCommand('hoppy.guide');
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

export function deactivate(): void {
    // The gateway keeps running for other windows; nothing to clean up.
}
