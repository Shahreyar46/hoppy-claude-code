// Launches the demo VS Code with Playwright and exposes helpers for the capture script.
import { _electron as electron } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
export const P = JSON.parse(readFileSync(join(ROOT, 'paths.json'), 'utf8'));
const CODE = join(ROOT, '..', '..', '.vscode-test', 'vscode-win32-x64-archive-1.144.0', 'Code.exe');
export const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });

// REAL=1: the user's real home (logged-in Claude accounts, running router), separate VS Code profile.
export const REAL = !!process.env.REAL;
export async function launch() {
    const env = REAL ? { ...process.env } : { ...process.env, USERPROFILE: P.HOME, HOME: P.HOME, APPDATA: P.APPDATA };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDE_CONFIG_DIR;
    const app = await electron.launch({
        executablePath: CODE,
        args: [P.PROJECT, '--user-data-dir', REAL ? P.USERDATA + '-real' : P.USERDATA, '--extensions-dir', P.EXT, '--disable-workspace-trust', '--skip-release-notes', '--disable-gpu-sandbox', '--new-window'],
        env,
        timeout: 60000,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setContentSize(1920, 1080);
        w.setPosition(0, 0);
    });
    await page.waitForTimeout(4000);
    await dismissOnboarding(page);
    return { app, page };
}

/** VS Code's first-run welcome (sign in, theme...) covers the window; skip through it. */
export async function dismissOnboarding(page) {
    for (let i = 0; i < 6; i++) {
        const overlay = page.locator('.onboarding-a-overlay.visible');
        if (!(await overlay.count())) {
            await page.waitForTimeout(1500);
            if (!(await overlay.count())) {
                return;
            }
        }
        const skip = page.getByText('Continue without Signing In');
        if (await skip.count()) {
            await skip.first().click().catch(() => undefined);
        } else {
            await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(1200);
    }
}

export async function shot(page, name) {
    const file = join(SHOTS, `${name}.png`);
    // While Claude streams, the page can be busy for a moment ("waiting for fonts"); try again rather than stop.
    for (let i = 0; i < 3; i++) {
        try {
            await page.screenshot({ path: file, timeout: 15000, animations: 'allow', caret: 'initial' });
            console.log('shot', name);
            return file;
        } catch {
            await page.waitForTimeout(1500);
        }
    }
    console.log('shot skipped', name);
    return null;
}

/** Runs a VS Code command through the command palette, like a user would. */
export async function command(page, title) {
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(400);
    await page.keyboard.type(title, { delay: 15 });
    await page.waitForTimeout(600);
    // Fuzzy search can rank a "recently used" neighbour first; click the row whose label is exactly the title.
    const rows = page.locator('.quick-input-list .monaco-list-row');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
        const label = ((await rows.nth(i).locator('.label-name').first().textContent().catch(() => '')) || '').trim();
        if (label === title) {
            await rows.nth(i).click();
            await page.waitForTimeout(800);
            return;
        }
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
}

// ---------- privacy: swap real emails, key endings and user paths for demo text on screen ----------
import { homedir as _home } from 'node:os';
import { execFileSync as _exec } from 'node:child_process';

function realEmail(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8')).oauthAccount?.emailAddress;
    } catch {
        return undefined;
    }
}

/** Pairs [real, demo]. Built in memory only; never printed or written. */
export function maskMap() {
    const h = _home();
    const pairs = [];
    const work = realEmail(join(h, '.claude.json')) || realEmail(join(h, '.claude', '.claude.json'));
    const personal = realEmail(join(h, '.claude-account2', '.claude.json'));
    if (work) pairs.push([work, 'work@acme.dev']);
    if (personal) pairs.push([personal, 'me@personal.dev']);
    try {
        const status = JSON.parse(_exec('node', ['--no-warnings', join(ROOT, '..', '..', 'scripts', 'ccr-config.mjs'), 'status']).toString());
        const demo = { openrouter: 'a1b2', gemini: 'm7Kq', deepseek: '4f2d', glm: 'o9Zx' };
        for (const p of status.providers || []) {
            if (p.keyHint) pairs.push([`••••${p.keyHint}`, `••••${demo[p.name] || 'demo'}`]);
        }
    } catch {
        // no router: nothing to mask
    }
    pairs.push([h, 'C:\\Users\\dev'], [h.replace(/\\/g, '/'), 'C:/Users/dev']);
    return pairs;
}
function require_basename(p) {
    return p.split(/[\\/]/).pop();
}

let MAP;
/** Replaces sensitive text in every frame (workbench, quick pick, webviews) right before a screenshot. */
export async function mask(page) {
    MAP ||= maskMap();
    for (const f of page.frames()) {
        await f
            .evaluate((map) => {
                const fix = (s) => {
                    for (const [a, b] of map) s = s.split(a).join(b);
                    return s;
                };
                const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
                for (let n = w.nextNode(); n; n = w.nextNode()) {
                    const t = fix(n.nodeValue);
                    if (t !== n.nodeValue) n.nodeValue = t;
                }
                for (const el of document.querySelectorAll('[title],[aria-label],input,textarea')) {
                    for (const attr of ['title', 'aria-label', 'value', 'placeholder']) {
                        const v = el.getAttribute(attr);
                        if (v && fix(v) !== v) el.setAttribute(attr, fix(v));
                    }
                    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && fix(el.value) !== el.value) el.value = fix(el.value);
                }
            }, MAP)
            .catch(() => undefined);
    }
}

/** Fails loudly if any real email or the user name is still visible anywhere. */
export async function assertClean(page, name) {
    MAP ||= maskMap();
    const secrets = MAP.map(([a]) => a).filter((a) => a.length > 3);
    for (const f of page.frames()) {
        const text = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        for (const s of secrets) {
            if (text.includes(s)) throw new Error(`${name}: real data still on screen in a frame (pattern #${secrets.indexOf(s)})`);
        }
    }
}

export async function cleanShot(page, name) {
    await mask(page);
    await page.waitForTimeout(80);
    await mask(page);
    await assertClean(page, name);
    return shot(page, name);
}

// ---------- shared scene helpers (v2) ----------
import { writeFileSync as _write } from 'node:fs';
export const BOXES = {};
const BOX_FILE = join(ROOT, 'boxes.json');
try {
    Object.assign(BOXES, JSON.parse(readFileSync(BOX_FILE, 'utf8')));
} catch {
    // first run
}
/** Remembers where a control is in a shot (page pixels), so the video highlights exactly that spot. */
export async function mark(shotName, locator, key = 'focus', pad = 6) {
    const b = await locator.boundingBox().catch(() => null);
    if (!b) return null;
    BOXES[shotName] ||= {};
    BOXES[shotName][key] = [Math.round(b.x - pad), Math.round(b.y - pad), Math.round(b.x + b.width + pad), Math.round(b.y + b.height + pad)];
    _write(BOX_FILE, JSON.stringify(BOXES, null, 1));
    return b;
}

export function helpers(page) {
    const wait = (ms) => page.waitForTimeout(ms);
    const statusItem = () => page.locator('.statusbar-item').filter({ hasText: /Claude ·|Other AI/ }).first();
    async function frameWith(selector, timeout = 30000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            // Newest frames last: prefer the most recently opened tab (a new Claude tab sits beside the old one).
            for (const f of page.frames().filter((x) => x !== page.mainFrame()).reverse()) {
                const el = f.locator(selector).first();
                if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return f;
            }
            await wait(500);
        }
        throw new Error(`no visible frame with ${selector}`);
    }
    const claudeInput = '[role="textbox"][aria-label="Message input"]';
    async function snap(name) {
        await page.mouse.move(960, 560);
        return cleanShot(page, name);
    }
    async function openMenu() {
        await statusItem().click();
        await wait(900);
    }
    /** Quick pick row whose label contains text. */
    const row = (text) => page.locator('.quick-input-list .monaco-list-row').filter({ hasText: text }).first();
    async function closeClaudeBanners() {
        for (const f of page.frames()) {
            for (const label of ['Close', 'Dismiss']) {
                const b = f.locator(`[aria-label="${label}"]`);
                const n = await b.count().catch(() => 0);
                for (let i = 0; i < n; i++) await b.nth(i).click({ timeout: 500 }).catch(() => undefined);
            }
        }
    }
    /** Makes sure a Claude tab is showing (picking the account already in use opens nothing). */
    async function ensureClaudeTab() {
        const ok = await frameWith(claudeInput, 6000).catch(() => null);
        if (ok) return ok;
        const { command: cmd } = await import('./vsc.mjs');
        await cmd(page, 'Claude Code: Open in New Tab');
        await wait(9000);
        await closeClaudeBanners();
        return frameWith(claudeInput);
    }
    async function ask(text) {
        const f = await ensureClaudeTab();
        const box = f.locator(claudeInput).last();
        await box.click({ timeout: 60000 });
        await box.type(text, { delay: 35 });
        return { f, box };
    }
    async function watchReply(f, prefix, maxMs = 150000, every = 2500) {
        let last = '';
        let stableSince = Date.now();
        const start = Date.now();
        for (let i = 1; Date.now() - start < maxMs; i++) {
            await wait(every);
            await snap(`${prefix}-${String(i).padStart(2, '0')}`);
            const text = await f.evaluate(() => document.body.innerText).catch(() => '');
            if (text !== last) {
                last = text;
                stableSince = Date.now();
            } else if (Date.now() - stableSince > 9000 && Date.now() - start > 12000) return i;
        }
        return -1;
    }
    const toast = (text) => page.locator('.notifications-toasts .notification-toast').filter({ hasText: text }).first();
    return { wait, statusItem, frameWith, claudeInput, snap, openMenu, row, closeClaudeBanners, ask, watchReply, toast, ensureClaudeTab };
}

/** Answers the next native save/open dialog in the main process (native dialogs cannot be clicked). */
export async function stubDialog(app, kind, filePath) {
    await app.evaluate(({ dialog }, [k, p]) => {
        if (k === 'save') {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
        } else {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
        }
    }, [kind, filePath]);
}
