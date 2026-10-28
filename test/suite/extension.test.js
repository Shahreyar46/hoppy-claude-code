// Integration tests inside a real VS Code. Read-only against the real ccr config and chat folders:
// nothing here restarts the gateway, saves keys, or copies chats.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const out = path.resolve(__dirname, '..', '..', 'out');
const targets = require(path.join(out, 'targets.js'));
const chats = require(path.join(out, 'chats.js'));
const gateway = require(path.join(out, 'gateway.js'));
const { SettingsPanel } = require(path.join(out, 'settings.js'));

const ext = () => vscode.extensions.all.find((e) => e.id.toLowerCase().endsWith('.hoppy-claude-code'));
const envSetting = () => vscode.workspace.getConfiguration('claudeCode').get('environmentVariables') || [];
const configDirVar = () => envSetting().find((e) => e.name === 'CLAUDE_CONFIG_DIR')?.value;

suite('Hoppy', () => {
    suiteSetup(async () => {
        await vscode.workspace.getConfiguration('hoppy').update('syncChatsOnSwitch', false, vscode.ConfigurationTarget.Global);
        await ext().activate();
    });

    test('activates and registers every command', async () => {
        assert.ok(ext().isActive, 'extension active');
        const all = await vscode.commands.getCommands(true);
        for (const id of ['menu', 'more', 'settings', 'guide', 'switch', 'switchToDir', 'useClaude', 'useOtherAi', 'handoff', 'addAccount', 'renameAccount', 'setup', 'syncFreeModels', 'gatewayRestart', 'installSkill', 'status']) {
            assert.ok(all.includes(`hoppy.${id}`), `missing command hoppy.${id}`);
        }
    });

    test('finds Claude accounts and the Other AI target', () => {
        const list = targets.listTargets();
        const claude = list.filter((t) => t.kind === 'claude');
        console.log('    targets:', list.map((t) => `${t.kind}:${t.label}${t.email ? ` <${t.email}>` : ''} loggedIn=${t.loggedIn}`).join(' | '));
        assert.ok(claude.some((t) => t.dir.toLowerCase().endsWith('\\.claude')), '~/.claude found');
        assert.ok(claude.some((t) => /\.claude-account2$/i.test(t.dir)), '~/.claude-account2 found');
        assert.strictEqual(list.filter((t) => t.kind === 'other').length, 1, 'one Other AI target');
        assert.ok(!claude.some((t) => /\.claude-router$/i.test(t.dir)), 'router folder is not listed as a Claude account');
    });

    test('switching sets CLAUDE_CONFIG_DIR for the Claude panel', async () => {
        const list = targets.listTargets();
        const acct2 = list.find((t) => /\.claude-account2$/i.test(t.dir));
        const other = list.find((t) => t.kind === 'other');
        const main = list.find((t) => t.dir.toLowerCase().endsWith('\\.claude'));

        await targets.setTarget(other);
        assert.strictEqual(configDirVar(), other.dir);
        assert.strictEqual(targets.currentTarget().kind, 'other');

        await targets.setTarget(acct2);
        assert.strictEqual(configDirVar(), acct2.dir);
        assert.strictEqual(targets.currentTarget().dir, acct2.dir);

        await targets.setTarget(main);
        const inherited = process.env.CLAUDE_CONFIG_DIR;
        if (inherited && path.normalize(inherited).toLowerCase() !== main.dir.toLowerCase()) {
            assert.strictEqual(configDirVar(), main.dir, 'main set explicitly because VS Code inherited another account');
        } else {
            assert.strictEqual(configDirVar(), undefined, 'main uses Claude Code default (variable removed)');
        }
        assert.strictEqual(targets.currentTarget().dir.toLowerCase(), main.dir.toLowerCase());
    });

    test('other environment variables are kept when switching', async () => {
        const cfg = vscode.workspace.getConfiguration('claudeCode');
        await cfg.update('environmentVariables', [{ name: 'KEEP_ME', value: '1' }], vscode.ConfigurationTarget.Global);
        await targets.setTarget(targets.listTargets().find((t) => t.kind === 'other'));
        assert.ok(envSetting().some((e) => e.name === 'KEEP_ME'), 'KEEP_ME survived');
        await cfg.update('environmentVariables', [], vscode.ConfigurationTarget.Global);
    });

    test('reads the live ccr config through the helper (read-only)', async () => {
        const status = await gateway.ccrStatus(ext().extensionPath);
        console.log('    providers:', (status.providers || []).map((p) => `${p.name}(${p.models.length}, key ••••${p.keyHint})`).join(', '));
        assert.ok(status.exists, 'ccr config exists');
        assert.ok(status.providers.length > 0, 'has providers');
        assert.ok(!status.providers.some((p) => p.name === 'anthropic'), 'no Anthropic provider');
        assert.ok(status.providers.every((p) => !p.hasKey || (p.keyHint && p.keyHint.length === 4)), 'only 4-char key hints exposed');
        assert.strictEqual(status.codexEnabled, false, 'Codex takeover off');
        assert.strictEqual(status.fallback.mode, 'model-chain');
    });

    test('lists chats of the open project across accounts (read-only)', () => {
        const list = chats.findChats();
        const sources = [...new Set(list.map((c) => c.source.label))];
        console.log(`    chats: ${list.length} from [${sources.join(', ')}]; newest: "${list[0]?.preview}"`);
        assert.ok(list.length > 0, 'found chats for this workspace');
        assert.ok(list.every((c, i) => i === 0 || list[i - 1].modified >= c.modified), 'newest first');
    });

    test('settings page opens and builds its state from live data', async () => {
        await vscode.commands.executeCommand('hoppy.settings');
        let labels = [];
        for (let i = 0; i < 30; i++) {
            labels = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
            if (labels.includes('Hoppy Settings')) {
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(labels.includes('Hoppy Settings'), `Settings tab is open (open tabs: ${JSON.stringify(labels)})`);

        const panel = SettingsPanel.current;
        assert.ok(panel, 'panel instance exists');
        const sent = [];
        panel.post = (m) => sent.push(m);
        await panel.sendState();
        const state = sent.find((m) => m.type === 'state');
        assert.ok(state, 'state sent to page');
        console.log(`    page state: ${state.targets.length} targets, ${state.providers.filter((p) => p.enabled).length} providers on, ${state.catalog.length} models in catalog, fallback ${state.fallback.length}`);
        assert.strictEqual(state.providers.length, 4, 'four providers shown');
        assert.ok(state.catalog.length > 10, 'catalog loaded');
        assert.ok(state.catalog.every((m) => !m.selector.startsWith('openrouter/') || m.selector.split('/').length >= 3), 'selectors well formed');
        assert.ok(!JSON.stringify(state).match(/sk-or-v1-[A-Za-z0-9]{20}|AIza[A-Za-z0-9_-]{20}/), 'no full API key reaches the page');
    });

    test('a key with the wrong format is rejected before any network call', async () => {
        const panel = SettingsPanel.current;
        const sent = [];
        panel.post = (m) => sent.push(m);
        await panel.onMessage({ type: 'saveKey', provider: 'gemini', key: 'not-a-gemini-key' });
        const result = sent.find((m) => m.type === 'keyResult');
        assert.ok(result && result.ok === false && /AIza/.test(result.message), `rejected: ${result && result.message}`);
    });

    test('Claude Code can open a fresh tab, so switching needs no window reload', async () => {
        const all = await vscode.commands.getCommands(true);
        assert.ok(all.includes('claude-vscode.editor.open'), 'Claude Code command claude-vscode.editor.open exists');
    });

    test('end to end: after a switch, a new Claude tab runs on that account (no reload)', async function () {
        this.timeout(120000);
        const { execSync } = require('child_process');
        const claudePids = () => execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', { encoding: 'utf8' })
            .split('\n').filter((l) => l.includes('claude.exe')).map((l) => l.split('","')[1]);
        // Newest change time inside a config folder (skips big chat/plugin trees).
        const touchedSince = (dir, t0) => {
            let newest = 0;
            const walk = (d, depth) => {
                for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
                    const p = path.join(d, n);
                    const st = fs.statSync(p);
                    newest = Math.max(newest, st.mtimeMs);
                    if (st.isDirectory() && depth < 2 && n !== 'projects' && n !== 'plugins') walk(p, depth + 1);
                }
            };
            walk(dir, 0);
            return newest > t0;
        };
        const list = targets.listTargets();
        const main = list.find((x) => x.dir.toLowerCase().endsWith('\\.claude'));
        const other = list.find((x) => x.kind === 'other');

        for (const [to, notTo] of [[other, main], [main, other]]) {
            await targets.setTarget(to);
            const before = new Set(claudePids());
            const t0 = Date.now();
            await vscode.commands.executeCommand('claude-vscode.editor.open');
            let started = [];
            for (let i = 0; i < 40 && !(started.length && touchedSince(to.dir, t0)); i++) {
                await new Promise((r) => setTimeout(r, 500));
                started = claudePids().filter((p) => !before.has(p));
            }
            await new Promise((r) => setTimeout(r, 2000));
            console.log(`    switched to ${targets.describe(to)}: new Claude process ${JSON.stringify(started)}, wrote to ${to.dir}: ${touchedSince(to.dir, t0)}, wrote to ${notTo.dir}: ${touchedSince(notTo.dir, t0)}`);
            assert.ok(started.length > 0, 'a Claude process started for the new tab');
            assert.ok(touchedSince(to.dir, t0), `new tab used ${to.dir}`);
            assert.ok(!touchedSince(notTo.dir, t0), `new tab did not use ${notTo.dir}`);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await new Promise((r) => setTimeout(r, 1500));
        }
    });

    test('getting started guide is registered and every step has its page', () => {
        const pkg = ext().packageJSON;
        const walk = pkg.contributes.walkthroughs.find((w) => w.id === 'getStarted');
        assert.ok(walk, 'walkthrough getStarted exists');
        assert.strictEqual(walk.steps.length, 5);
        for (const step of walk.steps) {
            const file = step.media.svg || step.media.markdown || step.media.image;
            assert.ok(fs.existsSync(path.join(ext().extensionPath, file)), `missing ${file}`);
            if (step.media.svg || step.media.image) assert.ok(step.media.altText, `${step.id} image has alt text`);
            assert.ok(step.completionEvents.length > 0, `${step.id} can be completed`);
        }
    });

    test('guide command opens without error', async () => {
        await vscode.commands.executeCommand('hoppy.guide');
    });

    test('settings can open straight on a tab (used by the guide buttons)', async () => {
        await vscode.commands.executeCommand('hoppy.settings', 'models');
        const panel = SettingsPanel.current;
        const sent = [];
        panel.post = (m) => sent.push(m);
        await panel.sendState();
        assert.strictEqual(sent.find((m) => m.type === 'state').initialTab, 'models');
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});
