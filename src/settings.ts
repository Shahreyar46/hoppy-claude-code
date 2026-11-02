import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ccrStatus, isGatewayUp, runHelper } from './gateway';
import { applyToCcr, checkKey, CLAUDE_MODEL, defaultModels, listProviderModels, modelsUrlFor } from './setup';
import { allProviders, baseFor, checkBaseUrl, customId, customProviders, findProvider, NO_KEY, normalizeBase, PROVIDERS, providerOptions, ProviderInfo, setProviderOptions } from './providers';
import { findEntry, limitLabel, loadCatalog, Tier } from './catalog';
import { ACCOUNT_COLORS, colorFor, currentTarget, describe, listTargets, setColor } from './targets';
import { cachedUsage, formatTokens, modelLabel } from './usage';
import { checkModels, HealthResult } from './health';

export interface CatalogModel {
    selector: string;
    provider: string;
    name: string;
    free: boolean;
    priceIn?: number;
    priceOut?: number;
    ctx?: number;
    vision: boolean;
    /** From the built-in catalog, when it knows the model. */
    tools?: boolean;
    limits?: string;
    rpd?: number;
    tier?: Tier;
}

/** Models offered for providers that are not OpenRouter (their APIs have no public catalog). */
const STATIC_MODELS: CatalogModel[] = [
    { selector: 'gemini/gemini-3.8-flash', provider: 'gemini', name: 'Gemini 3.8 Flash', free: true, ctx: 1048576, vision: true },
    { selector: 'gemini/gemini-3.1-pro-preview', provider: 'gemini', name: 'Gemini 3.1 Pro (paid tier only)', free: false, ctx: 1048576, vision: true },
    { selector: 'deepseek/deepseek-chat', provider: 'deepseek', name: 'DeepSeek Chat', free: false, ctx: 163840, vision: false },
    { selector: 'deepseek/deepseek-reasoner', provider: 'deepseek', name: 'DeepSeek Reasoner', free: false, ctx: 163840, vision: false },
    { selector: 'glm/glm-5.3', provider: 'glm', name: 'GLM 5.3', free: false, ctx: 1048576, vision: false },
];

const secretKey = (id: string) => `hoppy.key.${id}`;

let openRouterCache: CatalogModel[] | undefined;
const providerCache = new Map<string, { at: number; models: CatalogModel[]; failed?: boolean }>();

/** Live models of an OpenAI-compatible provider, read with the key saved in secret storage. */
async function providerCatalog(info: ProviderInfo, key: string | undefined): Promise<CatalogModel[]> {
    if (!modelsUrlFor(info) || !key) {
        return [];
    }
    const hit = providerCache.get(info.id);
    // A failed fetch is remembered for 2 minutes, so a provider that is down does not slow every refresh.
    if (hit && Date.now() - hit.at < (hit.failed ? 2 : 10) * 60000) {
        return hit.models;
    }
    let listed: Awaited<ReturnType<typeof listProviderModels>>;
    try {
        listed = await listProviderModels(info, key);
    } catch (err) {
        providerCache.set(info.id, { at: Date.now(), models: [], failed: true });
        throw err;
    }
    const models = listed.map<CatalogModel>((m) => ({
        selector: `${info.id}/${m.id}`,
        provider: info.id,
        name: m.id,
        free: info.group === 'free' || info.group === 'local' || info.group === 'community',
        ctx: m.ctx,
        vision: /vl|vision|pixtral|llama-4/i.test(m.id),
    }));
    providerCache.set(info.id, { at: Date.now(), models });
    return models;
}

/** OpenRouter models that support tool calling (Claude Code cannot work without tools). */
async function openRouterCatalog(): Promise<CatalogModel[]> {
    if (openRouterCache) {
        return openRouterCache;
    }
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const data: any[] = ((await r.json()) as any).data;
    openRouterCache = data
        .filter((m) => (m.supported_parameters || []).includes('tools') && !CLAUDE_MODEL.test(m.id))
        .map((m) => {
            const pin = Number(m.pricing?.prompt ?? 0) * 1e6;
            const pout = Number(m.pricing?.completion ?? 0) * 1e6;
            return {
                selector: `openrouter/${m.id}`,
                provider: 'openrouter',
                name: m.name || m.id,
                free: m.id.endsWith(':free') || (pin === 0 && pout === 0),
                priceIn: pin,
                priceOut: pout,
                ctx: m.context_length,
                vision: (m.architecture?.input_modalities || []).includes('image'),
            };
        });
    return openRouterCache;
}

/** Context window of an Other AI model, when its catalog knows it. */
export async function modelContext(selector: string): Promise<number | undefined> {
    const known = STATIC_MODELS.find((m) => m.selector === selector)?.ctx ?? [...providerCache.values()].flatMap((c) => c.models).find((m) => m.selector === selector)?.ctx;
    if (known || !selector.startsWith('openrouter/')) {
        return known;
    }
    try {
        return (await openRouterCatalog()).find((m) => m.selector === selector)?.ctx;
    } catch {
        return undefined;
    }
}

/**
 * Adds what the built-in catalog knows (free, tools, vision, limits, tier) to a model. The catalog wins for
 * "free" because a provider's free tier often covers only some of its models (GLM Flash).
 */
export function enrich(m: CatalogModel, extensionPath: string): CatalogModel {
    const e = findEntry(loadCatalog(extensionPath), m.selector);
    if (!e) {
        return m;
    }
    return {
        ...m,
        name: m.name === m.selector.split('/').slice(1).join('/') ? e.label : m.name,
        free: m.provider === 'openrouter' ? m.free : e.free,
        ctx: m.ctx ?? e.context,
        vision: m.vision || !!e.vision,
        tools: e.tools,
        limits: limitLabel(e),
        rpd: e.rpd,
        tier: e.tier,
    };
}

/** Catalog models for providers without a usable model list (Cloudflare, GLM, Gemini, DeepSeek). */
function builtInModels(extensionPath: string): CatalogModel[] {
    const listed = new Set(STATIC_MODELS.map((m) => m.selector));
    const extra = loadCatalog(extensionPath)
        .models.filter((e) => {
            const p = PROVIDERS.find((x) => x.id === e.provider);
            return p && !modelsUrlFor(p) && p.id !== 'openrouter' && !listed.has(`${e.provider}/${e.id}`);
        })
        .map<CatalogModel>((e) => ({ selector: `${e.provider}/${e.id}`, provider: e.provider, name: e.label, free: e.free, ctx: e.context, vision: !!e.vision }));
    return [...STATIC_MODELS, ...extra];
}

export class SettingsPanel {
    private static current: SettingsPanel | undefined;
    /** Set by the extension: "resets 12:50am" when an account is at its limit. */
    static limitLabel: (dir: string) => string | undefined = () => undefined;
    private readonly panel: vscode.WebviewPanel;

    static show(context: vscode.ExtensionContext, tab?: string): void {
        if (!SettingsPanel.current) {
            SettingsPanel.current = new SettingsPanel(context);
        }
        SettingsPanel.current.panel.reveal();
        if (tab) {
            // A freshly created page is not listening yet; the tab also rides along with the next state.
            SettingsPanel.current.pendingTab = tab;
            SettingsPanel.current.post({ type: 'setTab', tab });
        }
    }

    private pendingTab?: string;
    /** Last model check results, by selector; kept while the panel is open. */
    private health: Record<string, HealthResult> = {};

    static refresh(): void {
        SettingsPanel.current?.sendState();
    }

    private constructor(private readonly context: vscode.ExtensionContext) {
        const media = vscode.Uri.joinPath(context.extensionUri, 'media');
        this.panel = vscode.window.createWebviewPanel('hoppySettings', 'Hoppy Settings', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [media],
        });
        this.panel.iconPath = new vscode.ThemeIcon('settings-gear');
        this.panel.webview.html = this.html(media);
        this.panel.onDidDispose(() => (SettingsPanel.current = undefined));
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((err) => this.toast('error', String(err?.message || err))));
    }

    private html(media: vscode.Uri): string {
        const w = this.panel.webview;
        const nonce = crypto.randomBytes(16).toString('base64');
        const css = w.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css'));
        const js = w.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js'));
        const icon = w.asWebviewUri(vscode.Uri.joinPath(media, 'icon.svg'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Hoppy Settings</title>
</head>
<body>
<div id="app" data-icon="${icon}"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }

    private post(msg: object): void {
        this.panel.webview.postMessage(msg);
    }

    private toast(kind: 'info' | 'error' | 'busy', text: string): void {
        this.post({ type: 'toast', kind, text });
    }

    async sendState(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('hoppy');
        const status = await ccrStatus(this.context.extensionPath);
        const providerState = await Promise.all(
            allProviders().map(async (p: ProviderInfo) => {
                const live = status.providers?.find((x) => x.name === p.id);
                return {
                    id: p.id,
                    label: p.label,
                    group: p.group,
                    note: p.note,
                    tags: p.tags,
                    keyUrl: p.keyUrl,
                    warning: p.warning ?? null,
                    needs: p.needs ?? null,
                    keyOptional: !!p.keyOptional,
                    custom: !!p.custom,
                    options: providerOptions(p.id),
                    defaultBase: p.needs === 'url' ? p.base : null,
                    enabled: !!live?.hasKey,
                    keyHint: live?.keyHint === NO_KEY.slice(-4) ? null : live?.keyHint ?? null,
                    savedKey: !!(await this.context.secrets.get(secretKey(p.id))),
                    models: live?.models ?? [],
                };
            }),
        );
        let catalog: CatalogModel[] = builtInModels(this.context.extensionPath);
        let catalogError: string | undefined;
        try {
            catalog = [...(await openRouterCatalog()), ...catalog];
        } catch (err) {
            catalogError = `Could not load the OpenRouter catalog (${String(err)}). Showing enabled models only.`;
        }
        for (const p of providerState.filter((x) => x.enabled)) {
            const info = findProvider(p.id);
            if (!info || !modelsUrlFor(info)) {
                continue;
            }
            try {
                catalog.push(...(await providerCatalog(info, await this.context.secrets.get(secretKey(info.id)))));
            } catch (err) {
                catalogError = `Could not load the ${info.label} model list (${String(err)}).`;
            }
        }
        // Anything enabled in ccr but missing from the catalog still shows up.
        for (const p of providerState) {
            for (const m of p.models) {
                const selector = `${p.id}/${m}`;
                if (!catalog.some((c) => c.selector === selector)) {
                    catalog.push({ selector, provider: p.id, name: m, free: m.endsWith(':free'), vision: false });
                }
            }
        }
        const current = currentTarget();
        const quota = providerState.find((p) => p.id === 'openrouter')?.enabled ? await this.openRouterQuota() : undefined;
        this.post({
            type: 'state',
            ccrReady: status.exists,
            gateway: await isGatewayUp(),
            targets: listTargets().map((t) => {
                const u = cachedUsage(t.dir);
                return {
                    ...t,
                    title: describe(t),
                    current: t.dir === current.dir,
                    limit: SettingsPanel.limitLabel(t.dir),
                    color: t.kind === 'claude' ? colorFor(t.dir) ?? null : null,
                    usage: u && {
                        h5: formatTokens(u.last5h.tokens),
                        today: formatTokens(u.today.tokens),
                        week: formatTokens(u.last7d.tokens),
                        replies: u.last7d.replies,
                        models: u.models.slice(0, 3).map((m) => ({ name: modelLabel(m.model), share: u.last7d.tokens ? Math.round((m.tokens / u.last7d.tokens) * 100) : 0 })),
                    },
                };
            }),
            providers: providerState,
            catalog: catalog.filter((c) => providerState.some((p) => p.id === c.provider && p.enabled)).map((c) => enrich(c, this.context.extensionPath)),
            catalogUpdated: loadCatalog(this.context.extensionPath).updated,
            showCommunity: cfg.get<boolean>('showCommunityProviders', false),
            mainModel: cfg.get<string>('mainModel'),
            smallModel: cfg.get<string>('smallModel'),
            fallback: cfg.get<string[]>('fallbackModels') || [],
            catalogError,
            initialTab: this.pendingTab,
            colors: ACCOUNT_COLORS,
            health: this.health,
            quota,
        });
        this.pendingTab = undefined;
    }

    /** Free-model requests left today on OpenRouter (shared by all its free models). Costs no tokens. */
    private async openRouterQuota(): Promise<{ remaining: number; limit: number } | undefined> {
        try {
            const exported = await runHelper(this.context.extensionPath, 'export-key openrouter');
            if (!exported?.key) {
                return undefined;
            }
            const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${exported.key}` } });
            const free = ((await r.json()) as any)?.data?.free_model_daily_requests;
            return free ? { remaining: free.remaining, limit: free.limit } : undefined;
        } catch {
            return undefined;
        }
    }

    private async save(options: { keys?: Record<string, string>; [k: string]: unknown }, doneText: string): Promise<void> {
        this.toast('busy', 'Saving… Other AI restarts for a few seconds.');
        const result = await applyToCcr(this.context, options);
        this.toast(result.ok ? 'info' : 'error', result.ok ? doneText : result.lines.join(' · '));
        await this.sendState();
        const status = await ccrStatus(this.context.extensionPath);
        vscode.commands.executeCommand('setContext', 'hoppy.hasProvider', !!status.providers?.some((p) => p.hasKey));
    }

    private async onMessage(m: any): Promise<void> {
        switch (m.type) {
            case 'ready':
                return this.sendState();
            case 'openUrl':
                vscode.env.openExternal(vscode.Uri.parse(m.url));
                return;
            case 'switchTarget':
                await vscode.commands.executeCommand('hoppy.switchToDir', m.dir);
                return this.sendState();
            case 'addAccount':
                await vscode.commands.executeCommand('hoppy.addAccount');
                return this.sendState();
            case 'setColor':
                if (listTargets().some((t) => t.kind === 'claude' && t.dir === m.dir)) {
                    await setColor(m.dir, String(m.color || ''));
                }
                return this.sendState();
            case 'renameAccount':
                await vscode.commands.executeCommand('hoppy.renameAccount', m.dir);
                return this.sendState();
            case 'runSetup':
                await vscode.commands.executeCommand('hoppy.setup');
                return this.sendState();
            case 'openGuide':
                await vscode.commands.executeCommand('hoppy.guide');
                return;
            case 'saveKey': {
                const info = findProvider(String(m.provider));
                const typed = String(m.key || '').trim();
                if (!info || (!typed && !info.keyOptional)) {
                    return;
                }
                const key = typed || NO_KEY;
                const options = {
                    account: typeof m.account === 'string' ? m.account.trim() : undefined,
                    base: typeof m.base === 'string' && m.base.trim() ? normalizeBase(m.base) : undefined,
                };
                const problem =
                    (typed ? info.looksValid(typed) : undefined) ||
                    (options.base ? checkBaseUrl(options.base) : undefined) ||
                    (info.needs === 'account' && !/^[a-f0-9]{32}$/i.test(options.account || '') ? 'The account ID has 32 letters and digits (Cloudflare dashboard, Workers AI page)' : undefined);
                if (problem) {
                    this.post({ type: 'keyResult', provider: m.provider, ok: false, message: problem });
                    return;
                }
                if (info.needs) {
                    await setProviderOptions(info.id, options);
                }
                this.toast('busy', `Checking ${info.label}…`);
                const check = await checkKey(info.id, key, baseFor(info));
                this.post({ type: 'keyResult', provider: m.provider, ok: check.ok, message: check.message });
                if (!check.ok) {
                    this.toast('error', check.message);
                    return;
                }
                await this.context.secrets.store(secretKey(info.id), key);
                let extra: object = {};
                if (info.id === 'openrouter' && !m.hasModels) {
                    extra = { freeModels: (await openRouterCatalog()).filter((c) => c.selector.endsWith(':free')).map((c) => c.selector.slice('openrouter/'.length)) };
                } else if (modelsUrlFor(info) && !m.hasModels) {
                    providerCache.delete(info.id);
                    try {
                        extra = { providerModels: { [info.id]: defaultModels(await listProviderModels(info, key)) } };
                    } catch {
                        // The key check passed; models can still be picked in the Models tab.
                    }
                } else if (!m.hasModels) {
                    const builtIn = builtInModels(this.context.extensionPath).filter((c) => c.provider === info.id).map((c) => c.selector.slice(info.id.length + 1));
                    if (builtIn.length) {
                        extra = { providerModels: { [info.id]: defaultModels(builtIn.map((id) => ({ id }))) } };
                    }
                }
                return this.save({ keys: { [info.id]: key }, ...extra }, `${info.label} key saved. ${check.message}`);
            }
            case 'addCustom': {
                const label = String(m.label || '').trim().slice(0, 40);
                const base = normalizeBase(String(m.baseUrl || ''));
                const error = !label ? 'Give it a name' : checkBaseUrl(base);
                const id = customId(label);
                if (error || PROVIDERS.some((p) => p.id === id)) {
                    this.post({ type: 'keyResult', provider: '__custom', ok: false, message: error || 'That name is taken by a built-in provider' });
                    return;
                }
                const list = customProviders().filter((c) => c.id !== id);
                list.push({ id, label, baseUrl: base });
                await vscode.workspace.getConfiguration('hoppy').update('customProviders', list, vscode.ConfigurationTarget.Global);
                this.post({ type: 'keyResult', provider: '__custom', ok: true, message: `${label} added. Paste its key (or leave it empty if it needs none), then Test & save.` });
                await this.sendState();
                this.post({ type: 'focusKey', provider: id });
                return;
            }
            case 'removeCustom': {
                const id = String(m.provider);
                if (!customProviders().some((c) => c.id === id)) {
                    return;
                }
                await this.context.secrets.delete(secretKey(id));
                await vscode.workspace.getConfiguration('hoppy').update('customProviders', customProviders().filter((c) => c.id !== id), vscode.ConfigurationTarget.Global);
                const live = (await ccrStatus(this.context.extensionPath)).providers?.some((p) => p.name === id);
                return live ? this.save({ removeProviders: [id] }, 'Custom provider removed.') : this.sendState();
            }
            case 'showCommunity':
                await vscode.workspace.getConfiguration('hoppy').update('showCommunityProviders', !!m.value, vscode.ConfigurationTarget.Global);
                return this.sendState();
            case 'toggleProvider': {
                const info = findProvider(String(m.provider));
                if (!info) {
                    return;
                }
                const modelsKey = `hoppy.models.${info.id}`;
                if (!m.enabled) {
                    // Keep the key in OS secret storage and the model list in state, so turning it back on
                    // needs no re-entry and comes back as it was.
                    const exported = await runHelper(this.context.extensionPath, `export-key ${info.id}`);
                    if (exported?.key) {
                        await this.context.secrets.store(secretKey(info.id), exported.key);
                    }
                    const live = (await ccrStatus(this.context.extensionPath)).providers?.find((p) => p.name === info.id);
                    if (live?.models.length) {
                        await this.context.globalState.update(modelsKey, live.models);
                    }
                    return this.save({ removeProviders: [info.id] }, `${info.label} turned off. Its key is kept for later.`);
                }
                const key = await this.context.secrets.get(secretKey(info.id));
                if (!key) {
                    this.toast('info', `Paste a ${info.label} key below to turn it on.`);
                    this.post({ type: 'focusKey', provider: info.id });
                    return;
                }
                let models = this.context.globalState.get<string[]>(modelsKey);
                if (!models?.length && modelsUrlFor(info)) {
                    models = defaultModels(await listProviderModels(info, key).catch(() => []));
                }
                if (!models?.length && info.id === 'openrouter') {
                    models = (await openRouterCatalog().catch(() => [])).filter((c) => c.selector.endsWith(':free')).map((c) => c.selector.slice('openrouter/'.length));
                }
                return this.save({ keys: { [info.id]: key }, ...(models?.length ? { providerModels: { [info.id]: models } } : {}) }, `${info.label} turned on.`);
            }
            case 'saveModels': {
                const cfg = vscode.workspace.getConfiguration('hoppy');
                await cfg.update('mainModel', m.mainModel, vscode.ConfigurationTarget.Global);
                await cfg.update('smallModel', m.smallModel, vscode.ConfigurationTarget.Global);
                const providerModels: Record<string, string[]> = {};
                for (const selector of m.enabled as string[]) {
                    const [provider, ...rest] = selector.split('/');
                    (providerModels[provider] ||= []).push(rest.join('/'));
                }
                for (const p of allProviders()) {
                    providerModels[p.id] ||= [];
                }
                return this.save({ providerModels }, 'Models saved. Reload the Claude panel in Other AI mode to see them.');
            }
            case 'saveFallback':
                await vscode.workspace.getConfiguration('hoppy').update('fallbackModels', m.models, vscode.ConfigurationTarget.Global);
                return this.save({}, 'Backups saved.');
            case 'checkModels': {
                const selectors = (Array.isArray(m.models) ? m.models : []).filter((x: unknown) => typeof x === 'string').slice(0, 20) as string[];
                if (!selectors.length) {
                    return;
                }
                this.toast('busy', `Checking ${selectors.length} model(s)… one tiny request each.`);
                const keyFor = async (provider: string) => {
                    if (!findProvider(provider)) {
                        return undefined;
                    }
                    const saved = await this.context.secrets.get(secretKey(provider));
                    if (saved) {
                        return saved;
                    }
                    const exported = await runHelper(this.context.extensionPath, `export-key ${provider}`);
                    return exported?.key as string | undefined;
                };
                const urlFor = (provider: string) => {
                    const p = findProvider(provider);
                    const base = p && baseFor(p);
                    return base ? `${base}/chat/completions` : undefined;
                };
                for (const r of await checkModels(selectors, keyFor, 3, urlFor)) {
                    this.health[r.selector] = r;
                }
                const bad = selectors.filter((x) => this.health[x]?.status !== 'ok').length;
                this.toast('info', bad ? `${selectors.length - bad} of ${selectors.length} models work right now.` : 'All checked models work.');
                return this.sendState();
            }
            case 'refreshCatalog':
                openRouterCache = undefined;
                return this.sendState();
        }
    }
}
