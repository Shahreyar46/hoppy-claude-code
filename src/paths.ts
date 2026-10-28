import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const GATEWAY_PORT = 3456;

export function expandHome(p: string): string {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function setting<T>(key: string): T {
    return vscode.workspace.getConfiguration('hoppy').get<T>(key) as T;
}

/** Folder Claude Code uses in Other AI Models mode, e.g. C:\Users\me\.claude-router */
export function routerDir(): string {
    return path.normalize(expandHome(setting<string>('routerConfigDir') || '~/.claude-router'));
}

/** Same folder in ccr's "~/..." notation, which its profile settings expect. */
export function routerSettingsFileForCcr(): string {
    const raw = setting<string>('routerConfigDir') || '~/.claude-router';
    return `${raw.replace(/\\/g, '/').replace(/\/$/, '')}/settings.json`;
}

/** Claude Code config folders that hold real Claude (plan) chats. */
export function claudeConfigDirs(): string[] {
    const home = os.homedir();
    const found = new Set<string>([path.join(home, '.claude')]);
    for (const name of fs.readdirSync(home)) {
        if (/^\.claude-account/i.test(name)) {
            found.add(path.join(home, name));
        }
    }
    for (const extra of setting<string[]>('claudeConfigDirs') || []) {
        found.add(path.normalize(expandHome(extra)));
    }
    found.delete(routerDir());
    return [...found].filter((d) => fs.existsSync(d));
}

export function ccrDataDir(): string {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-code-router');
}
