// v2 part D: AI Providers, Models, Backups (real check, nothing saved), Other AI /model, Ctrl+Alt+H,
// project pin, More menu, Export settings (saved into the project so the file can be shown).
// Nothing here saves router settings: no Test & save, no Save models/backups (the router is the real one).
import { launch, mark, helpers, command, stubDialog, P } from './vsc.mjs';
import { join } from 'node:path';

const EXPORT_FILE = join(P.PROJECT, 'hoppy-settings.json');
const { app, page } = await launch();
const h = helpers(page);
const { wait, snap, statusItem, openMenu, row, toast } = h;

await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
await page.keyboard.press('Control+B');
let sf = await h.frameWith('main#panel');
await wait(2500);

// ---- AI Providers ----
await sf.locator('#tab-providers').click();
await wait(1500);
await mark('E1-providers', sf.locator('#tab-providers'), 'click', 4);
await mark('E1-providers', sf.locator('article.prow').first(), 'first');
await mark('E1-providers', sf.locator('h2.section').filter({ hasText: 'Connected' }).first(), 'connected');
await mark('E1-providers', sf.locator('h2.section').filter({ hasText: /Add another|Choose a service/ }).first(), 'add');
await snap('E1-providers');
const groqConnect = sf.locator('#prov-groq button[data-act="open-key"]');
await mark('E2-connect', groqConnect, 'click', 2);
await groqConnect.click();
await wait(700);
await sf.locator('#key-groq').type('gsk_••••••••••••••••', { delay: 40 });
await mark('E2-connect', sf.locator('#prov-groq').first());
await mark('E2-connect', sf.locator('#prov-groq .steps').first(), 'steps');
await mark('E2-connect', sf.locator('#prov-groq button[data-act="save-key"]').first(), 'save', 2);
await snap('E2-connect');
await sf.locator('#prov-groq button[data-act="close-key"]').click().catch(() => undefined);

// ---- Models ----
await sf.locator('#tab-models').click();
await wait(1500);
await mark('E3-models', sf.locator('#tab-models'), 'click', 4);
await mark('E3-models', sf.locator('select').nth(0), 'main');
await mark('E3-models', sf.locator('select').nth(1), 'helper');
await mark('E3-models', sf.locator('.model-list, ul, .list').first(), 'list').catch(() => undefined);
await mark('E3-models', sf.locator('button[data-act="save-models"]').first(), 'save', 2);
await snap('E3-models');

// ---- Backups: real check, then undo the reorder ----
await sf.locator('#tab-fallback').click();
await wait(1500);
await mark('E4-backups', sf.locator('#tab-fallback'), 'click', 4);
await mark('E4-backups', sf.locator('ol.chain').first(), 'chain');
await mark('E4-backups', sf.locator('button[data-act="check-models"]').first(), 'check', 2);
await snap('E4-backups');
await sf.locator('button[data-act="check-models"]').click();
for (let i = 0; i < 40; i++) {
    await wait(1500);
    sf = await h.frameWith('main#panel');
    if (await sf.locator('button[data-act="check-models"]', { hasText: 'Check again' }).count()) break;
}
await wait(800);
await mark('E5-checked', sf.locator('.healthbar').first(), 'bar');
await mark('E5-checked', sf.locator('ol.chain').first());
await snap('E5-checked');
if (await sf.locator('button[data-act="working-first"]').count()) {
    await mark('E6-working-first', sf.locator('button[data-act="working-first"]'), 'click', 2);
    await sf.locator('button[data-act="working-first"]').click();
    await wait(800);
    await mark('E6-working-first', sf.locator('ol.chain').first());
    await snap('E6-working-first');
    await sf.locator('button[data-act="reset"]').click().catch(() => undefined);
}
await page.keyboard.press('Control+B');

// ---- Other AI: /model ----
await command(page, 'View: Close All Editors');
await openMenu();
await mark('E7-menu-other', row('Other AI'));
await snap('E7-menu-other');
await row('Other AI').click();
await wait(11000);
await h.closeClaudeBanners();
const f = await h.ensureClaudeTab();
const box = f.locator(h.claudeInput).last();
await box.click();
await box.type('/model', { delay: 60 });
await wait(1500);
await mark('E8-model-list', f.getByText('Switch model').first()).catch(() => undefined);
await mark('E8-model-list', box, 'input');
await snap('E8-model-list');
await page.keyboard.press('Escape');
await box.press('Control+A').catch(() => undefined);
await box.press('Backspace').catch(() => undefined);

// ---- Ctrl+Alt+H ----
await mark('E9-before-flip', statusItem(), 'status', 8);
await snap('E9-before-flip');
await page.keyboard.press('Control+Alt+H');
await wait(9000);
await mark('E10-flip', statusItem(), 'status', 8);
await mark('E10-flip', toast('Now on'), 'toast').catch(() => undefined);
await snap('E10-flip');

// ---- pin this project ----
await openMenu();
await mark('E11-pin', row('Always use'));
await snap('E11-pin');
await row('Always use').click();
await wait(1200);
await mark('E12-pinned', toast('always uses'));
await snap('E12-pinned');

// ---- More: export ----
await openMenu();
await row('More').click();
await wait(900);
await mark('E13-more', page.locator('.quick-input-widget').first());
await mark('E13-more', row('Export settings'), 'export');
await mark('E13-more', row('second-opinion'), 'skill');
await snap('E13-more');
await stubDialog(app, 'save', EXPORT_FILE);
await row('Export settings').click();
await wait(1500);
await mark('E14-exported', toast('exported'));
await snap('E14-exported');
await page.keyboard.press('Control+P');
await wait(300);
await page.keyboard.type('hoppy-settings.json', { delay: 30 });
await page.keyboard.press('Enter');
await wait(1500);
await mark('E15-file', page.locator('.part.editor').first());
await snap('E15-file');
await command(page, 'Hoppy: Stop Using a Fixed Account in This Project');
await app.close();
console.log('v2d done');
