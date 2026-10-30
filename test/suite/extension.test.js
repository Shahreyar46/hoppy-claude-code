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
        for (const id of ['menu', 'more', 'settings', 'guide', 'switch', 'switchToDir', 'useClaude', 'useOtherAi', 'handoff', 'addAccount', 'renameAccount', 'setup', 'syncFreeModels', 'gatewayRestart', 'installSkill', 'status', 'flip']) {
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
        assert.strictEqual(state.providers.length, 8, 'eight providers shown');
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

    // ---- 1.1: limit radar ----
    const limitParse = require(path.join(out, 'limitParse.js'));
    const limits = require(path.join(out, 'limits.js'));
    const limitEntry = (text, timestamp, extra = {}) =>
        JSON.stringify({ type: 'assistant', isApiErrorMessage: true, uuid: 'err-1', parentUuid: 'a-1', timestamp, message: { model: '<synthetic>', content: [{ type: 'text', text }] }, ...extra });
    const dhaka = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' });

    test('limit notices: kind and reset time for every wording Claude Code writes', () => {
        const hit = Date.parse('2026-10-21T16:26:21Z'); // 22:26 in Dhaka
        const cases = [
            ["You've hit your session limit · resets 12:50am (Asia/Dhaka)", 'session', '22/10/2026, 00:50:00'],
            ["You've hit your session limit · resets 11pm (Asia/Dhaka)", 'session', '21/10/2026, 23:00:00'],
            ["You've hit your weekly limit · resets Oct 31, 6am (Asia/Dhaka)", 'weekly', '31/10/2026, 06:00:00'],
            ["You've hit your weekly limit · resets 1pm (Asia/Dhaka)", 'weekly', '22/10/2026, 13:00:00'],
        ];
        for (const [text, kind, when] of cases) {
            assert.strictEqual(limitParse.limitKind(text), kind, text);
            assert.strictEqual(dhaka(limitParse.parseResetTime(text, hit)), when, text);
        }
        assert.strictEqual(limitParse.parseResetTime('Claude AI usage limit reached|1761300000', hit), 1761300000000);
        assert.strictEqual(limitParse.parseResetTime("You've hit your Opus limit", hit), undefined, 'unknown wording gives no time, no crash');
    });

    test('limit notices: only Claude Code synthetic entries count, not chat text', () => {
        const text = "You've hit your session limit · resets 6pm (Asia/Dhaka)";
        assert.ok(limitParse.parseLimitLine(limitEntry(text, '2026-10-21T10:00:00Z')));
        const modelSaidIt = JSON.stringify({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text }] } });
        assert.strictEqual(limitParse.parseLimitLine(modelSaidIt), undefined);
        assert.strictEqual(limitParse.parseLimitLine('{not json limit'), undefined);
        const chunk = ['{"type":"user"}', limitEntry(text, '2026-10-21T10:00:00Z'), '{"type":"user","message":{"content":"hi"}}'].join('\n');
        assert.strictEqual(limitParse.lastLimitIn(chunk).kind, 'session');
    });

    test('a carried chat drops the limit notice and stays linked', () => {
        const lines = [
            JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: null, message: { content: 'fix it' } }),
            JSON.stringify({ type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', message: { content: [{ type: 'text', text: 'ok' }] } }),
            limitEntry("You've hit your session limit · resets 6pm (Asia/Dhaka)", '2026-10-21T10:00:00Z', { uuid: 'err-1', parentUuid: 'a-1' }),
            JSON.stringify({ type: 'user', uuid: 'u-2', parentUuid: 'err-1', message: { content: 'continue' } }),
        ].join('\n');
        const cleaned = chats.cleanChat(lines, { thinking: false }).split('\n').map((l) => JSON.parse(l));
        assert.strictEqual(cleaned.length, 3);
        assert.ok(!cleaned.some((e) => e.isApiErrorMessage));
        assert.strictEqual(cleaned[2].parentUuid, 'a-1', 'next message re-linked past the removed notice');
    });

    test('subagent notices map to their main chat file', () => {
        const f = path.join('C:', 'x', 'projects', 'p', 'sess-1', 'subagents', 'agent-a.jsonl');
        assert.strictEqual(limits.mainSessionFile(f), path.join('C:', 'x', 'projects', 'p', 'sess-1.jsonl'));
        const main = path.join('C:', 'x', 'projects', 'p', 'sess-1.jsonl');
        assert.strictEqual(limits.mainSessionFile(main), main);
    });

    test('radar: a fresh limit notice fires once and marks the account', async function () {
        this.timeout(15000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-radar-'));
        const proj = path.join(dir, 'projects', 'c--demo');
        fs.mkdirSync(proj, { recursive: true });
        const file = path.join(proj, 'sess-1.jsonl');
        fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u-1', message: { content: 'hi' } }) + '\n');
        const store = new Map();
        const memento = { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v), keys: () => [...store.keys()] };
        const radar = new limits.LimitRadar(memento);
        const hits = [];
        radar.onHit((h) => hits.push(h));
        radar.start([dir]);
        try {
            await new Promise((r) => setTimeout(r, 300));
            const reset = new Date(Date.now() + 2 * 3600000);
            const h12 = reset.getHours() % 12 || 12;
            const text = `You've hit your session limit · resets ${h12}:${String(reset.getMinutes()).padStart(2, '0')}${reset.getHours() < 12 ? 'am' : 'pm'}`;
            fs.appendFileSync(file, limitEntry(text, new Date().toISOString()) + '\n');
            fs.appendFileSync(file, limitEntry(text, new Date().toISOString(), { uuid: 'err-2' }) + '\n');
            for (let i = 0; i < 40 && !hits.length; i++) {
                await new Promise((r) => setTimeout(r, 100));
            }
            await new Promise((r) => setTimeout(r, 800));
            assert.strictEqual(hits.length, 1, 'one notification for one limit window');
            assert.strictEqual(hits[0].sessionFile, file);
            assert.ok(radar.limitFor(dir), 'account marked as limited');
            assert.ok(Math.abs(hits[0].resetsAt - reset.getTime()) < 61000, 'reset time read in local time');
            await radar.clear(dir);
            assert.strictEqual(radar.limitFor(dir), undefined);
        } finally {
            radar.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('usage: counts each reply once, skips notices, copied history and non-Claude models', () => {
        const usage = require(path.join(out, 'usage.js'));
        usage.initUsage(fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-usage-store-')));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-usage-'));
        const proj = path.join(dir, 'projects', 'c--demo');
        fs.mkdirSync(proj, { recursive: true });
        const now = Date.now();
        const reply = (id, model, ts, tokens) =>
            JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, model, usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 999999, output_tokens: 0 } } });
        fs.writeFileSync(
            path.join(proj, 's1.jsonl'),
            [
                reply('m1', 'claude-opus-5-5', now - 60000, 100),
                reply('m1', 'claude-opus-5-5', now - 59000, 100), // same reply, second content block
                reply('m2', 'claude-sonnet-5-5', now - 30000, 50),
                reply('m3', '<synthetic>', now - 20000, 0),
                reply('m4', 'openrouter/x/y:free', now - 10000, 70), // old Other AI chat in a Claude folder
                reply('m0', 'claude-opus-5-5', now - 3 * 3600000, 500), // older than this file: copied history
            ].join('\n') + '\n',
        );
        usage.noteImported(dir, reply('m2', 'claude-sonnet-5-5', now - 30000, 50), '');
        const u = usage.scanUsage(dir, { claudeOnly: true });
        assert.strictEqual(u.last5h.replies, 1, 'm1 only: m2 imported, m0 predates the file, m3 notice, m4 not Claude');
        assert.strictEqual(u.last5h.tokens, 100, 'cache reads are not counted');
        const all = usage.scanUsage(dir, { claudeOnly: false });
        assert.strictEqual(all.last5h.replies, 2, 'Other AI folder counts every model');
        assert.strictEqual(usage.formatTokens(3456789), '3.5M');
        assert.strictEqual(usage.modelLabel('claude-opus-5-5'), 'Opus 5.5');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('health: HTTP answers map to plain statuses, working models sort first', () => {
        const health = require(path.join(out, 'health.js'));
        assert.strictEqual(health.statusFromHttp(401, ''), 'key');
        assert.strictEqual(health.statusFromHttp(402, ''), 'credit');
        assert.strictEqual(health.statusFromHttp(429, 'rate limited'), 'busy');
        assert.strictEqual(health.statusFromHttp(404, ''), 'missing');
        assert.strictEqual(health.statusFromHttp(400, 'No endpoints found for x'), 'missing');
        assert.strictEqual(health.statusFromHttp(400, 'x is not a valid model ID'), 'missing');
        assert.strictEqual(health.statusFromHttp(410, 'end of life'), 'missing');
        assert.strictEqual(health.statusFromHttp(429, 'Rate limit exceeded: free-models-per-day'), 'quota');
        const r = (selector, status) => ({ selector, status, ms: 1, checkedAt: 0 });
        assert.deepStrictEqual(health.workingFirst(['a', 'b', 'c', 'd'], [r('a', 'busy'), r('b', 'ok'), r('c', 'no-tools')]), ['b', 'd', 'c', 'a']);
        assert.deepStrictEqual(health.splitSelector('openrouter/x/y:free'), { provider: 'openrouter', model: 'x/y:free' });
    });

    test('new providers: key formats and default model picks', () => {
        const setup = require(path.join(out, 'setup.js'));
        const p = (id) => setup.PROVIDERS.find((x) => x.id === id);
        assert.strictEqual(p('groq').looksValid('gsk_abc'), undefined);
        assert.ok(p('groq').looksValid('sk-abc'));
        assert.strictEqual(p('cerebras').looksValid('csk-abc'), undefined);
        assert.strictEqual(p('nvidia').looksValid('nvapi-abc'), undefined);
        const picks = setup.defaultModels([{ id: 'whatever-small' }, { id: 'qwen3-coder-480b' }, { id: 'gpt-oss-120b' }], 2);
        assert.deepStrictEqual(picks, ['qwen3-coder-480b', 'gpt-oss-120b'], 'coding-capable families first');
    });

    test('hand-over summary keeps goal, changed files and latest turns', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-sum-'));
        const file = path.join(dir, 's.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ type: 'user', message: { content: 'Add dark mode to settings' } }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/theme.ts' } }, { type: 'text', text: 'Theme toggle added.' }], usage: { input_tokens: 10, cache_read_input_tokens: 150000, cache_creation_input_tokens: 5000, output_tokens: 300 } } }),
            JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } }),
        ].join('\n'));
        const sum = chats.summarizeChat(file);
        assert.ok(sum.includes('Add dark mode to settings'));
        assert.ok(sum.includes('src/theme.ts'));
        assert.ok(sum.includes('Theme toggle added.'));
        assert.ok(!sum.includes('session limit'), 'limit notice not carried');
        assert.strictEqual(chats.chatTokens(file), 155310);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('radar: a limit notice copied in from another account (older than the file) is ignored', async function () {
        this.timeout(15000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-radar-copy-'));
        const proj = path.join(dir, 'projects', 'c--demo');
        fs.mkdirSync(proj, { recursive: true });
        const file = path.join(proj, 'copied.jsonl');
        const old = new Date(Date.now() - 2 * 3600000).toISOString();
        fs.writeFileSync(file, limitEntry("You've hit your weekly limit · resets Dec 30, 6am", old) + '\n');
        const store = new Map();
        const radar = new limits.LimitRadar({ get: (k) => store.get(k), update: async (k, v) => void store.set(k, v), keys: () => [...store.keys()] });
        radar.start([dir]);
        try {
            await new Promise((r) => setTimeout(r, 2500));
            assert.strictEqual(radar.limitFor(dir), undefined, 'copied notice does not mark the account');
        } finally {
            radar.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('radar: an account that answers after its limit notice is no longer marked', async function () {
        this.timeout(15000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-radar-lift-'));
        const proj = path.join(dir, 'projects', 'c--demo');
        fs.mkdirSync(proj, { recursive: true });
        const file = path.join(proj, 'sess.jsonl');
        fs.writeFileSync(file, '');
        const store = new Map();
        const radar = new limits.LimitRadar({ get: (k) => store.get(k), update: async (k, v) => void store.set(k, v), keys: () => [...store.keys()] });
        radar.start([dir]);
        try {
            await new Promise((r) => setTimeout(r, 300));
            fs.appendFileSync(file, limitEntry("You've hit your weekly limit · resets Dec 30, 6am", new Date(Date.now() - 5 * 60000).toISOString()) + '\n');
            await new Promise((r) => setTimeout(r, 1200));
            assert.ok(radar.limitFor(dir), 'marked after the notice');
            const reply = { type: 'assistant', uuid: 'r1', timestamp: new Date().toISOString(), message: { id: 'msg_r1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1, output_tokens: 1 } } };
            fs.appendFileSync(file, JSON.stringify(reply) + '\n');
            await new Promise((r) => setTimeout(r, 1200));
            assert.strictEqual(radar.limitFor(dir), undefined, 'cleared once the account answers again');
        } finally {
            radar.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('radar: a new chat hitting the same limit window still asks (older notice does not block it)', async function () {
        this.timeout(15000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-radar-newchat-'));
        const proj = path.join(dir, 'projects', 'c--demo');
        fs.mkdirSync(proj, { recursive: true });
        const text = "You've hit your weekly limit · resets Dec 30, 6am";
        const store = new Map();
        // an earlier notice for this account, same reset time, already recorded
        store.set('hoppy.limits', { [path.normalize(dir).toLowerCase()]: { kind: 'weekly', text, hitAt: Date.now() - 4 * 60000, resetsAt: Date.parse('2099-12-30T06:00:00Z'), dir, sessionFile: path.join(proj, 'old.jsonl') } });
        const radar = new limits.LimitRadar({ get: (k) => store.get(k), update: async (k, v) => void store.set(k, v), keys: () => [...store.keys()] });
        const hits = [];
        radar.onHit((h) => hits.push(h));
        radar.start([dir]);
        try {
            await new Promise((r) => setTimeout(r, 300));
            const file = path.join(proj, 'new-chat.jsonl');
            fs.writeFileSync(file, limitEntry(text, new Date().toISOString()) + '\n');
            for (let i = 0; i < 30 && !hits.length; i++) await new Promise((r) => setTimeout(r, 100));
            assert.strictEqual(hits.length, 1, 'the new chat gets its question');
        } finally {
            radar.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('chat preview skips the editor context block the VS Code panel sends first', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoppy-preview-'));
        const file = path.join(dir, 'p', 's.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<ide_opened_file>App.tsx</ide_opened_file>' }, { type: 'text', text: 'Add a dark mode toggle' }] } }) + '\n');
        const chat = chats.chatFromFile(file, { kind: 'claude', dir, label: 'x', loggedIn: true });
        assert.strictEqual(chat.preview, 'Add a dark mode toggle');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('folder matching ignores case and a trailing separator', () => {
        assert.ok(targets.sameDir('C:\\Users\\me\\.claude-account2\\', 'c:/users/ME/.claude-account2'));
        assert.ok(!targets.sameDir('C:\\Users\\me\\.claude', 'C:\\Users\\me\\.claude-account2'));
    });

    test('limit setting is registered and on by default', () => {
        assert.strictEqual(vscode.workspace.getConfiguration('hoppy').get('suggestOnLimit'), true);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});
