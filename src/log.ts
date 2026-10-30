import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** Hoppy's own log: View → Output → Hoppy. Helps users (and us) see why something did or did not happen. */
export function log(message: string): void {
    channel ||= vscode.window.createOutputChannel('Hoppy', { log: true });
    channel.info(message);
}
