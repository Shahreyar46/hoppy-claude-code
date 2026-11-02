import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ccrStatus, installCcr, isCcrInstalled, nodeVersionOk, runHelper, startGateway, stopGateway } from './gateway';
import { ccrDataDir, routerSettingsFileForCcr } from './paths';
import { baseFor, ccrTemplate, chatUrl, findProvider, NO_KEY, PROVIDERS, ProviderInfo, ProviderModel } from './providers';

export { PROVIDERS, ProviderInfo, ProviderModel } from './providers';
function askKey(p: ProviderInfo): Promise<string | undefined> {
    return new Promise((resolve) => {
        const box = vscode.window.createInputBox();
        box.title = `${p.label} API key`;
        box.prompt = `Paste your ${p.label} key. Leave empty to keep the current one. Click the globe to open the key page.`;
        box.password = true;
        box.ignoreFocusOut = true;
        box.buttons = [{ iconPath: new vscode.ThemeIcon('globe'), tooltip: `Open ${p.keyUrl}` }];
        box.onDidTriggerButton(() => vscode.env.openExternal(vscode.Uri.parse(p.keyUrl)));
        box.onDidChangeValue((v) => (box.validationMessage = v.trim() ? p.looksValid(v.trim()) : undefined));
        box.onDidAccept(() => {
            const v = box.value.trim();
            if (v && p.looksValid(v)) {
                return;
            }
            resolve(v);
            box.dispose();
        });
        box.onDidHide(() => {
            resolve(undefined);
            box.dispose();
        });
        box.show();
    });
}

// Models that cannot chat with tools: speech, embeddings, safety classifiers, rerankers, image-only.
const NOT_CHAT = /whisper|tts|speech|audio|embed|guard|rerank|moderation|ocr|vision-only|image|diffusion|flux|parakeet|retriever|reward|safety/i;
// Families known to handle Claude Code's tool calls reasonably; picked first when a provider is turned on.
const GOOD_FOR_CODE = /coder|codestral|devstral|kimi|qwen3|gpt-oss|deepseek|glm|llama-4|llama-3\.3|mistral-large|mistral-medium|nemotron/i;

/** Model list address: local servers and custom providers follow the address the user set. */
export function modelsUrlFor(p: ProviderInfo, base = baseFor(p)): string | undefined {
    if ((p.needs === 'url' || p.custom) && base) {
        return `${base}/models`;
    }
    return p.modelsUrl;
}

const authHeaders = (key: string): Record<string, string> => (key && key !== NO_KEY ? { Authorization: `Bearer ${key}` } : {});

// Embedding, image and video families whose ids do not say so.
const NOT_CHAT_FAMILY = /(^|\/)(bge|e5|gte|minilm|nomic-embed|wan-|veo|seedream|sdxl|kontext|imagen|happyhorse|kling|seedance|hailuo)/i;

/**
 * Claude models offered by other gateways (Kilo, LLM7, OpenRouter…). Claude only runs on Claude accounts:
 * paying a gateway for Claude means paying twice and sends the chat through a third party.
 */
export const CLAUDE_MODEL = /(^|[/~])anthropic\/|(^|\/)claude[-.]/i;

const textOut = (m: any) => {
    const out = m.output_modalities ?? m.architecture?.output_modalities;
    return !Array.isArray(out) || out.includes('text');
};
// Explicit "no tools" signals from Pollinations (capabilities list) and the Hugging Face router (per-host flag).
const mayUseTools = (m: any) =>
    !(Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('tool_calling')) &&
    !(Array.isArray(m.providers) && m.providers.length && !m.providers.some((p: any) => p?.supports_tools));

/** Reads the usual model list shapes: {data: [...]}, a bare array, or {models: [...]}. */
export function parseModelList(body: any): ProviderModel[] {
    const data: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return data
        .map((m) => (typeof m === 'string' ? { id: m } : m))
        .filter((m) => typeof m?.id === 'string' && !NOT_CHAT.test(m.id) && !NOT_CHAT_FAMILY.test(m.id) && !CLAUDE_MODEL.test(m.id))
        .filter((m) => m.capabilities?.function_calling !== false && m.capabilities?.completion_chat !== false && (m.type === undefined || /chat|language|llm/i.test(String(m.type))))
        .filter((m) => textOut(m) && (m.category === undefined || m.category === 'text') && mayUseTools(m))
        .map((m) => ({
            id: String(m.id),
            ctx: Number(m.context_window || m.max_context_length || m.context_length || m.providers?.find((p: any) => p?.context_length)?.context_length) || undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** Some APIs answer a wrong key with 400 instead of 401 (xAI). */
const badKeyText = (text: string) => /incorrect api key|invalid api key|api key (is )?invalid|invalid[_ ]?(auth|token)|unauthori[sz]ed|authentication/i.test(text);

/** Live model list of an OpenAI-compatible provider, chat models only. */
export async function listProviderModels(p: ProviderInfo, key: string, base?: string): Promise<ProviderModel[]> {
    const url = modelsUrlFor(p, base ?? baseFor(p));
    if (!url) {
        return [];
    }
    const r = await fetch(url, { headers: authHeaders(key), signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
        throw new Error(`${p.label} returned ${r.status}`);
    }
    return parseModelList(await r.json());
}

/** A few sensible models to enable when a provider is first turned on; the Models tab changes them. */
export function defaultModels(models: ProviderModel[], max = 6): string[] {
    const good = models.filter((m) => GOOD_FOR_CODE.test(m.id));
    return [...good, ...models.filter((m) => !good.includes(m))].slice(0, max).map((m) => m.id);
}

/** Cheap live check (no model tokens used). Returns a human-readable result line. */
export async function checkKey(id: string, key: string, base?: string): Promise<{ ok: boolean; message: string }> {
    const info = findProvider(id);
    base = base ?? (info && baseFor(info));
    try {
        if (info?.needs === 'account' && !base) {
            return { ok: false, message: `${info.label} needs your 32-character account ID` };
        }
        if (id === 'cloudflare' && base) {
            const account = /accounts\/([^/]+)/.exec(base)?.[1];
            for (const url of [`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, 'https://api.cloudflare.com/client/v4/user/tokens/verify']) {
                const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
                const d = (await r.json().catch(() => ({}))) as any;
                if (r.ok && d?.success) {
                    return { ok: true, message: `Cloudflare OK, token ${d.result?.status || 'active'}` };
                }
            }
            return { ok: false, message: 'Cloudflare rejected the token, or it is not for this account' };
        }
        if (info?.keyOptional && (!key || key === NO_KEY)) {
            const url = info && modelsUrlFor(info, base);
            if (!url) {
                return { ok: true, message: `${info.label} saved` };
            }
            const r = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
            if (!r?.ok) {
                return { ok: false, message: info.group === 'local' ? `${info.label} is not answering at ${base}. Start it, then try again.` : `${info.label} did not answer (${r?.status ?? 'offline'})` };
            }
            const count = parseModelList(await r.json()).length;
            return { ok: true, message: `${info.label} OK, ${count} models available` };
        }
        if (id === 'openrouter') {
            const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
            if (!r.ok) {
                return { ok: false, message: `OpenRouter rejected the key (${r.status})` };
            }
            const d = ((await r.json()) as any).data;
            const free = d.free_model_daily_requests;
            return { ok: true, message: `OpenRouter OK${free ? `, free requests today: ${free.remaining}/${free.limit}` : ''}` };
        }
        if (id === 'gemini') {
            const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
            return r.ok ? { ok: true, message: 'Gemini OK' } : { ok: false, message: `Gemini rejected the key (${r.status})` };
        }
        if (id === 'deepseek') {
            const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
            if (!r.ok) {
                return { ok: false, message: `DeepSeek rejected the key (${r.status})` };
            }
            const d = (await r.json()) as any;
            const bal = d.balance_infos?.[0];
            return { ok: true, message: `DeepSeek OK, balance ${bal ? `${bal.total_balance} ${bal.currency}` : 'unknown'}${d.is_available ? '' : ' (add credit to use it)'}` };
        }
        const listUrl = info && modelsUrlFor(info, base);
        if (info && listUrl && info.publicModelList) {
            // The model list answers without a key, so prove the key with a 1-token request to a live model.
            const models = await listProviderModels(info, key, base);
            // Listed models can already be retired (410), which says nothing about the key: try a few.
            for (const model of defaultModels(models, 4)) {
                const r = await fetch(chatUrl(base || info.base), {
                    method: 'POST',
                    signal: AbortSignal.timeout(20000),
                    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
                });
                if (r.status === 401 || r.status === 403 || (r.status === 400 && badKeyText(await r.clone().text().catch(() => '')))) {
                    return { ok: false, message: `${info.label} rejected the key (${r.status})` };
                }
                if (r.status === 402) {
                    return { ok: false, message: `${info.label} accepted the key but has no credits left` };
                }
                if (r.ok || r.status === 429) {
                    return { ok: true, message: `${info.label} OK, ${models.length} models available` };
                }
            }
            return { ok: true, message: `${info.label}: key saved, but it could not be checked right now` };
        }
        if (info && listUrl) {
            const r = await fetch(listUrl, { headers: authHeaders(key), signal: AbortSignal.timeout(10000) });
            if (r.status === 401 || r.status === 403 || (r.status === 400 && badKeyText(await r.clone().text().catch(() => '')))) {
                return { ok: false, message: `${info.label} rejected the key (${r.status})` };
            }
            if (!r.ok) {
                // Busy (429) or down (5xx) says nothing about the key: save it and say so.
                return { ok: true, message: `${info.label} is busy right now (${r.status}); key saved, it will be used when the service answers` };
            }
            const count = parseModelList(await r.json()).length;
            return { ok: true, message: `${info.label} OK, ${count} models available` };
        }
        return { ok: true, message: `${info?.label || id} key saved (no free check available; a 401 or 429 later means bad key or no balance)` };
    } catch (err) {
        return { ok: true, message: `${id}: could not reach the provider to check (${String(err)}); key saved anyway` };
    }
}

export async function fetchFreeModels(): Promise<string[]> {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const data: any[] = ((await r.json()) as any).data;
    return data
        .filter((m) => m.id.endsWith(':free') && (m.supported_parameters || []).includes('tools'))
        .map((m) => m.id)
        .sort();
}

/** Stop ccr, undo any takeover of the user's own configs, apply options, start ccr again. */
export async function applyToCcr(context: vscode.ExtensionContext, options: { keys?: Record<string, string>; [k: string]: unknown }): Promise<{ ok: boolean; lines: string[] }> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    const templates: Record<string, object> = {};
    for (const id of Object.keys(options.keys || {})) {
        const p = findProvider(id);
        const base = p && baseFor(p);
        if (p && base) {
            templates[id] = ccrTemplate(p, base);
        }
    }
    await stopGateway();
    const restore = await runHelper(context.extensionPath, 'restore-takeover');
    const result = await runHelper(context.extensionPath, 'apply', {
        routerSettingsFile: routerSettingsFileForCcr(),
        fallback: cfg.get<string[]>('fallbackModels'),
        mainModel: cfg.get<string>('mainModel'),
        smallModel: cfg.get<string>('smallModel'),
        ...options,
        templates,
    });
    const started = await startGateway();
    const lines = [
        ...(restore.restored || []).map((f: string) => `Restored your original config: ${f}`),
        ...(result.changes || []),
        started ? 'Other AI is ready' : 'Other AI did not start. Open the Hoppy menu → More → Restart Other AI',
    ];
    if (!result.ok) {
        lines.unshift(`Config update failed: ${result.error}`);
    }
    return { ok: !!result.ok && started, lines };
}

/** First ccr start creates its config (and takes over ~/.claude); undo the takeover right away. */
async function ensureCcrConfig(context: vscode.ExtensionContext): Promise<boolean> {
    if ((await ccrStatus(context.extensionPath)).exists) {
        return true;
    }
    await startGateway();
    const db = path.join(ccrDataDir(), 'config.sqlite');
    for (let i = 0; i < 30 && !fs.existsSync(db); i++) {
        await new Promise((r) => setTimeout(r, 500));
    }
    await stopGateway();
    await runHelper(context.extensionPath, 'restore-takeover');
    return (await ccrStatus(context.extensionPath)).exists;
}

export async function runSetup(context: vscode.ExtensionContext): Promise<boolean> {
    const node = await nodeVersionOk();
    if (!node.ok) {
        const pick = await vscode.window.showErrorMessage(
            `Node.js 22.5 or newer is required (found: ${node.version}).`,
            'Download Node.js',
        );
        if (pick) {
            vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
        }
        return false;
    }

    if (!(await isCcrInstalled())) {
        const pick = await vscode.window.showInformationMessage(
            'One-time setup: Hoppy needs a small local helper (Claude Code Router) to connect Claude Code to other AI models. Install it now? It takes about a minute, no terminal needed.',
            { modal: true },
            'Install now',
        );
        if (!pick) {
            return false;
        }
        const install = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Installing the Other AI helper (about a minute)…' },
            () => installCcr(),
        );
        if (!install.ok) {
            vscode.window.showErrorMessage('Installing Claude Code Router failed.', { modal: true, detail: install.output });
            return false;
        }
    }

    const ready = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Preparing Other AI…' },
        () => ensureCcrConfig(context),
    );
    if (!ready) {
        vscode.window.showErrorMessage('Could not create the ccr config. Run "ccr start" in a terminal, then try again.');
        return false;
    }

    const status = await ccrStatus(context.extensionPath);
    const hasKey = (id: string) => !!status.providers?.find((p) => p.name === id && p.hasKey);
    const chosen = await vscode.window.showQuickPick(
        PROVIDERS.filter((p) => !p.needs && !p.keyOptional && p.group !== 'community').map((p) => ({
            label: `${hasKey(p.id) ? '$(check) ' : ''}${p.label}`,
            description: p.note,
            picked: p.id === 'openrouter' && !hasKey(p.id),
            provider: p,
        })),
        { title: 'Which providers do you want to add or update?', canPickMany: true, ignoreFocusOut: true },
    );
    if (!chosen) {
        return false;
    }

    const keys: Record<string, string> = {};
    const report: string[] = [];
    for (const { provider } of chosen) {
        const key = await askKey(provider);
        if (key === undefined) {
            return false;
        }
        if (!key) {
            continue;
        }
        const check = await checkKey(provider.id, key);
        report.push(`${check.ok ? '✔' : '✖'} ${check.message}`);
        if (check.ok) {
            keys[provider.id] = key;
        }
    }

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Saving keys and updating models…' },
        async () => {
            let freeModels: string[] = [];
            if (keys.openrouter || hasKey('openrouter')) {
                freeModels = await fetchFreeModels().catch(() => []);
            }
            const providerModels: Record<string, string[]> = {};
            for (const [id, key] of Object.entries(keys)) {
                const info = PROVIDERS.find((p) => p.id === id);
                if (info?.modelsUrl && !hasKey(id)) {
                    providerModels[id] = defaultModels(await listProviderModels(info, key).catch(() => []));
                }
                // The settings page reads these to list models and to turn providers back on.
                await context.secrets.store(`hoppy.key.${id}`, key);
            }
            return applyToCcr(context, { keys, freeModels, providerModels });
        },
    );

    const summary = [...report, ...result.lines].join('\n');
    const pick = await vscode.window.showInformationMessage(
        result.ok ? 'Setup complete.' : 'Setup finished with problems.',
        { modal: true, detail: summary },
        'Switch to Other AI now',
    );
    return pick === 'Switch to Other AI now';
}
