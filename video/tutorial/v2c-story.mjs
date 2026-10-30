// v2 part C: the real story. Work is really at its weekly limit (until Oct 31 6 AM).
// 1) On Work, open the earlier dark-mode chat from Claude's history (real past work) and ask for more.
// 2) The real limit hits; Hoppy's real popup; "Continue on Other AI"; Other AI continues the same chat.
// 3) On Personal, find that chat in history and open it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, mark, helpers, command, P } from './vsc.mjs';

const settingsFile = join(P.USERDATA + '-real', 'User', 'settings.json');
const st = JSON.parse(readFileSync(settingsFile, 'utf8'));
st['hoppy.syncChatsOnSwitch'] = true; // shared chats: history shows this project's chats on every account
writeFileSync(settingsFile, JSON.stringify(st, null, 2));

const { app, page } = await launch();
const h = helpers(page);
const { wait, snap, statusItem, openMenu, row, ask, watchReply, toast } = h;
const historyButton = (f) => f.locator('button[aria-label*="istory" i], button[title*="istory" i], button[aria-label*="ast conversation" i]').first();

async function openFromHistory(prefix, text) {
    const f = await h.ensureClaudeTab();
    const btn = historyButton(f);
    await mark(`${prefix}-history`, btn, 'click', 2);
    await btn.click();
    await wait(2500);
    const item = f.getByText(text).first();
    await mark(`${prefix}-history`, item);
    await snap(`${prefix}-history`);
    await item.click();
    await wait(7000);
    return f;
}

// ---- 1) deep in a task on Work ----
await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+P');
await wait(300);
await page.keyboard.type('App.tsx', { delay: 15 });
await page.keyboard.press('Enter');
await wait(1200);
await openMenu();
await row('Claude · Work').click();
await wait(11000);
await h.closeClaudeBanners();
await openFromHistory('D1', 'dark mode toggle');
await mark('D2-task', page.locator('.part.editor').first());
await mark('D2-task', statusItem(), 'status');
await snap('D2-task');

// ---- 2) the real limit and Hoppy's real popup ----
let { f, box } = await ask('Next: add a cart count badge next to the shop title.');
await mark('D3-ask', box);
await snap('D3-ask');
await page.keyboard.press('Enter');
const popup = toast('Keep this chat going');
for (let i = 0; i < 30 && !(await popup.count()); i++) await wait(1000);
if (!(await popup.count())) throw new Error('no Hoppy popup');
await wait(800);
await mark('D4-popup', popup);
await mark('D4-popup', popup.getByRole('button', { name: /Continue on Other AI/ }), 'click', 2);
await mark('D4-popup', f.getByText(/hit your weekly limit/).first(), 'banner').catch(() => undefined);
await mark('D4-popup', statusItem(), 'status');
await snap('D4-popup');
await popup.getByRole('button', { name: /Continue on Other AI/ }).click();
await wait(14000);
await h.closeClaudeBanners();
// "Reload all tabs?" info: dismiss so the shot is clean
const info = toast('continues on');
await mark('D5-on-other', info);
await mark('D5-on-other', statusItem(), 'status');
await snap('D5-on-other');
if (await info.count()) await info.locator('.codicon-notifications-clear, .codicon-close').first().click().catch(() => undefined);
const offer = toast('without asking');
if (await offer.count()) {
    await mark('D6-always', offer);
    await snap('D6-always');
    await offer.getByRole('button', { name: 'Keep asking' }).click().catch(() => undefined);
}
({ f, box } = await ask('Please continue: add the cart count badge next to the shop title.'));
await mark('D7-ask-other', box);
await snap('D7-ask-other');
await page.keyboard.press('Enter');
await watchReply(f, 'D8-other', 240000, 3000);
await mark('D9-other-done', page.locator('.part.editor').first());
await snap('D9-other-done');

// ---- 3) the same chat from Personal's history ----
await command(page, 'View: Close All Editors');
await openMenu();
await row('Claude · Personal').click();
await wait(11000);
await h.closeClaudeBanners();
await openFromHistory('D10', 'dark mode toggle');
await mark('D11-personal-chat', page.locator('.part.editor').first());
await mark('D11-personal-chat', statusItem(), 'status');
await snap('D11-personal-chat');
await app.close();
console.log('v2c done');
