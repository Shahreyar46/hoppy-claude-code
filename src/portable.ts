import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ccrStatus } from './gateway';
import { applyToCcr, PROVIDERS } from './setup';
import { ACCOUNT_COLORS, colorFor, listTargets, setColor, setLabel } from './targets';

// Settings that travel between PCs or teammates. API keys and logins never do.

interface PortableFile {
    hoppy: 1;
    exportedAt: string;
    settings: Record<string, unknown>;
    accounts: { folder: string; label: string; color?: string }[];
    providers: Record<string, string[]>;
}

/** Plain settings safe to share, with the type each must have on import. */
const SETTINGS: Record<string, 'string' | 'boolean' | 'string[]'> = {
    mainModel: 'string',
    smallModel: 'string',
    fallbackModels: 'string[]',
    onLimit: 'string',
    suggestOnLimit: 'boolean',
    showUsage: 'boolean',
    syncChatsOnSwitch: 'boolean',
    autoStartGateway: 'boolean',
};

const ON_LIMIT = ['ask', 'nextAccount', 'otherAi'];

function toPortablePath(dir: string): string {
    const home = os.homedir();
    const inHome = dir.toLowerCase() === home.toLowerCase() || dir.toLowerCase().startsWith(home.toLowerCase() + path.sep);
    return inHome ? `~${dir.slice(home.length).replace(/\\/g, '/')}` : dir;
}

function fromPortablePath(p: string): string {
    return path.normalize(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
}

function typeOk(value: unknown, type: 'string' | 'boolean' | 'string[]'): boolean {
    if (type === 'string[]') {
        return Array.isArray(value) && value.every((v) => typeof v === 'string');
    }
    return typeof value === type;
}

export async function exportSettings(context: vscode.ExtensionContext): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    const settings: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS)) {
        const v = cfg.get(key);
        if (v !== undefined) {
            settings[key] = v;
        }
    }
    const status = await ccrStatus(context.extensionPath);
    const providers: Record<string, string[]> = {};
    for (const p of status.providers || []) {
        if (p.hasKey && PROVIDERS.some((x) => x.id === p.name)) {
            providers[p.name] = p.models;
        }
    }
    const data: PortableFile = {
        hoppy: 1,
        exportedAt: new Date().toISOString(),
        settings,
        accounts: listTargets()
            .filter((t) => t.kind === 'claude')
            .map((t) => ({ folder: toPortablePath(t.dir), label: t.label, color: colorFor(t.dir) })),
        providers,
    };
    const uri = await vscode.window.showSaveDialog({
        title: 'Export Hoppy settings',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Desktop', 'hoppy-settings.json')),
        filters: { 'Hoppy settings': ['json'] },
    });
    if (!uri) {
        return;
    }
    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2));
    vscode.window.showInformationMessage(`Settings exported to ${path.basename(uri.fsPath)}. It has your model choices and account names, never API keys or logins.`);
}

export async function importSettings(context: vscode.ExtensionContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ title: 'Import Hoppy settings', canSelectMany: false, filters: { 'Hoppy settings': ['json'] } });
    if (!picked?.[0]) {
        return;
    }
    let data: PortableFile;
    try {
        data = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf8'));
    } catch {
        vscode.window.showErrorMessage('That file is not a Hoppy settings file.');
        return;
    }
    if (data?.hoppy !== 1 || typeof data.settings !== 'object' || !data.settings) {
        vscode.window.showErrorMessage('That file is not a Hoppy settings file.');
        return;
    }

    const cfg = vscode.workspace.getConfiguration('hoppy');
    let applied = 0;
    for (const [key, type] of Object.entries(SETTINGS)) {
        const v = (data.settings as Record<string, unknown>)[key];
        if (v === undefined || !typeOk(v, type) || (key === 'onLimit' && !ON_LIMIT.includes(v as string))) {
            continue;
        }
        await cfg.update(key, v, vscode.ConfigurationTarget.Global);
        applied++;
    }

    // Names and colors only for account folders that exist on this PC.
    const here = listTargets().filter((t) => t.kind === 'claude');
    let named = 0;
    for (const a of Array.isArray(data.accounts) ? data.accounts : []) {
        if (typeof a?.folder !== 'string' || typeof a.label !== 'string') {
            continue;
        }
        const t = here.find((x) => x.dir.toLowerCase() === fromPortablePath(a.folder).toLowerCase());
        if (!t) {
            continue;
        }
        await setLabel(t, a.label.slice(0, 40));
        if (typeof a.color === 'string' && ACCOUNT_COLORS.includes(a.color)) {
            await setColor(t.dir, a.color);
        }
        named++;
    }

    // Model lists only for providers already connected here; others need their own key first.
    const status = await ccrStatus(context.extensionPath);
    const connected = new Set((status.providers || []).filter((p) => p.hasKey).map((p) => p.name));
    const providerModels: Record<string, string[]> = {};
    const needKey: string[] = [];
    for (const [id, models] of Object.entries(data.providers && typeof data.providers === 'object' ? data.providers : {})) {
        const info = PROVIDERS.find((p) => p.id === id);
        if (!info || !Array.isArray(models)) {
            continue;
        }
        if (connected.has(id)) {
            providerModels[id] = models.filter((m) => typeof m === 'string');
        } else {
            needKey.push(info.label);
        }
    }
    const modelSettings = ['mainModel', 'smallModel', 'fallbackModels'].some((k) => (data.settings as Record<string, unknown>)[k] !== undefined);
    // applyToCcr reads main model and backups from settings, so it also runs when only those changed.
    if (Object.keys(providerModels).length || modelSettings) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Applying model choices…' }, () => applyToCcr(context, { providerModels }));
    }

    const lines = [`${applied} settings applied`, `${named} account name(s) matched`, `${Object.keys(providerModels).length} provider model list(s) applied`];
    const pick = await vscode.window.showInformationMessage(
        `Settings imported: ${lines.join(', ')}.${needKey.length ? ` Connect ${needKey.join(', ')} with your own key to use their models.` : ''}`,
        ...(needKey.length ? ['Open AI Providers'] : []),
    );
    if (pick) {
        await vscode.commands.executeCommand('hoppy.settings', 'providers');
    }
}
