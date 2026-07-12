"""Snapshot listing and restore helpers."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from paths import (
    SNAPSHOTS_DIR,
    SESSIONS_MEMORY_DIR,
    WORKSPACE,
    chat_ui_log_path,
    ensure_dirs,
    path_under,
    safe_id,
)


def list_snapshots(limit: int = 50) -> list[dict[str, Any]]:
    ensure_dirs()
    if not SNAPSHOTS_DIR.exists():
        return []
    dirs = sorted(
        [p for p in SNAPSHOTS_DIR.iterdir() if p.is_dir()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    out: list[dict[str, Any]] = []
    for d in dirs[:limit]:
        base = d.resolve()
        files: list[str] = []
        for f in d.rglob("*"):
            if not f.is_file():
                continue
            try:
                f.resolve().relative_to(base)
            except (OSError, ValueError):
                continue
            files.append(str(f.relative_to(d)))
        out.append(
            {
                "id": d.name,
                "path": str(d),
                "mtime": d.stat().st_mtime,
                "files": files[:100],
            }
        )
    return out


def snapshot_file_path(snapshot_id: str, rel: str) -> Path | None:
    sid = safe_id(snapshot_id, kind="snapshot_id")
    base = path_under(SNAPSHOTS_DIR, sid)
    if base is None or not base.is_dir():
        return None
    if not rel or rel.startswith(("/", "\\")) or ".." in Path(rel).parts:
        return None
    target = path_under(base, rel)
    if target is None or not target.is_file():
        return None
    return target


def restore_file(snapshot_id: str, rel: str, dest_rel: str | None = None) -> dict[str, Any]:
    src = snapshot_file_path(snapshot_id, rel)
    if not src:
        raise FileNotFoundError(f"snapshot file not found: {snapshot_id}/{rel}")
    out_rel = dest_rel or rel
    if not out_rel or out_rel.startswith(("/", "\\")) or ".." in Path(out_rel).parts:
        raise ValueError("invalid restore destination")
    dest = path_under(WORKSPACE, out_rel)
    if dest is None:
        raise ValueError("restore destination escapes workspace")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return {"ok": True, "restored": str(dest.relative_to(WORKSPACE.resolve()))}


def latest_snapshot_for(rel_or_abs: str) -> dict[str, Any] | None:
    """Find the newest snapshot that contains this workspace-relative path."""
    rel = rel_or_abs
    try:
        p = Path(rel_or_abs)
        if p.is_absolute():
            rel = str(p.resolve().relative_to(WORKSPACE.resolve()))
    except Exception:  # noqa: BLE001
        pass
    base = Path(rel).name
    # Prefer exact relative path; fall back to basename for legacy flat snaps.
    def _matches(f: str) -> bool:
        return f == rel or f.endswith(f"/{rel}") or f == base or Path(f).name == base

    for snap in list_snapshots(limit=100):
        match = next((f for f in snap["files"] if _matches(f)), None)
        if match:
            return {"snapshot_id": snap["id"], "rel": match, "path": snap["path"]}
    return None


def list_shadow_checkpoints(limit: int = 30) -> list[dict[str, Any]]:
    try:
        from clawagents.memory.shadow_checkpoint import list_checkpoints

        return list_checkpoints(workspace=str(WORKSPACE), limit=limit)
    except Exception as exc:  # noqa: BLE001
        return [{"error": str(exc)}]


def restore_shadow_checkpoint(
    sha: str,
    *,
    mode: str = "files",
    chat_id: str | None = None,
) -> dict[str, Any]:
    try:
        from clawagents.memory.shadow_checkpoint import restore_checkpoint

        session_path = None
        ui_path = None
        if chat_id:
            session_path = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
            try:
                ui_path = chat_ui_log_path(chat_id)
            except Exception:  # noqa: BLE001
                ui_path = None
        mode_norm = mode if mode in ("files", "conversation", "both") else "files"
        return restore_checkpoint(
            sha,
            workspace=str(WORKSPACE),
            mode=mode_norm,  # type: ignore[arg-type]
            session_path=session_path,
            chat_ui_path=ui_path,
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def shadow_checkpoint_diff(lhs: str, rhs: str | None = None) -> dict[str, Any]:
    try:
        from clawagents.memory.shadow_checkpoint import checkpoint_diff

        return checkpoint_diff(lhs, rhs, workspace=str(WORKSPACE))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "files": []}
