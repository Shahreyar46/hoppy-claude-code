# Plan: Hoppy 1.1 "Never stuck"

**Generated**: 2026-10-30
**Estimated Complexity**: Medium (5 sprints, ~3–4 working days)
**Target release**: 1.1.0 (Marketplace + Open VSX, win32-x64 / win32-arm64)

## Overview

Hoppy 1.0 lets people switch by hand. 1.1 makes Hoppy notice the moment a person gets stuck and
offer the next move, without them thinking about it. Competitor research (claude-swap, Claude
Multi-Account Switcher, Kahuecosta Multi-Account, CC Switch, OmniRoute) shows the market wants
three things: limit detection with one-click switch, usage visibility per account, and resilient
fallback. Nobody combines those with chat carry-over and other AI models; that combination is
Hoppy's moat.

### Product thinking (senior product engineer)

- **Job to be done**: "When Claude stops me mid-task, get me working again in under 10 seconds,
  with my context intact."
- **North-star metric**: time from limit message to next useful reply (target < 10 s, 2 clicks).
- **Principles**
  1. User stays in control: Hoppy suggests, user clicks. No silent auto-rotation of Claude
     accounts (avoids looking like limit evasion, keeps trust).
  2. Local only: read Claude Code's own log files. No unofficial Anthropic endpoints
     (`/api/oauth/usage`), no token reading, no proxying the Claude login.
  3. Zero setup: every 1.1 feature works out of the box with existing accounts.
- **Non-goals for 1.1**: Mac/Linux, auto-rotation, cloud sync, paid tier, OmniRoute-style
  60-provider gateway, team features.

### Engineering thinking (senior AI/ML + LLM engineer)

- **Limit signal is deterministic, no ML needed.** Claude Code writes a synthetic assistant
  entry into the session JSONL:
  `model: "<synthetic>"`, `isApiErrorMessage: true`,
  text `You've hit your session limit · resets 12:50am (Asia/Dhaka)`.
  Parse with a tolerant regex (`/hit your (\w+) limit/i` + `/resets (.+?)(?: \((.+)\))?$/`),
  keep the raw text as fallback when reset time can't be parsed.
- **Usage = sum of `message.usage` on real assistant entries** (skip `<synthetic>`), grouped by
  config dir, rolling 5 h window + today + 7 days. Count input + cache_creation + output; show
  cache reads separately (they are cheap and inflate numbers). Incremental parse with a per-file
  byte offset cache so a 200 MB history never re-reads.
- **Context fit on handoff.** Moving a long Claude chat to a smaller model fails silently or
  degrades badly. Estimate chat tokens (last assistant `usage.input_tokens` + cache tokens is an
  exact count of the prompt Claude saw), compare with target model `context_length` from the
  OpenRouter catalog, warn and offer "Continue with summary" instead of full history.
- **Tool-calling quality.** Claude Code is tool-heavy. Keep the catalog filtered to
  `supported_parameters` containing `tools` (already done) and add a one-shot "tool call smoke
  test" to model health checks, so models that claim tools but fail are flagged.
- **Fallback resilience.** ccr v3.1.3 (published 2026-10-09, maintained) owns request-time
  fallback. Hoppy cannot intercept requests, so cooldown is done at the config level: a health
  check pings each chain model, failing ones move to the end of the chain for N minutes, then
  return. Spike first whether ccr v3 already exposes retry/cooldown settings.

## Prerequisites

- Node 22.5+ (already required for `node:sqlite`)
- claude-code-router 3.1.x
- Test harness from 1.0 (`@vscode/test-electron`, 13 passing tests)
- Sample JSONL fixtures with limit messages (copy, redact, store in `test/fixtures/`)

---

## Sprint 1: Limit radar (detect + hop)

**Goal**: When the active Claude account hits a limit, Hoppy shows a notification within 2 s
with one-click options to keep working.

**Demo/Validation**:
- Append a fixture limit line to a live session file → notification appears.
- Click "Hop to Personal and continue" → new Claude tab on Personal, chat copied, `/resume`
  hint shown.
- Menu shows "Work · limit, resets 12:50am" and puts it last.

### Task 1.1: Limit parser
- **Location**: `src/limits.ts` (new)
- **Description**: `parseLimitEntry(line: string): LimitHit | undefined` returning
  `{ kind: 'session'|'weekly'|'other', resetsAtText, resetsAt?: Date, raw, sessionFile }`.
  Converts "12:50am (Asia/Dhaka)" into a Date (next occurrence; weekly may include a weekday/date).
- **Dependencies**: none
- **Acceptance Criteria**: parses all fixture variants; never throws; unknown wording still
  returns `kind: 'other'` with raw text.
- **Validation**: unit tests with 6+ fixture strings (session, weekly, Opus-specific, no
  timezone, unknown wording, non-limit API error).

### Task 1.2: Limit store
- **Location**: `src/limits.ts`
- **Description**: persist `{ [configDir]: LimitHit }` in `globalState`; `isLimited(dir)`
  clears entries whose `resetsAt` has passed; `onDidChangeLimits` event.
- **Dependencies**: 1.1
- **Acceptance Criteria**: survives window reload; expired entries auto-clear.
- **Validation**: unit test with fake clock.

### Task 1.3: Session watcher
- **Location**: `src/limits.ts`, wired in `src/extension.ts` activate
- **Description**: watch `<currentDir>/projects/**/*.jsonl` with
  `vscode.workspace.createFileSystemWatcher(new RelativePattern(Uri.file(dir), ...))`.
  On change, read only bytes after the last known offset, split lines, feed parser.
  Re-target the watcher when the account switches. Debounce 300 ms.
- **Dependencies**: 1.1, 1.2
- **Acceptance Criteria**: detects within 2 s; CPU idle when nothing changes; no full-file reads.
- **Validation**: integration test appends a line to a temp config dir and asserts the event.

### Task 1.4: "Hop" notification
- **Location**: `src/extension.ts` (new `onLimitHit`)
- **Description**: warning notification
  "Work hit its session limit (resets 12:50am)." Buttons:
  `Hop to <best other account> and continue`, `Use Other AI`, `More…`.
  "Best" = first non-limited account, else Other AI if configured.
  "and continue" reuses `copyChat` for the session that hit the limit, opens a fresh tab via
  `openFreshClaudeTab`, shows "Type /resume and pick the top chat".
  Setting `hoppy.suggestOnLimit` (default true).
- **Dependencies**: 1.3
- **Acceptance Criteria**: 2 clicks from limit to new tab with chat available; shows once per
  limit hit (no spam across multiple tabs).
- **Validation**: integration test stubs `showWarningMessage` and checks chosen path runs.

### Task 1.5: Spike: open a tab directly on a session
- **Location**: notes in `docs/plans/spikes.md`
- **Description**: check if `claude-vscode.editor.open` accepts a session id / resume arg in the
  installed Claude Code version. If yes, skip the manual `/resume` step.
- **Dependencies**: none (parallel)
- **Acceptance Criteria**: documented yes/no with evidence.

### Task 1.6: Menu awareness
- **Location**: `src/targets.ts` (`describe`), `src/extension.ts` (`showMenu`)
- **Description**: limited accounts show `$(watch) limit · resets 12:50am` and sort below
  available ones; status bar tooltip lists limits.
- **Dependencies**: 1.2
- **Validation**: menu snapshot test.

---

## Sprint 2: Usage meter

**Goal**: Users see how much each account used (5 h / today / 7 days) before they hit a wall.

**Demo/Validation**:
- Menu row: "Work · 1.2M tokens in last 5h".
- Settings → Accounts card shows three numbers + last limit hit.
- Opening the menu on a 500 MB history takes < 300 ms after first scan.

### Task 2.1: Usage scanner
- **Location**: `src/usage.ts` (new)
- **Description**: `scanUsage(configDir): UsageSummary` summing `message.usage` of
  `type: assistant` entries, skipping `<synthetic>` and sidechain duplicates (dedupe by
  `message.id`). Buckets: last 5 h, today (local), last 7 days. Per model breakdown.
- **Dependencies**: none
- **Acceptance Criteria**: matches a hand-computed total on fixtures; dedupes streamed chunks
  sharing one `message.id`.
- **Validation**: unit tests.

### Task 2.2: Incremental cache
- **Location**: `src/usage.ts`
- **Description**: cache `{file: {size, mtime, offset, partialBuckets}}` in
  `context.globalStorageUri/usage-cache.json`; only parse appended bytes; drop entries older
  than 8 days.
- **Dependencies**: 2.1
- **Acceptance Criteria**: second scan of unchanged dir < 50 ms.
- **Validation**: perf test on generated 100 MB fixture.

### Task 2.3: Show usage
- **Location**: `src/extension.ts`, `src/settings.ts`, `media/settings.js`, `media/settings.css`
- **Description**: menu detail line, status bar tooltip, Accounts tab stat row
  (5 h / today / 7 d + model split bar). Wording: "tokens used", never "% of limit" (Anthropic
  does not publish exact limits; a % would be a guess).
- **Dependencies**: 2.2
- **Validation**: harness.html snapshot + manual check.

---

## Sprint 3: Feel (colors + quick flip)

**Goal**: Always know which account you are on at a glance; flip in one keystroke.

### Task 3.1: Account color
- **Location**: `package.json` (`hoppy.accountColors` setting), `src/extension.ts`,
  Settings Accounts tab color dots (6 preset swatches, accessible contrast)
- **Description**: status bar text colored per account (`statusItem.color`); Other AI keeps blue.
- **Validation**: manual, both light and dark themes.

### Task 3.2: Quick flip
- **Location**: `package.json` keybinding `ctrl+alt+h` → `hoppy.flip`, `src/extension.ts`
- **Description**: remember previous target in `globalState`; flip switches back and opens a
  fresh tab. Check for keybinding conflicts with Claude Code.
- **Validation**: integration test runs `hoppy.flip` twice and asserts the env var toggles.

---

## Sprint 4: Other AI resilience

**Goal**: Other AI keeps answering even when free models are busy, and handoffs never overflow a
model's context.

### Task 4.1: Spike ccr v3 fallback options
- **Location**: `docs/plans/spikes.md`
- **Description**: read ccr 3.1.3 config schema for retry, timeout, cooldown, circuit breaker.
- **Acceptance Criteria**: documented which knobs exist; decides 4.2 scope.

### Task 4.2: Model health check + auto-reorder
- **Location**: `src/health.ts` (new), `scripts/ccr-config.mjs` (`apply` reorder), Backups tab
- **Description**: "Check models" button and a background check every 30 min while Other AI is
  active: tiny chat request with one tool definition through the gateway per chain model;
  record ok / 429 / 404 / tool-fail / latency. Failing models move to the end of the chain with
  `cooldownUntil`; restored after cooldown. Show status dots in Backups.
- **Dependencies**: 4.1
- **Acceptance Criteria**: a model forced to 404 is demoted within one check; restored after
  cooldown; free quota cost of checks < 1 % of daily free requests (max 1 request per model per
  30 min).
- **Validation**: unit test for reorder logic; manual with a fake bad model id.

### Task 4.3: New provider tiles
- **Location**: `src/setup.ts` (`PROVIDERS`, `checkKey`), `scripts/ccr-config.mjs`,
  `media/settings.js`
- **Description**: add Groq (`gsk_`), Cerebras (`csk-`), Mistral, NVIDIA NIM (`nvapi-`), all
  OpenAI-compatible. Live key check via each `/models` endpoint. Only list models that support
  tool calling. Update README `External services`-style privacy section.
- **Dependencies**: none (parallel with 4.1)
- **Validation**: key-format unit tests; one real key test per provider if the user has keys.

### Task 4.4: Context-fit guard on handoff
- **Location**: `src/chats.ts`, `src/extension.ts` (handoff + limit hop)
- **Description**: estimate chat prompt tokens from the last assistant `usage`
  (input + cache_read + cache_creation). If > 80 % of target model `context_length`, warn and
  offer "Continue with a short summary": write a new session file whose first user message is a
  structured summary (goal, files touched, last 10 turns verbatim). Summary is built locally
  (no LLM call) in 1.1; LLM-written summary is a 1.2 idea.
- **Dependencies**: Sprint 1
- **Acceptance Criteria**: 180k-token chat to a 128k model shows the warning; summary session
  resumes cleanly.
- **Validation**: fixture test + manual `/resume`.

---

## Sprint 5: Release 1.1.0

### Task 5.1: Tests green
- 13 existing + new tests (parser, store, watcher, usage, flip, reorder, context guard).

### Task 5.2: Docs and onboarding
- README sections: "When you hit a limit", "Usage", "Health check"; CHANGELOG 1.1.0;
  walkthrough step "Never get stuck" with new SVG; settings Guide text.

### Task 5.3: Package and publish
- Bump to 1.1.0, `vsce package --target win32-x64` and `win32-arm64`, Marketplace upload,
  `ovsx publish` (after namespace claim #14891 is approved), git tag `v1.1.0`, zip refresh.

### Task 5.4: Short "What's new" clip (optional)
- 30 s 1.1 promo reusing the video pipeline: limit hit → Hoppy notification → hop → working.

---

## Testing Strategy

- **Unit**: parser, date math (timezones, after-midnight resets), usage dedupe, reorder logic.
- **Integration** (`@vscode/test-electron`): watcher on a temp config dir, limit hop flow,
  flip command, settings messages.
- **Manual**: real limit on account 2 (session limits happen often), real handoff to Other AI,
  light/dark themes, 125 % display scale.
- **Performance**: usage scan on large history; watcher CPU when idle.

## Potential Risks & Gotchas

- **Limit wording changes** in a Claude Code update → tolerant regex + raw-text fallback +
  fixture tests; detection degrades to "a limit was hit" instead of breaking.
- **Timezone parsing** ("resets 12:50am (Asia/Dhaka)") → use `Intl` with the given zone; if the
  zone is unknown, show the raw text and skip countdown.
- **Notification spam** when several tabs hit the limit at once → dedupe per account per
  reset window.
- **Watcher on huge `projects/` trees** → watch only `*.jsonl`, read only appended bytes.
- **Usage numbers ≠ Anthropic's limit math** → never show "% left"; label as tokens used.
- **Health checks spend free quota** → strict rate (1 per model per 30 min), off when Other AI
  is not in use.
- **ToS perception** of multi-account use → manual click only, no auto-rotation, no unofficial
  endpoints, README note that each account must belong to the user and follow Anthropic's terms.
- **Open VSX claim pending** → Marketplace release does not wait on it.

## Rollback Plan

- Every feature behind a setting (`hoppy.suggestOnLimit`, `hoppy.showUsage`,
  `hoppy.healthCheck`); defaults can flip off in a 1.1.1 hotfix.
- Health-check reorders store the original chain; "Reset chain" restores it.
- Marketplace: republish 1.0.1 vsix as 1.1.1 if a blocker ships.
