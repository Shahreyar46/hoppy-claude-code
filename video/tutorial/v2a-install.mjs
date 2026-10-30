// v2 part A: a real install from the Marketplace in a fresh recording profile.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launch, P, mark, helpers } from './vsc.mjs';

const CODE_CLI = join(process.cwd(), '..', '..', '.vscode-test', 'vscode-win32-x64-archive-1.144.0', 'bin', 'code.cmd');
const cli = (...args) => execFileSync('cmd', ['/c', CODE_CLI, '--extensions-dir', P.EXT, ...args], { stdio: 'pipe' }).toString();

// Fresh profile that starts on Work.
const realProfile = P.USERDATA + '-real';
const base = JSON.parse(readFileSync(join(P.USERDATA, 'User', 'settings.json'), 'utf8'));
Object.assign(base, {
    'hoppy.accountLabels': { [join(homedir(), '.claude')]: 'Work', [join(homedir(), '.claude-account2')]: 'Personal' },
    'typescript.validate.enable': false,
    'javascript.validate.enable': false,
    'editor.renderValidationDecorations': 'off',
    'problems.decorations.enabled': false,
    'workbench.editor.enablePreview': false,
    'workbench.hover.delay': 100000,
    'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: join(homedir(), '.claude') }],
});
rmSync(realProfile, { recursive: true, force: true });
mkdirSync(join(realProfile, 'User'), { recursive: true });
writeFileSync(join(realProfile, 'User', 'settings.json'), JSON.stringify(base, null, 2));
const extra = join(homedir(), '.claude-account3');
if (existsSync(extra) && !existsSync(join(extra, '.credentials.json'))) rmSync(extra, { recursive: true, force: true });

try {
    cli('--uninstall-extension', 'shahreyar.hoppy-claude-code');
} catch {
    // not installed
}

const { app, page } = await launch();
const { wait, snap } = helpers(page);
await page.keyboard.press('Control+Shift+X');
await wait(1500);
await page.keyboard.type('Hoppy for Claude Code', { delay: 45 });
await wait(5000);
const item = page.locator('.extension-list-item').filter({ hasText: 'Hoppy for Claude Code' }).first();
const install = item.getByRole('button', { name: /^Install$/ }).first();
await mark('X1-search', item);
await mark('X1-search', install, 'click', 2);
await mark('X1-search', page.locator('.extensions-viewlet .suggest-input-container, .extensions-viewlet .monaco-inputbox').first(), 'search');
await snap('X1-search');
await install.click();
await wait(1500);
const trust = page.getByRole('button', { name: /Trust Publisher & Install/ }).first();
if (await trust.count()) {
    await mark('X2-trust', page.locator('.monaco-dialog-box').first());
    await mark('X2-trust', trust, 'click', 2);
    await snap('X2-trust');
    await trust.click();
}
for (let i = 0; i < 60; i++) {
    await wait(1000);
    if (await item.getByRole('button', { name: /^Uninstall$/ }).count() || await page.locator('.statusbar-item').filter({ hasText: /Claude ·/ }).count()) break;
}
await wait(5000);
const statusLoc = page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();
await mark('X3-installed', statusLoc, 'status');
await mark('X3-installed', page.locator('.part.editor').first());
await snap('X3-installed');
await app.close();

// Back to the 1.1.0 build for the rest of the recording.
cli('--install-extension', join(process.cwd(), '..', '..', 'hoppy-claude-code-win32-x64-1.1.0.vsix'), '--force');
console.log('v2a done');
