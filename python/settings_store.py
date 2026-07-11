"""App settings persisted under .clawagents/vscode_settings.json."""

from __future__ import annotations

import os
from typing import Any

from paths import SETTINGS_FILE, atomic_write_json, read_json

DEFAULTS: dict[str, Any] = {
    "model": "",
    "provider": "auto",
    "base_url": "",
    "default_mode": "auto",
    "telemetry": False,
    "trajectory": False,
    "learn": False,
    "browser_tools": False,
    "mcp_enabled": True,
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
    atomic_write_json(SETTINGS_FILE, current)
    return current
