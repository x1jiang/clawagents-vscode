"""App settings persisted under .clawagents/vscode_settings.json."""

from __future__ import annotations

import os
from typing import Any

from paths import SETTINGS_FILE, atomic_write_json, read_json, under_workspace, workspace_rel
from url_trust import is_trusted_base_url

DEFAULTS: dict[str, Any] = {
    "model": "",
    "provider": "auto",
    "base_url": "",
    "default_mode": "auto",
    "telemetry": False,
    "trajectory": False,
    "learn": False,
    "browser_tools": False,
    "mcp_enabled": False,
    # When False, only ~/.clawagents/mcp.json is loaded (not workspace).
    "mcp_trust_workspace": False,
    "context_mode": True,
    "workspace_system_prompt": "",
    # Extra skill roots (absolute or workspace-relative). Each folder may be a
    # single skill (SKILL.md) or a container of skill subfolders / .md files.
    "skill_dirs": [],
    # When True, also auto-discover ./skills, ./.skills, etc. under workspace.
    "skill_auto_discover": True,
    # Auto-discovered (or registered) roots the user dismissed.
    "skill_ignore_dirs": [],
    # Skill names to skip even if found under an included root.
    "skill_exclude": [],
    # Opt-in: allow mode=full_access from the client (otherwise demoted to auto).
    "allow_full_access": False,
    # Opt-in: load skill_dirs that resolve outside the workspace.
    "allow_external_skill_dirs": False,
    # Set by the extension after the user confirms a non-localhost base_url.
    "trust_custom_base_url": False,
    # Native Amazon Bedrock (IAM). Empty base_url → AsyncAnthropicBedrock / Converse.
    "aws_region": "",
    "aws_profile": "",
    # OpenAI reasoning effort (none|low|medium|high|xhigh). Empty = provider default.
    "reasoning_effort": "medium",
}


def _env_defaults() -> dict[str, Any]:
    """Defaults injected by the extension host (VS Code settings).

    Only applied when the workspace settings file has no explicit value, so
    the sidebar Settings panel always wins per workspace.
    """
    out: dict[str, Any] = {}
    cm = os.environ.get("CLAW_CONTEXT_MODE")
    if cm is not None:
        out["context_mode"] = cm.strip() not in ("0", "false", "False", "")
    return out


def load_settings() -> dict[str, Any]:
    data = read_json(SETTINGS_FILE, {})
    if not isinstance(data, dict):
        data = {}
    merged = dict(DEFAULTS)
    merged.update(_env_defaults())
    merged.update({k: v for k, v in data.items() if k in DEFAULTS or k in data})
    return merged


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = load_settings()
    current.update(patch)

    base_url = str(current.get("base_url") or "").strip()
    if base_url and not is_trusted_base_url(base_url):
        if not current.get("trust_custom_base_url"):
            # Refuse to persist an untrusted remote endpoint without explicit trust.
            current["base_url"] = ""
            patch = {**patch, "base_url": ""}
    elif not base_url:
        current["trust_custom_base_url"] = False

    # Drop external skill dirs unless explicitly allowed.
    if not current.get("allow_external_skill_dirs"):
        dirs = current.get("skill_dirs") or []
        if isinstance(dirs, list):
            kept: list[str] = []
            for raw in dirs:
                if not isinstance(raw, str) or not raw.strip():
                    continue
                rel = workspace_rel(raw.strip())
                if rel is not None or under_workspace(raw.strip()):
                    kept.append(raw.strip())
            current["skill_dirs"] = kept

    atomic_write_json(SETTINGS_FILE, current)
    return current
