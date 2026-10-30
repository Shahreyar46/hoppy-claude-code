// Chapters intro–4: editor, install, guide, Hoppy menu, switching, add account, Settings > Accounts.
import { launch, cleanShot, command } from './vsc.mjs';

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// The "Add account" step creates ~/.claude-account3; start clean (only if it was never logged in).
const extra = join(homedir(), '.claude-account3');
if (existsSync(extra) && !existsSync(join(extra, '.credentials.json'))) rmSync(extra, { recursive: true, force: true });
// Fresh recording profile every run: starts on Work, no leftover state (colors, pins, offers).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { P } from './vsc.mjs';
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
    // Start on Work explicitly (this machine's own CLAUDE_CONFIG_DIR would otherwise decide).
    'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: join(homedir(), '.claude') }],
});
rmSync(realProfile, { recursive: true, force: true });
mkdirSync(join(realProfile, 'User'), { recursive: true });
writeFileSync(join(realProfile, 'User', 'settings.json'), JSON.stringify(base, null, 2));
const { app, page } = await launch();
const wait = (ms) => page.waitForTimeout(ms);
const away = () => page.mouse.move(900, 600);
/** Waits for the Settings webview and returns its frame. */
async function settingsFrame(timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        for (const f of page.frames()) {
            if (await f.locator('main#panel').count().catch(() => 0)) return f;
        }
        await page.waitForTimeout(500);
    }
    throw new Error('Settings webview did not load');
}
const statusItem = () => page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();

async function closeClaudeBanners() {
    for (const frame of page.frames()) {
        for (const label of ['Close', 'Dismiss']) {
            const b = frame.locator(`[aria-label="${label}"]`);
            const n = await b.count().catch(() => 0);
            for (let i = 0; i < n; i++) await b.nth(i).click({ timeout: 500 }).catch(() => undefined);
        }
    }
}

// ---- Intro / editor ----
await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+P');
await wait(400);
await page.keyboard.type('App.tsx', { delay: 20 });
await wait(500);
await page.keyboard.press('Enter');
await wait(1500);
await away(); await cleanShot(page, '01-editor');

// ---- 1 Install: Extensions view search ----
await page.keyboard.press('Control+Shift+X');
await wait(1200);
await page.keyboard.type('Hoppy for Claude Code', { delay: 45 });
await wait(4000);
await away(); await cleanShot(page, '02-ext-search');
const card = page.locator('.extension-list-item').filter({ hasText: 'Hoppy' }).first();
await card.click().catch(() => undefined);
await wait(4000);
await away(); await cleanShot(page, '03-ext-details');

// ---- guide ----
await command(page, 'Hoppy: Getting Started Guide');
await wait(2500);
await away(); await cleanShot(page, '04-guide');
await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+Shift+E');
await page.keyboard.press('Control+P');
await wait(400);
await page.keyboard.type('App.tsx', { delay: 20 });
await page.keyboard.press('Enter');
await wait(1200);
await away(); await cleanShot(page, '05-statusbar');

// ---- 2 menu + switch ----
await statusItem().click();
await wait(1200);
await away(); await cleanShot(page, '06-menu');
await page.keyboard.type('Personal', { delay: 40 });
await wait(600);
await away(); await cleanShot(page, '07-menu-pick');
await page.keyboard.press('Enter');
await wait(9000);
await closeClaudeBanners();
await wait(800);
await away(); await cleanShot(page, '08-switched');

// ---- 3 add account (creates ~/.claude-account3; removed after recording) ----
await statusItem().click();
await wait(900);
await page.keyboard.type('Add Claude account', { delay: 30 });
await wait(500);
await away(); await cleanShot(page, '09-menu-add');
await page.keyboard.press('Enter');
await wait(900);
await page.keyboard.type('Side project', { delay: 60 });
await wait(400);
await away(); await cleanShot(page, '10-add-name');
await page.keyboard.press('Enter');
await wait(10000);
await away(); await cleanShot(page, '11-add-login');

// ---- 4 Settings > Accounts (sidebar hidden so the page is large) ----
await command(page, 'View: Close All Editors');
await command(page, 'View: Close All Editor Groups');
await command(page, 'Hoppy: Settings');
await page.keyboard.press('Control+B');
let sf = await settingsFrame();
await wait(2500);
await away(); await cleanShot(page, '12-settings-accounts');
// Edit the account in use, so the status bar color change is visible.
const current = sf.locator('article.account.is-current button[data-act="edit"]');
await (await current.count() ? current : sf.locator('button[data-act="edit"]').first()).click();
await wait(800);
await away(); await cleanShot(page, '13-settings-edit');
await sf.locator('article.account.is-current .swatch').first().click().catch(() => sf.locator('.swatch').first().click());
await wait(2500);
sf = await settingsFrame();
await away(); await cleanShot(page, '14-settings-color');
await page.keyboard.press('Control+B');
await app.close();
console.log('capture1 done');
