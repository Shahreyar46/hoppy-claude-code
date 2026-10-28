# Hoppy for Claude Code

> **Windows only** for now (Windows 10/11). Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic; Hoppy is an independent extension that works with them.

Use **all your Claude accounts** and **other AI models** (free OpenRouter models, Gemini, DeepSeek, GLM, MiMo…) in the Claude Code panel of VS Code, without paying for Claude twice and without touching a terminal.

- **One click** in the status bar switches the Claude panel between your Claude accounts (for example Work and Personal) and other AI models.
- **Shared chat history**: after switching, `/resume` shows this project's chats from every account, so you continue exactly where you stopped.
- **Hit a limit mid-task?** Pick the chat and continue it on another account or another model.
- **Guided setup** for API keys, with live checks.
- **Automatic fallback**: if a model is busy, out of quota, or can't read screenshots, the next one takes over.
- **`/second-opinion` skill**: ask other models from inside a normal Claude chat.

Your Claude login is never routed through anything. Claude models always come from your own plan.

## Requirements

- Windows 10/11
- VS Code with the **Claude Code** extension, signed in with your Claude plan
- [Node.js](https://nodejs.org/) **22.5 or newer** (`node -v`)
- At least one API key. The easiest is a free [OpenRouter](https://openrouter.ai/settings/keys) key.

## Install

1. Get `modelhop-<version>.vsix` from your team.
2. VS Code: **Extensions** panel → `...` menu → **Install from VSIX…** → pick the file.

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
| **Accounts** | See every Claude account with its email, switch, rename, add a new one |
| **AI Providers** | Turn OpenRouter, Gemini, DeepSeek and GLM on or off, paste a key and click **Test & save**, open the key page with **Get key ↗** |
| **Models** | Tick which models are available, search, show free or all, see price, size and which models read images. Pick the main and helper model |
| **Backups** | Models tried automatically when the main one is busy or out of free requests. Warns if none can read screenshots |

Keys are checked live before saving and stored in Windows Credential Manager (VS Code secret storage) plus the local ccr config. The page only ever shows the last 4 characters. Turning a provider off keeps its key, so turning it back on needs no re-entry.

## Claude accounts

Hoppy finds your Claude accounts by itself: `~/.claude` and every `~/.claude-account*` folder. Each folder is one login.

- **Add one**: status bar → **Add Claude account** → give it a name. A new Claude tab opens and asks you to log in to that account.
- **Rename**: status bar → **Rename an account** (e.g. "Work (Max)", "Personal").
- **Switch**: click the status bar → pick the account. A new Claude tab opens on it right away; tabs already open keep their account until closed (or choose **Reload all tabs**).

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

- [Claude Code Router](https://github.com/musistudio/claude-code-router) (ccr) runs a local gateway on `127.0.0.1:3456` that speaks Claude's API format and forwards requests to OpenRouter, Gemini, DeepSeek or GLM.
- Switching sets `CLAUDE_CONFIG_DIR` for the Claude Code extension: an account folder (`~/.claude`, `~/.claude-account2`, …) or the Other AI folder (`~/.claude-router`) that points at the gateway. Logins stay in their own folders and are never copied or forwarded.
- Chats are JSONL files under `<folder>/projects/<project>/`. Syncing and handoff copy them between folders. When a chat moves to a different Claude account, Claude's internal "thinking" entries are removed (they are tied to the account that made them) and the chat is re-linked around them; every message, tool call and result is kept. The original file is never changed.
- ccr stores its config in SQLite. The extension edits it with a small Node script while ccr is stopped. API keys are passed through stdin and never printed.
- The extension never adds an Anthropic provider and removes one if found, so Claude is never billed per token through the router.

## Privacy

Code you send in Other AI mode goes to the provider you picked (OpenRouter and the model host, Google, DeepSeek or Z.ai). Check their data policies before using them on client or company code. Never send secrets.

## Build from source

```powershell
npm install
npm run compile
npm run package   # creates modelhop-<version>.vsix
```
