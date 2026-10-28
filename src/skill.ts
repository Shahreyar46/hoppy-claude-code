import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeConfigDirs } from './paths';

/** Copies the bundled /second-opinion skill into every Claude config folder (Claude-plan side only). */
export function installSkill(context: vscode.ExtensionContext): string[] {
    const source = path.join(context.extensionPath, 'resources', 'skill', 'second-opinion');
    const installed: string[] = [];
    for (const dir of claudeConfigDirs()) {
        const dest = path.join(dir, 'skills', 'second-opinion');
        fs.mkdirSync(dest, { recursive: true });
        for (const file of fs.readdirSync(source)) {
            fs.copyFileSync(path.join(source, file), path.join(dest, file));
        }
        installed.push(dest);
    }
    return installed;
}
