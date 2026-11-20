# ClawAgents for VS Code

Autonomous coding agent extension for **VS Code** and **Cursor**, powered by [`clawagents`](https://github.com/x1jiang/clawagents_py). Chat from the right **Secondary Side Bar**, edit files with explicit permission controls and checkpoints, optimize workspace harnesses, and run models from OpenAI, Anthropic, Google Gemini, AWS Bedrock / Mantle, xAI, Meta, or local servers (Ollama / vLLM / Gemma Q4).

- **Python Runtime:** [x1jiang/clawagents_py](https://github.com/x1jiang/clawagents_py) · [PyPI](https://pypi.org/project/clawagents/)
- **Releases & VSIX:** [GitHub Releases](https://github.com/x1jiang/clawagents-vscode/releases) · [Changelog](CHANGELOG.md)
- **Desktop App:** [x1jiang/clawagents-desktop](https://github.com/x1jiang/clawagents-desktop)

## Requirements

- **VS Code 1.85+** (or Cursor)
- **Python 3.10+** on the extension host (managed mode auto-discovers compatible installations, or configure `clawagents.pythonPath`)
- **`clawagents >= 6.20.102, < 7`** (auto-installed into the managed virtualenv on first start)
- At least one model provider credential (or a local model server)

## Quick Start

1. **Install** from the Visual Studio Marketplace or from a `.vsix` download (`code --install-extension clawagents-*.vsix`).
2. **Open a workspace** (local or Remote SSH). On first start, the extension installs its Python dependencies into an isolated managed virtualenv:
   ```text
   clawagents[gemini,anthropic,bedrock,mcp,media,accurate-tokens,pty]>=6.20.102,<7  fastapi  uvicorn  pydantic  python-dotenv
   ```
   You can trigger this manually anytime via **Command Palette → ClawAgents: Install/Upgrade Python Dependencies**.
3. **Add credentials** via **Command Palette → ClawAgents: Set API Key** (OpenAI, Anthropic, Gemini, Bedrock, xAI, Tavily) or a workspace `.env` file.
4. **Open Chat** from the right **Secondary Side Bar** or press `⌘⇧'` (`Ctrl+Shift+'`).
5. Start in **Plan** or **Ask** mode until you are comfortable enabling workspace **Auto-approve** toggles.

## Key Features

- **Multi-provider model support:** OpenAI (GPT-6 / GPT-6.1 Terra & Sol, Fast mode), Anthropic (Claude Fable 5.2, Claude 5.5, direct Fast mode), Google Gemini (Gemini 4 Hydrogen / Carbon / Argon, Gemini 3.8 Flash), AWS Bedrock & Mantle, xAI Grok, Meta / Muse, and local Ollama / Gemma Q4.
- **Concurrent chats & side chat:** Independent conversation tabs, per-thread model/effort routing, and draggable side-chat overlays that keep running across tab switches.
- **Permissions & checkpoints:** `ask` · `read-only` · `auto` · `full access` modes, opt-in per-category auto-approve, pre-write checkpoints with diff/restore, and serialized workspace writes across concurrent chats.
- **Harness² Workspace Optimizer:** Built-in Propose–Probe–Compose optimizer in **Settings → Skills** with unified diff preview, backed-up apply, conflict detection, and one-click rollback.
- **Telemetry & Info card:** Live token/cost/cache accounting, inference efficiency metrics (`Avg TTFT`, `Decode speed`), skill usage rankings, and deduplicated per-conversation human time estimates.
- **Extensible tooling:** Workspace/user skills (`SKILL.md`), MCP servers (`.clawagents/mcp.json`), optional Context Mode, Graphify knowledge graphs, Playwright browser tools, and long-horizon **Goal** autopilot.

## Core Settings

| Setting | Default | Description |
| --- | --- | --- |
| `clawagents.pythonRuntime` | `managed` | Isolated extension-owned virtualenv (`managed`) or an exact interpreter (`custom`) |
| `clawagents.pythonPath` | `python3` | Preferred base Python (`managed`) or exact interpreter path (`custom`) |
| `clawagents.provider` | `auto` | Preferred provider for credential selection |
| `clawagents.model` | *(empty)* | Default model override |
| `clawagents.defaultMode` | `auto` | Default permission mode |
| `clawagents.includeContextByDefault` | `false` | Attach active editor context by default (secrets omitted) |
| `clawagents.contextMode` | `true` | Enable Context Mode tools (`context-mode` ≥ 1.0.169) |
| `clawagents.graphify` | `false` | Enable Graphify knowledge-graph MCP (`graphifyy[mcp]` ≥ 0.9.20) |
| `clawagents.ensureCompanions` | `false` | Prompt to install/upgrade companion CLIs on startup (default: probe-only) |
| `clawagents.syncPathPythons` | `false` | Offer to upgrade other `PATH` Pythons below the required floor |
| `clawagents.advanced.enableContextObservatory` | `false` | Record run context events to `.clawagents/context-observatory/<chat_id>/` |

Sidebar **Settings** also configure API keys, base URLs, skills folders, MCP servers, Graphify, browser tools, and workspace telemetry. In multi-root workspaces, run **ClawAgents: Select Workspace Root** to scope sidecar state to a single folder.

## Optional Companions

| Companion | Floor | Install / Upgrade | Notes |
| --- | --- | --- | --- |
| [Context Mode](https://github.com/mksglu/context-mode) | **1.0.169** | `npm install -g context-mode@latest` | Requires Node ≥ 22.5 |
| [RTK](https://www.rtk-ai.app/) | **0.43.0** | `brew install rtk` / `brew upgrade rtk` | On `PATH` |
| [Graphify](https://github.com/Graphify-Labs/graphify) | **0.9.20** | `pip install 'graphifyy[mcp]'` | Run **ClawAgents: Graphify — Extract Workspace** |
| Browser Tools | — | `pip install 'clawagents[browser]' && playwright install chromium` | Enable in Settings → Browser tools |

Run **Command Palette → ClawAgents: Ensure Companions** to re-probe or upgrade companions.

## Security Model

- **Loopback-only sidecar:** Binds strictly to `127.0.0.1` with a per-session bearer token on every endpoint.
- **Credential isolation:** API keys live in VS Code SecretStorage or workspace `.env` (forwarding only key/model vars—no `PYTHONPATH` or base-URL hijacking).
- **Workspace confinement:** File restore, checkpoints, and chat state stay confined under the active workspace / `.clawagents/`.
- **Explicit trust gates:** Auto-approve toggles, MCP (`mcp.json`), and `full_access` mode are off by default and require explicit opt-in.

## Documentation

| Guide | Topic |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/python-setup.md](docs/python-setup.md) | Python interpreter selection, Remote SSH, no-folder storage, Meta/Glimmer preset, and troubleshooting |
| [docs/local-gemma.md](docs/local-gemma.md) | Optional managed local Gemma Q4 setup, hardware matrix, and controls |
| [docs/model-catalog-audit.md](docs/model-catalog-audit.md) | Verified model IDs, context windows, thinking/Fast-mode rules, and pricing sources |
| [docs/human-time.md](docs/human-time.md) | Per-conversation human time estimation rules and limits |
| [CHANGELOG.md](CHANGELOG.md) | Extension release history |
| [PUBLISH.md](PUBLISH.md) | Packaging, GitHub releases, and Marketplace / Open VSX publishing |

## Development

```bash
npm run install:all
npm run build      # typecheck + webview bundle + extension bundle
npm test           # Node unit tests
npm run package    # builds clawagents-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host.
