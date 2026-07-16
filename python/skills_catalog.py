"""Skill folder resolution + preview for the Settings UI."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import os
import threading
from pathlib import Path
from typing import Any

from paths import WORKSPACE, under_workspace
from settings_store import load_settings

_AUTO_NAMES = ("skills", ".skills", "skill", ".skill", "Skills")
# Personal skill libraries used by ClawAgents / Codex / Claude Code / agents.
# Loaded when skill_user_homes is true (default) so cohort/workflow skills
# under e.g. ~/.codex/skills are available without manual registration.
# Ordered lowest→highest precedence (later dirs win name collisions in
# SkillStore); ClawAgents' own home wins over other agents' libraries.
_USER_SKILL_HOMES = (
    "~/.codex/skills",
    "~/.claude/skills",
    "~/.agents/skills",
    "~/.clawagents/skills",
)

_ScanResult = tuple[list[dict[str, Any]], dict[str, str], list[str], dict[str, str]]
_scan_cache_lock = threading.RLock()
_scan_cache: dict[tuple[str, ...], tuple[str, _ScanResult]] = {}
# path -> (mtime_ns, ctime_ns, size, sha256). Digests are recalculated only
# when cheap metadata changes; ctime also catches content rewrites that restore
# the original mtime. Unchanged refreshes avoid reparsing every skill body.
_skill_file_digests: dict[str, tuple[int, int, int, str]] = {}


def clear_skill_catalog_cache() -> None:
    """Drop reusable snapshots (primarily for tests and explicit refreshes)."""
    with _scan_cache_lock:
        _scan_cache.clear()
        _skill_file_digests.clear()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _catalog_fingerprint(dirs: list[str]) -> str:
    """Build an incremental mtime/content snapshot of candidate skill files."""
    catalog = hashlib.sha256()
    seen: set[str] = set()
    for raw in dirs:
        root = Path(raw).resolve()
        catalog.update(f"root\0{root}\0".encode("utf-8", "surrogatepass"))
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames.sort()
            for filename in sorted(filenames):
                if not filename.lower().endswith(".md"):
                    continue
                path = Path(dirpath) / filename
                key = str(path.resolve())
                try:
                    stat = path.stat()
                except OSError:
                    continue
                seen.add(key)
                cached = _skill_file_digests.get(key)
                metadata = (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
                if cached and cached[:3] == metadata:
                    file_digest = cached[3]
                else:
                    try:
                        file_digest = _hash_file(path)
                    except OSError:
                        continue
                    _skill_file_digests[key] = (
                        stat.st_mtime_ns,
                        stat.st_ctime_ns,
                        stat.st_size,
                        file_digest,
                    )
                catalog.update(key.encode("utf-8", "surrogatepass"))
                catalog.update(b"\0")
                catalog.update(file_digest.encode("ascii"))
                catalog.update(b"\0")

    stale = [path for path in _skill_file_digests if path not in seen]
    for path in stale:
        _skill_file_digests.pop(path, None)
    return catalog.hexdigest()


def _norm(raw: str, *, require_under_workspace: bool = False) -> Path | None:
    text = (raw or "").strip()
    if not text:
        return None
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = (WORKSPACE / path).resolve()
    else:
        path = path.resolve()
    if not path.is_dir():
        return None
    # Auto-discovered roots must stay under the workspace after symlink resolve.
    if require_under_workspace and not under_workspace(path):
        return None
    return path


def _ignore_set(settings: dict[str, Any]) -> set[str]:
    out: set[str] = set()
    for raw in settings.get("skill_ignore_dirs") or []:
        if not isinstance(raw, str):
            continue
        p = _norm(raw)
        if p is not None:
            out.add(str(p))
    return out


def resolve_skill_dirs(settings: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return skill roots with origin metadata (registered | auto)."""
    settings = settings if settings is not None else load_settings()
    ignore = _ignore_set(settings)
    allow_external = bool(settings.get("allow_external_skill_dirs", False))
    seen: set[str] = set()
    entries: list[dict[str, Any]] = []

    def _add(raw: str, origin: str, *, require_under_workspace: bool = False) -> None:
        path = _norm(raw, require_under_workspace=require_under_workspace)
        if path is None:
            return
        if origin == "registered" and not allow_external and not under_workspace(path):
            return
        key = str(path)
        if key in seen or key in ignore:
            return
        seen.add(key)
        entries.append({"path": key, "origin": origin})

    for raw in settings.get("skill_dirs") or []:
        if isinstance(raw, str):
            # User-registered folders may live outside the workspace only when
            # allow_external_skill_dirs is on.
            _add(raw, "registered")

    # Always allow these known personal skill homes (not workspace-scoped).
    if settings.get("skill_user_homes", True):
        for home in _USER_SKILL_HOMES:
            path = _norm(home)
            if path is None:
                continue
            key = str(path)
            if key in seen or key in ignore:
                continue
            seen.add(key)
            entries.append({"path": key, "origin": "user_home"})

    if settings.get("skill_auto_discover", True):
        for name in _AUTO_NAMES:
            _add(str(WORKSPACE / name), "auto", require_under_workspace=True)

    return entries


def resolve_skill_dir_paths(settings: dict[str, Any] | None = None) -> list[str]:
    return [e["path"] for e in resolve_skill_dirs(settings)]


def _scan_skills(
    dirs: list[str],
) -> tuple[list[dict[str, Any]], dict[str, str], list[str], dict[str, str]]:
    """Load skills from dirs via SkillStore (same rules as the agent).

    Returns (skills, ineligible name→reason, loader warnings,
    quarantined name→reason). The trailing fields are empty on older
    clawagents installs that don't expose them.
    """
    if not dirs:
        return [], {}, [], {}
    cache_key = tuple(str(Path(d).resolve()) for d in dirs)
    with _scan_cache_lock:
        fingerprint = _catalog_fingerprint(dirs)
        cached = _scan_cache.get(cache_key)
        if cached and cached[0] == fingerprint:
            return copy.deepcopy(cached[1])
    try:
        from clawagents.tools.skills import SkillStore
    except Exception:  # noqa: BLE001
        return [], {}, [], {}

    store = SkillStore()
    for d in dirs:
        store.add_directory(d)

    try:
        try:
            asyncio.get_running_loop()
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor() as pool:
                pool.submit(asyncio.run, store.load_all()).result()
        except RuntimeError:
            asyncio.run(store.load_all())
    except Exception:  # noqa: BLE001
        return [], {}, [], {}

    ineligible = dict(getattr(store, "ineligible", {}) or {})
    warnings = list(getattr(store, "warnings", []) or [])
    quarantined = dict(getattr(store, "quarantined", {}) or {})

    # Map skill path → owning root dir for UI badges
    root_paths = [Path(d).resolve() for d in dirs]
    out: list[dict[str, Any]] = []
    for skill in store.list():
        skill_path = str(getattr(skill, "path", "") or "")
        source_dir = ""
        try:
            sp = Path(skill_path).resolve()
            for root in root_paths:
                try:
                    sp.relative_to(root)
                    source_dir = str(root)
                    break
                except ValueError:
                    continue
            if not source_dir and sp.parent.is_dir():
                source_dir = str(sp.parent)
        except OSError:
            source_dir = ""
        out.append(
            {
                "name": skill.name,
                "description": (skill.description or "").strip(),
                "when_to_use": (getattr(skill, "when_to_use", "") or "").strip(),
                "paths": [
                    str(p).strip()
                    for p in (getattr(skill, "paths", None) or [])
                    if str(p).strip()
                ],
                "path": skill_path,
                "source_dir": source_dir,
            }
        )
    out.sort(key=lambda s: s["name"].lower())
    result: _ScanResult = (out, ineligible, warnings, quarantined)
    with _scan_cache_lock:
        _scan_cache[cache_key] = (fingerprint, copy.deepcopy(result))
    return result


def preview_skills(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """Full Settings preview: folders, detected skills, excludes/ignores."""
    settings = settings if settings is not None else load_settings()
    folders = resolve_skill_dirs(settings)
    dir_paths = [f["path"] for f in folders]

    # Include bundled skills in the preview so the list matches runtime.
    # Bundled goes FIRST (lowest precedence) to mirror create_claw_agent.
    try:
        from clawagents.agent import _get_bundled_skills_dir

        bundled = _get_bundled_skills_dir()
        if bundled and Path(bundled).is_dir() and bundled not in dir_paths:
            folders.insert(0, {"path": bundled, "origin": "bundled"})
            dir_paths.insert(0, bundled)
    except Exception:  # noqa: BLE001
        pass

    skills, ineligible, warnings, quarantined = _scan_skills(dir_paths)
    exclude = [
        n for n in (settings.get("skill_exclude") or []) if isinstance(n, str) and n.strip()
    ]
    exclude_set = set(exclude)
    for s in skills:
        s["excluded"] = s["name"] in exclude_set

    # Ignored auto dirs (for restore UI)
    ignored: list[str] = []
    for raw in settings.get("skill_ignore_dirs") or []:
        if isinstance(raw, str) and raw.strip():
            p = _norm(raw)
            ignored.append(str(p) if p else raw.strip())

    return {
        "folders": folders,
        "skills": skills,
        "excluded": exclude,
        "ignored_dirs": ignored,
        "auto_discover": bool(settings.get("skill_auto_discover", True)),
        # name → why the skill can't run here (missing binary/env/OS).
        "unavailable": ineligible,
        # name → why the skill was blocked by the content scanner
        # (invisible-Unicode / remote-exec); not loaded into the catalog.
        "quarantined": quarantined,
        # Loader diagnostics (spec violations, oversized/skipped files).
        "warnings": warnings,
    }
