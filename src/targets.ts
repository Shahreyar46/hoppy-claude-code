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

function sameDir(a: string, b: string): boolean {
    return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
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
    const env = (claudeCodeConfig().get<EnvVar[]>('environmentVariables') || []).filter((e) => e.name !== 'CLAUDE_CONFIG_DIR');
    const isDefault = sameDir(t.dir, path.join(os.homedir(), '.claude'));
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    if (!isDefault || (inherited && !sameDir(inherited, t.dir))) {
        env.push({ name: 'CLAUDE_CONFIG_DIR', value: t.dir });
    }
    await claudeCodeConfig().update('environmentVariables', env, vscode.ConfigurationTarget.Global);
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
