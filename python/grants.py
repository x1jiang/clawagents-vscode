"""Persistent Allow-always permission grants for the VS Code bridge."""

from __future__ import annotations

import fnmatch
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Literal

from paths import GRANTS_FILE, atomic_write_json, read_json

Scope = Literal["read", "write"]


@dataclass
class PermissionGrant:
    path_pattern: str
    scope: str
    tool: str = "*"
    granted_at: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class GrantStore:
    def list(self) -> list[PermissionGrant]:
        raw = read_json(GRANTS_FILE, [])
        out: list[PermissionGrant] = []
        if not isinstance(raw, list):
            return out
        for r in raw:
            if isinstance(r, dict) and r.get("path_pattern"):
                out.append(
                    PermissionGrant(
                        path_pattern=str(r["path_pattern"]),
                        scope=str(r.get("scope") or "write"),
                        tool=str(r.get("tool") or "*"),
                        granted_at=str(r.get("granted_at") or ""),
                    )
                )
        return out

    def _save(self, grants: list[PermissionGrant]) -> None:
        atomic_write_json(GRANTS_FILE, [asdict(g) for g in grants])

    def add(self, *, path_pattern: str, scope: str = "write", tool: str = "*") -> PermissionGrant:
        g = PermissionGrant(
            path_pattern=path_pattern,
            scope=scope,
            tool=tool,
            granted_at=_now(),
        )
        grants = self.list()
        grants.append(g)
        self._save(grants)
        return g

    def match(self, file_path: str | None, *, tool: str, scope: str = "write") -> bool:
        if not file_path:
            # tool-only grants
            for g in self.list():
                if g.scope != scope:
                    continue
                if g.tool in ("*", tool) and g.path_pattern in ("*", tool, ""):
                    return True
            return False
        for g in self.list():
            if g.scope != scope:
                continue
            if g.tool not in ("*", tool):
                continue
            if g.path_pattern == "*" or fnmatch.fnmatch(file_path, g.path_pattern):
                return True
            # also match basename patterns (PurePath handles Windows separators)
            if fnmatch.fnmatch(PurePath(file_path).name, g.path_pattern):
                return True
        return False

    def clear(self) -> None:
        self._save([])
