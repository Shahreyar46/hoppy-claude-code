// Builds a sealed demo world for the tutorial screenshots: fake home folder with two Claude accounts
// (Work, Personal) and believable chat history, a router config with fake keys, a demo project, and
// an isolated VS Code profile. Nothing from the real user appears. Real keys are never read or printed.
import { mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
// Outside any git repo and away from the user's name, so paths on screen stay neutral.
const D = 'C:/hoppy-demo';
const HOME = join(D, 'home');
const APPDATA = join(D, 'appdata');
const PROJECT = join(D, 'acme-shop');
const USERDATA = join(D, 'user-data');
const EXT = join(D, 'extensions');
const REPO = join(ROOT, '..', '..');

if (existsSync(D)) rmSync(D, { recursive: true, force: true });
const w = (p, s) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, s));

// ---------- demo project ----------
const files = {
  'package.json': JSON.stringify({ name: 'acme-shop', version: '0.4.0', private: true, scripts: { dev: 'vite', build: 'vite build', test: 'vitest' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' } }, null, 2),
  'README.md': '# Acme Shop\n\nA small storefront: product list, cart and checkout.\n\n```bash\nnpm install\nnpm run dev\n```\n',
  'src/App.tsx': `import { useState } from 'react';
import { ProductList } from './components/ProductList';
import { Cart } from './components/Cart';
import { useTheme } from './hooks/useTheme';
import type { Product } from './types';

export default function App() {
    const [cart, setCart] = useState<Product[]>([]);
    const { theme, toggleTheme } = useTheme();

    const addToCart = (product: Product) => setCart((items) => [...items, product]);
    const removeFromCart = (id: string) => setCart((items) => items.filter((p) => p.id !== id));

    return (
        <main className={\`app app--\${theme}\`}>
            <header className="app__header">
                <h1>Acme Shop</h1>
                <button onClick={toggleTheme} aria-label="Toggle dark mode">
                    {theme === 'dark' ? 'Light' : 'Dark'} mode
                </button>
            </header>
            <ProductList onAdd={addToCart} />
            <Cart items={cart} onRemove={removeFromCart} />
        </main>
    );
}
`,
  'src/components/ProductList.tsx': `import { products } from '../data/products';
import type { Product } from '../types';

export function ProductList({ onAdd }: { onAdd: (p: Product) => void }) {
    return (
        <section className="products">
            {products.map((p) => (
                <article key={p.id} className="product">
                    <h2>{p.name}</h2>
                    <p className="product__price">\${p.price.toFixed(2)}</p>
                    <button onClick={() => onAdd(p)}>Add to cart</button>
                </article>
            ))}
        </section>
    );
}
`,
  'src/components/Cart.tsx': `import type { Product } from '../types';

export function Cart({ items, onRemove }: { items: Product[]; onRemove: (id: string) => void }) {
    const total = items.reduce((sum, p) => sum + p.price, 0);
    return (
        <aside className="cart">
            <h2>Cart ({items.length})</h2>
            {items.map((p) => (
                <div key={p.id} className="cart__row">
                    {p.name} <button onClick={() => onRemove(p.id)}>Remove</button>
                </div>
            ))}
            <strong>Total: \${total.toFixed(2)}</strong>
        </aside>
    );
}
`,
  'src/hooks/useTheme.ts': `import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export function useTheme() {
    const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'light');
    useEffect(() => localStorage.setItem('theme', theme), [theme]);
    return { theme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}
`,
  'src/data/products.ts': `import type { Product } from '../types';

export const products: Product[] = [
    { id: 'p1', name: 'Trail Backpack', price: 89 },
    { id: 'p2', name: 'Steel Bottle', price: 24 },
    { id: 'p3', name: 'Rain Shell', price: 129 },
];
`,
  'src/types.ts': `export interface Product {\n    id: string;\n    name: string;\n    price: number;\n}\n`,
  'src/styles.css': `.app { font-family: system-ui; padding: 24px; }\n.app--dark { background: #111; color: #eee; }\n.products { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }\n`,
};
for (const [p, s] of Object.entries(files)) w(join(PROJECT, p), s);

// ---------- demo Claude accounts with chat history ----------
const projectKey = PROJECT.replace(/[^A-Za-z0-9]/g, '-');
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function chat(dir, sessionId, turns, hoursAgo, model = 'claude-opus-5-5') {
  const lines = [];
  let parent = null;
  let t = Date.now() - hoursAgo * 3600000;
  for (const [user, reply, tokens] of turns) {
    const u = uid();
    lines.push({ type: 'user', uuid: u, parentUuid: parent, sessionId, cwd: PROJECT, timestamp: new Date(t).toISOString(), message: { role: 'user', content: user } });
    t += 40000;
    const a = uid();
    lines.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId, cwd: PROJECT, timestamp: new Date(t).toISOString(), message: { id: `msg_demo_${n}`, model, role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 4, cache_creation_input_tokens: Math.round(tokens * 0.6), cache_read_input_tokens: tokens * 3, output_tokens: Math.round(tokens * 0.4) } } });
    parent = a;
    t += 120000;
  }
  w(join(dir, 'projects', projectKey, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const WORK = join(HOME, '.claude');
const PERSONAL = join(HOME, '.claude-account2');
w(join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@acme.dev' } }));
w(join(WORK, '.credentials.json'), '{}');
w(join(PERSONAL, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@personal.dev' } }));
w(join(PERSONAL, '.credentials.json'), '{}');
const big = (k) => Array.from({ length: k }, (_, i) => [`Step ${i + 1}: refine the checkout form`, `Updated the checkout form, step ${i + 1}.`, 42000]);
chat(WORK, '7d1e2f30-0000-4000-8000-000000000001', [['Add dark mode to the shop', 'Added a theme toggle in App.tsx and a useTheme hook that remembers the choice.', 38000], ['Now update the tests', 'Added tests for useTheme: default theme, toggle, and saved preference.', 51000], ...big(10)], 3);
chat(WORK, '7d1e2f30-0000-4000-8000-000000000002', [['Why is the cart total wrong?', 'The total summed strings. Prices are numbers now and the total uses reduce.', 26000]], 20);
chat(PERSONAL, '9a8b7c60-0000-4000-8000-000000000003', [['Write a README for acme-shop', 'Wrote README.md with setup and scripts.', 9000]], 26);

// ---------- router config with fake keys (copied structure, every key replaced) ----------
const realDb = join(process.env.APPDATA, 'claude-code-router', 'config.sqlite');
const demoDb = join(APPDATA, 'claude-code-router', 'config.sqlite');
mkdirSync(dirname(demoDb), { recursive: true });
// Only the config row's structure is read from the real database (read-only); keys are replaced in
// memory and the demo database is created fresh, so no other real table (key store, backups) is copied.
const real = new DatabaseSync(realDb, { readOnly: true });
const cfg = JSON.parse(real.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get().value_json);
real.close();
const FAKE = { openrouter: 'sk-or-v1-demo0000000000000000000000000000000000000000000000000a1b2', gemini: 'AIzaDemoDemoDemoDemoDemoDemoDemoDem7Kq', deepseek: 'sk-demo00000000000000000000000004f2d', glm: 'demo0000000000000000.demoDemo9Zx' };
cfg.Providers = (cfg.Providers || []).filter((p) => FAKE[p.name]).map((p) => ({ ...p, api_key: FAKE[p.name] }));
const scrub = (o) => {
  for (const k of Object.keys(o || {})) {
    if (typeof o[k] === 'string' && /key|token|secret|password/i.test(k) && k !== 'api_key') o[k] = 'demo';
    else if (o[k] && typeof o[k] === 'object') scrub(o[k]);
  }
};
scrub(cfg);
const db = new DatabaseSync(demoDb);
db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
db.prepare("INSERT INTO app_config (key, value_json, updated_at) VALUES ('default', ?, ?)").run(JSON.stringify(cfg), new Date().toISOString());
db.close();

// ---------- VS Code profile ----------
const settings = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'window.titleBarStyle': 'custom',
  'window.commandCenter': true,
  'editor.fontSize': 15,
  'editor.minimap.enabled': false,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'hoppy.autoStartGateway': false,
  'hoppy.syncChatsOnSwitch': false,
  'hoppy.accountLabels': { [WORK]: 'Work', [PERSONAL]: 'Personal' },
  'git.openRepositoryInParentFolders': 'never',
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'security.workspace.trust.enabled': false,
  'hoppy.mainModel': 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
};
w(join(USERDATA, 'User', 'settings.json'), JSON.stringify(settings, null, 2));

// ---------- extensions: Claude Code (link) + Hoppy (installed from the vsix) ----------
mkdirSync(EXT, { recursive: true });
const realExt = join(homedir(), '.vscode', 'extensions');
const cc = execFileSync('cmd', ['/c', 'dir', '/b', join(realExt, 'anthropic.claude-code-*')]).toString().trim().split(/\r?\n/).pop();
symlinkSync(join(realExt, cc), join(EXT, cc), 'junction');
const code = join(REPO, '.vscode-test', 'vscode-win32-x64-archive-1.144.0', 'bin', 'code.cmd');
execFileSync('cmd', ['/c', code, '--extensions-dir', EXT, '--user-data-dir', USERDATA, '--install-extension', join(REPO, 'hoppy-claude-code-win32-x64-1.1.0.vsix'), '--force'], { stdio: 'inherit' });

writeFileSync(join(ROOT, 'paths.json'), JSON.stringify({ HOME, APPDATA, PROJECT, USERDATA, EXT, WORK, PERSONAL, projectKey }, null, 2));
console.log('demo ready:', D);
