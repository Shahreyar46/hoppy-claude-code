# Hoppy 1.2.3 (Usage Tracker, Multi-Account Switcher & Voice to Text for Claude Code): how to install

Use all your Claude accounts and other AI models (free or paid) in the Claude Code panel of VS Code. See your Claude usage at a glance, and talk to Claude with your voice.

## You need

- Windows 10 or 11
- VS Code with the **Claude Code** extension, logged in
- [Node.js](https://nodejs.org) 22.5 or newer (only for other AI models)

## Install (1 minute)

1. Unzip this folder.
2. Open VS Code.
3. Go to **Extensions** (Ctrl+Shift+X).
4. Click the **`...`** menu at the top of the Extensions panel → **Install from VSIX…**
5. Pick **`hoppy-claude-code-win32-x64-1.2.3.vsix`** from this folder (on an ARM Windows PC, pick `hoppy-claude-code-win32-arm64-1.2.3.vsix`).
6. The **Get started with Hoppy** guide opens. Follow its 8 short steps.

Updating from 1.1? Install the same way. Your accounts, keys and settings stay.

## New in 1.2

- **Claude usage in the status bar**: `5h 2% · wk 60%` shows how much of your 5-hour and weekly Claude limit is used (the same numbers as `/usage`). Yellow from 80%, red from 95%. Hover for every account.
- **Voice to text**: click **Voice** at the bottom right (or Ctrl+Alt+Shift+V), speak, click again. The text lands in the Claude chat box, not sent. English, Hindi and 18 more languages need no setup. Bangla and translation use your Gemini or Groq key.
- **Translate while you speak**: hover **Voice** → **Write in** → for example English.
- **Remove an account**: Settings → Accounts → **Edit** → **Remove account…** (asks first; the folder goes to the Recycle Bin).
- **26 AI providers** and your own custom endpoint.
- Full list: Hoppy menu → **More** → **What's new**, or **CHANGELOG.md** in this folder.

## After installing

- **Switch accounts or models** from any of these:
  - **Status bar, bottom right**: click **✦ Claude · Main**. A list opens at the top of VS Code → pick an account or **Other AI** (fastest)
  - **Settings**: status bar → **Settings** → **Accounts** → **Switch**
  - **Ctrl+Shift+P** → **Hoppy: Switch**
- Don't see **✦ Claude**, the usage numbers or **Voice** in the status bar? Right-click the status bar and tick them.
- Lost the guide? Click the status bar → **More** → **Getting started guide**.
- All details are in **README.md** in this folder.

## Videos

The two videos in this folder show switching accounts and models (recorded with 1.1). Usage and Voice are new in 1.2 and covered in the guide inside VS Code.

## Good to know

- Your Claude login is never sent anywhere else, and Claude is never billed extra.
- API keys stay on your own PC.
- Voice recordings go only to the engine you use, and only when you stop recording.
- Not affiliated with or endorsed by Anthropic.
