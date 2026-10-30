# Changelog

## 1.1.0

**Never stuck.**

- **Limit radar**: when a Claude account hits its session or weekly limit, Hoppy offers to continue the same chat on another account or Other AI in one click. The chat opens directly in a new tab, no `/resume` step.
- Accounts at their limit show when they reset, sink to the bottom of the menu, and turn the status bar orange until then.
- **Usage**: tokens used per account (last 5 hours, today, this week) in the menu and Settings, read from local chat files. Copied chats are not counted twice.
- **Hand-over summary**: a chat too long for the Other AI model can continue as a short summary (goal, files changed, latest messages).
- **Check models** in Backups: one tiny test request per model shows which work right now; **Put working first** reorders the chain.
- **New providers**: Groq, Cerebras, Mistral and NVIDIA NIM, with live model lists.
- **Account is back**: when a limit resets, Hoppy says so and offers to switch back.
- **Always continue**: after your first hop, choose to continue automatically next time (another account or Other AI), with Switch back and Ask me next time on the notice.
- **One account per project**: pin a project to an account; its window switches back to it whenever you return.
- **Export / Import settings** (never keys or logins) to move your setup to another PC or a teammate.
- Getting started guide updated for the new limit flow.
- **Ctrl+Alt+H** flips back to the previous account or model.
- Status bar color per account.
- Redesigned Settings: connected services on top and inline Connect for the rest, a clear "Claude panel uses" switcher, a limit banner with the way out, account details behind Edit.
- Fix: background refreshes no longer discard unsaved changes in Models and Backups.
- Fix: NVIDIA key check now really verifies the key (its model list is public).
- Fix: continuing a chat on another account or Other AI now opens it in a new tab there. Before, Claude Code could refocus the old tab, which kept running on the old account.
- Fix: the limit question is asked once per chat that hits a limit (and again only if you keep trying); an older notice no longer hides it.
- Fix: an account that answers again after a limit notice is no longer shown as limited; notices copied from another account are ignored.
- Fix: chats started in the VS Code panel show their first message in "Continue a chat" (not "(no preview)").
- Fix: account names show correctly when CLAUDE_CONFIG_DIR ends with a slash.
- New: Hoppy log in View → Output → Hoppy, explaining limit decisions.
- README: Marketplace install steps.
- Clearer model check results: "daily free limit reached" and "model not found" are reported as such; turned-off backups are not checked.

## 1.0.1

- Added the source code repository, homepage and issue tracker links: https://github.com/Shahreyar46/hoppy-claude-code

## 1.0.0

First release of Hoppy for Claude Code.

- Switch the Claude panel between your Claude accounts and other AI models from the status bar. A new Claude tab opens on your choice, no window reload.
- Shared chat history: this project's chats follow you to every account, so `/resume` picks up where you stopped.
- Continue any chat on another account or model when you hit a limit.
- Add and rename Claude accounts; each keeps its own login.
- Settings page: accounts, API keys (OpenRouter, Gemini, DeepSeek, GLM) with live checks, model picker (free and paid), backup models.
- Backup models take over automatically when a model is busy, out of quota or can't read screenshots.
- Guided setup with no terminal: installs the local helper in the background.
- 5-step getting started guide.
- `/second-opinion` skill: ask other models from inside a Claude chat.
