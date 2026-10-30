import { launch, helpers, command } from './vsc.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const { app, page } = await launch();
const h = helpers(page);
await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+P'); await h.wait(300); await page.keyboard.type('App.tsx', { delay: 15 }); await page.keyboard.press('Enter'); await h.wait(1000);
await h.openMenu(); await h.row('Claude · Work').click(); await h.wait(10000);
const { f } = await h.ask('hi');
await page.keyboard.press('Enter');
for (let i = 0; i < 20; i++) {
  await h.wait(1000);
  const t = await page.locator('.notifications-toasts .notification-toast').allInnerTexts();
  if (t.length) { console.log('TOASTS:', t.map((x) => x.replace(/\s+/g, ' ').slice(0, 160))); break; }
}
await h.wait(1500);
await page.screenshot({ path: 'shots/probe-popup.png' });
// Hoppy log
const logs = join(process.env.P_USERDATA || '', 'logs');
await app.close();
