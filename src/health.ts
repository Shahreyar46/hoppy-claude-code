// Live check of Other AI models: one tiny chat request with a tool, sent straight to the provider with the
// user's own key. Claude Code cannot work with a model that ignores tools, so "answers but never calls the
// tool" is reported separately from "works".

export type HealthStatus = 'ok' | 'no-tools' | 'busy' | 'quota' | 'key' | 'credit' | 'missing' | 'slow' | 'error';

export interface HealthResult {
    selector: string;
    status: HealthStatus;
    ms: number;
    note?: string;
    checkedAt: number;
}

/** OpenAI-compatible chat endpoints. Gemini has one too, so every provider is checked the same way. */
const CHAT_URL: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    deepseek: 'https://api.deepseek.com/chat/completions',
    glm: 'https://api.z.ai/api/paas/v4/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    cerebras: 'https://api.cerebras.ai/v1/chat/completions',
    mistral: 'https://api.mistral.ai/v1/chat/completions',
    nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
};

const TIMEOUT_MS = 25000;

export function splitSelector(selector: string): { provider: string; model: string } {
    const [provider, ...rest] = selector.split('/');
    return { provider, model: rest.join('/') };
}

export function statusFromHttp(code: number, body: string): HealthStatus {
    if (code === 401 || code === 403) {
        return 'key';
    }
    if (code === 429 && /per-day|per day|daily|requests per day/i.test(body)) {
        return 'quota';
    }
    if (code === 402 || /insufficient|balance|quota exceeded|billing/i.test(body)) {
        return code === 429 ? 'busy' : 'credit';
    }
    if (code === 429 || code === 503 || code === 529) {
        return 'busy';
    }
    if (code === 404 || code === 410 || /not found|does not exist|no endpoints|not a valid model|invalid model|end of life|no longer available/i.test(body)) {
        return 'missing';
    }
    return 'error';
}

export async function checkModel(selector: string, key: string): Promise<HealthResult> {
    const { provider, model } = splitSelector(selector);
    const url = CHAT_URL[provider];
    const started = Date.now();
    const done = (status: HealthStatus, note?: string): HealthResult => ({ selector, status, ms: Date.now() - started, note, checkedAt: Date.now() });
    if (!url) {
        return done('error', `No check available for ${provider}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                max_tokens: 512,
                messages: [{ role: 'user', content: 'Health check. Call the ping tool now, with no text.' }],
                tools: [{ type: 'function', function: { name: 'ping', description: 'Confirms the model can call tools.', parameters: { type: 'object', properties: {} } } }],
            }),
        });
        const text = await r.text();
        if (!r.ok) {
            let message = text.slice(0, 160);
            try {
                const j = JSON.parse(text);
                message = String(j.error?.message || j.message || j[0]?.error?.message || message).slice(0, 160);
            } catch {
                // not JSON
            }
            return done(statusFromHttp(r.status, text), `${r.status}: ${message}`);
        }
        const j = JSON.parse(text);
        const msg = j.choices?.[0]?.message;
        if (msg?.tool_calls?.length) {
            return done('ok');
        }
        return done('no-tools', 'Answered without calling the tool');
    } catch (err: any) {
        return err?.name === 'AbortError' ? done('slow', `No answer within ${TIMEOUT_MS / 1000}s`) : done('error', String(err?.message || err));
    } finally {
        clearTimeout(timer);
    }
}

/** Runs checks a few at a time, so free tiers are not hit with a burst. */
export async function checkModels(selectors: string[], keyFor: (provider: string) => Promise<string | undefined>, parallel = 3): Promise<HealthResult[]> {
    const results: HealthResult[] = [];
    const queue = [...new Set(selectors)];
    const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
            const key = await keyFor(splitSelector(s).provider);
            results.push(key ? await checkModel(s, key) : { selector: s, status: 'key', ms: 0, note: 'No key saved for this provider', checkedAt: Date.now() });
        }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
    return results;
}

/** Working models first, then unchecked, then slow or tool-less, then failing; order kept within each group. */
export function workingFirst(chain: string[], results: HealthResult[]): string[] {
    const rank = (s: string) => {
        const st = results.find((r) => r.selector === s)?.status;
        return st === 'ok' ? 0 : st === undefined ? 1 : st === 'slow' || st === 'no-tools' ? 2 : 3;
    };
    return chain.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}
