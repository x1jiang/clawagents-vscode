"""Chat metadata + UI event log + multi-turn agent runner."""

from __future__ import annotations

import json
import inspect
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from grants import GrantStore
from paths import (
    CHATS_DIR,
    MODEL,
    SESSIONS_MEMORY_DIR,
    WORKSPACE,
    atomic_write_json,
    chat_meta_path,
    chat_ui_log_path,
    ensure_dirs,
    now_ts,
    read_json,
    read_project_instructions,
)
from settings_store import load_settings
from pricing import estimate_usd

OnEvent = Callable[[str, dict[str, Any]], None]

# Providers that map 1:1 to a clawagents builtin profile. Selecting one in
# settings (without an explicit model) routes model+key resolution through
# that profile instead of the ambient PROVIDER/env defaults.
_PROFILE_PROVIDERS = frozenset({"openai", "gemini", "anthropic", "ollama"})

# os.chdir is process-global: serialize agent turns so concurrent streams
# cannot interleave workspace switches or clobber each other's cwd.
_turn_lock = threading.Lock()


def _title_from_text(text: str) -> str:
    line = (text or "").strip().splitlines()[0] if text else "New chat"
    line = re.sub(r"\s+", " ", line)[:60]
    return line or "New chat"


def list_chats() -> list[dict[str, Any]]:
    ensure_dirs()
    chats: list[dict[str, Any]] = []
    for path in CHATS_DIR.glob("*.json"):
        meta = read_json(path, None)
        if isinstance(meta, dict) and meta.get("id"):
            chats.append(meta)
    chats.sort(key=lambda c: float(c.get("updated_at") or 0), reverse=True)
    return chats


def get_chat(chat_id: str) -> dict[str, Any] | None:
    try:
        path = chat_meta_path(chat_id)
    except ValueError:
        return None
    meta = read_json(path, None)
    if not isinstance(meta, dict):
        return None
    return _ensure_session_cost(meta)


def _ensure_session_cost(meta: dict[str, Any]) -> dict[str, Any]:
    """Backfill session_cost_usd from UI done-events when missing (pre-0.4.6 chats)."""
    if "session_cost_usd" in meta and meta.get("session_cost_usd") is not None:
        return meta
    chat_id = str(meta.get("id") or "")
    if not chat_id:
        return meta
    settings = load_settings()
    model_id = str(settings.get("model") or MODEL or "")
    cost = 0.0
    prompt_n = 0
    completion_n = 0
    for ev in read_ui_events(chat_id):
        if ev.get("kind") != "done":
            continue
        usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
        p = int(usage.get("prompt_tokens") or 0)
        c = int(usage.get("completion_tokens") or 0)
        prompt_n += p
        completion_n += c
        run = estimate_usd(model_id, prompt_tokens=p, completion_tokens=c)
        if run:
            cost += float(run)
    meta = dict(meta)
    meta["session_cost_usd"] = cost
    meta["session_prompt_tokens"] = prompt_n
    meta["session_completion_tokens"] = completion_n
    meta["session_total_tokens"] = prompt_n + completion_n
    try:
        atomic_write_json(chat_meta_path(chat_id), meta)
    except OSError:
        pass
    return meta


def create_chat(
    *,
    chat_id: str | None = None,
    title: str | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    ensure_dirs()
    chat_id = chat_id or f"chat_{uuid.uuid4().hex[:12]}"
    # Validate early so callers get a clear error for injected ids.
    from paths import safe_id

    safe_id(chat_id, kind="chat_id")
    ts = now_ts()
    meta = {
        "id": chat_id,
        "title": title or "New chat",
        "mode": mode,
        "created_at": ts,
        "updated_at": ts,
        "message_count": 0,
        "session_cost_usd": 0.0,
        "session_prompt_tokens": 0,
        "session_completion_tokens": 0,
        "session_total_tokens": 0,
    }
    atomic_write_json(chat_meta_path(chat_id), meta)
    return meta


def patch_chat(chat_id: str, **fields: Any) -> dict[str, Any]:
    meta = get_chat(chat_id)
    if not meta:
        raise KeyError(chat_id)
    meta.update({k: v for k, v in fields.items() if v is not None})
    meta["updated_at"] = now_ts()
    atomic_write_json(chat_meta_path(chat_id), meta)
    return meta


def delete_chat(chat_id: str) -> None:
    try:
        chat_meta_path(chat_id).unlink(missing_ok=True)
        chat_ui_log_path(chat_id).unlink(missing_ok=True)
    except ValueError:
        return
    mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    try:
        # Only unlink memory if chat_id is a safe id (same rules as paths).
        from paths import safe_id

        safe_id(chat_id, kind="chat_id")
        mem.unlink(missing_ok=True)
    except ValueError:
        return


def append_ui_event(chat_id: str, event: dict[str, Any]) -> None:
    ensure_dirs()
    path = chat_ui_log_path(chat_id)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": now_ts(), **event}, default=str) + "\n")


def read_ui_events(chat_id: str) -> list[dict[str, Any]]:
    try:
        path = chat_ui_log_path(chat_id)
    except ValueError:
        return []
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def search_chats(query: str) -> list[dict[str, Any]]:
    q = query.lower().strip()
    if not q:
        return list_chats()
    hits: list[dict[str, Any]] = []
    for meta in list_chats():
        blob = (meta.get("title") or "").lower()
        if q in blob:
            hits.append(meta)
            continue
        for ev in read_ui_events(str(meta["id"])):
            text = str(ev.get("text") or ev.get("content") or "")
            if q in text.lower():
                hits.append(meta)
                break
    return hits


def truncate_after_last_user(chat_id: str) -> None:
    """Remove the last user turn and everything after it (for regenerate).

    Truncates both the UI event log and the agent's session memory so the
    regenerated turn does not see the previous answer in its context.
    """
    events = read_ui_events(chat_id)
    last_user = -1
    for i, ev in enumerate(events):
        if ev.get("kind") == "user":
            last_user = i
    if last_user >= 0:
        kept = events[:last_user]
        path = chat_ui_log_path(chat_id)
        with path.open("w", encoding="utf-8") as f:
            for ev in kept:
                f.write(json.dumps(ev, default=str) + "\n")
    _truncate_session_after_last_user(chat_id)


def _truncate_session_after_last_user(chat_id: str) -> None:
    """Drop the last user message and everything after it from session memory."""
    mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    if not mem.exists():
        return
    lines = [ln for ln in mem.read_text(encoding="utf-8").splitlines() if ln.strip()]
    last_user = -1
    for i, ln in enumerate(lines):
        try:
            if json.loads(ln).get("role") == "user":
                last_user = i
        except json.JSONDecodeError:
            continue
    if last_user < 0:
        return
    kept = lines[:last_user]
    mem.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")


def _decide_by_mode(mode: str, file_path: str | None) -> str | None:
    if mode == "read_only":
        return "deny"
    if mode == "full_access":
        return "allow_once"
    if mode == "auto" and file_path:
        try:
            resolved = Path(file_path).resolve()
            root = WORKSPACE.resolve()
            if resolved == root or root in resolved.parents:
                return "allow_once"
        except OSError:
            pass
    return None


def build_augmented_task(chat_id: str, content: str, settings: dict[str, Any]) -> str:
    """Augment the first user turn with workspace system prompt only.

    Project rules (CLAUDE.md / AGENTS.md / .clawagents/rules) are injected
    every LLM round via clawagents memory/rules — do not also wrap them into
    the user task (that caused double-injection and fade-after-compact).
    """
    mem_path = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    is_first = not mem_path.exists() or mem_path.stat().st_size == 0
    if not is_first:
        return content
    ws = (settings.get("workspace_system_prompt") or "").strip()
    if not ws:
        return content
    return f"<workspace_system_prompt>\n{ws}\n</workspace_system_prompt>\n\n{content}"


async def compact_chat(chat_id: str) -> dict[str, Any]:
    """Manually compact session memory: backup + keep head/tail with a stub summary."""
    import time

    ensure_dirs()
    mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    if not mem.exists():
        return {"compacted": False, "reason": "no session memory"}
    lines = [ln for ln in mem.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if len(lines) < 8:
        return {"compacted": False, "reason": "not enough history to compact"}
    backup = mem.with_suffix(mem.suffix + f".before-compact-{int(time.time())}")
    backup.write_text(mem.read_text(encoding="utf-8"), encoding="utf-8")
    head = lines[:2]
    tail = lines[-4:]
    summary = {
        "role": "user",
        "content": (
            "[Compacted conversation] Older turns were summarized away. "
            f"Dropped {len(lines) - len(head) - len(tail)} messages. "
            "Continue from the recent context below."
        ),
    }
    kept = head + [json.dumps(summary)] + tail
    mem.write_text("\n".join(kept) + "\n", encoding="utf-8")
    append_ui_event(
        chat_id,
        {
            "kind": "status",
            "text": f"Compacted session ({len(lines)} → {len(kept)} messages)",
        },
    )
    return {
        "compacted": True,
        "before": len(lines),
        "after": len(kept),
        "backup": backup.name,
    }


def _resolve_model_kwargs(model: str | None, settings: dict[str, Any]) -> dict[str, Any]:
    """Translate settings (model / provider / base_url) into agent kwargs."""
    kwargs: dict[str, Any] = {}
    effective_model = model or settings.get("model") or MODEL
    if effective_model:
        kwargs["model"] = effective_model
    base_url = (settings.get("base_url") or "").strip() or None
    if base_url:
        from url_trust import is_trusted_base_url

        if is_trusted_base_url(base_url) or settings.get("trust_custom_base_url"):
            kwargs["base_url"] = base_url
        # else: drop untrusted URL (do not send API keys to attacker host)
    provider = str(settings.get("provider") or "auto")
    if provider.startswith("profile:"):
        kwargs["profile"] = provider.split(":", 1)[1]
    elif provider in _PROFILE_PROVIDERS and not effective_model:
        # No explicit model: route default model/key selection through the
        # builtin profile so the provider choice actually takes effect.
        kwargs["profile"] = provider
    return kwargs


CAVEMAN_INSTRUCTION = """\
Caveman mode ON. Respond terse like smart caveman. All technical substance stay. Only fluff die.
Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging.
Fragments OK. Short synonyms. Technical terms exact. Code blocks unchanged. Errors quoted exact.
Pattern: [thing] [action] [reason]. [next step].
"""


async def run_chat_turn(
    *,
    chat_id: str,
    content: str,
    mode: str,
    model: str | None,
    on_event: OnEvent,
    before_tool_factory: Callable[..., Any],
    cancel_check: Callable[[], bool],
    ask_user_factory: Callable[[], Any] | None = None,
    caveman: bool = False,
) -> dict[str, Any]:
    """Run one multi-turn-aware agent invoke. Called from a worker thread's event loop."""
    from clawagents.agent import create_claw_agent
    from clawagents.session.backends import JsonlFileSession

    ensure_dirs()
    settings = load_settings()

    meta = get_chat(chat_id) or create_chat(
        chat_id=chat_id, title=_title_from_text(content), mode=mode
    )
    if meta.get("title") in (None, "", "New chat"):
        patch_chat(chat_id, title=_title_from_text(content), mode=mode)
    else:
        patch_chat(chat_id, mode=mode)

    append_ui_event(chat_id, {"kind": "user", "text": content})

    augmented = build_augmented_task(chat_id, content, settings)
    session = JsonlFileSession(chat_id, dir_path=SESSIONS_MEMORY_DIR)

    kwargs: dict[str, Any] = {"streaming": True}
    kwargs.update(_resolve_model_kwargs(model, settings))
    instructions: list[str] = []
    if mode == "ask":
        instructions.append(
            "You are in ask mode. Prefer explaining and proposing changes "
            "over writing files or running shell commands unless explicitly asked."
        )
    if caveman:
        instructions.append(CAVEMAN_INSTRUCTION)
    if settings.get("trajectory"):
        kwargs["trajectory"] = True
    if settings.get("learn"):
        kwargs["learn"] = True

    # Skills: registered folders (+ optional workspace auto-discover).
    # Passing an explicit list disables create_claw_agent's own auto-discover
    # and avoids picking up an app's ./skills when dogfooding ClawAgents.
    from skills_catalog import resolve_skill_dir_paths

    kwargs["skills"] = resolve_skill_dir_paths(settings)
    exclude = {
        n.strip()
        for n in (settings.get("skill_exclude") or [])
        if isinstance(n, str) and n.strip()
    }
    # ByteRover / OpenViking use cloud providers — always exclude.
    exclude.add("byterover")
    exclude.add("openviking")
    # skills_exclude requires a newer clawagents; older installs ignore excludes
    # rather than crashing the whole turn.
    _agent_params = inspect.signature(create_claw_agent).parameters
    if "skills_exclude" in _agent_params:
        kwargs["skills_exclude"] = sorted(exclude)
    elif exclude:
        # Best-effort: drop excluded skill folder names from the skills path list.
        kwargs["skills"] = [
            p
            for p in (kwargs.get("skills") or [])
            if Path(p).name not in exclude
        ]

    # MCP (user-configured servers from mcp.json + built-in Context Mode)
    mcp_servers: list[Any] = []
    if settings.get("mcp_enabled", False):
        try:
            from mcp_loader import load_mcp_servers

            mcp_servers.extend(
                load_mcp_servers(
                    trust_workspace=bool(settings.get("mcp_trust_workspace", False)),
                )
            )
        except Exception:  # noqa: BLE001
            pass
    if settings.get("context_mode", True):
        try:
            from mcp_loader import (
                CONTEXT_MODE_ROUTING_INSTRUCTION,
                create_context_mode_server,
            )

            already = any(
                getattr(s, "name", "") == "context-mode" for s in mcp_servers
            )
            ctx_server = None if already else create_context_mode_server()
            if ctx_server is not None:
                mcp_servers.append(ctx_server)
            if already or ctx_server is not None:
                instructions.append(CONTEXT_MODE_ROUTING_INSTRUCTION)
        except Exception:  # noqa: BLE001
            pass
    if mcp_servers:
        kwargs["mcp_servers"] = mcp_servers
    if instructions:
        kwargs["instruction"] = "\n\n".join(instructions)

    # Custom persona modes from .clawagents/modes.json (library builtins + workspace)
    agent_mode = str(settings.get("agent_mode") or "").strip()
    if agent_mode and "mode" in _agent_params:
        kwargs["mode"] = agent_mode
    action_mode = str(settings.get("action_mode") or "tools").strip()
    if action_mode == "code" and "action_mode" in _agent_params:
        kwargs["action_mode"] = "code"

    # Browser tools
    if settings.get("browser_tools"):
        try:
            from clawagents.browser import create_browser_tools

            kwargs.setdefault("tools", [])
            kwargs["tools"] = list(kwargs["tools"]) + list(create_browser_tools())
        except Exception:  # noqa: BLE001
            pass

    # ── Event forwarding ────────────────────────────────────────────────
    # The typed stream (on_stream_event) is the authoritative channel for
    # UI-visible events: it is the only one that carries assistant deltas,
    # per-turn assistant messages, tool args/output with call ids, and
    # per-request usage. The legacy on_event channel is forwarded only for
    # operational kinds (warn / error / checkpoint / compact_progress /
    # context / approval_required) that the webview needs.
    saw_assistant = False
    usage_totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def _session_message_count() -> int:
        mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
        if not mem.exists():
            return 0
        return sum(1 for ln in mem.read_text(encoding="utf-8").splitlines() if ln.strip())

    def _forward_legacy(kind: str, data: dict[str, Any]) -> None:
        if kind == "checkpoint":
            payload = dict(data or {})
            payload.setdefault("chat_id", chat_id)
            payload.setdefault("message_count", _session_message_count())
            # Best-effort: re-bind metadata on the library index for conversation restore.
            try:
                from clawagents.memory.shadow_checkpoint import bind_checkpoint_meta

                sha = str(payload.get("sha") or "")
                if sha:
                    bind_checkpoint_meta(
                        sha,
                        workspace=str(WORKSPACE),
                        tool=str(payload.get("tool") or "") or None,
                        message_count=int(payload.get("message_count") or 0),
                        session_path=SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl",
                        chat_ui_path=chat_ui_log_path(chat_id),
                        label=str(payload.get("label") or "") or None,
                        phase=str(payload.get("phase") or "") or None,
                    )
            except Exception:  # noqa: BLE001
                pass
            on_event("checkpoint", payload)
            return
        if kind in {
            "compact_progress",
            "context",
            "approval_required",
            "warn",
            "error",
        }:
            on_event(kind, data or {})
            return

    def _on_stream_event(ev: Any) -> None:
        nonlocal saw_assistant
        if cancel_check():
            return
        kind = getattr(ev, "kind", "")
        if kind == "assistant_delta":
            delta = getattr(ev, "delta", "") or ""
            if delta:
                on_event("assistant_delta", {"delta": delta})
        elif kind == "assistant_message":
            text = str(getattr(ev, "content", "") or "")
            if text.strip():
                saw_assistant = True
                append_ui_event(chat_id, {"kind": "assistant", "text": text})
                on_event("assistant_message", {"content": text})
        elif kind == "tool_started":
            on_event(
                "tool_started",
                {
                    "name": getattr(ev, "tool_name", "") or "tool",
                    "call_id": getattr(ev, "call_id", "") or "",
                    "args": getattr(ev, "args", None) or {},
                },
            )
        elif kind == "tool_result":
            out = getattr(ev, "output", "") or ""
            err = getattr(ev, "error", None)
            on_event(
                "tool_completed",
                {
                    "name": getattr(ev, "tool_name", "") or "tool",
                    "call_id": getattr(ev, "call_id", "") or "",
                    "success": bool(getattr(ev, "success", True)),
                    # Empty output + non-empty error is common for blocked
                    # commands; surface the error so the webview isn't blank.
                    "output": out if str(out).strip() else (err or ""),
                    "error": err,
                },
            )
        elif kind == "usage":
            usage_totals["prompt_tokens"] += int(getattr(ev, "input_tokens", 0) or 0)
            usage_totals["completion_tokens"] += int(getattr(ev, "output_tokens", 0) or 0)
            usage_totals["total_tokens"] += int(getattr(ev, "total_tokens", 0) or 0)
            on_event("usage", dict(usage_totals))

    def _on_legacy_event(kind: str, data: dict[str, Any] | None = None) -> None:
        if cancel_check():
            return
        # tool_skipped has no typed equivalent; without forwarding it, a
        # Plan-mode / permission denial leaves the UI with no tool card
        # update (or a stuck "running" card if tool_call was shown).
        if kind in ("warn", "error", "tool_skipped"):
            on_event(kind, data or {})
            return
        _forward_legacy(kind, data or {})

    with _turn_lock:
        # Capture cwd *inside* the lock: with concurrent turns, capturing it
        # outside could snapshot another turn's WORKSPACE chdir and "restore"
        # to the wrong directory afterwards.
        prev = os.getcwd()
        try:
            os.chdir(WORKSPACE)
            # Drop kwargs unsupported by the installed clawagents version
            # (PyPI lag vs extension features).
            allowed = set(inspect.signature(create_claw_agent).parameters)
            agent = create_claw_agent(**{k: v for k, v in kwargs.items() if k in allowed})
            agent.before_tool = before_tool_factory(mode=mode, grants=GrantStore())
            if ask_user_factory is not None:
                # Sidecar has no stdin — replace CLI ask_user with webview HITL.
                agent.tools.register(ask_user_factory())

            result = await agent.invoke(
                augmented,
                on_event=_on_legacy_event,
                on_stream_event=_on_stream_event,
                session=session,
                features={"session_persistence": True, "file_snapshots": True},
            )
        finally:
            try:
                os.chdir(prev)
            except OSError:
                pass

    status = getattr(result, "status", "done")
    iterations = getattr(result, "iterations", 0)
    out = getattr(result, "result", "")
    out_text = out if isinstance(out, str) else str(out)

    usage = getattr(result, "usage", None)
    usage_payload: dict[str, Any] = {}
    if usage is not None:
        usage_payload = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None)
            or getattr(usage, "input_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None)
            or getattr(usage, "output_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None)
            or getattr(usage, "tokens_used", None),
        }
        on_event("usage", usage_payload)

    # Prefer turn-accumulated totals (all LLM calls this run) over the last
    # response's usage blob when both exist.
    prompt_n = int(usage_totals.get("prompt_tokens") or usage_payload.get("prompt_tokens") or 0)
    completion_n = int(
        usage_totals.get("completion_tokens") or usage_payload.get("completion_tokens") or 0
    )
    total_n = int(
        usage_totals.get("total_tokens")
        or usage_payload.get("total_tokens")
        or (prompt_n + completion_n)
    )
    usage_payload = {
        "prompt_tokens": prompt_n,
        "completion_tokens": completion_n,
        "total_tokens": total_n,
    }
    model_id = str(kwargs.get("model") or settings.get("model") or MODEL or "")
    run_cost = estimate_usd(
        model_id, prompt_tokens=prompt_n, completion_tokens=completion_n
    )
    run_cost_f = float(run_cost) if run_cost is not None else 0.0

    latest = get_chat(chat_id) or meta
    session_cost = float(latest.get("session_cost_usd") or 0.0) + run_cost_f
    session_prompt = int(latest.get("session_prompt_tokens") or 0) + prompt_n
    session_completion = int(latest.get("session_completion_tokens") or 0) + completion_n
    session_total = int(latest.get("session_total_tokens") or 0) + total_n
    usage_payload["run_cost_usd"] = run_cost_f
    usage_payload["session_cost_usd"] = session_cost
    usage_payload["session_prompt_tokens"] = session_prompt
    usage_payload["session_completion_tokens"] = session_completion
    usage_payload["session_total_tokens"] = session_total

    # Safety net: if the run produced a final answer but no assistant_message
    # event reached the stream (e.g. older runtime without typed emission),
    # surface it so the turn is never silently blank.
    if not saw_assistant and out_text.strip() and not cancel_check():
        append_ui_event(chat_id, {"kind": "assistant", "text": out_text})
        on_event("assistant_message", {"content": out_text})

    append_ui_event(
        chat_id,
        {
            "kind": "done",
            "status": status,
            "iterations": iterations,
            "result": out_text,
            "usage": usage_payload,
        },
    )
    patch_chat(
        chat_id,
        message_count=int(latest.get("message_count") or 0) + 1,
        updated_at=now_ts(),
        session_cost_usd=session_cost,
        session_prompt_tokens=session_prompt,
        session_completion_tokens=session_completion,
        session_total_tokens=session_total,
    )
    return {
        "status": status,
        "result": out_text,
        "iterations": iterations,
        "usage": usage_payload,
    }
