# Python Setup, Storage & Troubleshooting

## Selecting Your Python Interpreter

ClawAgents supports two runtime modes via `clawagents.pythonRuntime`:

- **`managed` (default):** Creates an isolated, extension-owned virtualenv using `clawagents.pythonPath` as the preferred base interpreter. If unavailable or incompatible, it discovers Python 3.10+ on the extension host (excluding workspace executables and relative `PATH` entries) without modifying your settings or other Python installations.
- **`custom`:** Runs the sidecar with the exact interpreter specified in `clawagents.pythonPath` and prepends its directory to `PATH` for local agent commands. A missing or incompatible custom interpreter is reported as an error rather than silently falling back.

To pin a custom interpreter in VS Code **User settings** (or **Remote settings** in an SSH window):

```json
{
  "clawagents.pythonRuntime": "custom",
  "clawagents.pythonPath": "/absolute/path/to/venv/bin/python"
}
```

On Windows, provide the full `venv\\Scripts\\python.exe` path in JSON. The interpreter must exist on the host running the extension. Workspace-level absolute paths are ignored for security, and VS Code's separate Python extension selection does not configure ClawAgents.

### Verifying the Active Interpreter

- Open **Output → ClawAgents Sidecar** to inspect `Starting sidecar:` (active interpreter) and `PATH pin:` (prepended command directory).
- Settings changes apply automatically once active tasks finish, or immediately via **ClawAgents: Restart Sidecar**.
- To verify from a local agent command, run `python -c "import sys; print(sys.executable); print(sys.prefix)"`. Explicit absolute commands and separately configured containers/remote execution environments retain their own interpreter selection.

## Chat Storage Without an Open Folder

No-folder windows store chat history and settings in `no-folder-workspace` under the extension's host-local global storage, which survives VSIX upgrades. On first start, retained `.clawagents` state from older ClawAgents installation folders is copied without overwriting current files (leaving originals intact). Open workspace folders continue to use their own `.clawagents` directory.

## Self-Hosted Meta / Muse-Glimmer-30B Preset

Choose **Meta (Glimmer)** in ClawAgents Settings to select `Muse-Glimmer-30B` at the configured endpoint and approve the displayed URL with **Trust and save**. Meta also appears in the per-chat provider selector and automatically uses Chat Completions with no inherited OpenAI reasoning settings or API key.

Optional workspace `.env` or shell overrides (restart the sidecar after changing):

```dotenv
glimmer_30B_backend=https://your-glimmer-host/v1
glimmer_30B_model=Muse-Glimmer-30B
# META_API_KEY=your-dedicated-key  # only for authenticated deployments
```

Select **Meta (Glimmer)** again to apply updated environment defaults to Settings. Custom remote URLs always require explicit approval. During monorepo development, point `clawagents.pythonPath` at the interpreter where the sibling `clawagents_py` package is installed in editable mode.

## Provider Protocol Notes

- **GPT-6.1 Sol / GPT-6 Astra:** Agent tool calls require the OpenAI Responses API. Selecting these models automatically switches an inherited Chat Completions setting to Responses (tool-free Chat Completions remains supported).
- **Anthropic Fast mode (`speed="fast"`):** Available per conversation on direct `https://api.anthropic.com` for supported models (`claude-fable-5-2`, `claude-opus-5-5`, `claude-opus-5`). See [Model Catalog & Pricing Audit](model-catalog-audit.md) for details.

## Troubleshooting

| Symptom | Cause & Fix |
| --- | --- |
| **Python interpreter not found** | Run **ClawAgents: Select Python Interpreter** (or click **Select Python** in the error banner) and enter `python3` or an absolute Python 3.10+ path on the extension host. In Remote SSH windows, use a remote interpreter (local macOS/Windows paths won't exist on the remote host). |
| **Missing Python packages** | Click **Install Python dependencies** in the error banner or run **ClawAgents: Install/Upgrade Python Dependencies** from the Command Palette. |
| **Sidecar health check timed out** | Open **Output → ClawAgents Sidecar**. Usually caused by missing pip packages or an invalid `clawagents.pythonPath`. |
| **`provider_auth` error** | Invalid or missing credential. Precedence: VS Code SecretStorage → workspace `.env` → shell environment. Path-like values (e.g. `python.exe`) are ignored/purged automatically. |
| **Gemini errors** | Set the Gemini/Google API key and ensure `clawagents[gemini]` is installed (`google-genai>=3.3.0` on Python 3.11+ for `xhigh` thinking on Gemini 4 Hydrogen). |
| **MCP servers not loading** | Enable MCP in Settings, explicitly trust workspace `.clawagents/mcp.json` if using a project config, and verify `~/.clawagents/mcp.json`. |
| **Stale state / unresponsive sidecar** | Run **ClawAgents: Restart Sidecar** from the Command Palette. |
