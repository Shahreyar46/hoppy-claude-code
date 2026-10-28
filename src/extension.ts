import * as vscode from 'vscode';
import { copyChat, pickChat, syncChatsInto } from './chats';
import { ccrStatus, isCcrInstalled, isGatewayUp, startGateway, stopGateway } from './gateway';
import { applyToCcr, fetchFreeModels, runSetup } from './setup';
import { SettingsPanel } from './settings';
import { installSkill } from './skill';
import { createAccountDir, currentTarget, describe, isCurrent, listTargets, setLabel, setTarget, Target } from './targets';

let statusItem: vscode.StatusBarItem;

async function refreshStatus(): Promise<void> {
    const t = currentTarget();
    const gatewayUp = await isGatewayUp();
    const up = t.kind === 'other' ? gatewayUp : true;
    statusItem.text = t.kind === 'claude' ? `$(sparkle) Claude · ${t.label}` : up ? '$(globe) Other AI' : '$(warning) Other AI (stopped)';
    statusItem.backgroundColor = up ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');

    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = { enabledCommands: ['hoppy.settings', 'hoppy.handoff', 'hoppy.gatewayRestart'] };
    tip.appendMarkdown('**Hoppy** · the Claude panel uses:\n\n');
    for (const x of listTargets()) {
        const icon = x.kind === 'other' ? '$(globe)' : '$(sparkle)';
        const detail = x.kind === 'other' ? (gatewayUp ? 'ready' : 'stopped') : x.email ?? (x.loggedIn ? '' : 'needs login');
        tip.appendMarkdown(`${isCurrent(x) ? '**▶**' : '　'} ${icon} ${isCurrent(x) ? `**${describe(x)}**` : describe(x)} ${detail ? `· ${detail}` : ''}\n\n`);
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
async function openFreshClaudeTab(message: string): Promise<void> {
    let opened = true;
    try {
        await vscode.commands.executeCommand('claude-vscode.editor.open');
    } catch {
        opened = false;
    }
    const choice = await vscode.window.showInformationMessage(
        opened ? `${message} A new Claude tab is open on it; tabs that were already open stay as they were.` : `${message} Reload to apply.`,
        'Reload all tabs',
    );
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
    await setTarget(t);
    await refreshStatus();
    SettingsPanel.refresh();
    const login = t.kind === 'claude' && !t.loggedIn ? ' Log in there to finish adding it.' : '';
    const chats = synced ? ` ${synced} chat(s) from your other accounts are in /resume.` : '';
    await openFreshClaudeTab(`${note || `Now on ${describe(t)}.`}${chats}${login}`);
}

function targetItems(title: string, exclude?: Target) {
    return vscode.window.showQuickPick(
        listTargets()
            .filter((t) => !exclude || t.dir !== exclude.dir)
            .map((t) => ({
                label: `${t.kind === 'other' ? '$(globe)' : '$(sparkle)'} ${describe(t)}${isCurrent(t) ? '  (current)' : ''}`,
                description: t.kind === 'claude' ? (t.email ?? (t.loggedIn ? '' : 'not logged in yet')) : 'models from your API keys',
                target: t,
            })),
        { title },
    );
}

/**
 * Status bar click. The most common job, switching, is one pick: targets come first.
 * Everything else sits below a separator; rarely used tools live in "More".
 */
async function showMenu(context: vscode.ExtensionContext): Promise<void> {
    type Item = vscode.QuickPickItem & { target?: Target; command?: string };
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [
        sep('Use in the Claude panel'),
        ...listTargets().map<Item>((t) => ({
            label: `${t.kind === 'other' ? '$(globe)' : '$(sparkle)'} ${describe(t)}`,
            description: isCurrent(t) ? '$(check) in use' : t.kind === 'claude' ? (t.email ?? (t.loggedIn ? '' : 'needs login')) : 'models from your API keys',
            target: t,
        })),
        sep('Actions'),
        { label: '$(history) Continue a chat on another account or model…', command: 'hoppy.handoff' },
        { label: '$(add) Add Claude account', command: 'hoppy.addAccount' },
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
        if (dest.target.kind === 'other' && !(await prepareOtherAi(context))) {
            return;
        }
        copyChat(chat, dest.target);
        if (!isCurrent(dest.target)) {
            await setTarget(dest.target);
            await refreshStatus();
            SettingsPanel.refresh();
        }
        await openFreshClaudeTab(`Chat copied to ${describe(dest.target)}. Type /resume in the new tab and pick "${chat.preview.slice(0, 40)}".`);
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
        }),
    );

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
