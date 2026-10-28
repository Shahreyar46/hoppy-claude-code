import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ccrStatus, isGatewayUp, runHelper } from './gateway';
import { applyToCcr, checkKey, PROVIDERS, ProviderInfo } from './setup';
import { currentTarget, describe, listTargets } from './targets';

export interface CatalogModel {
    selector: string;
    provider: string;
    name: string;
    free: boolean;
    priceIn?: number;
    priceOut?: number;
    ctx?: number;
    vision: boolean;
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

/** OpenRouter models that support tool calling (Claude Code cannot work without tools). */
async function openRouterCatalog(): Promise<CatalogModel[]> {
    if (openRouterCache) {
        return openRouterCache;
    }
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const data: any[] = ((await r.json()) as any).data;
    openRouterCache = data
        .filter((m) => (m.supported_parameters || []).includes('tools'))
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

export class SettingsPanel {
    private static current: SettingsPanel | undefined;
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
            PROVIDERS.map(async (p: ProviderInfo) => {
                const live = status.providers?.find((x) => x.name === p.id);
                return {
                    id: p.id,
                    label: p.label,
                    note: p.note,
                    keyUrl: p.keyUrl,
                    enabled: !!live?.hasKey,
                    keyHint: live?.keyHint ?? null,
                    savedKey: !!(await this.context.secrets.get(secretKey(p.id))),
                    models: live?.models ?? [],
                };
            }),
        );
        let catalog: CatalogModel[] = STATIC_MODELS;
        let catalogError: string | undefined;
        try {
            catalog = [...(await openRouterCatalog()), ...STATIC_MODELS];
        } catch (err) {
            catalogError = `Could not load the OpenRouter catalog (${String(err)}). Showing enabled models only.`;
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
            targets: listTargets().map((t) => ({ ...t, title: describe(t), current: t.dir === current.dir })),
            providers: providerState,
            catalog: catalog.filter((c) => providerState.some((p) => p.id === c.provider && p.enabled)),
            mainModel: cfg.get<string>('mainModel'),
            smallModel: cfg.get<string>('smallModel'),
            fallback: cfg.get<string[]>('fallbackModels') || [],
            catalogError,
            initialTab: this.pendingTab,
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

    private async save(options: object, doneText: string): Promise<void> {
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
                const key = String(m.key || '').trim();
                const info = PROVIDERS.find((p) => p.id === m.provider);
                if (!info || !key) {
                    return;
                }
                const formatError = info.looksValid(key);
                if (formatError) {
                    this.post({ type: 'keyResult', provider: m.provider, ok: false, message: formatError });
                    return;
                }
                this.toast('busy', `Checking ${info.label} key…`);
                const check = await checkKey(info.id, key);
                this.post({ type: 'keyResult', provider: m.provider, ok: check.ok, message: check.message });
                if (!check.ok) {
                    this.toast('error', check.message);
                    return;
                }
                await this.context.secrets.store(secretKey(info.id), key);
                const extra = info.id === 'openrouter' && !(m.hasModels) ? { freeModels: (await openRouterCatalog()).filter((c) => c.selector.endsWith(':free')).map((c) => c.selector.slice('openrouter/'.length)) } : {};
                return this.save({ keys: { [info.id]: key }, ...extra }, `${info.label} key saved. ${check.message}`);
            }
            case 'toggleProvider': {
                const info = PROVIDERS.find((p) => p.id === m.provider);
                if (!info) {
                    return;
                }
                if (!m.enabled) {
                    // Keep the key in OS secret storage so turning it back on needs no re-entry.
                    const exported = await runHelper(this.context.extensionPath, `export-key ${info.id}`);
                    if (exported?.key) {
                        await this.context.secrets.store(secretKey(info.id), exported.key);
                    }
                    return this.save({ removeProviders: [info.id] }, `${info.label} turned off. Its key is kept for later.`);
                }
                const key = await this.context.secrets.get(secretKey(info.id));
                if (!key) {
                    this.toast('info', `Paste a ${info.label} key below to turn it on.`);
                    this.post({ type: 'focusKey', provider: info.id });
                    return;
                }
                return this.save({ keys: { [info.id]: key } }, `${info.label} turned on.`);
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
                for (const p of PROVIDERS) {
                    providerModels[p.id] ||= [];
                }
                return this.save({ providerModels }, 'Models saved. Reload the Claude panel in Other AI mode to see them.');
            }
            case 'saveFallback':
                await vscode.workspace.getConfiguration('hoppy').update('fallbackModels', m.models, vscode.ConfigurationTarget.Global);
                return this.save({}, 'Backups saved.');
            case 'refreshCatalog':
                openRouterCache = undefined;
                return this.sendState();
        }
    }
}
