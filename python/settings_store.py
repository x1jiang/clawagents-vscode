"""App settings persisted under .clawagents/vscode_settings.json."""

from __future__ import annotations

import logging
import os
import json
import threading
from typing import Any

from paths import SETTINGS_FILE, atomic_write_json, read_json, under_workspace, workspace_rel
from url_trust import is_trusted_base_url

logger = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "model": "",
    "provider": "auto",
    "base_url": "",
    "default_mode": "auto",
    "telemetry": False,
    "trajectory": False,
    "learn": False,
    # ATLAS failure-taxonomy supervision (built-in; on by default).
    "atlas": True,
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
    # Load ~/.codex/skills, ~/.claude/skills, ~/.agents/skills automatically.
    "skill_user_homes": True,
    # Set by the extension after the user confirms a non-localhost base_url.
    "trust_custom_base_url": False,
    # Native Amazon Bedrock (IAM). Empty base_url → AsyncAnthropicBedrock / Converse.
    "aws_region": "",
    "aws_profile": "",
    # OpenAI reasoning effort (none|low|medium|high|xhigh). Empty = provider default.
    "reasoning_effort": "medium",
    # OpenAI transport for compatible endpoints: auto | responses | chat_completions.
    "wire_api": "auto",
    # TLS verify for custom base_url (False for private-CA / corporate proxies).
    "ssl_verify": True,
    # Library agent mode override (empty = use chat mode from the client).
    "agent_mode": "",
    # tools (default) | code — forwarded when the installed clawagents supports it.
    "action_mode": "tools",
}

KNOWN_KEYS: frozenset[str] = frozenset(DEFAULTS)

# These values are approvals, not preferences.  Keeping them in the workspace
# settings file lets a cloned repository approve its own gateway, MCP commands,
# or elevated filesystem access.  They therefore live only in this process and
# are restored by the extension from VS Code SecretStorage at sidecar startup.
RUNTIME_ONLY_KEYS: frozenset[str] = frozenset(
    {
        "trust_custom_base_url",
        "mcp_trust_workspace",
        "allow_full_access",
        "allow_external_skill_dirs",
    }
)
PERSISTED_KEYS: frozenset[str] = KNOWN_KEYS - RUNTIME_ONLY_KEYS
_runtime_trust_lock = threading.RLock()
_runtime_trust: dict[str, Any] = {
    "trusted_custom_base_url": "",
    "mcp_trust_workspace": False,
    "allow_full_access": False,
    "allow_external_skill_dirs": False,
}


def _normalize_base_url(raw: Any) -> str:
    return str(raw or "").strip().rstrip("/")


def set_runtime_trust(
    patch: dict[str, Any] | None,
    *,
    base_url: str | None = None,
) -> None:
    """Update authenticated, process-local approvals.

    ``trusted_custom_base_url`` is bound to the exact approved endpoint.  A
    repository cannot swap ``base_url`` after approval and inherit that grant.
    """
    if not isinstance(patch, dict):
        return
    with _runtime_trust_lock:
        if "trusted_custom_base_url" in patch:
            _runtime_trust["trusted_custom_base_url"] = _normalize_base_url(
                patch.get("trusted_custom_base_url")
            )
        if "trust_custom_base_url" in patch:
            if bool(patch.get("trust_custom_base_url")):
                _runtime_trust["trusted_custom_base_url"] = _normalize_base_url(base_url)
            elif not _normalize_base_url(base_url):
                # Explicit clear only when base_url is empty. A mismatched /
                # untrusted committed URL must not wipe a prior URL-bound grant.
                _runtime_trust["trusted_custom_base_url"] = ""
        for key in RUNTIME_ONLY_KEYS - {"trust_custom_base_url"}:
            if key in patch:
                _runtime_trust[key] = bool(patch.get(key))


def runtime_trust_snapshot() -> dict[str, Any]:
    with _runtime_trust_lock:
        return dict(_runtime_trust)


def _restore_runtime_trust_from_env() -> None:
    raw = os.environ.get("CLAW_RUNTIME_TRUST", "").strip()
    if not raw:
        return
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("ignored invalid CLAW_RUNTIME_TRUST payload")
        return
    set_runtime_trust(value if isinstance(value, dict) else None)


_restore_runtime_trust_from_env()


def sanitize_patch(patch: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    """Keep only known settings keys; return (clean_patch, dropped_keys)."""
    if not isinstance(patch, dict):
        return {}, []
    clean: dict[str, Any] = {}
    dropped: list[str] = []
    for key, value in patch.items():
        if key in KNOWN_KEYS:
            clean[key] = value
        elif not str(key).startswith("_"):
            dropped.append(str(key))
    return clean, dropped


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
    # Only known keys — prevents schema drift / unknown junk from sticking.
    merged.update({k: v for k, v in data.items() if k in PERSISTED_KEYS})
    trust = runtime_trust_snapshot()
    base_url = _normalize_base_url(merged.get("base_url"))
    merged["trust_custom_base_url"] = bool(
        base_url
        and base_url == _normalize_base_url(trust.get("trusted_custom_base_url"))
    )
    for key in RUNTIME_ONLY_KEYS - {"trust_custom_base_url"}:
        merged[key] = bool(trust.get(key, False))
    return merged


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    clean, dropped = sanitize_patch(patch)
    if dropped:
        logger.warning("settings patch dropped unknown keys: %s", ", ".join(sorted(dropped)))

    current = load_settings()
    effective_base_url = str(clean.get("base_url", current.get("base_url", "")) or "")
    set_runtime_trust(clean, base_url=effective_base_url)
    current = load_settings()
    current.update({k: v for k, v in clean.items() if k in PERSISTED_KEYS})
    trust = runtime_trust_snapshot()
    current["trust_custom_base_url"] = bool(
        _normalize_base_url(current.get("base_url"))
        and _normalize_base_url(current.get("base_url"))
        == _normalize_base_url(trust.get("trusted_custom_base_url"))
    )

    base_url = str(current.get("base_url") or "").strip()
    if base_url and not is_trusted_base_url(base_url):
        if not current.get("trust_custom_base_url"):
            # Refuse to persist an untrusted remote endpoint without explicit trust.
            current["base_url"] = ""
            clean = {**clean, "base_url": ""}
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

    # Persist preferences only. Security approvals remain in process memory and
    # are restored from VS Code SecretStorage on the next sidecar start.
    to_write = {k: current[k] for k in DEFAULTS if k in PERSISTED_KEYS}
    atomic_write_json(SETTINGS_FILE, to_write)
    return load_settings()
