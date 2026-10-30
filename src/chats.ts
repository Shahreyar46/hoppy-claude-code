import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { listTargets, Target } from './targets';
import { noteImported } from './usage';

export interface Chat {
    file: string;
    source: Target;
    projectFolder: string;
    modified: Date;
    preview: string;
    hasImages: boolean;
}

/** Claude Code stores chats under projects/<folder path with every non-alphanumeric char as "-">. */
function projectKey(folder: string): string {
    return folder.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
}

function workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function projectDir(t: Target, folder: string): { dir: string; name: string } | undefined {
    const projects = path.join(t.dir, 'projects');
    if (!fs.existsSync(projects)) {
        return undefined;
    }
    const name = fs.readdirSync(projects).find((d) => d.toLowerCase() === projectKey(folder));
    return name ? { dir: path.join(projects, name), name } : undefined;
}

function firstUserMessage(content: string): string {
    for (const line of content.split('\n')) {
        try {
            const entry = JSON.parse(line);
            if (entry.type !== 'user' || entry.isMeta) {
                continue;
            }
            const c = entry.message?.content;
            // The VS Code panel sends editor context (<ide_opened_file>…) as its own text block before
            // the user's words, so look at every text block, not only the first.
            const texts: string[] = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => String(x.text || '')) : [];
            const text = texts.find((s) => s.trim() && !s.trim().startsWith('<'));
            if (text) {
                return text.replace(/\s+/g, ' ').trim().slice(0, 90);
            }
        } catch {
            // partial or non-JSON line
        }
    }
    return '(no preview)';
}

/** All chats for the open folder, across every Claude account and Other AI, newest first. */
export function findChats(): Chat[] {
    const folder = workspaceFolder();
    if (!folder) {
        return [];
    }
    const chats: Chat[] = [];
    for (const t of listTargets()) {
        const proj = projectDir(t, folder);
        if (!proj) {
            continue;
        }
        for (const name of fs.readdirSync(proj.dir).filter((n) => n.endsWith('.jsonl'))) {
            const file = path.join(proj.dir, name);
            const stat = fs.statSync(file);
            if (stat.size === 0) {
                continue;
            }
            const content = fs.readFileSync(file, 'utf8');
            chats.push({
                file,
                source: t,
                projectFolder: proj.name,
                modified: stat.mtime,
                preview: firstUserMessage(content),
                hasImages: content.includes('"type":"image"'),
            });
        }
    }
    return chats.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Removes Claude's internal thinking entries and re-links the chat around them.
 * Thinking blocks carry signatures from the account/model that produced them; another Claude
 * account (or a chat continued by a non-Claude model) may be rejected when they are replayed.
 * Messages, tool calls and results are all kept.
 */
export function stripThinking(content: string): string {
    return cleanChat(content, { thinking: true });
}

/**
 * Removes entries that should not travel to another account or model, re-linking the chat around them:
 * Claude Code's own error notices ("You've hit your session limit…") always, thinking when asked.
 */
export function cleanChat(content: string, opts: { thinking: boolean }): string {
    const lines = content.split('\n');
    const removed = new Map<string, string | null>();
    const kept: string[] = [];
    for (const line of lines) {
        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            kept.push(line);
            continue;
        }
        if (entry.type === 'assistant' && entry.isApiErrorMessage === true && entry.uuid) {
            removed.set(entry.uuid, entry.parentUuid ?? null);
            continue;
        }
        const blocks = opts.thinking && entry.type === 'assistant' && Array.isArray(entry.message?.content) ? entry.message.content : null;
        if (blocks && blocks.some((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
            const rest = blocks.filter((b: any) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
            if (!rest.length) {
                removed.set(entry.uuid, entry.parentUuid ?? null);
                continue;
            }
            entry.message.content = rest;
        }
        kept.push(JSON.stringify(entry));
    }
    const resolve = (id: string | null): string | null => {
        while (id && removed.has(id)) {
            id = removed.get(id) ?? null;
        }
        return id;
    };
    return kept
        .map((line) => {
            if (!removed.size || !line.includes('parentUuid')) {
                return line;
            }
            try {
                const entry = JSON.parse(line);
                if (entry.parentUuid && removed.has(entry.parentUuid)) {
                    entry.parentUuid = resolve(entry.parentUuid);
                    return JSON.stringify(entry);
                }
            } catch {
                // keep as is
            }
            return line;
        })
        .join('\n');
}

/** Copies one chat into a target. Keeps the source file's timestamp so syncing does not ping-pong. */
export function copyChat(chat: Chat, dest: Target): void {
    const destDir = path.join(dest.dir, 'projects', chat.projectFolder);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, path.basename(chat.file));
    let content = fs.readFileSync(chat.file, 'utf8');
    if (chat.source.dir.toLowerCase() !== dest.dir.toLowerCase()) {
        content = cleanChat(content, { thinking: dest.kind === 'claude' });
    }
    let previous = '';
    try {
        previous = fs.readFileSync(destFile, 'utf8');
    } catch {
        // new file for this account
    }
    noteImported(dest.dir, content, previous);
    fs.writeFileSync(destFile, content);
    fs.utimesSync(destFile, chat.modified, chat.modified);
}

/**
 * Copies a chat to another account or model under a NEW session id and returns that id.
 * Claude Code reuses an open tab when asked to open a session id it already shows, so continuing under the
 * same id would just refocus the old tab, still running on the old account. A fresh id always opens a new
 * tab on the destination; the original chat stays as it was.
 */
export function forkChat(chat: Chat, dest: Target): string {
    const destDir = path.join(dest.dir, 'projects', chat.projectFolder);
    fs.mkdirSync(destDir, { recursive: true });
    const oldId = path.basename(chat.file, '.jsonl');
    const newId = randomUUID();
    let content = cleanChat(fs.readFileSync(chat.file, 'utf8'), { thinking: dest.kind === 'claude' });
    content = content.split(`"sessionId":"${oldId}"`).join(`"sessionId":"${newId}"`);
    noteImported(dest.dir, content, '');
    fs.writeFileSync(path.join(destDir, `${newId}.jsonl`), content);
    return newId;
}

/** Session id Claude Code uses to reopen a chat: the chat file's name. */
export function sessionId(chat: Chat): string {
    return path.basename(chat.file, '.jsonl');
}

/** Wraps one chat file (e.g. the one that just hit a limit) as a Chat. */
export function chatFromFile(file: string, source: Target): Chat | undefined {
    try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, 'utf8');
        return {
            file,
            source,
            projectFolder: path.basename(path.dirname(file)),
            modified: stat.mtime,
            preview: firstUserMessage(content),
            hasImages: content.includes('"type":"image"'),
        };
    } catch {
        return undefined;
    }
}

/** Makes every chat of the open folder available in the target: copies ones it lacks or has an older copy of. */
export function syncChatsInto(dest: Target): number {
    let copied = 0;
    const newest = new Map<string, Chat>();
    for (const chat of findChats()) {
        const id = path.basename(chat.file);
        const seen = newest.get(id);
        if (!seen || chat.modified > seen.modified) {
            newest.set(id, chat);
        }
    }
    for (const [id, chat] of newest) {
        if (chat.source.dir.toLowerCase() === dest.dir.toLowerCase()) {
            continue;
        }
        const existing = path.join(dest.dir, 'projects', chat.projectFolder, id);
        if (fs.existsSync(existing) && fs.statSync(existing).mtime >= chat.modified) {
            continue;
        }
        copyChat(chat, dest);
        copied++;
    }
    return copied;
}

/** True when a chat file belongs to the folder open in this window. */
export function belongsToOpenProject(file: string): boolean {
    const folder = workspaceFolder();
    return !!folder && path.basename(path.dirname(file)).toLowerCase() === projectKey(folder);
}

export async function pickChat(title: string): Promise<Chat | undefined> {
    if (!workspaceFolder()) {
        vscode.window.showWarningMessage('Open the project folder first.');
        return undefined;
    }
    const chats = findChats();
    if (!chats.length) {
        vscode.window.showWarningMessage('No chats found for this folder yet.');
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        chats.slice(0, 40).map((c) => ({
            label: c.preview,
            description: `${c.source.kind === 'other' ? 'Other AI' : c.source.label} · ${c.modified.toLocaleString()}`,
            detail: c.hasImages ? '$(file-media) Has screenshots' : undefined,
            chat: c,
        })),
        { title, matchOnDescription: true },
    );
    return picked?.chat;
}

/**
 * Size of the chat as the model last saw it: the newest reply's prompt tokens (input + cache) plus its
 * output. Exact for Claude chats, since the API reports it; 0 when unknown.
 */
export function chatTokens(file: string): number {
    let lines: string[];
    try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
        return 0;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) {
            continue;
        }
        try {
            const e = JSON.parse(lines[i]);
            const u = e.message?.usage;
            if (e.type === 'assistant' && u && e.message?.model !== '<synthetic>') {
                return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
            }
        } catch {
            // partial line
        }
    }
    return 0;
}

function textOf(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('\n');
    }
    return '';
}

/**
 * A compact hand-over for a model that cannot hold the whole chat: the goal, files touched and the
 * latest turns. Built locally from the chat file; no model is called.
 */
export function summarizeChat(file: string, maxChars = 16000): string {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let goal = '';
    const files = new Set<string>();
    const turns: string[] = [];
    for (const line of lines) {
        let e: any;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        if (e.isMeta || e.isApiErrorMessage || e.isSidechain) {
            continue;
        }
        const content = e.message?.content;
        if (Array.isArray(content)) {
            for (const c of content) {
                const p = c?.type === 'tool_use' ? c.input?.file_path || c.input?.notebook_path : undefined;
                if (typeof p === 'string' && c.name !== 'Read') {
                    files.add(p);
                }
            }
        }
        const text = textOf(content).trim();
        if (!text || text.startsWith('<')) {
            continue;
        }
        if (e.type === 'user') {
            goal ||= text;
            turns.push(`User: ${text.slice(0, 1200)}`);
        } else if (e.type === 'assistant') {
            turns.push(`Assistant: ${text.slice(0, 1200)}`);
        }
    }
    const head = [
        'I am continuing a task from another chat that is too long for this model. Here is the hand-over.',
        '',
        `Goal (first request): ${goal.slice(0, 1500) || '(unknown)'}`,
        '',
        files.size ? `Files changed so far:\n${[...files].slice(-30).map((f) => `- ${f}`).join('\n')}` : 'Files changed so far: none recorded',
        '',
        'Latest conversation:',
    ].join('\n');
    const tail = '\n\nPlease read the files you need, then carry on from where this stopped. Ask me if something is unclear.';
    const budget = maxChars - head.length - tail.length;
    const recent: string[] = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0 && used + turns[i].length + 2 <= budget; i--) {
        recent.unshift(turns[i]);
        used += turns[i].length + 2;
    }
    return `${head}\n${recent.join('\n\n')}${tail}`;
}
