# Changelog

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
