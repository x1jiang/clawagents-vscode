# ClawAgents for VS Code

Coding agent for VS Code and Cursor. Chat from the right **Secondary Side Bar** (same strip as Claude Code / Codex), edit your workspace with permission controls, and use OpenAI, Anthropic, Gemini, or local OpenAI-compatible models (including Ollama).

## Requirements

- VS Code **1.85+** (or Cursor)
- Python **3.11+** on your PATH (or set `clawagents.pythonPath`)
- **clawagents ≥ 6.15.0** (auto-installed / upgraded by the extension; Goal autopilot + native Bedrock)
- A provider credential for at least one model provider

## Quick start

1. Install this extension from the Marketplace (or a `.vsix`).
2. Open a folder / Remote SSH window. On first start the extension **auto-installs** Python packages into `clawagents.pythonPath`:

```text
clawagents[gemini,anthropic,mcp]  fastapi  uvicorn  pydantic  python-dotenv
```

You can also run **ClawAgents: Install/Upgrade Python Dependencies** from the Command Palette.

3. Add credentials: Command Palette → **ClawAgents: Set Provider Credential** (includes **Tavily** for `web_search`), or put keys in a workspace `.env`. For browser tools: Settings → **Enable browser tools**, then `pip install 'clawagents[browser]' && playwright install chromium`.

4. Open the right **Secondary Side Bar** and click **ClawAgents**, or run **ClawAgents: Open Chat** (`⌘⇧'` / `Ctrl+Shift+'`).

5. Start in **Plan** / ask mode if you want confirmations. Turn on **Auto-approve → Edit / Execute** only when you trust the agent for that workspace.

## Features

- Multi-turn chats with history, regenerate, and live token usage
- Permission modes: ask · read-only · auto · full access
- Opt-in auto-approve for edits, shell, and web
- Checkpoints before writes (diff / restore)
- Skills folders, MCP servers (`.clawagents/mcp.json`), optional Context Mode
- Local sidecar process (loopback only) with a per-session bearer token

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `clawagents.pythonPath` | `python3` | Interpreter for the sidecar |
| `clawagents.model` | *(empty)* | Model override |
| `clawagents.provider` | `auto` | Preferred provider for credential selection |
| `clawagents.defaultMode` | `auto` | Default permission mode |
| `clawagents.includeContextByDefault` | `false` | Start with Context checked (editor snippets; not shown in history; secrets omitted) |
| `clawagents.contextMode` | `true` | Context Mode tools (needs `npm install -g context-mode`) |

Sidebar **Settings** cover provider, model, base URL, skills, MCP, browser tools, and telemetry (stored under `.clawagents/` in the workspace). Opt-in **ATLAS** failure checks live under the composer **Auto-approve** menu (off by default; costly on short tasks). The sidecar can auto-install the ATLAS runtime with other Python deps.

## Security

- Sidecar binds to loopback only; every HTTP endpoint requires a session bearer token
- Provider credentials stay in VS Code SecretStorage or your workspace env file — not written to disk by the extension
- Workspace `.env` only forwards API key / model vars (no `PYTHONPATH` / base-URL redirection)
- File restore, snapshots, and chat IDs are confined under the workspace / `.clawagents/`
- Mutating tools are gated by mode + Auto-approve toggles (defaults: **off**)
- MCP is **off** by default; workspace `mcp.json` requires an explicit trust toggle; only allowlisted launchers (`npx`, `uvx`, …) and loopback URLs
- `full_access` mode requires Settings → Allow Full Access; stale permission IDs cannot create wildcard grants

## Troubleshooting

- **Sidecar health check timed out** — open *ClawAgents Sidecar* output. Usually missing pip packages or a bad `clawagents.pythonPath`.
- **provider_auth** — invalid credential; workspace env overrides SecretStorage when both are set.
- **Gemini** — set the Gemini/Google provider credential; `pip install 'clawagents[gemini]'`.
- **MCP** — enable MCP in Settings, optionally trust workspace config, and check `~/.clawagents/mcp.json`.
- **Restart** — Command Palette → **ClawAgents: Restart Sidecar**.

## Optional tools

- [Context Mode](https://github.com/mksglu/context-mode): `npm install -g context-mode` (Node ≥ 22.5)
- Browser tools: Playwright Chromium via clawagents browser extras

## Source & development

- Source: [github.com/x1jiang/clawagents-vscode](https://github.com/x1jiang/clawagents-vscode)
- Runtime: [github.com/x1jiang/clawagents_py](https://github.com/x1jiang/clawagents_py)

```bash
npm run install:all
npm run build
# F5 → Run ClawAgents Extension
npm run package
```
