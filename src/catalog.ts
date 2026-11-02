// Built-in model catalog shipped with Hoppy (media/catalog.json). No remote fetch: it is updated with each
// release. Limits are free-tier numbers from the providers' docs on the date in the file; they change, so the
// UI labels them as estimates.
import * as fs from 'fs';
import * as path from 'path';

export type Tier = 'pro' | 'mid' | 'fast';

export interface CatalogEntry {
    provider: string;
    id: string;
    label: string;
    free: boolean;
    context?: number;
    tools?: boolean;
    vision?: boolean;
    /** Free-tier limits, when the provider publishes them. */
    rpm?: number;
    rpd?: number;
    tpm?: number;
    tpd?: number;
    tier?: Tier;
    /** Intelligence rank, lower is smarter (1 = best). */
    rank?: number;
    /** Speed rank, 1 = fastest. */
    speed?: number;
}

export interface ClaudePrice {
    /** Model id prefix, e.g. "claude-sonnet". */
    match: string;
    input: number;
    output: number;
}

export interface Catalog {
    updated: string;
    models: CatalogEntry[];
    /** List prices per 1M tokens, used for "estimated savings". */
    claudePrices: ClaudePrice[];
}

let cached: Catalog | undefined;

export function parseCatalog(raw: unknown): Catalog {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const models = (Array.isArray(r.models) ? r.models : [])
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as any).provider === 'string' && typeof (m as any).id === 'string')
        .map<CatalogEntry>((m) => ({
            provider: String(m.provider),
            id: String(m.id),
            label: typeof m.label === 'string' ? m.label : String(m.id),
            free: m.free === true,
            context: num(m.context),
            tools: typeof m.tools === 'boolean' ? m.tools : undefined,
            vision: typeof m.vision === 'boolean' ? m.vision : undefined,
            rpm: num(m.rpm),
            rpd: num(m.rpd),
            tpm: num(m.tpm),
            tpd: num(m.tpd),
            tier: m.tier === 'pro' || m.tier === 'mid' || m.tier === 'fast' ? m.tier : undefined,
            rank: num(m.rank),
            speed: num(m.speed),
        }));
    const claudePrices = (Array.isArray(r.claudePrices) ? r.claudePrices : [])
        .filter((p: any) => p && typeof p.match === 'string' && num(p.input) && num(p.output))
        .map((p: any) => ({ match: String(p.match), input: Number(p.input), output: Number(p.output) }));
    return { updated: typeof r.updated === 'string' ? r.updated : '', models, claudePrices };
}

export function loadCatalog(extensionPath: string): Catalog {
    if (!cached) {
        try {
            cached = parseCatalog(JSON.parse(fs.readFileSync(path.join(extensionPath, 'media', 'catalog.json'), 'utf8')));
        } catch {
            cached = { updated: '', models: [], claudePrices: [] };
        }
    }
    return cached;
}

/** Catalog entry for "provider/model". Matches the model id exactly, then without a ":free" or date suffix. */
export function findEntry(catalog: Catalog, selector: string): CatalogEntry | undefined {
    const [provider, ...rest] = selector.split('/');
    const id = rest.join('/');
    const same = catalog.models.filter((m) => m.provider === provider);
    const base = (s: string) => s.toLowerCase().replace(/:free$/, '').replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
    return same.find((m) => m.id === id) ?? same.find((m) => base(m.id) === base(id));
}

/** "10 rpm · 100 rpd" style limit label, or undefined when nothing is known. */
export function limitLabel(e: CatalogEntry | undefined): string | undefined {
    if (!e) {
        return undefined;
    }
    const k = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
    const parts = [e.rpm && `${k(e.rpm)} rpm`, e.rpd && `${k(e.rpd)} rpd`, e.tpd && `${k(e.tpd)} tokens/day`].filter(Boolean);
    return parts.length ? parts.join(' · ') : undefined;
}

/** Claude list price for a model id (per 1M tokens), longest matching prefix wins. */
export function claudePrice(catalog: Catalog, model: string): ClaudePrice | undefined {
    return catalog.claudePrices.filter((p) => model.startsWith(p.match)).sort((a, b) => b.match.length - a.match.length)[0];
}
