import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ccrStatus, installCcr, isCcrInstalled, nodeVersionOk, runHelper, startGateway, stopGateway } from './gateway';
import { ccrDataDir, routerSettingsFileForCcr } from './paths';

export interface ProviderInfo {
    id: 'openrouter' | 'gemini' | 'deepseek' | 'glm';
    label: string;
    keyUrl: string;
    note: string;
    looksValid: (key: string) => string | undefined;
}

export const PROVIDERS: ProviderInfo[] = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        keyUrl: 'https://openrouter.ai/settings/keys',
        note: 'Recommended. One key for free and paid models: DeepSeek, GLM, MiMo, Kimi, GPT…',
        looksValid: (k) => (k.startsWith('sk-or-') ? undefined : 'OpenRouter keys start with sk-or-'),
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        keyUrl: 'https://aistudio.google.com/apikey',
        note: 'Free tier, separate daily quota',
        looksValid: (k) => (k.startsWith('AIza') ? undefined : 'Gemini keys start with AIza'),
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        keyUrl: 'https://platform.deepseek.com/api_keys',
        note: 'Paid (prepaid balance)',
        looksValid: (k) => (k.startsWith('sk-') ? undefined : 'DeepSeek keys start with sk-'),
    },
    {
        id: 'glm',
        label: 'GLM (Z.ai)',
        keyUrl: 'https://z.ai/manage-apikey/apikey-list',
        note: 'Paid or GLM Coding Plan',
        looksValid: (k) => (k.includes('.') ? undefined : 'Z.ai keys have a dot in the middle (xxxx.yyyy). Use the copy button.'),
    },
];

function askKey(p: ProviderInfo): Promise<string | undefined> {
    return new Promise((resolve) => {
        const box = vscode.window.createInputBox();
        box.title = `${p.label} API key`;
        box.prompt = `Paste your ${p.label} key. Leave empty to keep the current one. Click the globe to open the key page.`;
        box.password = true;
        box.ignoreFocusOut = true;
        box.buttons = [{ iconPath: new vscode.ThemeIcon('globe'), tooltip: `Open ${p.keyUrl}` }];
        box.onDidTriggerButton(() => vscode.env.openExternal(vscode.Uri.parse(p.keyUrl)));
        box.onDidChangeValue((v) => (box.validationMessage = v.trim() ? p.looksValid(v.trim()) : undefined));
        box.onDidAccept(() => {
            const v = box.value.trim();
            if (v && p.looksValid(v)) {
                return;
            }
            resolve(v);
            box.dispose();
        });
        box.onDidHide(() => {
            resolve(undefined);
            box.dispose();
        });
        box.show();
    });
}

/** Cheap live check (no model tokens used). Returns a human-readable result line. */
export async function checkKey(id: ProviderInfo['id'], key: string): Promise<{ ok: boolean; message: string }> {
    try {
        if (id === 'openrouter') {
            const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
            if (!r.ok) {
                return { ok: false, message: `OpenRouter rejected the key (${r.status})` };
            }
            const d = ((await r.json()) as any).data;
            const free = d.free_model_daily_requests;
            return { ok: true, message: `OpenRouter OK${free ? `, free requests today: ${free.remaining}/${free.limit}` : ''}` };
        }
        if (id === 'gemini') {
            const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
            return r.ok ? { ok: true, message: 'Gemini OK' } : { ok: false, message: `Gemini rejected the key (${r.status})` };
        }
        if (id === 'deepseek') {
            const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } });
            if (!r.ok) {
                return { ok: false, message: `DeepSeek rejected the key (${r.status})` };
            }
            const d = (await r.json()) as any;
            const bal = d.balance_infos?.[0];
            return { ok: true, message: `DeepSeek OK, balance ${bal ? `${bal.total_balance} ${bal.currency}` : 'unknown'}${d.is_available ? '' : ' (add credit to use it)'}` };
        }
        return { ok: true, message: 'GLM key saved (no free check available; a 401 or 429 later means bad key or no balance)' };
    } catch (err) {
        return { ok: true, message: `${id}: could not reach the provider to check (${String(err)}); key saved anyway` };
    }
}

export async function fetchFreeModels(): Promise<string[]> {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const data: any[] = ((await r.json()) as any).data;
    return data
        .filter((m) => m.id.endsWith(':free') && (m.supported_parameters || []).includes('tools'))
        .map((m) => m.id)
        .sort();
}

/** Stop ccr, undo any takeover of the user's own configs, apply options, start ccr again. */
export async function applyToCcr(context: vscode.ExtensionContext, options: object): Promise<{ ok: boolean; lines: string[] }> {
    const cfg = vscode.workspace.getConfiguration('hoppy');
    await stopGateway();
    const restore = await runHelper(context.extensionPath, 'restore-takeover');
    const result = await runHelper(context.extensionPath, 'apply', {
        routerSettingsFile: routerSettingsFileForCcr(),
        fallback: cfg.get<string[]>('fallbackModels'),
        mainModel: cfg.get<string>('mainModel'),
        smallModel: cfg.get<string>('smallModel'),
        ...options,
    });
    const started = await startGateway();
    const lines = [
        ...(restore.restored || []).map((f: string) => `Restored your original config: ${f}`),
        ...(result.changes || []),
        started ? 'Other AI is ready' : 'Other AI did not start. Open the Hoppy menu → More → Restart Other AI',
    ];
    if (!result.ok) {
        lines.unshift(`Config update failed: ${result.error}`);
    }
    return { ok: !!result.ok && started, lines };
}

/** First ccr start creates its config (and takes over ~/.claude); undo the takeover right away. */
async function ensureCcrConfig(context: vscode.ExtensionContext): Promise<boolean> {
    if ((await ccrStatus(context.extensionPath)).exists) {
        return true;
    }
    await startGateway();
    const db = path.join(ccrDataDir(), 'config.sqlite');
    for (let i = 0; i < 30 && !fs.existsSync(db); i++) {
        await new Promise((r) => setTimeout(r, 500));
    }
    await stopGateway();
    await runHelper(context.extensionPath, 'restore-takeover');
    return (await ccrStatus(context.extensionPath)).exists;
}

export async function runSetup(context: vscode.ExtensionContext): Promise<boolean> {
    const node = await nodeVersionOk();
    if (!node.ok) {
        const pick = await vscode.window.showErrorMessage(
            `Node.js 22.5 or newer is required (found: ${node.version}).`,
            'Download Node.js',
        );
        if (pick) {
            vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
        }
        return false;
    }

    if (!(await isCcrInstalled())) {
        const pick = await vscode.window.showInformationMessage(
            'One-time setup: Hoppy needs a small local helper (Claude Code Router) to connect Claude Code to other AI models. Install it now? It takes about a minute, no terminal needed.',
            { modal: true },
            'Install now',
        );
        if (!pick) {
            return false;
        }
        const install = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Installing the Other AI helper (about a minute)…' },
            () => installCcr(),
        );
        if (!install.ok) {
            vscode.window.showErrorMessage('Installing Claude Code Router failed.', { modal: true, detail: install.output });
            return false;
        }
    }

    const ready = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Preparing Other AI…' },
        () => ensureCcrConfig(context),
    );
    if (!ready) {
        vscode.window.showErrorMessage('Could not create the ccr config. Run "ccr start" in a terminal, then try again.');
        return false;
    }

    const status = await ccrStatus(context.extensionPath);
    const hasKey = (id: string) => !!status.providers?.find((p) => p.name === id && p.hasKey);
    const chosen = await vscode.window.showQuickPick(
        PROVIDERS.map((p) => ({
            label: `${hasKey(p.id) ? '$(check) ' : ''}${p.label}`,
            description: p.note,
            picked: p.id === 'openrouter' && !hasKey(p.id),
            provider: p,
        })),
        { title: 'Which providers do you want to add or update?', canPickMany: true, ignoreFocusOut: true },
    );
    if (!chosen) {
        return false;
    }

    const keys: Record<string, string> = {};
    const report: string[] = [];
    for (const { provider } of chosen) {
        const key = await askKey(provider);
        if (key === undefined) {
            return false;
        }
        if (!key) {
            continue;
        }
        const check = await checkKey(provider.id, key);
        report.push(`${check.ok ? '✔' : '✖'} ${check.message}`);
        if (check.ok) {
            keys[provider.id] = key;
        }
    }

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Saving keys and updating models…' },
        async () => {
            let freeModels: string[] = [];
            if (keys.openrouter || hasKey('openrouter')) {
                freeModels = await fetchFreeModels().catch(() => []);
            }
            return applyToCcr(context, { keys, freeModels });
        },
    );

    const summary = [...report, ...result.lines].join('\n');
    const pick = await vscode.window.showInformationMessage(
        result.ok ? 'Setup complete.' : 'Setup finished with problems.',
        { modal: true, detail: summary },
        'Switch to Other AI now',
    );
    return pick === 'Switch to Other AI now';
}
