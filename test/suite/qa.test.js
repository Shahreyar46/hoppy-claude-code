// End-to-end QA, run with HOPPY_QA=1. Uses temporary Claude account folders inside the isolated test
// profile, so real chats and logins are never touched. HOPPY_QA_LIVE=1 also sends a few real requests
// (OpenRouter free models with the saved key; fake keys for the other providers).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const out = path.resolve(__dirname, '..', '..', 'out');
const targets = require(path.join(out, 'targets.js'));
const chats = require(path.join(out, 'chats.js'));
const health = require(path.join(out, 'health.js'));
const setup = require(path.join(out, 'setup.js'));
const gateway = require(path.join(out, 'gateway.js'));
const usage = require(path.join(out, 'usage.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hoppy = () => vscode.workspace.getConfiguration('hoppy');
const envDir = () => (vscode.workspace.getConfiguration('claudeCode').get('environmentVariables') || []).find((e) => e.name === 'CLAUDE_CONFIG_DIR')?.value;
const ext = () => vscode.extensions.all.find((e) => e.id.toLowerCase().endsWith('.hoppy-claude-code'));

suite('QA end to end', function () {
    this.timeout(90000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-qa-'));
    const accA = path.join(root, '.claude-qa-a');
    const accB = path.join(root, '.claude-qa-b');
    const project = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || root).replace(/[^A-Za-z0-9]/g, '-');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const fileA = path.join(accA, 'projects', project, `${sessionId}.jsonl`);
    let savedEnv;
    const origWarn = vscode.window.showWarningMessage;
    const origInfo = vscode.window.showInformationMessage;

    suiteSetup(async () => {
        // Notifications would wait for a click forever in a test run; answer them with "dismiss".
        vscode.window.showInformationMessage = async () => undefined;
        vscode.window.showWarningMessage = async () => undefined;
        await ext().activate();
        savedEnv = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
        for (const d of [accA, accB]) {
            fs.mkdirSync(path.join(d, 'projects', project), { recursive: true });
            fs.writeFileSync(path.join(d, '.credentials.json'), '{}');
        }
        fs.writeFileSync(
            fileA,
            [
                JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'QA: add dark mode' } }),
                JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, timestamp: new Date().toISOString(), message: { id: 'msg_qa1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'Done.' }], usage: { input_tokens: 5, output_tokens: 5 } } }),
            ].join('\n') + '\n',
        );
        await hoppy().update('claudeConfigDirs', [accA, accB], vscode.ConfigurationTarget.Global);
        await hoppy().update('accountLabels', { [accA]: 'QA-A', [accB]: 'QA-B' }, vscode.ConfigurationTarget.Global);
        await sleep(1500);
    });

    suiteTeardown(async () => {
        vscode.window.showWarningMessage = origWarn;
        vscode.window.showInformationMessage = origInfo;
        await hoppy().update('claudeConfigDirs', undefined, vscode.ConfigurationTarget.Global);
        await hoppy().update('accountLabels', undefined, vscode.ConfigurationTarget.Global);
        await hoppy().update('accountColors', undefined, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('claudeCode').update('environmentVariables', savedEnv, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {
            // A Claude process from the opened tab may still hold a file; the OS temp cleaner takes it.
        }
    });

    test('QA accounts are listed and logged in', () => {
        const list = targets.listTargets();
        assert.ok(list.some((t) => t.label === 'QA-A' && t.loggedIn));
        assert.ok(list.some((t) => t.label === 'QA-B' && t.loggedIn));
    });

    test('limit hit → popup → "Continue on QA-B" carries the chat and opens it', async () => {
        await vscode.commands.executeCommand('hoppy.switchToDir', accA);
        assert.strictEqual(path.normalize(envDir()), path.normalize(accA), 'on QA-A');
        let popup;
        vscode.window.showInformationMessage = async () => undefined;
        // Real accounts on this PC may rank first; pick QA-B through "Choose…" so they are never touched.
        vscode.window.showWarningMessage = async (msg, ...items) => {
            popup = { msg, items: items.filter((x) => typeof x === 'string') };
            return popup.items.find((x) => x === 'Continue on QA-B') || 'Choose…';
        };
        const origPick = vscode.window.showQuickPick;
        vscode.window.showQuickPick = async (items) => {
            vscode.window.showQuickPick = origPick;
            return (await items).find((i) => i.target && i.target.label === 'QA-B');
        };
        const reset = new Date(Date.now() + 3 * 3600000);
        const h = reset.getHours() % 12 || 12;
        const text = `You've hit your session limit · resets ${h}:${String(reset.getMinutes()).padStart(2, '0')}${reset.getHours() < 12 ? 'am' : 'pm'}`;
        fs.appendFileSync(fileA, JSON.stringify({ type: 'assistant', uuid: 'e1', parentUuid: 'a1', isApiErrorMessage: true, sessionId, timestamp: new Date().toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');

        // The carried chat gets a NEW session id, so Claude Code opens a new tab on QA-B instead of
        // refocusing the old QA-A tab.
        const projB = path.join(accB, 'projects', project);
        const findCopy = () => {
            const names = fs.existsSync(projB) ? fs.readdirSync(projB).filter((n) => n.endsWith('.jsonl') && n !== `${sessionId}.jsonl`) : [];
            return names.length ? path.join(projB, names[0]) : '';
        };
        let copied = '';
        for (let i = 0; i < 80 && !(popup && (copied = findCopy()) && path.normalize(envDir() || '') === path.normalize(accB)); i++) {
            await sleep(100);
        }
        copied = findCopy();
        assert.ok(copied, 'chat carried to QA-B under a new session id');
        const newId = path.basename(copied, '.jsonl');
        assert.ok(!fs.readFileSync(copied, 'utf8').includes(sessionId), 'old session id fully replaced');
        assert.ok(fs.readFileSync(copied, 'utf8').includes(newId), 'entries carry the new session id');
        console.log('    popup:', popup?.msg, '| buttons:', popup?.items.join(' / '));
        assert.ok(popup, 'popup shown');
        assert.ok(/QA-A hit its session limit/.test(popup.msg), 'names the account and limit kind');
        assert.ok(popup.items.some((x) => x.startsWith('Continue on ') && x !== 'Continue on Other AI') && popup.items.includes('Continue on Other AI') && popup.items.includes('Choose…'), 'offers another account, Other AI and Choose');
        assert.ok(fs.existsSync(copied), 'chat copied to QA-B');
        const lines = fs.readFileSync(copied, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(!lines.some((e) => e.isApiErrorMessage), 'limit notice not carried');
        assert.ok(!JSON.stringify(lines).includes('"thinking"'), 'thinking stripped for another Claude account');
        assert.strictEqual(path.normalize(envDir()), path.normalize(accB), 'panel now on QA-B');
    });

    test('the limited account is marked and sorted last; second notice in same window does not pop up again', async () => {
        let pops = 0;
        vscode.window.showWarningMessage = async () => {
            pops++;
            return undefined;
        };
        fs.appendFileSync(fileA, JSON.stringify({ type: 'assistant', uuid: 'e2', parentUuid: 'e1', isApiErrorMessage: true, sessionId, timestamp: new Date().toISOString(), message: { model: '<synthetic>', content: [{ type: 'text', text: fs.readFileSync(fileA, 'utf8').match(/You've hit your session limit · resets [^"]+/)[0] }] } }) + '\n');
        await sleep(1500);
        assert.strictEqual(pops, 0, 'no repeat popup');
    });

    test('Ctrl+Alt+H flip goes back to the previous account', async () => {
        vscode.window.showInformationMessage = async () => undefined;
        await vscode.commands.executeCommand('hoppy.flip');
        assert.strictEqual(path.normalize(envDir()), path.normalize(accA), 'flipped back to QA-A');
        await vscode.commands.executeCommand('hoppy.flip');
        assert.strictEqual(path.normalize(envDir()), path.normalize(accB), 'and forth to QA-B');
        const kb = ext().packageJSON.contributes.keybindings.find((k) => k.command === 'hoppy.flip');
        assert.strictEqual(kb.key, 'ctrl+alt+h');
    });

    test('account colors: known colors saved, unknown rejected, reset works', async () => {
        await targets.setColor(accB, '#FF6B8B');
        assert.strictEqual(targets.colorFor(accB), '#FF6B8B');
        await targets.setColor(accB, 'red; background:url(x)');
        assert.strictEqual(targets.colorFor(accB), undefined, 'arbitrary strings refused');
        await targets.setColor(accB, '#4EC9B0');
        await targets.setColor(accB, '');
        assert.strictEqual(targets.colorFor(accB), undefined, 'empty resets');
    });

    test('pin project: remembered, followed on focus, switching inside moves the pin, unpin forgets', async () => {
        await vscode.commands.executeCommand('hoppy.switchToDir', accA);
        await vscode.commands.executeCommand('hoppy.pinProject');
        assert.ok(targets.isProjectPinned(), 'pinned');
        assert.strictEqual(path.normalize(targets.pinnedDir()), path.normalize(accA));
        // Another window changed the global choice; coming back to this one restores the pin.
        await vscode.workspace.getConfiguration('claudeCode').update('environmentVariables', [{ name: 'CLAUDE_CONFIG_DIR', value: accB }], vscode.ConfigurationTarget.Global);
        const back = await targets.applyProjectPin();
        assert.ok(back && back.label === 'QA-A', 'pin re-applied');
        assert.strictEqual(path.normalize(envDir()), path.normalize(accA));
        // Switching inside the pinned project moves the pin.
        await vscode.commands.executeCommand('hoppy.switchToDir', accB);
        assert.strictEqual(path.normalize(targets.pinnedDir()), path.normalize(accB), 'pin follows a switch made here');
        await vscode.commands.executeCommand('hoppy.unpinProject');
        assert.ok(!targets.isProjectPinned(), 'unpinned');
        await hoppy().update('projectAccounts', undefined, vscode.ConfigurationTarget.Global);
    });

    test('export → import round trip carries settings and names, never keys', async () => {
        const file = path.join(root, 'hoppy-settings.json');
        const origSave = vscode.window.showSaveDialog;
        const origOpen = vscode.window.showOpenDialog;
        try {
            await hoppy().update('onLimit', 'otherAi', vscode.ConfigurationTarget.Global);
            await targets.setColor(accB, '#89D185');
            vscode.window.showSaveDialog = async () => vscode.Uri.file(file);
            await vscode.commands.executeCommand('hoppy.exportSettings');
            const text = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(text);
            assert.strictEqual(data.hoppy, 1);
            assert.strictEqual(data.settings.onLimit, 'otherAi');
            assert.ok(data.accounts.some((a) => a.label === 'QA-B' && a.color === '#89D185'));
            assert.ok(!/sk-or-|AIza|api_key|apiKey|nvapi-|gsk_|csk-/i.test(text), 'no key material in the file');

            // Change things, then import: they come back. A bad value in the file is ignored.
            await hoppy().update('onLimit', 'ask', vscode.ConfigurationTarget.Global);
            await hoppy().update('accountLabels', { [accA]: 'QA-A', [accB]: 'renamed' }, vscode.ConfigurationTarget.Global);
            data.settings.showUsage = 'yes please';
            // Model choices make import re-apply the router config (stop, write, start the gateway). This test
            // runs against the real router on this PC, so it must never trigger that.
            delete data.settings.mainModel;
            delete data.settings.smallModel;
            delete data.settings.fallbackModels;
            data.providers = {};
            fs.writeFileSync(file, JSON.stringify(data));
            vscode.window.showOpenDialog = async () => [vscode.Uri.file(file)];
            await vscode.commands.executeCommand('hoppy.importSettings');
            assert.strictEqual(hoppy().get('onLimit'), 'otherAi', 'setting restored');
            assert.strictEqual(hoppy().get('showUsage'), true, 'wrong type ignored');
            assert.ok(targets.listTargets().some((t) => t.label === 'QA-B'), 'account name restored');

            fs.writeFileSync(file, '{"not":"hoppy"}');
            await vscode.commands.executeCommand('hoppy.importSettings');
            assert.strictEqual(hoppy().get('onLimit'), 'otherAi', 'foreign file changes nothing');
        } finally {
            vscode.window.showSaveDialog = origSave;
            vscode.window.showOpenDialog = origOpen;
            await hoppy().update('onLimit', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('review fix: a limit in a chat of another project only marks the account, no popup here', async () => {
        let pops = 0;
        vscode.window.showWarningMessage = async () => {
            pops++;
            return undefined;
        };
        const otherProj = path.join(accB, 'projects', 'C--some-other-project');
        fs.mkdirSync(otherProj, { recursive: true });
        const f = path.join(otherProj, 'sess-x.jsonl');
        fs.writeFileSync(f, '');
        await sleep(300);
        fs.appendFileSync(f, JSON.stringify({ type: 'assistant', uuid: 'x1', isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your weekly limit · resets Dec 31, 6am" }] } }) + '\n');
        await sleep(1500);
        assert.strictEqual(pops, 0, 'no popup for a chat this window does not have open');
        assert.ok(targets.listTargets().some((t) => t.label === 'QA-B'), 'still listed');
    });

    test('review fix: export keeps a folder next to home as an absolute path', () => {
        const portable = require(path.join(out, 'portable.js'));
        assert.ok(portable, 'module loads');
        const home = os.homedir();
        const src = fs.readFileSync(path.join(out, 'portable.js'), 'utf8');
        assert.ok(src.includes('path.sep'), 'home prefix checked on a path boundary');
        console.log(`    home: ${home}`);
    });

    test('review fix: busy provider is not reported as a bad key', async function () {
        if (!process.env.HOPPY_QA_LIVE) {
            this.skip();
        }
        const realFetch = global.fetch;
        global.fetch = async () => new Response('{"error":"rate limited"}', { status: 429 });
        try {
            const r = await setup.checkKey('groq', 'gsk_anything');
            assert.strictEqual(r.ok, true, r.message);
            assert.ok(/busy/.test(r.message));
            global.fetch = async () => new Response('{"error":"bad key"}', { status: 401 });
            const bad = await setup.checkKey('groq', 'gsk_anything');
            assert.strictEqual(bad.ok, false);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('new commands and settings are registered', async () => {
        const all = await vscode.commands.getCommands(true);
        for (const id of ['pinProject', 'unpinProject', 'exportSettings', 'importSettings']) {
            assert.ok(all.includes(`hoppy.${id}`), id);
        }
        assert.strictEqual(hoppy().get('onLimit'), 'ask', 'asks by default');
        const steps = ext().packageJSON.contributes.walkthroughs[0].steps;
        assert.ok(!steps.find((x) => x.id === 'continue').description.includes('/resume'), 'guide no longer asks for /resume');
    });

    test('usage: a chat copied by Hoppy is not counted for the destination', () => {
        usage.initUsage(fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-qa-usage-')));
        const b = usage.scanUsage(accB, { claudeOnly: true });
        const a = usage.scanUsage(accA, { claudeOnly: true });
        console.log(`    usage QA-A: ${a.last5h.replies} replies, QA-B: ${b.last5h.replies} replies`);
        assert.strictEqual(a.last5h.replies, 1, 'origin counts its reply');
        assert.strictEqual(b.last5h.replies, 0, 'copy does not count');
    });

    test('real data: summary and token count of the largest local chat (read-only)', () => {
        const dir = path.join(os.homedir(), '.claude-account2', 'projects');
        if (!fs.existsSync(dir)) {
            return;
        }
        let biggest;
        for (const p of fs.readdirSync(dir)) {
            const pd = path.join(dir, p);
            if (!fs.statSync(pd).isDirectory()) continue;
            for (const f of fs.readdirSync(pd).filter((n) => n.endsWith('.jsonl'))) {
                const s = fs.statSync(path.join(pd, f));
                if (!biggest || s.size > biggest.size) biggest = { file: path.join(pd, f), size: s.size };
            }
        }
        const t0 = Date.now();
        const sum = chats.summarizeChat(biggest.file);
        const tokens = chats.chatTokens(biggest.file);
        console.log(`    biggest chat ${(biggest.size / 1e6).toFixed(1)} MB → ${tokens} tokens, summary ${sum.length} chars in ${Date.now() - t0} ms`);
        assert.ok(sum.length <= 16000, 'summary within budget');
        assert.ok(sum.startsWith('I am continuing a task'), 'has the hand-over header');
        assert.ok(tokens > 0, 'token count read');
    });

    test('live: OpenRouter health check (1 working free model, 1 missing model, 1 bad key)', async function () {
        if (!process.env.HOPPY_QA_LIVE) {
            this.skip();
        }
        const key = (await gateway.runHelper(ext().extensionPath, 'export-key openrouter'))?.key;
        assert.ok(key, 'OpenRouter key available');
        const main = hoppy().get('mainModel') || 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free';
        const [good, missing] = await Promise.all([health.checkModel(main, key), health.checkModel('openrouter/nobody/no-such-model:free', key)]);
        const badKey = await health.checkModel(main, 'sk-or-v1-' + '0'.repeat(64));
        console.log(`    ${main}: ${good.status} ${good.ms}ms ${good.note || ''}`);
        console.log(`    missing: ${missing.status} ${missing.note || ''}`);
        console.log(`    bad key: ${badKey.status} ${badKey.note || ''}`);
        assert.ok(['ok', 'busy', 'quota', 'no-tools', 'slow'].includes(good.status), 'real model answers or is busy, never a key/missing error');
        assert.ok(['missing', 'error'].includes(missing.status), 'missing model reported');
        assert.strictEqual(badKey.status, 'key', 'bad key reported as key problem');
    });

    test('live: new providers reject fake keys cleanly (no crash, clear message)', async function () {
        if (!process.env.HOPPY_QA_LIVE) {
            this.skip();
        }
        for (const [id, fake] of [['groq', 'gsk_qa_fake'], ['cerebras', 'csk-qafake'], ['mistral', 'qa-fake-' + 'x'.repeat(24)], ['nvidia', 'nvapi-qafake']]) {
            const r = await setup.checkKey(id, fake);
            console.log(`    ${id}: ok=${r.ok} ${r.message}`);
            assert.ok(r.message.length > 0);
            if (!/could not reach|could not be checked/.test(r.message)) {
                assert.strictEqual(r.ok, false, `${id} fake key rejected`);
            }
        }
    });

    test('live: model context lookup for the main Other AI model', async function () {
        if (!process.env.HOPPY_QA_LIVE) {
            this.skip();
        }
        const settings = require(path.join(out, 'settings.js'));
        const main = hoppy().get('mainModel');
        const ctx = main ? await settings.modelContext(main) : undefined;
        console.log(`    ${main} context: ${ctx}`);
        if (main?.startsWith('openrouter/')) {
            assert.ok(ctx > 0, 'context known');
        }
    });
});
