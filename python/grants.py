"""Persistent Allow-always permission grants for the VS Code bridge."""

from __future__ import annotations

import fnmatch
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from paths import GRANTS_FILE, WORKSPACE, atomic_write_json, read_json, workspace_rel

Scope = Literal["read", "write"]


@dataclass
class PermissionGrant:
    path_pattern: str
    scope: str
    tool: str = "*"
    granted_at: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _norm_pattern(pattern: str) -> str:
    """Normalize a grant pattern to a workspace-relative POSIX path when possible."""
    text = (pattern or "").strip().replace("\\", "/")
    if not text:
        return ""  # tool-only grant
    if text == "*":
        return "*"
    # Glob patterns stay as-is (matched against full relative paths only).
    if any(ch in text for ch in "*?[]"):
        return text
    return workspace_rel(text) or text


def _candidate_paths(file_path: str) -> set[str]:
    """Full-path candidates for matching — never basename alone."""
    out: set[str] = {file_path.replace("\\", "/")}
    rel = workspace_rel(file_path)
    if rel:
        out.add(rel)
    try:
        p = Path(file_path)
        resolved = p.resolve() if p.is_absolute() else (WORKSPACE / p).resolve()
        out.add(str(resolved).replace("\\", "/"))
    except OSError:
        pass
    return out


class GrantStore:
    def list(self) -> list[PermissionGrant]:
        raw = read_json(GRANTS_FILE, [])
        out: list[PermissionGrant] = []
        if not isinstance(raw, list):
            return out
        for r in raw:
            if isinstance(r, dict) and r.get("path_pattern") is not None:
                pat = str(r.get("path_pattern") or "")
                tool = str(r.get("tool") or "*")
                # Refuse supply-chain wildcards (committed path=* tool=* grants).
                if pat.strip() == "*" and tool.strip() in ("*", ""):
                    continue
                out.append(
                    PermissionGrant(
                        path_pattern=pat,
                        scope=str(r.get("scope") or "write"),
                        tool=tool,
                        granted_at=str(r.get("granted_at") or ""),
                    )
                )
        return out

    def _save(self, grants: list[PermissionGrant]) -> None:
        atomic_write_json(GRANTS_FILE, [asdict(g) for g in grants])

    def add(self, *, path_pattern: str, scope: str = "write", tool: str = "*") -> PermissionGrant:
        pat = _norm_pattern(path_pattern) if path_pattern else ""
        tool_name = (tool or "").strip() or "*"
        if pat == "*" and tool_name == "*":
            raise ValueError("refusing open-ended path=* tool=* grant")
        g = PermissionGrant(
            path_pattern=pat,
            scope=scope,
            tool=tool_name,
            granted_at=_now(),
        )
        grants = self.list()
        grants.append(g)
        self._save(grants)
        return g

    def match(self, file_path: str | None, *, tool: str, scope: str = "write") -> bool:
        if not file_path:
            # tool-only grants (empty path or explicit tool sentinel)
            for g in self.list():
                if g.scope != scope:
                    continue
                if g.tool not in ("*", tool):
                    continue
                if g.path_pattern in ("", tool):
                    return True
            return False
        candidates = _candidate_paths(file_path)
        for g in self.list():
            if g.scope != scope:
                continue
            if g.tool not in ("*", tool):
                continue
            pat = _norm_pattern(g.path_pattern) if g.path_pattern else ""
            if not pat or pat == "*":
                # path=* is too broad — never auto-match (use tool-only grants instead)
                continue
            # Full path match only — never basename-only (config.json ≠ every config.json).
            for cand in candidates:
                if cand == pat or fnmatch.fnmatch(cand, pat):
                    return True
        return False

    def clear(self) -> None:
        self._save([])
