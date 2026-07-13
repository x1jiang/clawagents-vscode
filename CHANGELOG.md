# Changelog

## 1.0.27 — 2026-07-13

- Skills: auto-load personal homes (`~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`) so cohort/workflow skills are available without manual folder registration
- Require `clawagents>=6.12.8` for per-turn skill ranking + stronger `use_skill` activation

## 1.0.26 — 2026-07-13

- Fix: auto editor Context is no longer written into chat history (only what you typed is shown)
- Fix: `.env` and other secret-like files are omitted from auto Context / +Sel snippets
- Context checkbox defaults off (`clawagents.includeContextByDefault`); check it when you want editor snippets

## 1.0.25 — 2026-07-13

- Skills: require `clawagents>=6.12.7` for dynamic skill-catalog budget (~1.5% of context, floor 4k / ceiling 16k chars) with description-first truncation

## 1.0.24 — 2026-07-13

- Skills: require `clawagents>=6.12.6` so `list_skills` is registered (overflow catalog) while full skill bodies still load only via `use_skill`

## 1.0.23 — 2026-07-13

- Cleaner API-key handling: pass host SecretStorage key as explicit `api_key=` every turn; sidecar sets `CLAWAGENTS_SKIP_DOTENV=1` so clawagents never reloads workspace `.env` mid-process (requires `clawagents>=6.12.5`)

## 1.0.22 — 2026-07-13

- Fix: UI / SecretStorage API keys no longer get overwritten by workspace `.env` on the second chat turn (`CLAWAGENTS_DOTENV_OVERRIDE=0` + spawn-secret restore; requires `clawagents>=6.12.4` for the library-side fix)

## 1.0.21 — 2026-07-13

- Harden settings: single source of truth (`DEFAULTS` + `sanitize_patch`); remove duplicate `SettingsBody` so new keys cannot be silently dropped
- Persist `agent_mode` / `action_mode`; webview verifies patched keys after save
- Diagnostics warn on custom HTTPS + TLS verify on / Wire API auto; chat preflight if custom gateway has no model

## 1.0.20 — 2026-07-13

- Fix Settings save: `wire_api`, `reasoning_effort`, and `ssl_verify` were dropped by the API body schema (UI snapped back; chat kept hitting Chat Completions → 404 on Responses-only gateways)

## 1.0.19 — 2026-07-13

- Custom OpenAI-compatible Base URL: probe `/v1/models` and fill the model dropdown from the gateway (fixes header stuck on **default** / Provider **OpenAI (no key)**)
- Refresh provider catalog after Save settings; Wire API + TLS verify save immediately

## 1.0.18 — 2026-07-13

- Settings: API keys live only on each Provider card (OpenAI / Anthropic / Gemini / Bedrock) + Tavily under Browser/web — removed duplicate Set/Clear/Verify from Advanced

## 1.0.17 — 2026-07-13

- OpenAI compatible gateways: **Wire API** (auto / Responses / Chat Completions) + **Verify TLS** settings
- Effort selector saves immediately (no longer stuck on Medium)
- Requires `clawagents>=6.12.3` for Responses-only proxies (e.g. Codex gateways)

## 1.0.16 — 2026-07-13

- OpenAI GPT-5.5/5.6: auto-route to Responses API via `clawagents>=6.12.2` so Effort applies with tools (Ollama/BAG stay on Chat Completions)

## 1.0.15 — 2026-07-12

- Model dropdown: only list models for providers with credentials that pass a live key check (auto no longer dumps every catalog entry)
- Remove DeepSeek R1 from Bedrock catalog
- Bedrock availability no longer unlocked by `OPENAI_API_KEY` alone; Ollama only when local daemon responds

## 1.0.14 — 2026-07-12

- Remove Cline attribution from README / LICENSE / NOTICE

## 1.0.13 — 2026-07-12

- Secondary Side Bar flame icon: teal (`#2DD4BF`) so it’s visible on dark themes and distinct from Claude (orange) / Codex (white)

## 1.0.12 — 2026-07-12

- **Effort** selector for GPT-5.5/5.6 and o-series (Light / Medium / High / Extra High / None) — header + Settings; requires `clawagents>=6.12.1`

## 1.0.11 — 2026-07-12

- **VS Code**: Secondary Side Bar + editor title Open button (same pattern as Claude Code / Codex) so the flame icon appears in the right strip
- Install target clarified: use VS Code (`code --install-extension`), not only Cursor

## 1.0.10 — 2026-07-12

- **Cursor**: show ClawAgents on the left **Activity Bar** (Claude/Codex title-bar icons are Cursor built-ins — third-party extensions cannot join that strip)
- **VS Code**: keep Secondary Side Bar on the right when the auxiliary bar is available

## 1.0.9 — 2026-07-12

- Show ClawAgents in the right Secondary Side Bar strip: themeable SVG icon, editor title-bar Open button, reveal panel on startup (`clawagents.revealOnStartup`)

## 1.0.8 — 2026-07-12

- Settings provider dropdown: hide builtin `Profile: bedrock-gateway` (duplicate of **AWS Bedrock**; gateway mode stays on the Bedrock card)

## 1.0.7 — 2026-07-12

- **AWS Bedrock native IAM** — select Bedrock, pick AWS model IDs (Claude / Nova / Llama / GPT-OSS / …), leave Base URL empty
- Settings: AWS region + profile; optional BAG/LiteLLM gateway section
- Forward `AWS_*` credentials into the sidecar; require `clawagents[bedrock]≥6.12.0`

## 1.0.6 — 2026-07-12

- Settings: guided setup cards for **OpenAI** (Official / Ollama / BAG / Fix URL → /v1) and **Gemini** (inline key + verify)
- OpenAI provider fully supports OpenAI-compatible endpoints (including BAG as Base URL)
- Shared `set_provider_key` + `test_compatible_endpoint` for OpenAI / BAG probes

## 1.0.5 — 2026-07-12

- Settings: dedicated **Bedrock Access Gateway** card — Local preset (`http://localhost:8000/api/v1`), Fix URL → `/api/v1`, inline gateway API key, Test connection

## 1.0.4 — 2026-07-12

- Settings: **AWS Bedrock (gateway)** provider + selectable Bedrock model IDs (Claude / Nova / GPT-OSS)
- Bedrock requires an OpenAI-compatible **Base URL** (LiteLLM or Bedrock Access Gateway); store the gateway token via Set API key
- clawagents: route `anthropic.*` model IDs through OpenAI provider when `base_url` is set (fixes Bedrock gateway example)

## 1.0.3 — 2026-07-12

- Restore ClawAgents to the right **Secondary Side Bar** (1.0.2 Activity Bar move hid the icon for many users)
- Drag-and-drop: VS Code requires **holding Shift** to drop into a webview; placeholder/+Attach clarify this; harden URI parsing; **+Attach** file picker

## 1.0.2 — 2026-07-12

- Move ClawAgents icon to the left **Activity Bar** (was Secondary Side Bar) — reverted in 1.0.3
- Settings → **Clear API key…** / command **ClawAgents: Clear API Key…** (per provider or all)
- Header: last checkpoint time on **Checkpoints**; context % bar on **Compact**
- Settings panel **autosaves** (~0.5s debounce); MCP/base-URL trust prompts only when newly enabling

## 1.0.1 — 2026-07-11

- Settings → **Set API key…** includes **Tavily** (SecretStorage → `TAVILY_API_KEY`) for `web_search`
- Auto-approve: separate **Web** (fetch/search) and **Browser** (Playwright) checkboxes
- Browser tools remain opt-in under Settings; clearer install hint when load fails

## Unreleased

## 1.0.0 — 2026-07-11

- Graduate from Marketplace **Preview** (`preview` flag removed)
- First stable 1.x line; still requires **clawagents ≥ 6.11.1**

## 0.5.21 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.11.1** (CodeAct sandbox + checkpoint ref hardening)
- Do not forward library `approval_required` into the webview (avoids double permission prompts; sidecar uses `before_tool`)

## 0.5.20 — 2026-07-11

- UI polish: clearer header toolbar, context meter chip, Checkpoints/Compact actions
- Checkpoint panel restyle with Files / Chat / Both restore controls
- Softer composer and tab chrome within VS Code theme tokens

## 0.5.19 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.11.0** (shadow restore modes, always-on rules, modes, CodeAct, evals)
- Context meter + `/compact` + compact_progress visibility
- Checkpoint timeline with files / conversation / both restore
- Settings: agent persona mode + CodeAct action mode

## 0.5.18 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.8** (compaction budget escalation + message-identity fix)
- Per-run cancellation tokens (cancel no longer races concurrent turns; disconnect cancels only that run)
- `/cancel` unblocks pending `ask_user` prompts
- Capture previous cwd inside the turn lock (fixes chdir restore race)
- Configurable MCP `mcp.json` server timeout (default 60s, was SDK 5s)
- Gemini array-schema shim self-disables when upstream already fixed
- Release builds minify the extension bundle

## 0.5.17 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.7** (peer harness pack)
- Sidecar: `GET /checkpoints`, `POST /checkpoints/restore` for shadow-git undo

## 0.5.16 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.6** (context headroom: crushers, tiered read, cache-stable prompts, failure→AGENTS.md)

## 0.5.15 — 2026-07-11

- Remove **OpenViking** toggle/skill (default cloud embeddings not allowed); selection box is Edit/Execute/Web/Caveman only

## 0.5.14 — 2026-07-11

- Remove **ByteRover** toggle/skill (cloud LLM provider not allowed); OpenViking remains opt-in

## 0.5.13 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.5** (Gemini history 400 recovery + signature fidelity)

## 0.5.12 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.4** (Gemini 3 `function_call.id` + `thought_signature` replay — fixes remaining FR/FC 400s)

## 0.5.11 — 2026-07-11

- Require / auto-upgrade to **clawagents ≥ 6.10.3** (Gemini `function_response` turn purity — fixes follow-on 400s after 6.10.2)
- Sidecar probe fails closed until the remote Python package meets the floor

## 0.5.10 — 2026-07-11

- Require clawagents ≥ **6.10.2** (Gemini turn-hygiene fix for function-call 400s)

## 0.5.9 — 2026-07-11

- Fix `AskUserTool() takes no arguments` when sidecar still has clawagents &lt; 6.10.1
- Require / auto-upgrade to `clawagents>=6.10.1` (webview `ask_fn` HITL)

## 0.5.8 — 2026-07-11

### Security (second harden pass)
- Orphan/stale `allow_always` can no longer create `path=* tool=*` grants; refuse open-ended grants
- Confine `diff_snapshot` / `openPath` under the workspace; validate snapshot ids
- Drop provider base-URL keys from workspace `.env` allowlist (Settings + trust flag only)
- MCP: workspace `mcp.json` opt-in; allowlisted launchers; loopback URLs only; sanitize child env
- Ignore committed wildcard permission grants; demote `full_access` unless Settings opt-in
- Drop `HTTP_PROXY` / `LD_LIBRARY_PATH` from sidecar env; pip uses curated env
- External skill dirs require opt-in; server-side base_url trust check

## 0.5.7 — 2026-07-11

### Security
- Allowlist workspace `.env` keys (no `PYTHONSTARTUP` / `PYTHONPATH` injection into sidecar)
- Ignore absolute `clawagents.pythonPath` from workspace settings; prefer User/Remote
- Gate unknown/MCP tools in Plan and approval (no longer auto-allowed)
- “Allow always” grants match full relative paths only (not basename)
- Harden `atomic_write_json` against tmp symlink TOCTOU; confine instruction/skill/snapshot resolves
- Warn on non-localhost `base_url` (save + load); MCP defaults to off

### Other
- Pricing estimates use longest-prefix match (`gpt-5.5-pro` ≠ `gpt-5.5`)
- Light dependency upper pins; grant/path unit tests

## 0.5.6 — 2026-07-11

- Auto-install/upgrade Python deps (`clawagents[gemini,anthropic,mcp]`, fastapi, uvicorn, pydantic) on remote/local when missing or too old
- New command: **ClawAgents: Install/Upgrade Python Dependencies**

## 0.5.5 — 2026-07-11

- Fix crash on older PyPI clawagents: only pass `skills_exclude` / kwargs that `create_claw_agent` supports

## 0.5.4 — 2026-07-11

- Remote/SSH: probe Python before spawn, longer health timeout, surface real sidecar errors in UI
- Forward conda/pyenv env into sidecar; offline provider fallback when catalog is empty

## 0.5.3 — 2026-07-11

- Marketplace metadata cleanup (preview flag, softer listing copy) to clear false-positive “suspicious content” scans
- Avoid embedding secret-looking regex literals in the bundled extension host

## 0.5.2 — 2026-07-11

- Return 400 (not 500) when `/chat/stream` receives an invalid `chat_id`

## 0.5.1 — 2026-07-11

- `+File` inserts only `@path` (agent reads the file) instead of pasting full contents
- Drag-and-drop workspace files onto the draft to attach `@path` refs

## 0.5.0 — 2026-07-11

First Marketplace-ready release.

### Security
- Fail-closed sidecar auth when the gateway session key is missing
- Lock sidecar bind address to loopback
- Validate `chat_id` / `snapshot_id` and confine snapshot restore to the workspace
- Curate env vars passed to the sidecar; redact secrets in the Output channel
- Safer Auto-approve defaults (edit / execute / web off); auto interaction no longer forces full approve
- Restrict `open_file` to workspace folders; stronger CSP nonce + `connect-src 'none'`

### Publishing
- Marketplace metadata: icon, repository, bugs, homepage, gallery banner
- End-user README and first-run Python dependency check
- PyPI-oriented install errors (no monorepo-only paths)

## 0.4.15

- Fix Gemini 400 errors from tool schemas missing array `items` (Context Mode / MCP)

## 0.4.14

- Sanitize provider credentials; Gemini verify via query param; start sidecar before verify

## 0.4.13 and earlier

- Skills folders UI, Gemini models, ByteRover / OpenViking toggles, Context Mode, multi-provider settings
