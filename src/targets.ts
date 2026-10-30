import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeConfigDirs, routerDir } from './paths';

/** Where the Claude panel can point: one of the user's Claude accounts, or the Other AI router. */
export interface Target {
    kind: 'claude' | 'other';
    dir: string;
    label: string;
    email?: string;
    loggedIn: boolean;
}

interface EnvVar {
    name: string;
    value: string;
}

function claudeCodeConfig() {
    return vscode.workspace.getConfiguration('claudeCode');
}

/** Same folder, ignoring case and a trailing separator (CLAUDE_CONFIG_DIR is often set with one). */
export function sameDir(a: string, b: string): boolean {
    const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

function readEmail(dir: string): string | undefined {
    const candidates = [path.join(dir, '.claude.json')];
    if (sameDir(dir, path.join(os.homedir(), '.claude'))) {
        candidates.push(path.join(os.homedir(), '.claude.json'));
    }
    for (const file of candidates) {
        try {
            const email = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount?.emailAddress;
            if (email) {
                return email;
            }
        } catch {
            // missing or unreadable state file
        }
    }
    return undefined;
}

function labelFor(dir: string): string {
    const custom = vscode.workspace.getConfiguration('hoppy').get<Record<string, string>>('accountLabels') || {};
    const key = Object.keys(custom).find((k) => sameDir(k.replace(/^~/, os.homedir()), dir));
    if (key) {
        return custom[key];
    }
    const name = path.basename(dir);
    return name === '.claude' ? 'main' : name.replace(/^\.claude-?/, '') || name;
}

export function listTargets(): Target[] {
    const claude = claudeConfigDirs().map<Target>((dir) => ({
        kind: 'claude',
        dir,
        label: labelFor(dir),
        email: readEmail(dir),
        loggedIn: fs.existsSync(path.join(dir, '.credentials.json')),
    }));
    return [...claude, { kind: 'other', dir: routerDir(), label: 'Other AI', loggedIn: true }];
}

/** The folder the Claude panel uses now: Hoppy's setting, else VS Code's own environment, else ~/.claude. */
export function currentDir(): string {
    const fromSetting = (claudeCodeConfig().get<EnvVar[]>('environmentVariables') || []).find((e) => e.name === 'CLAUDE_CONFIG_DIR')?.value;
    return path.normalize(fromSetting || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export function currentTarget(): Target {
    const dir = currentDir();
    return listTargets().find((t) => sameDir(t.dir, dir)) ?? { kind: 'claude', dir, label: labelFor(dir), loggedIn: true };
}

export function isCurrent(t: Target): boolean {
    return sameDir(t.dir, currentDir());
}

/**
 * Points the Claude Code extension at a target folder. The login itself is never touched.
 * For the default ~/.claude account the variable is removed rather than set: with no
 * CLAUDE_CONFIG_DIR, Claude Code also reads its account state from ~/.claude.json, which an
 * explicit ~/.claude path would skip (and could prompt for a fresh login).
 */
export async function setTarget(t: Target): Promise<void> {
    await claudeCodeConfig().update('environmentVariables', envFor(t), vscode.ConfigurationTarget.Global);
    // Switching inside a pinned project moves its pin along, so "this project uses X" stays true.
    if (isProjectPinned()) {
        await pinProject(t);
    }
}

function envFor(t: Target): EnvVar[] {
    const env = (claudeCodeConfig().get<EnvVar[]>('environmentVariables') || []).filter((e) => e.name !== 'CLAUDE_CONFIG_DIR');
    const isDefault = sameDir(t.dir, path.join(os.homedir(), '.claude'));
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    if (!isDefault || (inherited && !sameDir(inherited, t.dir))) {
        env.push({ name: 'CLAUDE_CONFIG_DIR', value: t.dir });
    }
    return env;
}

// Claude Code reads its environment from User settings only, so a project cannot carry its own copy.
// Hoppy keeps "project folder -> account folder" and points the panel there when the project's window
// opens or gets focus.

function projectFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function projectAccounts(): Record<string, string> {
    return vscode.workspace.getConfiguration('hoppy').get<Record<string, string>>('projectAccounts') || {};
}

/** Account folder pinned to the open project, if any. */
export function pinnedDir(): string | undefined {
    const folder = projectFolder();
    if (!folder) {
        return undefined;
    }
    const map = projectAccounts();
    const key = Object.keys(map).find((k) => sameDir(k, folder));
    return key ? map[key] : undefined;
}

export function isProjectPinned(): boolean {
    return !!pinnedDir();
}

export async function pinProject(t: Target): Promise<void> {
    const folder = projectFolder();
    if (!folder) {
        return;
    }
    const map = Object.fromEntries(Object.entries(projectAccounts()).filter(([k]) => !sameDir(k, folder)));
    map[folder] = t.dir;
    await vscode.workspace.getConfiguration('hoppy').update('projectAccounts', map, vscode.ConfigurationTarget.Global);
}

export async function unpinProject(): Promise<void> {
    const folder = projectFolder();
    if (!folder) {
        return;
    }
    const map = Object.fromEntries(Object.entries(projectAccounts()).filter(([k]) => !sameDir(k, folder)));
    await vscode.workspace.getConfiguration('hoppy').update('projectAccounts', map, vscode.ConfigurationTarget.Global);
}

/** Points the panel at the project's pinned account. Returns the target when it had to switch. */
export async function applyProjectPin(): Promise<Target | undefined> {
    const dir = pinnedDir();
    if (!dir || sameDir(dir, currentDir())) {
        return undefined;
    }
    const t = listTargets().find((x) => sameDir(x.dir, dir));
    if (!t) {
        return undefined;
    }
    await claudeCodeConfig().update('environmentVariables', envFor(t), vscode.ConfigurationTarget.Global);
    return t;
}

/** Creates the next free ~/.claude-accountN folder for a new Claude login. */
export function createAccountDir(): string {
    for (let n = 2; ; n++) {
        const dir = path.join(os.homedir(), `.claude-account${n}`);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            return dir;
        }
    }
}

export async function setLabel(t: Target, label: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    const labels = { ...(cfg.get<Record<string, string>>('accountLabels') || {}) };
    labels[t.dir] = label;
    await cfg.update('accountLabels', labels, vscode.ConfigurationTarget.Global);
}

export function describe(t: Target): string {
    return t.kind === 'other' ? 'Other AI' : `Claude · ${t.label}`;
}

/** Colors offered in Settings; picked to read well on both light and dark status bars. */
export const ACCOUNT_COLORS = ['#FF6B8B', '#FFB38A', '#E5C07B', '#89D185', '#4EC9B0', '#B180D7'];

export function colorFor(dir: string): string | undefined {
    const colors = vscode.workspace.getConfiguration('hoppy').get<Record<string, string>>('accountColors') || {};
    const key = Object.keys(colors).find((k) => sameDir(k.replace(/^~/, os.homedir()), dir));
    return key ? colors[key] : undefined;
}

/** Saves a color for an account folder; an empty color removes it. Only known colors are accepted. */
export async function setColor(dir: string, color: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    const colors = { ...(cfg.get<Record<string, string>>('accountColors') || {}) };
    for (const k of Object.keys(colors)) {
        if (sameDir(k.replace(/^~/, os.homedir()), dir)) {
            delete colors[k];
        }
    }
    if (ACCOUNT_COLORS.includes(color)) {
        colors[dir] = color;
    }
    await cfg.update('accountColors', colors, vscode.ConfigurationTarget.Global);
}
