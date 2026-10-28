import { exec, spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { GATEWAY_PORT } from './paths';

export interface CcrStatus {
    exists: boolean;
    providers?: { name: string; hasKey: boolean; keyHint?: string | null; models: string[] }[];
    fallback?: { mode: string; models: string[] } | null;
    claudeSettingsFile?: string | null;
    claudeModel?: string | null;
    codexEnabled?: boolean;
}

function run(command: string, timeoutMs = 60000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        exec(command, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export function isGatewayUp(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: GATEWAY_PORT });
        socket.setTimeout(1500);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

export async function isCcrInstalled(): Promise<boolean> {
    return (await run('where ccr', 10000)).ok;
}

/** Installs claude-code-router globally with npm, in the background. */
export async function installCcr(): Promise<{ ok: boolean; output: string }> {
    const r = await run('npm install -g @musistudio/claude-code-router', 300000);
    return { ok: r.ok && (await isCcrInstalled()), output: (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n') };
}

export async function startGateway(): Promise<boolean> {
    if (await isGatewayUp()) {
        return true;
    }
    await run('ccr start --no-open');
    for (let i = 0; i < 20; i++) {
        if (await isGatewayUp()) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

export async function stopGateway(): Promise<void> {
    await run('ccr stop');
}

/** System Node (not VS Code's Electron); the helper needs node:sqlite (Node 22.5+). */
export async function nodeVersionOk(): Promise<{ ok: boolean; version: string }> {
    const r = await run('node -v', 10000);
    const version = r.stdout.trim();
    const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
    return { ok: r.ok && (major > 22 || (major === 22 && minor >= 5)), version: version || 'not found' };
}

/** Runs scripts/ccr-config.mjs. Secrets go through stdin, never the command line. */
export function runHelper(extensionPath: string, command: string, input?: object): Promise<any> {
    const script = path.join(extensionPath, 'scripts', 'ccr-config.mjs');
    return new Promise((resolve) => {
        const child = spawn('node', ['--no-warnings', script, ...command.split(' ')], { windowsHide: true, shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (err) => resolve({ ok: false, error: String(err) }));
        child.on('close', () => {
            try {
                resolve(JSON.parse(stdout));
            } catch {
                resolve({ ok: false, error: stderr.trim() || stdout.trim() || 'helper produced no output' });
            }
        });
        child.stdin.end(input ? JSON.stringify(input) : '');
    });
}

export async function ccrStatus(extensionPath: string): Promise<CcrStatus> {
    const r = await runHelper(extensionPath, 'status');
    return r && typeof r.exists === 'boolean' ? r : { exists: false };
}
