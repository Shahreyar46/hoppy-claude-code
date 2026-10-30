// v2 part E: "another computer" = the sealed demo world (C:\hoppy-demo: fake home, fake accounts Work and
// Personal, fake keys). Imports the file exported in part D.
// Model choices and provider lists are removed from the copy first: importing them would re-apply the router,
// and on this PC that is the user's real one.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, mark, helpers, command, stubDialog, P } from './vsc.mjs';

if (process.env.REAL) throw new Error('run without REAL=1');
const src = JSON.parse(readFileSync(join(P.PROJECT, 'hoppy-settings.json'), 'utf8'));
delete src.settings.mainModel;
delete src.settings.smallModel;
delete src.settings.fallbackModels;
src.providers = {};
const file = join('C:/hoppy-demo', 'hoppy-settings-from-work-pc.json');
writeFileSync(file, JSON.stringify(src, null, 2));

const { app, page } = await launch();
const h = helpers(page);
const { wait, snap, toast } = h;
await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
await page.keyboard.press('Control+B');
let sf = await h.frameWith('main#panel');
await wait(2000);
await mark('F1-before', sf.locator('article.account').nth(1));
await snap('F1-before');
await stubDialog(app, 'open', file);
await command(page, 'Hoppy: Import Settings');
await wait(2500);
await mark('F2-imported', toast('imported'));
await snap('F2-imported');
await command(page, 'View: Close All Editors');
await command(page, 'Hoppy: Settings');
sf = await h.frameWith('main#panel');
await wait(2000);
await mark('F3-after', sf.locator('article.account').nth(1));
await mark('F3-after', page.locator('.statusbar-item').filter({ hasText: /Claude ·/ }).first(), 'status');
await snap('F3-after');
await page.keyboard.press('Control+B');
await app.close();
console.log('v2e done');
