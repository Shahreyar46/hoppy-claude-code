// Learned usage caps per Claude account. Anthropic publishes no exact remaining number, so Hoppy learns one:
// when an account hits its 5-hour or weekly limit, the tokens counted in that window become the account's cap.
// Remaining = cap - used now. Before the first limit is seen there is no cap and the UI shows usage only.
// Always presented as an estimate ("~40% left").
import * as path from 'path';
import * as vscode from 'vscode';

export type CapWindow = 'session' | 'weekly';

export interface Cap {
    tokens: number;
    learnedAt: number;
}

export type CapStore = Record<string, Partial<Record<CapWindow, Cap>>>;

const STATE_KEY = 'hoppy.caps';
/** A cap learned from a tiny window (a limit hit right after a reset) would be misleading. */
const MIN_CAP_TOKENS = 50000;

const dirKey = (dir: string) => path.normalize(dir).replace(/[\\/]+$/, '').toLowerCase();

/** Store a cap from a limit hit. The newest hit wins: plans and Anthropic's weighting change. */
export function learn(store: CapStore, dir: string, window: CapWindow, usedTokens: number, now = Date.now()): CapStore {
    if (!(usedTokens >= MIN_CAP_TOKENS)) {
        return store;
    }
    const k = dirKey(dir);
    return { ...store, [k]: { ...store[k], [window]: { tokens: Math.round(usedTokens), learnedAt: now } } };
}

/**
 * While an account works past its learned cap, the cap was too low (other models, plan change): raise it, so
 * Hoppy never shows "0% left" for an account that is still answering.
 */
export function raiseIfPassed(store: CapStore, dir: string, window: CapWindow, usedTokens: number, now = Date.now()): CapStore {
    const cap = store[dirKey(dir)]?.[window];
    return cap && usedTokens > cap.tokens ? learn(store, dir, window, usedTokens, now) : store;
}

export function capFor(store: CapStore, dir: string, window: CapWindow): Cap | undefined {
    return store[dirKey(dir)]?.[window];
}

/** Share of the cap still left, 0..1, or undefined when no cap is known. */
export function fractionLeft(used: number, cap: Cap | undefined): number | undefined {
    if (!cap || cap.tokens <= 0) {
        return undefined;
    }
    return Math.max(0, Math.min(1, 1 - used / cap.tokens));
}

/** "~40% left" or undefined. Rounded to 5% so it does not pretend to be exact. */
export function leftLabel(fraction: number | undefined): string | undefined {
    if (fraction === undefined) {
        return undefined;
    }
    return `~${Math.round((fraction * 100) / 5) * 5}% left`;
}

// ---- VS Code side ----

export function loadCaps(state: vscode.Memento): CapStore {
    return state.get<CapStore>(STATE_KEY) || {};
}

export async function saveCaps(state: vscode.Memento, store: CapStore): Promise<void> {
    await state.update(STATE_KEY, store);
}
