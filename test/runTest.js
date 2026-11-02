// Launches an isolated VS Code (own user-data and extensions dir) with Hoppy loaded and runs test/suite.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

// Several tests need the real Claude Code extension. The test extensions dir links to the newest copy in
// ~/.vscode/extensions. VS Code deletes old versions when it updates, which left a dangling link before,
// so the link and extensions.json are rebuilt on every run.
function prepareExtensionsDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const source = process.env.HOPPY_TEST_CLAUDE_EXT_DIR || path.join(os.homedir(), '.vscode', 'extensions');
    const re = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(-.+)?$/;
    const found = fs.existsSync(source) ? fs.readdirSync(source)
        .map((name) => ({ name, m: re.exec(name) }))
        .filter((x) => x.m && fs.existsSync(path.join(source, x.name, 'package.json')))
        .sort((a, b) => {
            for (let i = 1; i <= 3; i++) {
                const d = Number(b.m[i]) - Number(a.m[i]);
                if (d) return d;
            }
            return 0;
        }) : [];
    for (const name of fs.readdirSync(dir)) {
        if (re.test(name)) fs.rmSync(path.join(dir, name), { recursive: false, force: true });
    }
    if (!found.length) {
        console.warn(`[runTest] Claude Code not found in ${source}; tests that need it will fail.`);
        fs.writeFileSync(path.join(dir, 'extensions.json'), '[]');
        return;
    }
    const pick = found[0];
    const link = path.join(dir, pick.name);
    fs.symlinkSync(path.join(source, pick.name), link, 'junction');
    const pkg = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'));
    const platform = pick.m[4] ? pick.m[4].slice(1) : undefined;
    const entry = {
        identifier: { id: 'anthropic.claude-code' },
        version: pkg.version,
        location: { $mid: 1, path: '/' + link.replace(/\\/g, '/'), scheme: 'file' },
        relativeLocation: pick.name,
        metadata: { installedTimestamp: Date.now(), ...(platform ? { targetPlatform: platform } : {}) },
    };
    fs.writeFileSync(path.join(dir, 'extensions.json'), JSON.stringify([entry]));
    console.log(`[runTest] Using Claude Code ${pkg.version}`);
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const tmp = path.join(os.tmpdir(), 'modelhop-test');
    const extDir = path.join(os.tmpdir(), 'modelhop-test-ext');
    prepareExtensionsDir(extDir);
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
            launchArgs: [
                process.env.MODELHOP_TEST_WORKSPACE || root,
                '--user-data-dir', path.join(tmp, 'user-data'),
                '--extensions-dir', extDir,
                '--disable-workspace-trust',
            ],
        });
    } catch (err) {
        console.error('Tests failed', err);
        process.exit(1);
    }
}

main();
