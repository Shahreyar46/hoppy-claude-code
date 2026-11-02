# Claude Usage Tracker, Multi-Account Switcher & Voice to Text - Hoppy

**Hoppy is a free VS Code extension for Claude Code that shows your Claude usage limits live in the status bar, keeps multiple Claude accounts logged in and switches between them in one click without losing your chat, continues the same chat on another account or on free AI models when you hit a limit, and adds voice to text in any language with automatic translation.**

> **Windows only** for now (Windows 10/11). Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic; Hoppy is an independent extension that works with them.

## Features

### Claude usage tracker: 5-hour and weekly limits, always visible
See exactly how much of your Claude Code limit is used, right in the status bar: `5h 2% · wk 60%`. The same numbers as `/usage`, for every account, with reset times and tokens. Yellow at 80%, red at 95%, so a limit never surprises you.

### Multiple Claude accounts, all logged in, one click to switch
Add your Work and Personal Claude accounts once. Each stays logged in. One click in the status bar switches the Claude Code panel between them. No logging out, no terminal.

### Switch without losing context
Your chat history comes with you. After switching, `/resume` shows this project's chats from every account, so you continue the **same chat** exactly where you stopped.

### Hit the Claude limit? Keep working
When an account hits its 5-hour or weekly limit, Hoppy offers to continue the same chat on your other Claude account, or on **free AI models** (Gemini, DeepSeek, OpenRouter free models and more), in one click. When the limit resets, Hoppy tells you.

### Voice to text in any language, with translation
Click **Voice**, speak, click again: the text lands in the Claude chat box. Speak in your own language (English, Bangla, Hindi, Spanish and many more) and Hoppy can write it in another language automatically, for example speak Bangla and get English.

### 26 AI providers and free models
OpenRouter, Gemini, DeepSeek, GLM, Groq, Cerebras, Mistral, NVIDIA, Hugging Face, Ollama, LM Studio, OpenAI, xAI and more, or your own OpenAI-compatible endpoint. Models are ranked by coding strength, with automatic fallback when one is busy.

Also: guided API key setup with live checks, a `/second-opinion` skill to ask other models from inside a Claude chat, and one account per project.

Your Claude login is never routed through anything. Claude models always come from your own plan.

## What's new in 1.2

| Feature | What you get |
|---|---|
| **Usage in the status bar** | `5h 2% · wk 60%` next to your account, exact numbers from Anthropic (read-only). Turns yellow at 80% and red at 95%. Hover for every account: bars, reset times, tokens, emails and your Other AI models |
| **Hoppy Usage view** | Explorer side panel with the same cards, a **Switch** link per account and the top models you used this week |
| **Voice to text** | **Voice** button in the status bar (`Ctrl+Alt+Shift+V`). English, Hindi and 18 more languages need no key (Claude Code's own dictation). Bangla and translation use Gemini or Groq with your key |
| **Translate while you speak** | Speak Bangla, get English (or any of 15 languages). Hover **Voice** → **Write in** |
| **Remove an account** | Settings → Accounts → **Edit** → **Remove account…**. Asks first, shows size and chats, moves the folder to the Recycle Bin |
| **26 providers** | Groq, Cerebras, Mistral, NVIDIA, Hugging Face, Ollama, LM Studio, DeepSeek, OpenAI, xAI, Together, Fireworks, Kimi, Qwen and more, plus a **Custom** endpoint |
| **Model catalog** | Models ranked by coding strength and speed, with free limits and "no tools" badges |

## Videos

| Overview (2 min) | Full tutorial (4 min) |
|---|---|
| [![Hoppy overview](https://i.ytimg.com/vi/zhqcQeih3do/hqdefault.jpg)](https://youtu.be/zhqcQeih3do) | [![Hoppy full tutorial](https://i.ytimg.com/vi/Sl9I1QzJ-zs/hqdefault.jpg)](https://youtu.be/Sl9I1QzJ-zs) |
| Switch accounts and models, keep going when a limit hits | Every feature step by step, on real screens |

Inside VS Code: Hoppy menu → **More** → **Video guides**.

## FAQ

**How do I see my Claude Code usage limit in VS Code?**
Install Hoppy. The status bar shows `5h x% · wk y%`: how much of your 5-hour and weekly Claude limit is used, the same numbers as Claude Code's `/usage`. Hover it for every account and reset times.

**Can I use multiple Claude accounts in VS Code?**
Yes. Hoppy keeps each Claude account logged in in its own folder and switches the Claude Code panel between them in one click. Use only accounts you own (for example Work and Personal).

**Do I lose my chat when I switch Claude accounts?**
No. Hoppy copies the project's chats so `/resume` shows them on every account, and you continue the same conversation with its context.

**What can I do when Claude Code hits the usage limit?**
Hoppy notices the limit and offers to continue the same chat on another Claude account or on free AI models such as Gemini, DeepSeek or OpenRouter free models. It tells you when your limit resets.

**Can I use Claude Code with free AI models?**
Yes. Connect a free key (OpenRouter, Gemini, Groq and others) and switch the Claude Code panel to **Other AI**. Hoppy runs a local gateway so Claude Code works with those models.

**Can I talk to Claude Code with my voice in Bangla or another language?**
Yes. Click **Voice** in the status bar and speak. English, Hindi and 18 more languages work with no setup; Bangla and other languages use your Gemini or Groq key. Choose **Write in** to translate automatically, for example Bangla to English.

**Is Hoppy free? Is it official?**
Hoppy is free. It is an independent extension, not made by Anthropic. Your Claude login is never sent anywhere else, and API keys stay on your PC.

## Requirements

- Windows 10/11
- VS Code with the **Claude Code** extension, signed in with your Claude plan
- [Node.js](https://nodejs.org/) **22.5 or newer** (`node -v`)
- At least one API key. The easiest is a free [OpenRouter](https://openrouter.ai/settings/keys) key.

## Install

1. VS Code: open **Extensions** (Ctrl+Shift+X) and search **Hoppy** (or **Claude Usage Tracker**).
2. Click **Install** (and **Trust Publisher & Install** if VS Code asks).
3. The getting started guide opens, and **Claude · <account>** appears in the status bar.

Offline: **Extensions** → `...` menu → **Install from VSIX…** → pick `hoppy-claude-code-win32-x64-<version>.vsix`.

## How to switch accounts or models

Three ways, all do the same:

| Where | How |
|---|---|
| **Status bar** (fastest) | Click **✦ Claude · …** at the bottom right. A list opens at the top of VS Code → pick an account or **Other AI** |
| **Settings page** | Status bar → **Settings** → **Accounts** tab → **Switch** |
| **Command palette** | **Ctrl+Shift+P** → type **Hoppy: Switch** → pick one |

A new Claude tab opens on your choice right away. Tabs that were already open keep their account until you close them.

Don't see **✦ Claude** in the status bar? Right-click the status bar and tick **Hoppy**.

## Settings page

Status bar → **Settings** opens a page with four tabs:

| Tab | What you do there |
|---|---|
| **Accounts** | Every Claude account with its email and tokens used (last 5 hours, today, this week). Switch, add, or **Edit** to rename and pick a status bar color |
| **AI Providers** | Connected services on top; **Connect** another below (26 services: OpenRouter, Gemini, DeepSeek, GLM, Groq, Cerebras, Mistral, NVIDIA NIM and more, or your own **Custom** endpoint). Paste a key and Hoppy checks it before saving |
| **Models** | Tick which models are available, search, show free or all, see price, size and which models read images. Pick the main and helper model |
| **Backups** | Models tried automatically when the main one is busy or out of free requests. **Check models** sends one tiny request to each and shows which work right now; **Put working first** reorders them |

Keys are checked live before saving and stored in Windows Credential Manager (VS Code secret storage) plus the local ccr config. The page only ever shows the last 4 characters. Turning a provider off keeps its key, so turning it back on needs no re-entry.

## When you hit a limit

When a Claude account reaches its session or weekly limit, Hoppy notices within a second and asks where to keep going:

- **Continue on <another account>**: the chat is copied there and opens in a new tab. Send a message and carry on.
- **Continue on Other AI**: same, on your other AI models. If the chat is bigger than the model can hold, Hoppy offers a short hand-over instead (goal, files changed, latest messages).
- The account shows `⌚ resets 12:50am` in the menu and the status bar turns orange until the limit resets.

Hoppy reads only Claude Code's local chat files for this; nothing is sent anywhere. Turn it off with `hoppy.suggestOnLimit`.

When the limit resets, Hoppy tells you and offers to switch back.

Tired of the question? After your first hop Hoppy offers **Always continue on another account** (or Other AI). Change it any time with `hoppy.onLimit`; the notice after an automatic hop has **Switch back** and **Ask me next time**.

**Ctrl+Alt+H** flips back to the account or model you used before.

## One account per project

Hoppy menu → **Always use Claude · Work in this project**. Whenever you open or come back to that project's window, Hoppy points the Claude panel at Work again. Switching inside the project moves the pin; **This project always uses …** in the menu removes it.

## Share your setup

Hoppy menu → **More** → **Export settings** writes your model choices, backups, limit behaviour and account names to a JSON file. **Never** API keys or logins. **Import settings** on another PC or a teammate's applies what fits there and lists services that still need their own key.

## Usage

- **Status bar**: `5h 2% · wk 60%` shows how much of the current account's 5-hour and weekly Claude limit is used. These are the exact numbers Claude Code's `/usage` shows: Hoppy reads them from Anthropic with the account's existing login (read-only; it never refreshes, changes or stores the login). Turn this off with `hoppy.claudeQuota` to use local estimates instead.
- **Colors**: yellow box from 80% used, red from 95% (`hoppy.usageBackground`), font color with `hoppy.usageColor`.
- **Hover** the usage item for every account: 5-hour and weekly bars, reset times, tokens used, emails, and your Other AI models with their tokens.
- **Hoppy Usage view** (Explorer side bar): the same cards, plus **Switch** links and the top models used this week.
- Tokens are counted from local chat files (copied chats are not counted twice). Anthropic publishes % only, so token totals marked `~` are estimates.

## Voice to text

Click **Voice** in the status bar (or `Ctrl+Alt+Shift+V`), speak, click again. The text goes into the Claude chat box, not sent, so you can check it and press Enter.

- **No setup** for English, Hindi, Spanish and 17 more languages: Hoppy uses Claude Code's own dictation on your Claude login.
- **Bangla and other languages**: Gemini (most accurate in our tests, it uses the meaning of the sentence) or Groq Whisper, with the key you already saved in Hoppy. Bangladesh place names are recognized.
- **Translate**: hover **Voice** → **Write in** → for example **English**: speak Bangla, get English.
- **Settings** (`hoppy.voice.*`): engine, spoken language, output language, where the text goes (Claude box, cursor or clipboard), your own word list.
- Audio leaves your PC only when you stop a recording, and only to the engine shown. On Gemini's free tier Google may use what you send to improve its products; Hoppy asks once before using it. Windows only for Hoppy's own recorder; nothing to install.

## Claude accounts

Hoppy finds your Claude accounts by itself: `~/.claude` and every `~/.claude-account*` folder. Each folder is one login.

- **Add one**: status bar → **Add Claude account** → give it a name. A new Claude tab opens and asks you to log in to that account.
- **Rename**: status bar → **Rename an account** (e.g. "Work (Max)", "Personal").
- **Switch**: click the status bar → pick the account. A new Claude tab opens on it right away; tabs already open keep their account until closed (or choose **Reload all tabs**).
- **Remove**: Settings → Accounts → **Edit** → **Remove account…** (or Hoppy menu → **Remove an account**). Hoppy shows the folder, its size and chats, and asks first. The folder (login, chats, settings) goes to the Recycle Bin, so you can restore it. Main (`~/.claude`) can't be removed.

Use only accounts you own (for example one for work and one personal). Using several accounts to get around usage limits can break Anthropic's terms.

## First-time setup for other AI models (about 3 minutes)

1. Click **`✨ Claude · …`** in the status bar (bottom right) → **Set up API keys**.
2. If Claude Code Router isn't installed, click **Install now**. Hoppy installs it in the background (about a minute).
3. Tick the providers you have keys for. OpenRouter is pre-selected.
4. Paste each key. Click the 🌐 globe button in the box to open that provider's key page.
5. The extension checks every key, loads the model list, sets up the fallback chain, and starts the gateway.
6. Click **Switch to Other AI now**. A new Claude tab opens on the other AI models.

## Daily use

| You want | Do this |
|---|---|
| Work with Claude | Status bar shows `✨ Claude · <account>`. Nothing to do. |
| Use another Claude account | Click the status bar → pick the account → a new Claude tab opens; `/resume` shows all this project's chats |
| Work with other AI models | Click the status bar → **Other AI** → a new Claude tab opens on it |
| Limit ran out mid-task | Status bar → **Continue a chat on…** → pick the chat → pick where → type `/resume` in the new tab |
| Pick a specific model | In the Claude panel type `/model openrouter/poolside/laguna-s-2.1:free` |
| Ask another model from a Claude chat | Install the skill once (menu), then say "ask nemotron to review this" |
| Add paid models or new free ones | **Settings → Models**: untick *Free only*, tick what you want, **Save**. Or menu → **More** → **Refresh model list** |

### Good free models

| Use | Model |
|---|---|
| Best overall (default) | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` |
| Chats with screenshots | `openrouter/nvidia/nemotron-3.5-super-vl:free` |
| Coding | `openrouter/poolside/laguna-s-2.1:free`, `openrouter/cohere/north-mini-code:free` |
| Huge files | `openrouter/thinkingmachines/inkling:free` |

## Limits and costs

- **OpenRouter free models**: about 50 requests per day for the whole account (all free models share it), resetting daily at 00:00 UTC. Buying $10 of credit once raises it to about 1,000 per day.
- **Gemini free tier** has its own daily quota, so it is the last step of the fallback chain.
- **DeepSeek, GLM, MiMo** are paid. Add credit on the provider (or on OpenRouter) first; until then they return "insufficient balance" and cost nothing.
- In Other AI mode, **Auto permission mode** spends extra requests on safety checks. Use "Ask before edits" there to make the free quota last longer.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `hoppy.autoStartGateway` | `true` | Start the gateway when VS Code opens |
| `hoppy.syncChatsOnSwitch` | `true` | Copy this project's chats from other accounts on every switch |
| `hoppy.accountLabels` | `{}` | Friendly account names (set through **Rename an account**) |
| `hoppy.mainModel` | Nemotron Ultra (free) | Default model in Other AI mode |
| `hoppy.smallModel` | Nemotron Lightning (free) | Helper model for background jobs (titles, summaries) |
| `hoppy.fallbackModels` | VL → Laguna → Gemma → Inkling → Gemini | Order tried when a model fails |
| `hoppy.routerConfigDir` | `~/.claude-router` | Claude Code folder used in Other AI mode |
| `hoppy.claudeConfigDirs` | `[]` | Extra Claude folders to search for chats to hand off |
| `hoppy.suggestOnLimit` | `true` | Offer to continue elsewhere when a Claude account hits its limit |
| `hoppy.showUsage` | `true` | Show tokens used per account in the menu and settings |
| `hoppy.accountColors` | `{}` | Status bar color per account (set in Settings → Accounts → Edit) |
| `hoppy.onLimit` | `ask` | On a limit: `ask`, `nextAccount` or `otherAi` |
| `hoppy.projectAccounts` | `{}` | Projects pinned to an account (set from the Hoppy menu) |
| `hoppy.claudeQuota` | `true` | Exact 5-hour and weekly % from Anthropic (read-only) |
| `hoppy.usageBackground` | `auto` | Usage item box: `auto` (yellow 80%, red 95%), `yellow`, `red` |
| `hoppy.usageColor` | `auto` | Usage item font color, or any hex color |
| `hoppy.voice.engine` | `auto` | `auto`, `claude`, `gemini`, `groq`, `openai` |
| `hoppy.voice.spokenLanguage` | `auto` | The language you speak, or detect it |
| `hoppy.voice.outputLanguage` | `same` | Write as spoken, or translate into a language |
| `hoppy.voice.insertInto` | `claude` | Claude chat box, wherever your cursor is, or clipboard |
| `hoppy.voice.words` | `[]` | Your own words Voice should always spell right |

After changing models or the backups list in settings.json, run **Refresh model list** to apply them.

## Troubleshooting

| Problem | Fix |
|---|---|
| Status bar shows `⚠ Other AI (stopped)` | Menu → **More** → **Restart Other AI** |
| "There's an issue with the selected model" | Usually a chat with screenshots on a text-only model. The fallback handles it; if not, `/model openrouter/nvidia/nemotron-3.5-super-vl:free` |
| `401` / "token expired or incorrect" | Wrong or cut-off key. Run setup again and use the provider's copy button |
| `402` / `429` "insufficient balance" | Paid provider without credit. Use a free model or add credit |
| `429` on free models | Daily free limit reached. Wait for the reset, or Gemini takes over automatically |
| Normal Claude Code stopped working after installing ccr by hand | Run **Set up API keys** once; it restores your original `~/.claude/settings.json` and Codex config |
| Model dropdown doesn't list every model | Expected. Type `/model <name>` in the Claude panel |

## How it works

- [Claude Code Router](https://github.com/musistudio/claude-code-router) (ccr) runs a local gateway on `127.0.0.1:3456` that speaks Claude's API format and forwards requests to the services you connected (OpenRouter, Gemini, DeepSeek, GLM, Groq, Cerebras, Mistral or NVIDIA NIM).
- Switching sets `CLAUDE_CONFIG_DIR` for the Claude Code extension: an account folder (`~/.claude`, `~/.claude-account2`, …) or the Other AI folder (`~/.claude-router`) that points at the gateway. Logins stay in their own folders and are never copied or forwarded.
- Chats are JSONL files under `<folder>/projects/<project>/`. Syncing and handoff copy them between folders. When a chat moves to a different Claude account, Claude's internal "thinking" entries are removed (they are tied to the account that made them) and the chat is re-linked around them; every message, tool call and result is kept. The original file is never changed.
- ccr stores its config in SQLite. The extension edits it with a small Node script while ccr is stopped. API keys are passed through stdin and never printed.
- The extension never adds an Anthropic provider and removes one if found, so Claude is never billed per token through the router.

## Privacy

Code you send in Other AI mode goes to the provider you picked (OpenRouter and the model host, Google, DeepSeek, Z.ai, Groq, Cerebras, Mistral or NVIDIA). **Check models** sends one short test message to each model you check, with your key. Limit detection and token counts are read from local files only. The exact usage % is read from Anthropic's usage endpoint with the account's own login (turn off with `hoppy.claudeQuota`). Voice recordings go only to the engine you use (Claude Code dictation, Gemini, Groq or OpenAI) and only when you stop recording. Check their data policies before using them on client or company code. Never send secrets.

## Build from source

```powershell
npm install
npm run compile
npx vsce package --target win32-x64   # creates hoppy-claude-code-win32-x64-<version>.vsix
```
