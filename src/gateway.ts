import { exec, spawn } from 'child_process';
import * as fs from 'fs';
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

/** Runs a PowerShell script without a window. Encoded, so paths need no shell quoting. */
function powershell(script: string, timeoutMs = 30000): ReturnType<typeof run> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return run(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, timeoutMs);
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** ccr's own entry script, from the global npm folder. */
async function ccrCli(): Promise<string | undefined> {
    const r = await run('npm root -g', 15000);
    const file = path.join(r.stdout.trim(), '@musistudio', 'claude-code-router', 'dist', 'main', 'cli.js');
    return r.ok && fs.existsSync(file) ? file : undefined;
}

// On Windows, "ccr start" runs a background service that launches the gateway in a
// visible console window (and relaunches it when the window is closed). Hoppy runs
// "ccr serve" instead: WMI starts it outside VS Code, so it outlives the window, with
// a hidden console that the gateway inherits.
const CCR_SERVE = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'claude-code-router' -and $_.CommandLine -match 'cli\\.js"? serve' }`;
const CCR_SERVICE = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'claude-code-router' -and $_.CommandLine -match 'daemon-child' }`;

async function startHidden(): Promise<boolean> {
    const cli = await ccrCli();
    if (!cli) {
        return false;
    }
    const r = await powershell([
        '$node = (Get-Command node -ErrorAction Stop).Source',
        '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
        `$line = '"' + $node + '" "' + ${psQuote(cli)} + '" serve --no-open'`,
        '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $env:USERPROFILE; ProcessStartupInformation = $si }',
        'exit $r.ReturnValue',
    ].join('\n'));
    return r.ok;
}

async function waitFor(up: boolean, tries: number): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        if ((await isGatewayUp()) === up) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

export async function startGateway(): Promise<boolean> {
    if (await isGatewayUp()) {
        // A gateway started by "ccr start" has a console window; swap it for a hidden one once.
        if (process.platform !== 'win32' || !(await powershell(`if (${CCR_SERVICE}) { exit 0 } else { exit 1 }`)).ok) {
            return true;
        }
        await stopGateway();
    }
    if (!(process.platform === 'win32' && (await startHidden()) && (await waitFor(true, 20)))) {
        await run('ccr start --no-open');
    }
    return waitFor(true, 20);
}

export async function stopGateway(): Promise<void> {
    await run('ccr stop');
    if (process.platform === 'win32') {
        await powershell(`${CCR_SERVE} | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`);
    }
    await waitFor(false, 10);
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
