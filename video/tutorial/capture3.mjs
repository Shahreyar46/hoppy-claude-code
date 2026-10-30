// Chapter 5, the limit scene. A real Work tab, a message, then a limit notice added to that chat's file
// (a real limit cannot be forced). Everything Hoppy does from there is real: the popup, the carry-over to
// Personal, the "always" offer, the real reply on Personal and the menu marking Work.
import { readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launch, cleanShot, P } from './vsc.mjs';

const { app, page } = await launch();
const wait = (ms) => page.waitForTimeout(ms);
const snap = async (name) => {
    await page.mouse.move(900, 600);
    return cleanShot(page, name);
};
const statusItem = () => page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();
const claudeInput = '[role="textbox"][aria-label="Message input"]';

async function frameWith(selector, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        for (const f of page.frames().filter((x) => x !== page.mainFrame())) {
            const el = f.locator(selector).first();
            if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return f;
        }
        await wait(500);
    }
    throw new Error(`no visible frame with ${selector}`);
}
async function menuPick(label) {
    await statusItem().click();
    await wait(900);
    await page.keyboard.type(label, { delay: 30 });
    await wait(500);
}
async function ask(text) {
    const f = await frameWith(claudeInput);
    const box = f.locator(claudeInput).last();
    await box.click();
    await box.type(text, { delay: 35 });
    return f;
}
async function watchReply(f, prefix, maxMs = 120000) {
    let last = '';
    let stableSince = Date.now();
    const start = Date.now();
    for (let i = 1; Date.now() - start < maxMs; i++) {
        await wait(2500);
        await snap(`${prefix}-${String(i).padStart(2, '0')}`);
        const text = await f.evaluate(() => document.body.innerText).catch(() => '');
        if (text !== last) {
            last = text;
            stableSince = Date.now();
        } else if (Date.now() - stableSince > 9000 && Date.now() - start > 12000) return;
    }
}
const toast = (text) => page.locator('.notifications-toasts .notification-toast').filter({ hasText: text }).first();

// Start on Work, in a new tab, with the code open beside it.
await menuPick('Work');
await page.keyboard.press('Enter');
await wait(10000);
let f = await ask('Add a cart count badge next to the shop title.');
await snap('L1-typed');
await page.keyboard.press('Enter');
await wait(2500);
await page.keyboard.press('Escape'); // stop: only the limit should answer in this scene
await wait(1500);
await snap('L2-sent');

// The chat file this Work tab just wrote to.
const proj = join(homedir(), '.claude', 'projects', P.projectKey ? P.PROJECT.replace(/[^A-Za-z0-9]/g, '-') : '');
const newest = readdirSync(proj)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => ({ n, t: statSync(join(proj, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
const file = join(proj, newest.n);
const sessionId = newest.n.replace(/\.jsonl$/, '');
const resetAt = new Date(Date.now() + 4 * 3600000);
const h = resetAt.getHours() % 12 || 12;
const text = `You've hit your session limit · resets ${h}${resetAt.getHours() < 12 ? 'am' : 'pm'} (Asia/Dhaka)`;
appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: `limit-${Date.now()}`, isApiErrorMessage: true, sessionId, timestamp: new Date().toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');

// Hoppy's real popup
let popup = null;
for (let i = 0; i < 20 && !popup; i++) {
    await wait(500);
    if (await toast('Keep this chat going').count()) popup = toast('Keep this chat going');
}
if (!popup) throw new Error('Hoppy popup did not appear');
await snap('L3-popup');
await popup.getByRole('button', { name: /Continue on Personal/ }).hover();
await wait(300);
await snap('L4-popup-hover');
await popup.getByRole('button', { name: /Continue on Personal/ }).click();
await wait(10000);
await snap('L5-continued');
await wait(1500);
const offer = toast('without asking');
if (await offer.count()) {
    await snap('L6-always-offer');
    await offer.getByRole('button', { name: 'Keep asking' }).click().catch(() => undefined);
}
f = await ask('Please continue: add the cart count badge.');
await page.keyboard.press('Enter');
await watchReply(f, 'L7-reply');
await snap('L8-reply-done');
await menuPick('');
await snap('L9-menu-limited');
await page.keyboard.press('Escape');
await app.close();
console.log('capture3 done');
