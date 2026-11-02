# Hoppy 1.2 plan: "Every free model, smartly"

Written 2026-11-02 after reading FreeLLMAPI (v0.16.16) and OmniRoute (v3.8.53).
Research clones (read only, never run): `C:\Users\Shimul\Desktop\Dev\research\{freellmapi,OmniRoute}`.

## 1. Decision

**Hoppy stays a VS Code extension. We do not build a desktop app or bundle either project.**

- Both projects are gateway servers with a dashboard (same job as claude-code-router, "ccr", which Hoppy already drives). Their desktop apps are Electron wrappers around that server.
- Neither can switch Claude subscription accounts, see the Claude Code panel, detect a limit or continue the same chat. That is Hoppy's moat, and only an extension can do it.
- We copy their best **ideas** into Hoppy, keep ccr as the built-in engine, and add an optional "external engine" so power users can plug in FreeLLMAPI, OmniRoute or any Anthropic-compatible URL.

## 2. Comparison

| | Hoppy 1.1 | FreeLLMAPI | OmniRoute |
|---|---|---|---|
| Form | VS Code extension, ccr engine | Express + SQLite server, React dashboard, Electron tray app | Next.js 16 server, 219 DB migrations, Electron app, PWA |
| Claude account switching, limit hop, chat continue | Yes | No | No |
| Providers | 8 | 43 built-in (several no longer free) | "380" (counts scrapers, playgrounds) |
| Routing | Main model + fallback chain + health check | Bandit scoring, profiles `auto`, `auto:smart`, `auto:fast`, cooldown ladder | 20 combo strategies, `auto/*` ladders, circuit breaker |
| Free quota awareness | Health check only | Per key RPM/RPD/TPM/TPD counters, reset times | Quota preflight, billing classes |
| Claude Code quality fixes | Thinking stripped on copy | Tool-call rescue, image downscale, count_tokens, sticky session + handoff note | count_tokens, thinking-signature fixes, `/model` discovery aliases |
| Compression | Hand-over summary for long chats | Off by default; lossless/standard/aggressive, fails open | RTK + Caveman stack |
| Risky parts | None | Pools many free accounts (its own ToS doc warns), catalog paywall, catalog sync to its server | Claude/ChatGPT/Copilot subscription proxy with CLI fingerprint spoofing, web-cookie scraping, MITM root CA, affiliate links |
| Install | Marketplace, one click | Docker or desktop exe, then connect Claude Code | npm/Docker/Electron, heavy native build |

Overstated claims to ignore: FreeLLMAPI "7.4B free tokens/month" is a hard-coded README string; OmniRoute "1.62B tokens", "380 providers", "89% compression" are sums or modelled figures.

## 3. Hard rules (unchanged, apply to every item below)

1. Never route a Claude subscription login through any gateway. Other AI lives only in its own `CLAUDE_CONFIG_DIR` (`~/.claude-router`).
2. Never pay for Claude twice: no Anthropic API key in ccr.
3. No OAuth or subscription proxying of other services (ChatGPT/Codex, Copilot, Gemini CLI, Kiro, Antigravity, Cursor…), no web-cookie scraping, no fingerprint spoofing, no MITM certificates.
4. One key per provider by default. No pooling of many free accounts.
5. No remote catalog, telemetry or affiliate links. Every network call is listed in the README.
6. Never call `applyToCcr` against the real router in tests.

## 4. Scope, in sprints (build in this order: 1, 2, 3, 3a, 4, 5, 6; 3a needs the counts from 3)

### Sprint 1: More providers + built-in free model catalog
Goal: "use all the models they offer", minus the risky ones.

- Add providers to `src/setup.ts` `PROVIDERS` and `scripts/ccr-config.mjs` templates (all OpenAI-compatible, so ccr needs no custom transformer unless noted):
  - Free: Cloudflare Workers AI (account id + token), Hugging Face router, SiliconFlow, Z.ai GLM Flash (free model inside existing GLM), Ollama (local `http://127.0.0.1:11434` and Ollama Cloud), LM Studio / any local OpenAI-compatible URL.
  - Paid (opt-in): OpenAI, xAI, Together, Fireworks, Moonshot/Kimi, Qwen (DashScope).
  - **Custom provider**: name + base URL + key + model list. Covers everything else.
- Verify each provider's ccr transformer before adding it. `ccr` must accept the `api_base_url`/models shape; test with Hoppy's health check (`src/health.ts`) using a real key where the user has one.
- **Catalog source**: FreeLLMAPI is MIT licensed. Seed Hoppy's catalog from its provider definitions (`shared/types.ts` Platform list, `docs/en/providers/01-supported-platforms.md`) and its model/limit seed (`server/src/db/migrations/20260101_000000_legacy_baseline.ts`, RPM/RPD/TPM/TPD columns), then verify each against the provider's own docs (their seed dates from April 2026). Add `THIRD_PARTY_NOTICES.md` with FreeLLMAPI's MIT copyright line. Copy data only, not code that phones home (their catalog sync to freellmapi.co).
- Target for 1.2: their ~28 working chat providers / 80+ free chat models, minus the ones excluded below.
- Provider matrix from the user's FreeLLMAPI screenshot (Models page, ~100 chat models). Models come from each provider's live `/models` list, so adding the provider brings all its models:
  - Already in Hoppy: Groq (GPT-OSS 120B/20B, Compound, Qwen3.6, Llama 4), NVIDIA (DeepSeek V4, Nemotron 3, Llama, MiniMax), Gemini (3.5/3.1/2.5 Flash, Gemma 4), Cerebras (GLM-4.7, GPT-OSS 120B), OpenRouter `:free` (Nemotron, Gemma, Qwen3-Coder, GLM-4.5 Air), GLM (GLM-4.5/4.7 Flash).
  - Add (standard, safe): Cloudflare Workers AI "CF" (Kimi K2.6/K2.7 Code, Llama 4 Scout, Qwen3 30B, GLM-4.7 Flash, Granite, DeepSeek R1 Distill), Ollama Cloud (GPT-OSS 120B, Gemma 4 31B), GitHub Models (GPT-4.1 with a GitHub token), OVH AI Endpoints (Qwen3.5 397B, Llama 3.3 70B, Qwen3-Coder 30B, GPT-OSS), Hugging Face, SiliconFlow.
  - Add with a warning (user opts in): Cohere "Command" models (trial keys are for non-production use), Reka.
  - **Community gateways** (Kilo, OpenCode Zen, Routeway, AI Horde, LLM7, Pollinations): free, but some log or train on prompts and some proxy other services' models. Ask the user (open question 4). If yes: a separate "Community" group, off by default, with "prompts may be logged" on each card, never in the Smart profile. Not in scope: embeddings, image, speech (Claude Code does not use them).
- New `media/catalog.json` shipped in the extension (no remote fetch): per model `provider, id, label, free, context, tools, vision, rpm, rpd, tier (pro|mid|fast)`. Seed from the provider docs, mark the date. Settings shows badges: Free, Tools, Vision, context size, daily limit.
- Skip: Cohere ("avoid" in FreeLLMAPI's own ToS review), obscure gateways that log prompts (Kilo, llm7, airforce, navy…), anything that needs a card for "free" (Cerebras free tier note is fine as is).

### Sprint 2: Routing profiles + "Free only" guard
- In Models tab, a profile picker for Other AI: **Auto** (balanced), **Smart** (strongest free/pro models first), **Fast** (lowest latency first), **Custom** (today's manual chain).
- A profile builds the main model + fallback chain from `catalog.json` scores and the last Check models results (`health.ts` latency, status). Re-built when Check models runs.
- **Free only** switch (default on): paid models never enter the chain. Show "paid" badge and require switching it off to add one.
- Background model (`Router.background` in ccr) set to a fast free model automatically.

### Sprint 3a: Usage analytics, remaining-tokens widget, back-to-Claude
User asked for these on 2026-11-02. Data stays local (Claude JSONL logs already scanned by `src/usage.ts`, plus Other AI chats in `~/.claude-router/projects` and the counts from Sprint 3).

- **Usage tab in Settings** (analytics): tokens and replies per day for the last 7 / 30 days, split by account (Work, Personal, Other AI) and, for Other AI, by model. Simple bar chart (inline SVG, no chart library, no remote scripts), totals row, and "busiest hour". Reuse `scanUsage` buckets; add a per-day, per-model bucket.
- **Analytics like FreeLLMAPI's** (user shared their screenshots): range 24h / 7d / 30d / 90d; cards for requests, success rate, input tokens, output tokens, average latency, p95 latency, average time to first token, and **estimated savings** (tokens × list price of the Claude model it replaced, from a price table in `catalog.json`); charts "requests over time" (success vs failures) and "tokens over time".
  - Token counts come from local chat files. Latency, success/failure and TTFT need per-request logs: **spike first** whether ccr v3 writes them (`request-log-worker.js`), where, and in what format. If ccr has no usable log, show only what local files prove and leave latency cards out rather than estimate.
- **Models table like theirs** (in the Models tab): one row per model with provider, Tools/Vision badges, limits ("10 rpm · 100 rpd"), reliability (success rate), speed (latency) and intelligence (from `catalog.json` tier) bars, a score, and an on/off toggle. The routing profile (Sprint 2) orders by this score. Manual mode keeps drag to reorder.
- **Monthly free budget bar**: stacked bar of each enabled free model's monthly allowance (daily limit × 30, labelled "estimate"), with "remaining" from Sprint 3 counts. Never present it as a guaranteed number.
- **Remaining widget**:
  - A **Hoppy Usage** view in the Explorer sidebar (VS Code `WebviewView` or `TreeView`, user can collapse/move it) plus a richer status bar tooltip.
  - Per Claude account: used in the last 5 h and this week, and **estimated remaining**. Anthropic gives no official remaining number, so learn each account's cap: when the limit radar sees a session/weekly limit, store tokens used in that window as that account's cap; remaining = cap − used now, shown as "~40% left (estimate)". Before the first limit is seen, show "used" only, never a made-up number.
  - Reset times when known ("resets 6:00 AM").
  - Per free model (Other AI): "37 of 50 requests today, resets 6:00" from Sprint 3 counts and `catalog.json` limits.
- **Back to Claude**: extend `checkLimitsEnded` in `src/extension.ts`. When a Claude account's limit resets **while the panel is on Other AI**, show a warning-level notice "Claude · Work is back. Move this chat back to Claude?" with **Move chat to Work** (uses `continueChatOn` / `forkChat`, so the same chat continues on Claude) and **Switch only**. Also a soft reminder 10 minutes before a known reset. Respect a "Don't ask again" setting.

### Sprint 3: Quota awareness (predictive, not reactive)
- Count requests per model per day. Source: ccr request logs (find where ccr v3 writes them: `request-log-worker.js` in `dist/main`; read only). If logs are not usable, count from Other AI JSONL chats in `~/.claude-router/projects` (Hoppy already scans these in `usage.ts`).
- Show "OpenRouter free: 37 of 50 today, resets 6:00" in the Hoppy menu Other AI row and Settings Backups.
- Cooldown ladder for the chain: when Check models or a 429 says `quota`, mark the model cooling until its reset (UTC midnight or Retry-After), skip it in profile building, show the time.
- When all free models are spent: one clear message, "Free models are used up until 6:00. Switch to a Claude account?" with buttons.

### Sprint 4: Claude Code quality on free models
- `/model` picker: set `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` in `~/.claude-router/settings.json` to the profile's smart / main / fast models. Check whether ccr v3 serves `/v1/models` so `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` can list all models; add it only if it works.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set from the main model's context size in `catalog.json`, so Claude Code compacts before a small free model overflows.
- Spike (time-boxed, 2 hours): can a ccr custom transformer or route script (`route-script-worker.js`, `router-plugin.js` in ccr `dist/main`) do (a) tool-call rescue (tool calls written as text into real `tool_use`), (b) lossless tool-output trimming (ANSI, long logs to head/tail)? If yes, ship as an opt-in Hoppy transformer. If no, record why and drop it.

### Sprint 5: Optional external engine
- Settings > Other AI > **Engine**: Built-in (ccr, default) / FreeLLMAPI / OmniRoute / Custom URL.
- External engine: Hoppy writes only `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (stored in SecretStorage, written to `~/.claude-router/settings.json` like today) and `ANTHROPIC_MODEL` (e.g. `auto`, `auto:smart`). Defaults: FreeLLMAPI `http://127.0.0.1:3001` (desktop app `:31415`), OmniRoute `http://127.0.0.1:20128`.
- Hoppy does not install, start or configure external engines. It shows a health dot (port open + a tiny `/v1/messages` ping) and links to their docs.
- Warn in the UI: never connect a Claude subscription inside those apps, and never run `freellmapi setup-claude` without `--profile` (it writes into `~/.claude/settings.json`).
- Provider/Models/Backups tabs are hidden or read-only when an external engine is active (that engine owns them).

### Sprint 6: Release 1.2.0
- README, CHANGELOG, walkthrough step text, `== External services ==`-style list of every network call in README.
- Tests (see section 6), vsix x64 + arm64, short "What's new" note.

## 5. Not doing (and why)

| Idea | Why not |
|---|---|
| Desktop app | Duplicates the gateway; loses Hoppy's one-click VS Code advantage |
| Bundling OmniRoute or FreeLLMAPI | Heavy native builds, fast churn (OmniRoute plans a breaking 4.0), risky features inside |
| Subscription OAuth proxies, web-cookie providers | ToS violations; account bans for users |
| Multi-account key pooling | Against provider ToS; FreeLLMAPI's own review warns |
| Remote model catalog | External calls, freshness paywall pattern; we ship ours in each release |
| Semantic cache, MCP server, A2A, guardrails, evals | Out of scope for a switcher; big surface |
| Fusion (one prompt to several models, a judge merges) | Several times the requests per turn, burns free quotas; maybe later as an opt-in `/second-opinion` upgrade |
| Embeddings, image, speech routing, Playground | Claude Code does not use them |
| Dashboard in 60 languages | Later; English UI first, translation once strings settle |

## 6. Verification for every sprint

- Unit tests in `test/suite/extension.test.js` for: catalog parsing, profile building (given catalog + health results → chain), Free-only guard, quota counting and cooldown reset times, external-engine env writing (never touches a Claude account dir).
- Live checks with the user's real keys only through `health.ts` (direct provider calls), never through `applyToCcr` in tests.
- Manual: Other AI chat answers through each new provider; `/model` shows the profile models; external engine with a URL that is down shows a red dot and a clear message.
- Run tests from PowerShell with `ELECTRON_RUN_AS_NODE` removed (see handover). 4 tests fail today because the test copy of Claude Code is broken; fix that setup first or keep it noted.

## 7. Decisions (2026-11-02, user said "take your decision")

1. **Paid providers: yes** (OpenAI, xAI, Together, Fireworks, Kimi, Qwen). Usable only when "Free only" is off.
2. **Cohere + Reka: yes**, with a "trial key, not for production" note.
3. **Community gateways: yes**, as a "Community" group, off by default, "prompts may be logged" on each card, never in the Smart profile.
4. **One key per provider.** No second key for the same provider.
5. **External engine (Sprint 5): later**, not in 1.2. Build order for 1.2: Sprints 1, 2, 3, 3a, 4, 6.
6. Build in a new chat (Sonnet 5.5) from the handover.
