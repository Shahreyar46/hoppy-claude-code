// Chapters 5-11 with real Claude: a real chat on Personal, moved to Work, Work's real limit, Hoppy's
// popup, continue on Personal; then AI Providers, Models, Backups (real check), Other AI, extras.
// Expects capture1 to have run (panel on Personal, fresh profile).
import { launch, cleanShot, command } from './vsc.mjs';

const { app, page } = await launch();
const wait = (ms) => page.waitForTimeout(ms);
const away = () => page.mouse.move(900, 600);
const snap = async (name) => {
    await away();
    return cleanShot(page, name);
};
const statusItem = () => page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();

async function frameWith(selector, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        // Webviews only: the workbench itself has text areas too (the code editor).
        for (const f of page.frames().filter((x) => x !== page.mainFrame())) {
            const el = f.locator(selector).first();
            if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return f;
        }
        await wait(500);
    }
    throw new Error(`no visible frame with ${selector}`);
}
const settingsFrame = () => frameWith('main#panel');
const claudeInput = '[role="textbox"][aria-label="Message input"]';

async function closeClaudeBanners() {
    for (const f of page.frames()) {
        for (const label of ['Close', 'Dismiss']) {
            const b = f.locator(`[aria-label="${label}"]`);
            const n = await b.count().catch(() => 0);
            for (let i = 0; i < n; i++) await b.nth(i).click({ timeout: 500 }).catch(() => undefined);
        }
    }
}

/** Types into the visible Claude panel and sends. */
async function ask(text) {
    const f = await frameWith(claudeInput, 30000);
    const box = f.locator(claudeInput).last();
    await box.click();
    await box.type(text, { delay: 35 });
    await wait(300);
    return f;
}

/** Waits until the Claude panel stops changing; takes a frame every few seconds for the video. */
async function watchReply(f, prefix, maxMs = 150000) {
    let last = '';
    let stableSince = Date.now();
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < maxMs) {
        await wait(2500);
        await snap(`${prefix}-${String(++i).padStart(2, '0')}`);
        const text = await f.evaluate(() => document.body.innerText).catch(() => '');
        if (text !== last) {
            last = text;
            stableSince = Date.now();
        } else if (Date.now() - stableSince > 9000 && Date.now() - start > 12000) {
            return;
        }
    }
}

async function menuPick(label) {
    await statusItem().click();
    await wait(900);
    await page.keyboard.type(label, { delay: 30 });
    await wait(500);
}

// ---- real chat on Personal ----
// capture1 ends on the new, never-logged-in "Side project" account; go back to Personal first.
await menuPick('Personal');
await page.keyboard.press('Enter');
await wait(6000);
await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+P');
await wait(300);
await page.keyboard.type('App.tsx', { delay: 15 });
await page.keyboard.press('Enter');
await wait(800);
await command(page, 'Claude Code: Open in New Tab');
await wait(8000);
await closeClaudeBanners();
let f = await ask('Add a dark mode toggle to the header in App.tsx. Keep it small.');
await snap('20-ask');
await page.keyboard.press('Enter');
await watchReply(f, '21-reply');
await snap('22-reply-done');

// ---- 6 Continue a chat (Personal → Work) ----
await menuPick('Continue a chat');
await snap('30-menu-continue');
await page.keyboard.press('Enter');
await wait(1200);
await snap('31-pick-chat');
await page.keyboard.press('Enter');
await wait(1000);
await page.keyboard.type('Work', { delay: 40 });
await wait(400);
await snap('32-pick-dest');
await page.keyboard.press('Enter');
await wait(9000);
await closeClaudeBanners();
await snap('33-on-work');

// ---- 5 Work hits its real limit → Hoppy popup ----
f = await ask('Now add a test for the toggle.');
await page.keyboard.press('Enter');
let popup = null;
for (let i = 0; i < 40 && !popup; i++) {
    await wait(1000);
    const t = page.locator('.notifications-toasts .notification-toast').filter({ hasText: 'Keep this chat going' });
    if (await t.count()) popup = t.first();
}
await snap('40-limit-popup');
if (popup) {
    await popup.getByRole('button', { name: /Continue on Personal/ }).click().catch(() => undefined);
    await wait(9000);
    await closeClaudeBanners();
    await snap('41-continued');
    // the one-time "do this without asking?" offer
    await wait(1500);
    await snap('42-always-offer');
    const keep = page.locator('.notifications-toasts .notification-toast').filter({ hasText: 'without asking' });
    if (await keep.count()) await keep.first().getByRole('button', { name: 'Keep asking' }).click().catch(() => undefined);
    f = await ask('Please continue: add a test for the toggle.');
    await page.keyboard.press('Enter');
    await watchReply(f, '43-reply', 120000);
    await snap('44-reply-done');
} else {
    console.log('NOTE: no limit popup appeared (Work may no longer be limited)');
}
await menuPick('');
await snap('45-menu-limited');
await page.keyboard.press('Escape');

// ---- 7 AI Providers / 8 Models / 9 Backups ----
await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
await page.keyboard.press('Control+B');
let sf = await settingsFrame();
await sf.locator('#tab-providers').click();
await wait(1500);
await snap('50-providers');
await sf.locator('#prov-groq button[data-act="open-key"]').click().catch(() => undefined);
await wait(700);
await sf.locator('#key-groq').type('gsk_••••••••••••', { delay: 40 }).catch(() => undefined);
await snap('51-connect-groq');
await sf.locator('#prov-groq button[data-act="close-key"]').click().catch(() => undefined);
await sf.locator('#tab-models').click();
await wait(1500);
await snap('60-models');
await sf.locator('input[type="search"], #search').first().type('qwen', { delay: 60 }).catch(() => undefined);
await wait(800);
await snap('61-models-search');
await sf.locator('#tab-fallback').click();
await wait(1500);
await snap('70-backups');
await sf.locator('button[data-act="check-models"]').click();
for (let i = 0; i < 30; i++) {
    await wait(1500);
    sf = await settingsFrame();
    if (await sf.locator('button[data-act="check-models"]', { hasText: 'Check again' }).count()) break;
}
await wait(800);
await snap('71-backups-checked');
if (await sf.locator('button[data-act="working-first"]').count()) {
    await sf.locator('button[data-act="working-first"]').click();
    await wait(800);
    await snap('72-backups-working-first');
    await sf.locator('button[data-act="reset"]').click().catch(() => undefined); // do not change the real chain
}
await page.keyboard.press('Control+B');

// ---- 10 Other AI ----
await command(page, 'View: Close All Editors');
await menuPick('Other AI');
await snap('80-menu-other');
await page.keyboard.press('Enter');
await wait(10000);
await closeClaudeBanners();
await snap('81-other-tab');
f = await ask('/model');
await wait(1500);
await snap('82-model-list');
await page.keyboard.press('Escape');
await wait(500);
f = await ask('In one sentence: what does App.tsx do?');
await page.keyboard.press('Enter');
await watchReply(f, '83-other-reply', 90000);

// ---- 11 Extras ----
await page.keyboard.press('Control+Alt+H');
await wait(9000);
await snap('90-flip');
await menuPick('Always use');
await snap('91-pin-item');
await page.keyboard.press('Enter');
await wait(1200);
await snap('92-pinned');
await menuPick('More');
await page.keyboard.press('Enter');
await wait(900);
await snap('93-more');
await page.keyboard.press('Escape');
await command(page, 'Hoppy: Stop Using a Fixed Account in This Project');
await wait(1500);

await app.close();
console.log('capture2 done');
