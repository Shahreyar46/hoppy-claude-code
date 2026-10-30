// v2 part B: status bar, Hoppy menu, switching, add account, Settings > Accounts. Every highlight position
// is recorded from the real element.
import { launch, mark, helpers, command } from './vsc.mjs';

const { app, page } = await launch();
const h = helpers(page);
const { wait, snap, statusItem, openMenu, row } = h;

await command(page, 'View: Close All Editors');
await page.keyboard.press('Control+P');
await wait(300);
await page.keyboard.type('App.tsx', { delay: 15 });
await page.keyboard.press('Enter');
await wait(1500);
await mark('B1-statusbar', statusItem(), 'focus', 8);
await mark('B1-statusbar', statusItem(), 'click', 0);
await snap('B1-statusbar');

await openMenu();
await mark('B2-menu', page.locator('.quick-input-widget').first());
await mark('B2-menu', row('Claude · Work'), 'work');
await mark('B2-menu', row('Claude · Personal'), 'personal');
await mark('B2-menu', row('Other AI'), 'other');
await mark('B2-menu', page.locator('.quick-input-list .monaco-list-row').filter({ hasText: /tokens in 5h/ }).first(), 'usage');
await mark('B2-menu', row('Claude · Personal'), 'click', 0);
await snap('B2-menu');
await row('Claude · Personal').click();
await wait(10000);
await h.closeClaudeBanners();
await wait(600);
await mark('B3-switched', statusItem(), 'status');
await mark('B3-switched', page.locator('.part.editor').first());
await snap('B3-switched');

// add account
await openMenu();
await mark('B4-menu-add', row('Add Claude account'));
await mark('B4-menu-add', row('Add Claude account'), 'click', 0);
await snap('B4-menu-add');
await row('Add Claude account').click();
await wait(900);
await page.keyboard.type('Side project', { delay: 60 });
await wait(300);
await mark('B5-add-name', page.locator('.quick-input-widget').first());
await snap('B5-add-name');
await page.keyboard.press('Enter');
await wait(10000);
const login = await h.frameWith('button', 20000).catch(() => null);
if (login) await mark('B6-add-login', login.getByText('Claude.ai Subscription').first());
await mark('B6-add-login', statusItem(), 'status');
await snap('B6-add-login');

// Settings > Accounts
await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
await page.keyboard.press('Control+B');
let sf = await h.frameWith('main#panel');
await wait(2500);
await mark('B7-settings', sf.locator('.route').first(), 'route');
await mark('B7-settings', sf.locator('article.account').nth(0), 'work');
await mark('B7-settings', sf.locator('article.account').nth(1), 'personal');
await mark('B7-settings', sf.locator('article.account .usage').nth(0), 'usage');
await mark('B7-settings', sf.locator('.route .hop').filter({ hasText: 'Personal' }).first(), 'click', 0);
await snap('B7-settings');
// Back to Personal from the switcher (real click), then edit it.
await sf.locator('.route .hop').filter({ hasText: 'Personal' }).first().click();
await wait(9000);
await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
sf = await h.frameWith('main#panel');
await wait(2000);
const edit = sf.locator('article.account.is-current button[data-act="edit"]');
await mark('B8-edit', edit, 'click', 0);
await edit.click();
await wait(800);
await mark('B8-edit', sf.locator('article.account.is-current').first());
await mark('B8-edit', sf.locator('article.account.is-current .swatch').first(), 'swatch', 2);
await snap('B8-edit');
await sf.locator('article.account.is-current .swatch').first().click();
await wait(2500);
await mark('B9-color', statusItem(), 'status', 8);
await snap('B9-color');
await page.keyboard.press('Control+B');
await app.close();
console.log('v2b done');
