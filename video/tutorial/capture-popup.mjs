// Limit popup, captured in the sealed demo world (C:\hoppy-demo: fake home and fake accounts created by
// make-demo.mjs). Real chat files are never touched. The popup is Hoppy's real UI; the video composites
// it over the real Work chat.
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, cleanShot, P } from './vsc.mjs';

if (process.env.REAL) throw new Error('run without REAL=1: this scene uses the demo world only');
const { app, page } = await launch();
const wait = (ms) => page.waitForTimeout(ms);
const snap = async (name) => {
    await page.mouse.move(900, 600);
    return cleanShot(page, name);
};
const toast = (text) => page.locator('.notifications-toasts .notification-toast').filter({ hasText: text }).first();

await page.keyboard.press('Control+P');
await wait(300);
await page.keyboard.type('App.tsx', { delay: 15 });
await page.keyboard.press('Enter');
await wait(2500);

// The demo Work account's chat for acme-shop (demo file written by make-demo.mjs).
const proj = join(P.WORK, 'projects', P.projectKey);
const name = readdirSync(proj).find((n) => n.endsWith('.jsonl'));
const resetAt = new Date(Date.now() + 4 * 3600000);
const h = resetAt.getHours() % 12 || 12;
const text = `You've hit your session limit · resets ${h}${resetAt.getHours() < 12 ? 'am' : 'pm'}`;
appendFileSync(join(proj, name), JSON.stringify({ type: 'assistant', uuid: `demo-limit-${Date.now()}`, isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');

let popup = null;
for (let i = 0; i < 20 && !popup; i++) {
    await wait(500);
    if (await toast('Keep this chat going').count()) popup = toast('Keep this chat going');
}
if (!popup) throw new Error('popup did not appear');
await snap('P1-popup');
await popup.getByRole('button', { name: /Continue on Personal/ }).hover();
await wait(300);
await snap('P2-popup-hover');
await popup.getByRole('button', { name: /Continue on Personal/ }).click();
await wait(6000);
await snap('P3-after');
await wait(1500);
if (await toast('without asking').count()) await snap('P4-always-offer');
const item = page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();
await item.click();
await wait(900);
await snap('P5-menu-limited');
await page.keyboard.press('Escape');
await app.close();
console.log('popup capture done');
