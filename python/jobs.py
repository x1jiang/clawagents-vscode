"""Background job visibility for the VS Code chat.

A long command that outlives its foreground wait keeps running as a background
job, and the turn that started it usually ends before it finishes. Two things
then have to happen, or the result is lost:

* the *next* turn of that chat must still recognise the job as its own, so the
  agent gets told when it finished. The clawagents tool registry is rebuilt for
  every turn, so ownership has to be re-seeded from here.
* the user must be able to see that something is still running without asking
  the agent, which is what :func:`snapshot` feeds.

Job records live in the clawagents job manager, which is process-wide and
therefore lasts exactly as long as this sidecar. That is the right lifetime:
if the sidecar goes away the child processes are gone too, so there is nothing
to persist to disk and no risk of resurrecting ids that no longer resolve.
"""

from __future__ import annotations

import threading
from typing import Any

# chat_id -> job ids started by that chat. Chats are long-lived and jobs are
# not, so this stays small; entries are pruned as jobs leave the manager.
_lock = threading.RLock()
_by_chat: dict[str, set[str]] = {}
_UNATTRIBUTED = "_"


def _manager() -> Any | None:
    """The job manager clawagents actually starts background jobs on."""
    try:
        from clawagents.tools.background_task import create_background_task_tools

        for tool in create_background_task_tools():
            mgr = getattr(tool, "_manager", None)
            if mgr is not None:
                return mgr
    except Exception:  # noqa: BLE001 - visibility must never break a turn
        return None
    return None


def remember(chat_id: str | None, job_ids: "set[str] | list[str]") -> None:
    """Attribute jobs to a chat after a turn ends."""
    ids = {str(j).strip() for j in job_ids if str(j).strip()}
    if not ids:
        return
    with _lock:
        _by_chat.setdefault(chat_id or _UNATTRIBUTED, set()).update(ids)


def known_for(chat_id: str | None) -> set[str]:
    """Job ids a chat has started, restricted to ones the manager still knows.

    Filtering here keeps a rebuilt registry from claiming ownership of ids that
    no longer resolve, which would make every completion check a lookup miss.
    """
    with _lock:
        ids = set(_by_chat.get(chat_id or _UNATTRIBUTED, ()))
    if not ids:
        return set()
    mgr = _manager()
    if mgr is None:
        return set()
    live = {str(getattr(job, "id", "")) for job in _live_jobs(mgr)}
    stale = ids - live
    if stale:
        with _lock:
            tracked = _by_chat.get(chat_id or _UNATTRIBUTED)
            if tracked is not None:
                tracked -= stale
                if not tracked:
                    _by_chat.pop(chat_id or _UNATTRIBUTED, None)
    return ids & live


def _live_jobs(mgr: Any) -> list[Any]:
    try:
        return list(mgr.list())
    except Exception:  # noqa: BLE001
        return []


def _chat_for(job_id: str) -> str | None:
    with _lock:
        for chat_id, ids in _by_chat.items():
            if job_id in ids:
                return None if chat_id == _UNATTRIBUTED else chat_id
    return None


def _summary(job: Any) -> dict[str, Any]:
    # Prefer the command as typed. argv is the sandbox/session wrapper -- a cd,
    # the real command, then trailers that echo cwd and env back -- which is
    # unreadable in a one-line row. Jobs started outside `execute` carry no
    # label, so keep unwrapping the plain `sh -c` shape for those.
    display = str(getattr(job, "label", "") or "")
    if not display:
        argv = list(getattr(job, "command", None) or [])
        display = (
            argv[2]
            if len(argv) >= 3 and argv[0].endswith(("sh", "cmd.exe"))
            else " ".join(argv)
        )
    started = float(getattr(job, "started_at", 0.0) or 0.0)
    ended = getattr(job, "ended_at", None)
    import time as _time

    elapsed = (float(ended) if ended else _time.time()) - started if started else 0.0
    job_id = str(getattr(job, "id", ""))
    return {
        "job_id": job_id,
        "chat_id": _chat_for(job_id),
        "command": display[:300],
        "cwd": getattr(job, "cwd", None),
        "pid": getattr(job, "pid", None),
        "running": bool(getattr(job, "running", False)),
        "exit_code": getattr(job, "exit_code", None),
        "cancelled": bool(getattr(job, "cancelled", False)),
        "elapsed_ms": int(max(0.0, elapsed) * 1000),
        "started_at": started or None,
        "ended_at": float(ended) if ended else None,
    }


def snapshot(chat_id: str | None = None) -> dict[str, Any]:
    """Job list for the UI, newest first, plus a running count for the header."""
    mgr = _manager()
    jobs = [_summary(job) for job in _live_jobs(mgr)] if mgr is not None else []
    if chat_id:
        jobs = [j for j in jobs if j["chat_id"] in (chat_id, None)]
    jobs.sort(key=lambda j: j.get("started_at") or 0.0, reverse=True)
    return {
        "jobs": jobs,
        "running": sum(1 for j in jobs if j["running"]),
    }


def output(job_id: str, *, max_chars: int = 20_000) -> dict[str, Any]:
    """stdout/stderr tails for one job, for the "show me" affordance."""
    mgr = _manager()
    if mgr is None:
        raise KeyError("background jobs unavailable")
    job = mgr.status(job_id)  # raises KeyError for unknown ids

    def _tail(text: Any) -> str:
        body = str(text or "")
        return body if len(body) <= max_chars else body[-max_chars:]

    payload = _summary(job)
    payload["stdout"] = _tail(getattr(job, "stdout", ""))
    payload["stderr"] = _tail(getattr(job, "stderr", ""))
    payload["truncated"] = len(str(getattr(job, "stdout", "") or "")) > max_chars
    return payload


async def stop(job_id: str) -> dict[str, Any]:
    """Cancel a job on the user's behalf (SIGTERM then SIGKILL)."""
    mgr = _manager()
    if mgr is None:
        raise KeyError("background jobs unavailable")
    return _summary(await mgr.cancel(job_id))


def attach_registry(registry: Any, chat_id: str | None) -> None:
    """Re-seed a freshly built registry with the chat's outstanding jobs."""
    ids = known_for(chat_id)
    if not ids:
        return
    adopt = getattr(registry, "adopt_owned_jobs", None)
    if callable(adopt):
        try:
            adopt(ids)
        except Exception:  # noqa: BLE001
            pass


def harvest_registry(registry: Any, chat_id: str | None) -> None:
    """Record jobs a finished turn started, so the next turn inherits them."""
    getter = getattr(registry, "owned_job_ids", None)
    if not callable(getter):
        return
    try:
        remember(chat_id, getter())
    except Exception:  # noqa: BLE001
        pass


def reset_for_tests() -> None:
    with _lock:
        _by_chat.clear()
