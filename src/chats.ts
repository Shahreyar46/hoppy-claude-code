import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { listTargets, Target } from './targets';

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
            const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x.type === 'text')?.text : undefined;
            if (text && !text.startsWith('<')) {
                return text.replace(/\s+/g, ' ').slice(0, 90);
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
        const blocks = entry.type === 'assistant' && Array.isArray(entry.message?.content) ? entry.message.content : null;
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
    if (dest.kind === 'claude' && chat.source.dir.toLowerCase() !== dest.dir.toLowerCase()) {
        content = stripThinking(content);
    }
    fs.writeFileSync(destFile, content);
    fs.utimesSync(destFile, chat.modified, chat.modified);
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
