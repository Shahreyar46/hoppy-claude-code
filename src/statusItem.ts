import * as vscode from 'vscode';

export interface ItemLook {
    text: string;
    tooltip?: string | vscode.MarkdownString;
    color?: string | vscode.ThemeColor;
    backgroundColor?: vscode.ThemeColor;
}

const shown = new WeakMap<vscode.StatusBarItem, string>();

function colorKey(c: string | vscode.ThemeColor | undefined): string {
    return c === undefined ? '' : typeof c === 'string' ? c : `theme:${(c as unknown as { id: string }).id}`;
}

/** What the item would show, as one comparable string. */
export function lookKey(look: ItemLook): string {
    const tip = look.tooltip === undefined ? '' : typeof look.tooltip === 'string' ? look.tooltip : look.tooltip.value;
    return JSON.stringify([look.text, tip, colorKey(look.color), colorKey(look.backgroundColor)]);
}

/**
 * Updates a status bar item only when something visible changed. Every assignment, even of the same
 * value, makes VS Code redraw the item, which closes and reopens an open hover (it "blinks").
 */
export function applyLook(item: vscode.StatusBarItem, look: ItemLook): void {
    const key = lookKey(look);
    if (shown.get(item) === key) {
        return;
    }
    shown.set(item, key);
    item.text = look.text;
    item.tooltip = look.tooltip;
    item.color = look.color;
    item.backgroundColor = look.backgroundColor;
}
