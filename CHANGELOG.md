# Changelog

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
