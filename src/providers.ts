// One registry for every Other AI provider: used by setup, the settings page, the health check and the ccr
// helper (templates are sent with each apply). All are OpenAI-compatible except Gemini and OpenRouter in ccr,
// which keep their own ccr transformers.
//
// Not here on purpose (plan section 3): subscription/OAuth proxies, web-cookie providers, key pooling.
// Also left out: GitHub Models (retired 2026-07-30), AI Horde (no tool calls), Routeway (blocks non-browser
// clients), OpenCode Zen (free models locked to its own client).
import * as vscode from 'vscode';

export type ProviderGroup = 'free' | 'local' | 'paid' | 'trial' | 'community';

export interface ProviderInfo {
    id: string;
    label: string;
    group: ProviderGroup;
    keyUrl: string;
    note: string;
    /** Short labels for the settings tiles, e.g. "Free tier", "Fast". */
    tags: string[];
    looksValid: (key: string) => string | undefined;
    /** OpenAI-compatible base, ending before /chat/completions. May hold {account} (Cloudflare). */
    base: string;
    /** ccr address when it differs from base + /chat/completions (Gemini uses ccr's native transformer). */
    ccrUrl?: string;
    transformer?: string[];
    /** OpenAI-compatible model list endpoint, read with the user's key. */
    modelsUrl?: string;
    /** The model list answers without a valid key, so it cannot prove a key works. */
    publicModelList?: boolean;
    /** Works without a key (local servers, anonymous tiers); an empty key is allowed. */
    keyOptional?: boolean;
    /** Extra value asked next to the key. */
    needs?: 'account' | 'url';
    /** Shown on the tile and above the key form. */
    warning?: string;
    custom?: boolean;
}

export interface ProviderModel {
    id: string;
    ctx?: number;
}

/** Sent to ccr for keyless providers: ccr needs some key to treat a provider as on. */
export const NO_KEY = 'hoppy-no-key';

const prefix = (p: string, name: string) => (k: string) => (k.startsWith(p) ? undefined : `${name} keys start with ${p}`);
const anyKey = (k: string) => (k.length >= 8 ? undefined : 'That key looks too short');

export const PROVIDERS: ProviderInfo[] = [
    // ---- Free tiers ----
    {
        id: 'openrouter',
        group: 'free',
        tags: ['Free models', 'Recommended'],
        label: 'OpenRouter',
        keyUrl: 'https://openrouter.ai/settings/keys',
        note: 'Recommended. One key for free and paid models: DeepSeek, GLM, MiMo, Kimi, GPT…',
        looksValid: prefix('sk-or-', 'OpenRouter'),
        base: 'https://openrouter.ai/api/v1',
        transformer: ['openrouter'],
    },
    {
        id: 'gemini',
        group: 'free',
        tags: ['Free tier', 'Reads images'],
        label: 'Google Gemini',
        keyUrl: 'https://aistudio.google.com/apikey',
        note: 'Free tier, separate daily quota',
        looksValid: prefix('AIza', 'Gemini'),
        base: 'https://generativelanguage.googleapis.com/v1beta/openai',
        ccrUrl: 'https://generativelanguage.googleapis.com/v1beta/models/',
        transformer: ['gemini'],
    },
    {
        id: 'groq',
        group: 'free',
        tags: ['Free tier', 'Fast'],
        label: 'Groq',
        keyUrl: 'https://console.groq.com/keys',
        note: 'Very fast. Free tier with daily limits',
        looksValid: prefix('gsk_', 'Groq'),
        base: 'https://api.groq.com/openai/v1',
        modelsUrl: 'https://api.groq.com/openai/v1/models',
    },
    {
        id: 'cerebras',
        group: 'free',
        tags: ['Free tier', 'Fast'],
        label: 'Cerebras',
        keyUrl: 'https://cloud.cerebras.ai/platform',
        note: 'Very fast. Free tier with daily limits',
        looksValid: prefix('csk-', 'Cerebras'),
        base: 'https://api.cerebras.ai/v1',
        modelsUrl: 'https://api.cerebras.ai/v1/models',
    },
    {
        id: 'mistral',
        group: 'free',
        tags: ['Free tier'],
        label: 'Mistral',
        keyUrl: 'https://console.mistral.ai/api-keys',
        note: 'Free experiment plan or paid, includes Codestral',
        looksValid: (k) => (/^[A-Za-z0-9]{24,}$/.test(k) ? undefined : 'Mistral keys are 32 letters and digits'),
        base: 'https://api.mistral.ai/v1',
        modelsUrl: 'https://api.mistral.ai/v1/models',
    },
    {
        id: 'nvidia',
        group: 'free',
        tags: ['Free credits'],
        label: 'NVIDIA NIM',
        keyUrl: 'https://build.nvidia.com/settings/api-keys',
        note: 'Free credits for many open models',
        looksValid: prefix('nvapi-', 'NVIDIA'),
        base: 'https://integrate.api.nvidia.com/v1',
        modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
        publicModelList: true,
    },
    {
        id: 'glm',
        group: 'free',
        tags: ['Free Flash models', 'Paid'],
        label: 'GLM (Z.ai)',
        keyUrl: 'https://z.ai/manage-apikey/apikey-list',
        note: 'GLM Flash models are free; bigger GLM models are paid or need the Coding Plan',
        looksValid: (k) => (k.includes('.') ? undefined : 'Z.ai keys have a dot in the middle (xxxx.yyyy). Use the copy button.'),
        base: 'https://api.z.ai/api/paas/v4',
    },
    {
        id: 'cloudflare',
        group: 'free',
        tags: ['Free daily allowance'],
        label: 'Cloudflare Workers AI',
        keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        note: 'Kimi, GPT-OSS, GLM Flash, Llama 4 and more. Needs your account ID and a token with Workers AI access',
        looksValid: anyKey,
        base: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1',
        needs: 'account',
    },
    {
        id: 'huggingface',
        group: 'free',
        tags: ['Small monthly credit'],
        label: 'Hugging Face',
        keyUrl: 'https://huggingface.co/settings/tokens',
        note: 'One token for many open models (Kimi, DeepSeek, Qwen Coder) through the HF router; small free credit each month',
        looksValid: prefix('hf_', 'Hugging Face'),
        base: 'https://router.huggingface.co/v1',
        modelsUrl: 'https://router.huggingface.co/v1/models',
        publicModelList: true,
    },
    {
        id: 'ollamacloud',
        group: 'free',
        tags: ['Free plan'],
        label: 'Ollama Cloud',
        keyUrl: 'https://ollama.com/settings/keys',
        note: 'Big open models (Qwen3 Coder, GPT-OSS, GLM) on Ollama servers. Free plan has session limits; some models need a subscription',
        looksValid: anyKey,
        base: 'https://ollama.com/v1',
        modelsUrl: 'https://ollama.com/v1/models',
        publicModelList: true,
    },
    {
        id: 'ovh',
        group: 'free',
        tags: ['EU', 'Free tier'],
        label: 'OVHcloud AI Endpoints',
        keyUrl: 'https://endpoints.ai.cloud.ovh.net/',
        note: 'Qwen, Llama and GPT-OSS hosted in Europe. A key needs an OVHcloud Public Cloud project',
        looksValid: anyKey,
        base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
        modelsUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
        publicModelList: true,
    },
    // ---- On this PC ----
    {
        id: 'ollama',
        group: 'local',
        tags: ['On this PC', 'No key'],
        label: 'Ollama (local)',
        keyUrl: 'https://ollama.com/download',
        note: 'Models running on your own PC. Start Ollama first; no key needed',
        looksValid: () => undefined,
        base: 'http://127.0.0.1:11434/v1',
        modelsUrl: 'http://127.0.0.1:11434/v1/models',
        keyOptional: true,
        needs: 'url',
    },
    {
        id: 'lmstudio',
        group: 'local',
        tags: ['On this PC', 'No key'],
        label: 'LM Studio (local)',
        keyUrl: 'https://lmstudio.ai/',
        note: 'Turn on the LM Studio server first (Developer tab); no key needed',
        looksValid: () => undefined,
        base: 'http://127.0.0.1:1234/v1',
        modelsUrl: 'http://127.0.0.1:1234/v1/models',
        keyOptional: true,
        needs: 'url',
    },
    // ---- Paid (used only when "Free only" is off) ----
    {
        id: 'deepseek',
        group: 'paid',
        tags: ['Paid', 'Cheap'],
        label: 'DeepSeek',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        note: 'Paid (prepaid balance)',
        looksValid: prefix('sk-', 'DeepSeek'),
        base: 'https://api.deepseek.com',
        transformer: ['deepseek'],
    },
    {
        id: 'openai',
        group: 'paid',
        tags: ['Paid'],
        label: 'OpenAI',
        keyUrl: 'https://platform.openai.com/api-keys',
        note: 'GPT models, billed per token',
        looksValid: prefix('sk-', 'OpenAI'),
        base: 'https://api.openai.com/v1',
        modelsUrl: 'https://api.openai.com/v1/models',
    },
    {
        id: 'xai',
        group: 'paid',
        tags: ['Paid'],
        label: 'xAI (Grok)',
        keyUrl: 'https://console.x.ai/',
        note: 'Grok models, billed per token',
        looksValid: prefix('xai-', 'xAI'),
        base: 'https://api.x.ai/v1',
        modelsUrl: 'https://api.x.ai/v1/models',
    },
    {
        id: 'together',
        group: 'paid',
        tags: ['Paid'],
        label: 'Together AI',
        keyUrl: 'https://api.together.ai/settings/api-keys',
        note: 'Many open models, billed per token',
        looksValid: anyKey,
        base: 'https://api.together.xyz/v1',
        modelsUrl: 'https://api.together.xyz/v1/models',
    },
    {
        id: 'fireworks',
        group: 'paid',
        tags: ['Paid', 'Fast'],
        label: 'Fireworks AI',
        keyUrl: 'https://fireworks.ai/account/api-keys',
        note: 'Fast open models, billed per token',
        looksValid: anyKey,
        base: 'https://api.fireworks.ai/inference/v1',
        modelsUrl: 'https://api.fireworks.ai/inference/v1/models',
    },
    {
        id: 'moonshot',
        group: 'paid',
        tags: ['Paid'],
        label: 'Moonshot (Kimi)',
        keyUrl: 'https://platform.moonshot.ai/console/api-keys',
        note: 'Kimi models from Moonshot, billed per token',
        looksValid: prefix('sk-', 'Moonshot'),
        base: 'https://api.moonshot.ai/v1',
        modelsUrl: 'https://api.moonshot.ai/v1/models',
    },
    {
        id: 'qwen',
        group: 'paid',
        tags: ['Paid'],
        label: 'Qwen (Alibaba Cloud)',
        keyUrl: 'https://modelstudio.console.alibabacloud.com/',
        note: 'Qwen models from Alibaba Cloud Model Studio (international), billed per token',
        looksValid: prefix('sk-', 'Model Studio'),
        base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        modelsUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
    },
    {
        id: 'siliconflow',
        group: 'paid',
        tags: ['Paid', 'Trial credit'],
        label: 'SiliconFlow',
        keyUrl: 'https://cloud.siliconflow.com/account/ak',
        note: 'Open models (Qwen, DeepSeek, GLM). Small trial credit, then paid',
        looksValid: prefix('sk-', 'SiliconFlow'),
        base: 'https://api.siliconflow.com/v1',
        modelsUrl: 'https://api.siliconflow.com/v1/models',
    },
    // ---- Trial keys ----
    {
        id: 'cohere',
        group: 'trial',
        tags: ['Trial key'],
        label: 'Cohere',
        keyUrl: 'https://dashboard.cohere.com/api-keys',
        note: 'Command models. Trial keys have a small monthly allowance',
        warning: 'Trial keys are for testing, not production use (Cohere terms).',
        looksValid: anyKey,
        base: 'https://api.cohere.ai/compatibility/v1',
        modelsUrl: 'https://api.cohere.ai/compatibility/v1/models',
    },
    {
        id: 'reka',
        group: 'trial',
        tags: ['Prepaid credit'],
        label: 'Reka',
        keyUrl: 'https://platform.reka.ai/apikeys',
        note: 'Reka Flash and Edge models. Prepaid credits',
        warning: 'New accounts get no free tier; check your credit before relying on it.',
        looksValid: anyKey,
        base: 'https://api.reka.ai/v1',
        modelsUrl: 'https://api.reka.ai/v1/models',
    },
    // ---- Community gateways (hidden until turned on in Settings, never in the Smart profile) ----
    {
        id: 'kilo',
        group: 'community',
        tags: ['Community', 'Free models'],
        label: 'Kilo Gateway',
        keyUrl: 'https://app.kilo.ai/',
        note: 'Free models from a community gateway',
        warning: 'Prompts may be logged: free models on Kilo can be used for training. Do not send private code.',
        looksValid: anyKey,
        base: 'https://api.kilo.ai/api/gateway/v1',
        modelsUrl: 'https://api.kilo.ai/api/gateway/models',
        publicModelList: true,
    },
    {
        id: 'llm7',
        group: 'community',
        tags: ['Community', 'No key'],
        label: 'LLM7',
        keyUrl: 'https://token.llm7.io/',
        note: 'Small free gateway, works without a key (about 100 requests an hour)',
        warning: 'Prompts may be logged by the gateway. Do not send private code.',
        looksValid: () => undefined,
        base: 'https://api.llm7.io/v1',
        modelsUrl: 'https://api.llm7.io/v1/models',
        publicModelList: true,
        keyOptional: true,
    },
    {
        id: 'pollinations',
        group: 'community',
        tags: ['Community', 'Small free allowance'],
        label: 'Pollinations',
        keyUrl: 'https://enter.pollinations.ai/',
        note: 'Open-source community gateway with a small free allowance (needs a free key)',
        warning: 'Prompts may be logged by the gateway. Do not send private code.',
        looksValid: anyKey,
        base: 'https://gen.pollinations.ai/v1',
        modelsUrl: 'https://gen.pollinations.ai/v1/models',
        publicModelList: true,
    },
];

export interface CustomProvider {
    id: string;
    label: string;
    baseUrl: string;
}

/** "custom-" + a slug of the name; ccr provider names must be short and lowercase. */
export function customId(label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    return `custom-${slug || 'provider'}`;
}

/** https anywhere, plain http only to this PC. Anthropic is never allowed: Claude does not go through the router. */
export function checkBaseUrl(raw: string): string | undefined {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return 'Enter a full address, like https://api.example.com/v1';
    }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        return 'Use https (plain http only works for this PC: 127.0.0.1 or localhost)';
    }
    if (/(^|\.)anthropic\.com$|(^|\.)claude\.ai$/i.test(url.hostname)) {
        return 'Claude is not added here. Use a Claude account instead (Accounts tab).';
    }
    return undefined;
}

export function normalizeBase(raw: string): string {
    return raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export function toCustomInfo(c: CustomProvider): ProviderInfo {
    const base = normalizeBase(c.baseUrl);
    const local = /^http:\/\//.test(base);
    return {
        id: c.id,
        label: c.label,
        group: local ? 'local' : 'paid',
        tags: ['Custom'],
        keyUrl: base,
        note: base,
        looksValid: () => undefined,
        base,
        modelsUrl: `${base}/models`,
        keyOptional: true,
        custom: true,
    };
}

/** Fill {account} and apply a user-set base (local servers). Returns undefined when a needed value is missing. */
export function resolveBase(p: ProviderInfo, opts: { account?: string; base?: string } = {}): string | undefined {
    if (p.needs === 'account') {
        const account = (opts.account || '').trim();
        return /^[a-f0-9]{32}$/i.test(account) ? p.base.replace('{account}', account) : undefined;
    }
    if (p.needs === 'url' && opts.base) {
        return normalizeBase(opts.base);
    }
    return p.base;
}

export function chatUrl(base: string): string {
    return `${base}/chat/completions`;
}

/** Template for the ccr helper (validated again there). */
export function ccrTemplate(p: ProviderInfo, base: string): { api_base_url: string; transformer?: { use: string[] } } {
    return {
        api_base_url: p.ccrUrl && base === p.base ? p.ccrUrl : chatUrl(base),
        ...(p.transformer ? { transformer: { use: p.transformer } } : {}),
    };
}

// ---- VS Code side: custom providers and per-provider values live in settings ----

export function customProviders(): CustomProvider[] {
    const raw = vscode.workspace.getConfiguration('hoppy').get<unknown[]>('customProviders') || [];
    return raw
        .filter((c: any) => c && typeof c.id === 'string' && /^custom-[a-z0-9-]{1,30}$/.test(c.id) && typeof c.baseUrl === 'string' && !checkBaseUrl(c.baseUrl))
        .map((c: any) => ({ id: c.id, label: String(c.label || c.id).slice(0, 40), baseUrl: normalizeBase(c.baseUrl) }));
}

export function allProviders(): ProviderInfo[] {
    return [...PROVIDERS, ...customProviders().map(toCustomInfo)];
}

export function findProvider(id: string): ProviderInfo | undefined {
    return allProviders().find((p) => p.id === id);
}

/** Account id (Cloudflare) or server address (local) saved per provider. Not secret. */
export function providerOptions(id: string): { account?: string; base?: string } {
    const all = vscode.workspace.getConfiguration('hoppy').get<Record<string, any>>('providerOptions') || {};
    const o = all[id] || {};
    return { account: typeof o.account === 'string' ? o.account : undefined, base: typeof o.base === 'string' ? o.base : undefined };
}

export async function setProviderOptions(id: string, value: { account?: string; base?: string }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    const all = { ...(cfg.get<Record<string, unknown>>('providerOptions') || {}) };
    all[id] = value;
    await cfg.update('providerOptions', all, vscode.ConfigurationTarget.Global);
}

/** Base URL in use for a provider, from its saved options. */
export function baseFor(p: ProviderInfo): string | undefined {
    return resolveBase(p, providerOptions(p.id));
}
