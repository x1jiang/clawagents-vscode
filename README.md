# ClawAgents for VS Code

Autonomous coding agent for VS Code and Cursor. Chat in the **right sidebar**, edit your workspace with permission controls, and use OpenAI, Anthropic, Gemini, or local OpenAI-compatible models (including Ollama).

## Requirements

- VS Code **1.85+** (or Cursor)
- Python **3.11+** on your PATH (or set `clawagents.pythonPath`)
- An API key for at least one provider

## Quick start

1. Install this extension from the Marketplace (or a `.vsix`).
2. Install the Python runtime into your interpreter:

```bash
python3 -m pip install -r <extension>/python/requirements.txt
python3 -m pip install 'clawagents[gemini,anthropic,mcp]'
```

The extension path is under your VS Code extensions folder, e.g. `~/.vscode/extensions/clawagents.clawagents-*/python/requirements.txt`. Or install directly:

```bash
python3 -m pip install 'clawagents[gemini,anthropic,mcp]' fastapi uvicorn pydantic
```

3. Set an API key: Command Palette → **ClawAgents: Set API Key**, or put keys in a workspace `.env`:

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...   # or GOOGLE_API_KEY
```

4. Open the **Secondary Side Bar** (right) and click the ClawAgents icon, or run **ClawAgents: Open Chat** (`⌘⇧'` / `Ctrl+Shift+'`).

5. Start in **Plan** / ask mode if you want confirmations. Turn on **Auto-approve → Edit / Execute** only when you trust the agent for that workspace.

## Features

- Multi-turn chats with history, regenerate, and live token usage
- Permission modes: ask · read-only · auto · full access
- Opt-in auto-approve for edits, shell, and web
- Checkpoints before writes (diff / restore)
- Skills folders, MCP servers (`.clawagents/mcp.json`), optional Context Mode
- Local-only sidecar (`127.0.0.1` + per-session bearer token)

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `clawagents.pythonPath` | `python3` | Interpreter for the sidecar |
| `clawagents.model` | *(empty)* | Model override |
| `clawagents.provider` | `auto` | Preferred provider for key selection |
| `clawagents.defaultMode` | `auto` | Default permission mode |
| `clawagents.includeContextByDefault` | `true` | Attach active editor context |
| `clawagents.contextMode` | `true` | Context Mode tools (needs `npm install -g context-mode`) |

Sidebar **Settings** also cover provider, model, base URL, skills, MCP, browser tools, and telemetry (stored under `.clawagents/` in the workspace).

## Security

- Sidecar binds **localhost only**; every HTTP endpoint requires a session bearer token
- API keys stay in VS Code SecretStorage or your `.env` — not written by the extension to disk
- File restore and chat IDs are confined under the workspace / `.clawagents/`
- Mutating tools are gated by mode + Auto-approve toggles (defaults: **off**)
- MCP configs can run arbitrary local commands — treat `.clawagents/mcp.json` as trusted input

## Troubleshooting

- **Sidecar health check timed out** — open *ClawAgents Sidecar* output. Usually missing pip packages or a bad `clawagents.pythonPath`.
- **provider_auth** — invalid key; workspace `.env` overrides SecretStorage when both are set.
- **Gemini** — use `GEMINI_API_KEY` or `GOOGLE_API_KEY`; `pip install 'clawagents[gemini]'`.
- **MCP** — `pip install 'clawagents[mcp]'` and check `.clawagents/mcp.json`.
- **Restart** — Command Palette → **ClawAgents: Restart Sidecar**.

## Optional tools

- [Context Mode](https://github.com/mksglu/context-mode): `npm install -g context-mode` (Node ≥ 22.5)
- Browser tools: Playwright Chromium via clawagents browser extras

## Development

```bash
npm run install:all
python3 -m pip install -e ../clawagents_py   # monorepo runtime
npm run build
# F5 → Run ClawAgents Extension
npm run package   # → clawagents-<version>.vsix
npm run publish   # Marketplace (requires vsce login)
```

## Attribution

UI/host patterns adapted from [Cline](https://github.com/cline/cline) (Apache-2.0). Agent runtime is [clawagents](https://github.com/x1jiang/clawagents_py) (MIT). See `NOTICE`.
