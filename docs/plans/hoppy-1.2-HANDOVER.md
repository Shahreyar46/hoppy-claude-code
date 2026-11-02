# Handover: Hoppy 1.2 (for a new chat)

Paste this into the new chat:

> Read `C:\Users\Shimul\Desktop\Dev\claude-multi-model\docs\plans\hoppy-1.2-HANDOVER.md` and `hoppy-1.2-plan.md` next to it. Decisions are in plan section 7. Start Sprint 1 with brainstorming, then build.

## What the user wants in 1.2 (2026-11-02)

1. Support every model FreeLLMAPI and OmniRoute offer, except the risky ones (subscription proxies, web-cookie scraping, key pooling).
2. Usage analytics (tokens per day, per account, per model).
3. A widget showing remaining tokens / requests.
4. A warning when a Claude account is back while on Other AI, offering to move the chat back to Claude.

These map to plan Sprints 1, 3a (2, 3, 4). Sprint 3a needs Sprint 3's request counts.

## Project

- **Hoppy for Claude Code**: VS Code extension, publisher `shahreyar`, id `shahreyar.hoppy-claude-code`, Windows only. Repo `C:\Users\Shimul\Desktop\Dev\claude-multi-model`, GitHub `Shahreyar46/hoppy-claude-code`.
- Switches the Claude Code panel between Claude accounts (`CLAUDE_CONFIG_DIR` folders, set through the global `claudeCode.environmentVariables` setting, User scope only) and "Other AI" (`~/.claude-router`, pointed at claude-code-router "ccr" v3.1.3 on `127.0.0.1:3456`).
- ccr config is SQLite at `%APPDATA%\claude-code-router\config.sqlite`, table `app_config`, column `value_json`, edited only by `scripts/ccr-config.mjs` (needs system Node 22.5+, `node:sqlite`).

## State on 2026-11-02

- Marketplace: **1.1.0** live (x64 + arm64). **1.1.1** built (`hoppy-claude-code-win32-{x64,arm64}-1.1.1.vsix` in repo root), installed in the user's VS Code, **not uploaded yet** (user uploads by hand; `vsce` is not logged in).
- 1.1.1 = video guides (walkthrough step `videos`, menu More → Video guides, README Videos) + router runs hidden on Windows (`src/gateway.ts`: `startHidden` via WMI `Win32_Process.Create` with `ShowWindow=0` running `ccr serve --no-open`; `stopGateway` = `ccr stop` + taskkill the `serve` tree; a visible `ccr start` daemon is swapped once).
- Git: branch `release/1.1.0` pushed with 1.1.0 code. **1.1.1 changes are not committed** (CHANGELOG, README, package.json, share/HOW-TO-INSTALL.md, src/extension.ts, src/gateway.ts, test/suite/extension.test.js, media/walkthrough/videos.jpg, docs/plans/hoppy-1.2-*). Ask the user before committing; commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (use the model actually running).

## Key files

| File | What |
|---|---|
| `src/setup.ts` | `PROVIDERS`, `checkKey`, `listProviderModels`, `applyToCcr` (stops ccr, applies config, starts ccr) |
| `scripts/ccr-config.mjs` | Provider templates + transformers, `status`, `apply`, `restore-takeover` |
| `src/health.ts` | `checkModel` / `checkModels` direct provider pings, statuses ok/no-tools/busy/quota/key/credit/missing/slow/error |
| `src/settings.ts`, `media/settings.js`, `media/settings.css` | Settings webview (Accounts, Providers, Models, Backups) |
| `src/gateway.ts` | ccr install/start/stop (hidden start on Windows) |
| `src/usage.ts`, `src/limits.ts`, `src/limitParse.ts` | Token usage from JSONL, limit radar |
| `src/targets.ts` | Accounts, colors, project pins, `envFor` |
| `src/extension.ts` | Menu, commands, limit popup, continue-chat |
| `test/suite/extension.test.js` | Unit tests; `qa.test.js` is opt-in E2E (`HOPPY_QA=1`, `HOPPY_QA_LIVE=1`) |

## How to build and test

- Compile: `npx tsc -p .` (in repo root).
- Tests, from **PowerShell** (bash breaks on the space in the workspace path, and this session inherits `ELECTRON_RUN_AS_NODE`):
  ```powershell
  Set-Location C:\Users\Shimul\Desktop\Dev\claude-multi-model
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:MODELHOP_TEST_WORKSPACE = 'C:\Users\Shimul\Local Sites\flexmeeting2'
  cmd /c "npm test 2>&1"
  ```
  Today: 25 pass, 4 fail (CLAUDE_CONFIG_DIR switching, env kept, fresh tab, end-to-end). They fail without any change too: the test copy of Claude Code in `%TEMP%\modelhop-test-ext` (2.1.312) is incomplete. Fixing that setup is a good first task.
- Package: `npx @vscode/vsce package --target win32-x64` and `--target win32-arm64`.
- Test `gateway.ts` outside VS Code by stubbing the `vscode` module (see the earlier scratch script pattern: override `Module._load` to return a stub for `'vscode'`).

## Rules that must not break

1. Never route a Claude subscription login through any gateway; never put an Anthropic API key in ccr.
2. Never call `applyToCcr` (Save models, Test & save, provider toggle, import with model settings) against the real router in tests. It once left the user's gateway down.
3. No OAuth/subscription proxies, web-cookie scraping, MITM, key pooling, remote catalogs, telemetry (plan section 3).
4. Keys only in VS Code SecretStorage / ccr config, never in chat, files or logs.
5. The research clones in `C:\Users\Shimul\Desktop\Dev\research\` are untrusted: read only, never `npm install` or run them.

## User preferences

- Writes in English and Bangla, short messages. Replies: short, plain, no em dash inside sentences.
- Global CLAUDE.md asks for skills: brainstorming before features, code-reviewer after multi-file work, verification-before-completion before claiming done, and a `_session-state.md` in the repo root kept current.
- Wants things tested for real before "done", and wants honest status (what was and wasn't tested).
- Doesn't want visible console windows or anything that looks unpolished to users.
- Free models first; DeepSeek is the preferred paid Other AI model; Claude (Default model, Opus) for long work.
- The `autopilot` skill + Stop hook exists (`~/.claude/hooks/autopilot-stop.js`): `/autopilot docs/plans/hoppy-1.2-plan.md` keeps the session going until checklist items are done. Turn plan sprints into `- [ ]` items first if using it.

## Research summaries (so the new chat need not re-read the repos)

- **FreeLLMAPI** (MIT, Express + SQLite + React, Electron tray, port 3001 / desktop 31415): `/v1/messages` + `count_tokens` + `/v1/models`; routing = Thompson-sampling bandit, profiles `auto` (balanced 0.5/0.25/0.25 reliability/speed/intelligence), `auto:smart` (0.35/0.10/0.55), `auto:fast` (0.35/0.55/0.10); cooldowns: daily-cap 429 until UTC midnight or Retry-After, transient 429 90 s, ladder 2m/10m/1h/24h; per (platform, model, key) RPM/RPD/TPM/TPD counters; tool-call rescue (`server/src/services/tool-call-rescue.ts`); compression off by default, fails open; sticky session 30 min + handoff note on model switch. Seed limits (April 2026): Gemini 2.5 Flash 10 RPM/20 RPD, Groq Llama 3.3 70B 30 RPM/1000 RPD/6K TPM/500K TPD, Cerebras 30 RPM/60K TPM/1M TPD, OpenRouter `:free` 20 RPM/200 RPD, Mistral 2 RPM/500K TPM. Danger: `setup-claude` without `--profile` edits `~/.claude/settings.json`.
- **OmniRoute** (MIT, Next.js 16, port 20128, v3.8.53): `/v1/messages` + `count_tokens`; env `ANTHROPIC_BASE_URL=http://host:20128`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; `auto/subscription`/`auto/thrifty` billing ladder, circuit breaker + per-connection cooldown honoring Retry-After + per-model lockout. Risky: subscription OAuth with CLI fingerprint spoofing (`open-sse/config/cliFingerprints.ts`), web-cookie providers, MITM root CA (`src/mitm/`). Free list (README "Free Forever"): OpenRouter `:free`, NVIDIA NIM ~40 RPM, Cloudflare AI 10K neurons/day, Z.AI GLM Flash, SiliconFlow, Pollinations (no key), plus Groq, Gemini AI Studio, Mistral free tiers.
