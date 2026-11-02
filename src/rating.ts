import * as vscode from 'vscode';

/** Marketplace review page for Hoppy. */
export const REVIEW_URL = 'https://marketplace.visualstudio.com/items?itemName=shahreyar.hoppy-claude-code&ssr=false#review-details';

export interface RatingState {
    firstSeen?: number;
    wins?: number;
    askAfter?: number;
    done?: boolean;
}

const KEY = 'hoppy.rating';
const DAY = 86400000;
export const MIN_DAYS = 4;
export const MIN_WINS = 3;
export const LATER_DAYS = 14;

/**
 * Ask once, only after real use: Hoppy installed for a few days and a few things worked for the user
 * (switching accounts, a voice text landing in Claude). "Later" waits two weeks; "never" and "rated" stop it.
 */
export function shouldAsk(s: RatingState, now: number): boolean {
    if (s.done || !s.firstSeen) {
        return false;
    }
    if (s.askAfter && now < s.askAfter) {
        return false;
    }
    return now - s.firstSeen >= MIN_DAYS * DAY && (s.wins || 0) >= MIN_WINS;
}

let memento: vscode.Memento | undefined;

export function initRating(state: vscode.Memento, now = Date.now()): void {
    memento = state;
    const s = state.get<RatingState>(KEY) || {};
    if (!s.firstSeen) {
        void state.update(KEY, { ...s, firstSeen: now });
    }
}

/** Something worked for the user. May show the one-time rating request (never during a modal flow). */
export function noteWin(): void {
    if (!memento) {
        return;
    }
    const state = memento;
    const s: RatingState = { ...(state.get<RatingState>(KEY) || {}) };
    s.wins = (s.wins || 0) + 1;
    void state.update(KEY, s);
    if (!shouldAsk(s, Date.now())) {
        return;
    }
    // Mark first, so two quick wins never show two requests.
    void state.update(KEY, { ...s, askAfter: Date.now() + LATER_DAYS * DAY });
    setTimeout(async () => {
        const pick = await vscode.window.showInformationMessage(
            'Is Hoppy saving you time? A quick rating on the Marketplace helps other Claude Code users find it.',
            'Rate Hoppy',
            'Later',
            "Don't ask again",
        );
        const cur = state.get<RatingState>(KEY) || {};
        if (pick === 'Rate Hoppy') {
            await vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
            await state.update(KEY, { ...cur, done: true });
        } else if (pick === "Don't ask again") {
            await state.update(KEY, { ...cur, done: true });
        }
        // "Later" or closed: askAfter (two weeks) already set.
    }, 3000);
}
