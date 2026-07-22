"""Chat metadata + UI event log + multi-turn agent runner."""

from __future__ import annotations

import json
import inspect
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable

from caveman_prompt import CAVEMAN_INSTRUCTION
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
_PROFILE_PROVIDERS = frozenset({"openai", "gemini", "anthropic", "ollama", "bedrock"})


def _bedrock_api_key(*, mantle: bool = False) -> str:
    """Gateway / Mantle token for OpenAI-compatible Bedrock proxies.

    Mantle must not fall back to ``OPENAI_API_KEY`` — that yields
    ``invalid bearer token`` (401) against bedrock-mantle hosts.
    BAG / LiteLLM still allows OpenAI-key fallback (common local setup).
    """
    try:
        from spawn_secrets import get_secret

        key = get_secret("BEDROCK_API_KEY") or get_secret("MANTLE_API_KEY")
        if key:
            return key
        if not mantle:
            return get_secret("OPENAI_API_KEY") or "bedrock"
        return "bedrock"
    except Exception:  # noqa: BLE001
        key = (
            (os.environ.get("BEDROCK_API_KEY") or "").strip()
            or (os.environ.get("MANTLE_API_KEY") or "").strip()
        )
        if key:
            return key
        if not mantle:
            return (os.environ.get("OPENAI_API_KEY") or "").strip() or "bedrock"
        return "bedrock"


def _apply_aws_settings(settings: dict[str, Any], *, active: bool = True) -> None:
    """Push or clear region/profile in env for native Bedrock.

    When ``active`` is False (provider left Bedrock), clear keys this helper
    previously set so later subprocesses do not inherit stale AWS credentials.
    """
    if not active:
        for key in ("AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"):
            # Only drop values that match current settings — do not clobber a
            # user-exported shell profile unrelated to ClawAgents Settings.
            wanted = ""
            if key in ("AWS_REGION", "AWS_DEFAULT_REGION"):
                wanted = str(settings.get("aws_region") or "").strip()
            elif key == "AWS_PROFILE":
                wanted = str(settings.get("aws_profile") or "").strip()
            if wanted and os.environ.get(key) == wanted:
                os.environ.pop(key, None)
        return
    region = str(settings.get("aws_region") or "").strip()
    if region:
        os.environ["AWS_REGION"] = region
        os.environ.setdefault("AWS_DEFAULT_REGION", region)
    profile = str(settings.get("aws_profile") or "").strip()
    if profile:
        os.environ["AWS_PROFILE"] = profile
    elif "AWS_PROFILE" in os.environ and not profile:
        # Settings cleared the profile — drop the process override.
        os.environ.pop("AWS_PROFILE", None)


# Host appends editor snippets under this marker (see webviewProvider.runTask).
_EDITOR_CONTEXT_MARK = "\n\n---\nEditor context:\n"


def display_user_text(content: str) -> str:
    """User-visible text only — strip auto-injected editor context from the bubble."""
    text = content or ""
    idx = text.find(_EDITOR_CONTEXT_MARK)
    if idx >= 0:
        return text[:idx].rstrip()
    return text


def _title_from_text(text: str) -> str:
    visible = display_user_text(text)
    line = visible.strip().splitlines()[0] if visible else "New chat"
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
        cached = int(
            usage.get("cached_input_tokens")
            or usage.get("cache_read_tokens")
            or 0
        )
        created = int(usage.get("cache_creation_tokens") or 0)
        prompt_n += p
        completion_n += c
        run = estimate_usd(
            model_id,
            prompt_tokens=p,
            completion_tokens=c,
            cached_input_tokens=cached,
            cache_creation_tokens=created,
        )
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


def _cleanup_fork_artifacts(chat_id: str) -> None:
    """Best-effort remove partial fork files after a failed copy."""
    try:
        chat_ui_log_path(chat_id).unlink(missing_ok=True)
    except (ValueError, OSError):
        pass
    try:
        from paths import safe_id

        safe_id(chat_id, kind="chat_id")
        (SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl").unlink(missing_ok=True)
    except (ValueError, OSError):
        pass
    try:
        chat_meta_path(chat_id).unlink(missing_ok=True)
    except (ValueError, OSError):
        pass


def fork_chat(source_chat_id: str, *, title: str | None = None) -> dict[str, Any]:
    """Fork an existing conversation into a new chat with copied history and session memory.

    Raises ``RuntimeError`` if a source history/memory file exists but cannot be
    copied — never returns success with a missing history that still advertises
    the source ``message_count``.
    """
    source_meta = get_chat(source_chat_id)
    if not source_meta:
        raise KeyError(source_chat_id)

    new_chat_id = f"chat_{uuid.uuid4().hex[:12]}"
    from paths import safe_id

    safe_id(new_chat_id, kind="chat_id")

    ts = now_ts()
    base_title = str(source_meta.get("title") or "Chat").strip()
    if title:
        fork_title = title
    elif base_title.startswith("[Forked] "):
        fork_title = base_title
    elif base_title.endswith(" (Fork)"):
        fork_title = f"[Forked] {base_title[:-7]}"
    else:
        fork_title = f"[Forked] {base_title}"

    new_meta = dict(source_meta)
    new_meta["id"] = new_chat_id
    new_meta["title"] = fork_title
    new_meta["created_at"] = ts
    new_meta["updated_at"] = ts

    try:
        src_ui_log = chat_ui_log_path(source_chat_id)
        if src_ui_log.exists():
            shutil.copy2(src_ui_log, chat_ui_log_path(new_chat_id))
        elif int(new_meta.get("message_count") or 0) > 0:
            # Meta claimed history but the UI log is missing — don't advertise it.
            new_meta["message_count"] = 0

        src_mem = SESSIONS_MEMORY_DIR / f"{source_chat_id}.jsonl"
        if src_mem.exists():
            from paths import safe_id as _safe_id

            _safe_id(source_chat_id, kind="chat_id")
            shutil.copy2(src_mem, SESSIONS_MEMORY_DIR / f"{new_chat_id}.jsonl")
    except (ValueError, OSError) as e:
        _cleanup_fork_artifacts(new_chat_id)
        raise RuntimeError(f"Failed to copy chat data while forking: {e}") from e

    atomic_write_json(chat_meta_path(new_chat_id), new_meta)
    return new_meta


def append_ui_event(chat_id: str, event: dict[str, Any]) -> None:
    ensure_dirs()
    path = chat_ui_log_path(chat_id)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": now_ts(), **event}, default=str) + "\n")


def read_ui_events(
    chat_id: str,
    *,
    offset: int | None = None,
    limit: int | None = None,
    tail: int | None = None,
) -> list[dict[str, Any]]:
    """Load UI log events, optionally windowed.

    ``tail=N`` returns the last N events (preferred for chat restore).
    ``offset``/``limit`` page from the start (0-based). Without windowing,
    returns the full log (used by truncate/regenerate).
    """
    try:
        path = chat_ui_log_path(chat_id)
    except ValueError:
        return []
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    if tail is not None and tail >= 0:
        return events[-tail:] if tail else []
    if offset is not None or limit is not None:
        start = max(0, int(offset or 0))
        if limit is None:
            return events[start:]
        end = start + max(0, int(limit))
        return events[start:end]
    return events


def count_ui_events(chat_id: str) -> int:
    """Count JSONL lines without building the event list."""
    try:
        path = chat_ui_log_path(chat_id)
    except ValueError:
        return 0
    if not path.exists():
        return 0
    n = 0
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
    except OSError:
        return 0
    return n


DEFAULT_UI_EVENTS_TAIL = 400


def read_ui_events_page(
    chat_id: str,
    *,
    tail: int = DEFAULT_UI_EVENTS_TAIL,
    before: int | None = None,
) -> dict[str, Any]:
    """Paginated UI log for chat restore / load-older.

    - Default: last ``tail`` events.
    - ``before``: exclusive end index into the full log (load older page ending
      just before that index).
    """
    total = count_ui_events(chat_id)
    page_size = max(1, min(int(tail), 2000))
    if before is None:
        start = max(0, total - page_size)
        events = read_ui_events(chat_id, offset=start, limit=page_size)
        return {
            "events": events,
            "total": total,
            "offset": start,
            "has_more": start > 0,
        }
    end = max(0, min(int(before), total))
    start = max(0, end - page_size)
    events = read_ui_events(chat_id, offset=start, limit=end - start)
    return {
        "events": events,
        "total": total,
        "offset": start,
        "has_more": start > 0,
    }


def _ui_log_contains(chat_id: str, needle: str, *, max_bytes: int = 512_000) -> bool:
    """Stream-scan a chat UI log for ``needle`` without loading the whole file."""
    try:
        path = chat_ui_log_path(chat_id)
    except ValueError:
        return False
    if not path.exists():
        return False
    needle_l = needle.lower()
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            read = 0
            for line in f:
                read += len(line.encode("utf-8", errors="replace"))
                if read > max_bytes:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    if needle_l in line.lower():
                        return True
                    continue
                text = str(ev.get("text") or ev.get("content") or "")
                if needle_l in text.lower():
                    return True
    except OSError:
        return False
    return False


def search_chats(
    query: str,
    *,
    max_chats: int = 200,
    max_hits: int = 50,
) -> list[dict[str, Any]]:
    q = query.lower().strip()
    if not q:
        return list_chats()[:max_hits]
    hits: list[dict[str, Any]] = []
    for meta in list_chats()[: max(1, max_chats)]:
        blob = (meta.get("title") or "").lower()
        if q in blob or _ui_log_contains(str(meta["id"]), q):
            hits.append(meta)
        if len(hits) >= max(1, max_hits):
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


def truncate_to_prompt_index(
    chat_id: str,
    prompt_index: int,
    *,
    user_text: str = "",
    message_count: int | None = None,
) -> dict[str, Any]:
    """Truncate UI + session memory to a rewind snapshot conversation marker."""
    events = read_ui_events(chat_id)
    target_user = (user_text or "").strip()
    kept_events: list[dict[str, Any]] = []
    if target_user:
        for i, ev in enumerate(events):
            if ev.get("kind") == "user" and display_user_text(
                str(ev.get("text") or "")
            ).strip() == display_user_text(target_user).strip():
                kept_events = events[: i + 1]
                break
    if not kept_events and message_count is not None and message_count > 0:
        user_seen = 0
        for i, ev in enumerate(events):
            if ev.get("kind") == "user":
                user_seen += 1
            if user_seen >= message_count:
                kept_events = events[: i + 1]
                break
    if kept_events:
        path = chat_ui_log_path(chat_id)
        with path.open("w", encoding="utf-8") as f:
            for ev in kept_events:
                f.write(json.dumps(ev, default=str) + "\n")
    _truncate_session_to_message_count(chat_id, message_count, user_text=target_user)
    return {
        "ok": True,
        "chat_id": chat_id,
        "prompt_index": prompt_index,
        "kept_events": len(kept_events),
    }


def _truncate_session_to_message_count(
    chat_id: str,
    message_count: int | None,
    *,
    user_text: str = "",
) -> None:
    """Drop session memory after rewind snapshot message_count / user_text."""
    mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    if not mem.exists():
        return
    lines = [ln for ln in mem.read_text(encoding="utf-8").splitlines() if ln.strip()]
    kept: list[str] = []
    target_user = (user_text or "").strip()
    if target_user:
        for i, ln in enumerate(lines):
            try:
                row = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if row.get("role") == "user" and display_user_text(
                str(row.get("content") or "")
            ).strip() == display_user_text(target_user).strip():
                kept = lines[: i + 1]
                break
    elif message_count is not None and message_count > 0:
        kept = lines[:message_count]
    if kept:
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
    """Manually compact session memory so the next turn starts lighter.

    The context meter shows *last LLM prompt tokens*, not session line count.
    A prior bug always rewrote history to 7 lines (head2+stub+tail4) and then
    refused further clicks with ``len(lines) < 8`` — so Compact looked broken
    right after a successful compact while the meter still showed 100%.

    Strategy:
    1. If there is room to drop turns → keep head/tail + summary stub (or LLM).
    2. Else if remaining turns are still fat → truncate oversized tool/user
       payloads in place (this is what frees context after a Goal blow-up).
    3. Only skip when both turn count and payload size are already small.
    """
    import time

    ensure_dirs()
    mem = SESSIONS_MEMORY_DIR / f"{chat_id}.jsonl"
    if not mem.exists():
        return {"compacted": False, "reason": "no session memory"}

    raw = mem.read_text(encoding="utf-8")
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if not lines:
        return {"compacted": False, "reason": "no session memory"}

    keep_head = 2
    keep_tail = 4
    min_keep = keep_head + keep_tail
    total_chars = sum(len(ln) for ln in lines)
    # ~4 chars/token rough estimate used elsewhere in clawagents.
    est_tokens_before = max(1, total_chars // 4)

    parsed: list[dict[str, Any]] = []
    for ln in lines:
        try:
            obj = json.loads(ln)
            if isinstance(obj, dict):
                parsed.append(obj)
            else:
                parsed.append({"role": "user", "content": str(obj)})
        except json.JSONDecodeError:
            parsed.append({"role": "user", "content": ln})

    def _msg_chars(m: dict[str, Any]) -> int:
        c = m.get("content")
        n = len(c) if isinstance(c, str) else len(json.dumps(c, ensure_ascii=False))
        meta = m.get("tool_calls_meta")
        if meta:
            n += len(json.dumps(meta, ensure_ascii=False))
        return n

    def _trim_message(m: dict[str, Any], *, max_content: int) -> dict[str, Any]:
        out = dict(m)
        c = out.get("content")
        if isinstance(c, str) and len(c) > max_content:
            out["content"] = (
                c[:max_content]
                + f"\n…[compact truncated {len(c) - max_content} chars]"
            )
        meta = out.get("tool_calls_meta")
        if isinstance(meta, list):
            trimmed_meta = []
            for tc in meta:
                if not isinstance(tc, dict):
                    trimmed_meta.append(tc)
                    continue
                tc2 = dict(tc)
                args = tc2.get("arguments")
                if isinstance(args, str) and len(args) > max_content:
                    tc2["arguments"] = args[:max_content] + "…"
                elif isinstance(args, dict):
                    dumped = json.dumps(args, ensure_ascii=False)
                    if len(dumped) > max_content:
                        tc2["arguments"] = dumped[:max_content] + "…"
                trimmed_meta.append(tc2)
            out["tool_calls_meta"] = trimmed_meta
        return out

    can_drop_turns = len(parsed) > min_keep
    # Fat payloads even with few turns (Goal tool dumps) still need compact.
    needs_payload_trim = total_chars > 12_000 or any(
        _msg_chars(m) > 4_000 for m in parsed
    )

    if not can_drop_turns and not needs_payload_trim:
        return {
            "compacted": False,
            "reason": (
                "not enough history to compact "
                f"({len(parsed)} messages, ~{est_tokens_before} tokens). "
                "Context % is from the last model call — start a new turn or "
                "New chat to reset the meter."
            ),
            "before": len(parsed),
            "est_tokens_before": est_tokens_before,
        }

    backup = mem.with_suffix(mem.suffix + f".before-compact-{int(time.time())}")
    backup.write_text(raw, encoding="utf-8")

    summary_text = ""
    compact_usage: dict[str, Any] = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cached_input_tokens": 0,
        "cache_creation_tokens": 0,
        "model": "",
    }
    settings = load_settings()
    model = (settings.get("model") or MODEL or "").strip()
    if can_drop_turns and model and model.lower() not in ("default",):
        # Best-effort LLM summary (desktop-style); fall back to stub on failure.
        try:
            from clawagents.config.config import load_config
            from clawagents.providers.llm import LLMMessage, create_provider

            convo_bits: list[str] = []
            for m in parsed:
                role = str(m.get("role") or "unknown")
                if role == "system":
                    continue
                content = m.get("content")
                text = content if isinstance(content, str) else json.dumps(content)
                if not text:
                    continue
                convo_bits.append(f"[{role}] {text[:2000]}")
            transcript = "\n\n".join(convo_bits)
            if len(transcript) > 60_000:
                transcript = (
                    transcript[:30_000] + "\n\n[…middle elided…]\n\n" + transcript[-30_000:]
                )
            prompt = (
                "Summarise this agent session so a fresh turn can continue. "
                "Preserve open tasks, decisions, file paths, and constraints. "
                "Drop chit-chat and verbose tool output. 8–15 short bullets.\n\n"
                f"=== CONVERSATION ===\n{transcript}\n=== END ==="
            )
            provider = create_provider(model, load_config())
            resp = await provider.chat(
                messages=[LLMMessage(role="user", content=prompt)],
                tools=None,
            )
            summary_text = (resp.content or "").strip()
            compact_usage = {
                "prompt_tokens": int(
                    getattr(resp, "prompt_tokens", 0)
                    or getattr(resp, "input_tokens", 0)
                    or 0
                ),
                "completion_tokens": int(
                    getattr(resp, "completion_tokens", 0)
                    or getattr(resp, "output_tokens", 0)
                    or 0
                ),
                "cached_input_tokens": int(
                    getattr(resp, "cache_read_tokens", 0)
                    or getattr(resp, "cached_input_tokens", 0)
                    or 0
                ),
                "cache_creation_tokens": int(
                    getattr(resp, "cache_creation_tokens", 0) or 0
                ),
                "model": str(getattr(resp, "model", None) or model),
            }
        except Exception:  # noqa: BLE001
            summary_text = ""

    if not summary_text:
        dropped = max(0, len(parsed) - min_keep) if can_drop_turns else 0
        summary_text = (
            "[Compacted conversation] Older turns were summarized away. "
            f"Dropped {dropped} messages "
            f"(~{est_tokens_before} tokens before compact). "
            "Continue from the recent context below."
        )

    if can_drop_turns:
        head = parsed[:keep_head]
        tail = parsed[-keep_tail:]
        # Trim fat tool dumps in the retained tail so compact actually frees context.
        tail = [_trim_message(m, max_content=2_500) for m in tail]
        kept_msgs = head + [{"role": "user", "content": summary_text}] + tail
    else:
        # Few turns but huge payloads — trim in place, keep every role.
        kept_msgs = [_trim_message(m, max_content=2_000) for m in parsed]
        kept_msgs.insert(
            min(1, len(kept_msgs)),
            {
                "role": "user",
                "content": (
                    "[Compacted conversation] Truncated oversized tool/user "
                    f"payloads (~{est_tokens_before} tokens before). "
                    "Continue from the trimmed context."
                ),
            },
        )

    kept_lines = [json.dumps(m, ensure_ascii=False) for m in kept_msgs]
    after_chars = sum(len(ln) for ln in kept_lines)
    est_tokens_after = max(1, after_chars // 4)

    def _charge_compact_usage() -> float | None:
        """Bill the summarizer call even when the rewrite is rejected."""
        try:
            cost = estimate_usd(
                str(compact_usage.get("model") or model),
                prompt_tokens=int(compact_usage.get("prompt_tokens") or 0),
                completion_tokens=int(compact_usage.get("completion_tokens") or 0),
                cached_input_tokens=int(compact_usage.get("cached_input_tokens") or 0),
                cache_creation_tokens=int(
                    compact_usage.get("cache_creation_tokens") or 0
                ),
                provider=str(settings.get("provider") or ""),
            )
        except Exception:  # noqa: BLE001
            return None
        if cost is None or cost <= 0:
            return cost
        latest = get_chat(chat_id) or {}
        prev = float(latest.get("session_cost_usd") or 0.0)
        patch_chat(
            chat_id,
            session_cost_usd=prev + float(cost),
            session_prompt_tokens=int(latest.get("session_prompt_tokens") or 0)
            + int(compact_usage.get("prompt_tokens") or 0),
            session_completion_tokens=int(latest.get("session_completion_tokens") or 0)
            + int(compact_usage.get("completion_tokens") or 0),
            session_total_tokens=int(latest.get("session_total_tokens") or 0)
            + int(compact_usage.get("prompt_tokens") or 0)
            + int(compact_usage.get("completion_tokens") or 0),
        )
        return cost

    # Never accept a "successful" compact that grows (or barely shrinks) stored
    # context — that resets the UI meter while leaving the session larger.
    saved = est_tokens_before - est_tokens_after
    min_save_tokens = 100
    min_save_ratio = 0.05
    if saved < min_save_tokens and saved < int(est_tokens_before * min_save_ratio):
        mem.write_text(raw, encoding="utf-8")  # restore pre-compact backup body
        try:
            backup.unlink(missing_ok=True)  # type: ignore[call-arg]
        except TypeError:
            if backup.exists():
                backup.unlink()
        except OSError:
            pass
        reject_cost = _charge_compact_usage()
        append_ui_event(
            chat_id,
            {
                "kind": "status",
                "text": (
                    f"Compact rejected — would not shrink "
                    f"(~{est_tokens_before} → ~{est_tokens_after} tokens). "
                    "Original session kept."
                    + (
                        f" · summarizer ~${reject_cost:.4f}"
                        if reject_cost is not None and reject_cost > 0
                        else ""
                    )
                ),
            },
        )
        return {
            "compacted": False,
            "reason": (
                f"compaction would not reduce tokens "
                f"(~{est_tokens_before} → ~{est_tokens_after}); kept original"
            ),
            "before": len(parsed),
            "after": len(parsed),
            "est_tokens_before": est_tokens_before,
            "est_tokens_after": est_tokens_before,
            "rejected_growth": True,
            "meter_reset": False,
            "usage": compact_usage,
            "compact_cost_usd": reject_cost,
        }

    mem.write_text("\n".join(kept_lines) + "\n", encoding="utf-8")
    compact_cost = _charge_compact_usage()

    append_ui_event(
        chat_id,
        {
            "kind": "status",
            "text": (
                f"Compacted session ({len(parsed)} → {len(kept_msgs)} messages, "
                f"~{est_tokens_before} → ~{est_tokens_after} tokens)"
                + (
                    f" · compact ~${compact_cost:.4f}"
                    if compact_cost is not None and compact_cost > 0
                    else ""
                )
            ),
        },
    )
    return {
        "compacted": True,
        "before": len(parsed),
        "after": len(kept_msgs),
        "est_tokens_before": est_tokens_before,
        "est_tokens_after": est_tokens_after,
        "backup": backup.name,
        "meter_reset": True,
        "usage": compact_usage,
        "compact_cost_usd": compact_cost,
    }


def _model_looks_bedrock(model: str | None) -> bool:
    """True when the model id is a Bedrock / Mantle catalog shape."""
    m = str(model or "").strip()
    if not m:
        return False
    try:
        from clawagents.config.config import is_bedrock_model_id

        return bool(is_bedrock_model_id(m))
    except Exception:  # noqa: BLE001
        lower = m.lower()
        if lower.startswith(("us.", "eu.", "apac.", "global.", "bedrock/")):
            return True
        return lower.startswith(
            ("anthropic.", "amazon.", "meta.", "openai.", "deepseek.", "qwen.")
        )


def _resolve_model_kwargs(model: str | None, settings: dict[str, Any]) -> dict[str, Any]:
    """Translate settings (model / provider / base_url) into agent kwargs."""
    kwargs: dict[str, Any] = {}
    effective_model = model or settings.get("model") or MODEL
    if effective_model:
        kwargs["model"] = effective_model
    provider = str(settings.get("provider") or "auto").strip().lower()
    base_url = (settings.get("base_url") or "").strip() or None
    mode = str(settings.get("bedrock_mode") or "iam").strip().lower()
    non_bedrock = provider in {"openai", "anthropic", "gemini", "ollama"}
    # Stale Mantle/BAG after Provider switch must not ride along.
    if base_url and non_bedrock:
        bag_like = (
            base_url.rstrip("/").endswith("/api/v1")
            and "bedrock-mantle." not in base_url
        )
        if "bedrock-mantle." in base_url:
            base_url = None
        elif provider in {"anthropic", "gemini"} and bag_like:
            base_url = None
    if base_url:
        from url_trust import is_trusted_base_url

        if is_trusted_base_url(base_url) or settings.get("trust_custom_base_url"):
            kwargs["base_url"] = base_url
        # else: drop untrusted URL (do not send API keys to attacker host)
    # provider=auto still needs Bedrock wiring when the selected model / mode /
    # base_url clearly target Mantle, BAG, or native Bedrock IDs.
    use_bedrock = provider == "bedrock" or (
        provider == "auto"
        and (
            mode in ("mantle", "bag")
            or (
                kwargs.get("base_url")
                and "bedrock-mantle." in str(kwargs.get("base_url") or "")
            )
            or _model_looks_bedrock(str(effective_model or ""))
        )
    )
    if provider.startswith("profile:"):
        kwargs["profile"] = provider.split(":", 1)[1]
        # Not Bedrock — drop AWS env this helper may have set earlier.
        _apply_aws_settings(settings, active=False)
    elif use_bedrock:
        _apply_aws_settings(settings, active=True)
        if mode == "mantle" and not kwargs.get("base_url"):
            region = str(settings.get("aws_region") or "").strip() or "us-east-1"
            kwargs["base_url"] = f"https://bedrock-mantle.{region}.api.aws/v1"
        if not effective_model:
            if mode == "mantle" or (
                kwargs.get("base_url")
                and "bedrock-mantle." in str(kwargs.get("base_url") or "")
            ):
                # Chat-completions-safe default (frontier GPT / Claude need
                # /openai/v1/responses or /anthropic/v1/messages — routed in
                # create_provider when those models are selected).
                kwargs["model"] = "openai.gpt-oss-20b"
            else:
                kwargs["model"] = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        if kwargs.get("base_url"):
            mantle_host = "bedrock-mantle." in str(kwargs.get("base_url") or "")
            # OpenAI-compatible gateway (Mantle / BAG / LiteLLM)
            kwargs["api_key"] = _bedrock_api_key(mantle=mantle_host)
            # Mantle is multi-path: only default wire_api for chat-ok models.
            # Claude → Anthropic Messages; openai.gpt-5.* → Responses.
            if mantle_host and not str(settings.get("wire_api") or "").strip():
                model_l = str(kwargs.get("model") or effective_model or "").lower()
                if model_l.startswith("anthropic.") or model_l.startswith("claude"):
                    pass  # Messages API; wire_api unused
                elif model_l.startswith("openai.") and "gpt-oss" not in model_l and any(
                    t in model_l for t in ("gpt-5.3", "gpt-5.4", "gpt-5.5", "gpt-5.6")
                ):
                    kwargs["wire_api"] = "responses"
                else:
                    kwargs["wire_api"] = "chat_completions"
        # else: native IAM — clawagents routes Bedrock model IDs via
        # AsyncAnthropicBedrock / Converse; do not force a gateway api_key.
    elif provider in _PROFILE_PROVIDERS and not effective_model:
        # No explicit model: route default model/key selection through the
        # builtin profile so the provider choice actually takes effect.
        kwargs["profile"] = provider
        _apply_aws_settings(settings, active=False)
    else:
        # Leaving Bedrock — clear process env this helper previously set.
        _apply_aws_settings(settings, active=False)

    # Always pass the host-injected key explicitly so workspace .env cannot
    # replace it mid-process via load_dotenv(override=True).
    if "api_key" not in kwargs:
        try:
            from spawn_secrets import resolve_api_key

            key = resolve_api_key(provider, str(effective_model or ""))
        except Exception:  # noqa: BLE001
            key = None
        if key:
            kwargs["api_key"] = key
        elif provider == "openai" and kwargs.get("base_url"):
            kwargs["api_key"] = "openai"

    effort = str(settings.get("reasoning_effort") or "").strip()
    if effort:
        kwargs["reasoning_effort"] = effort
    wire = str(settings.get("wire_api") or settings.get("openai_wire_api") or "").strip()
    if wire:
        kwargs["wire_api"] = wire
    if "ssl_verify" in settings:
        kwargs["ssl_verify"] = bool(settings.get("ssl_verify"))
    return kwargs


# Bound attachment payloads so a malformed/hostile request can't OOM the
# sidecar. The core resizes each image down further before sending.
_MAX_IMAGES_PER_TURN = 8
# The extension accepts 10 MiB decoded images; base64 expands by roughly 4/3.
# Keep this aligned so an image that gets a UI chip cannot be silently dropped.
_MAX_IMAGE_B64_BYTES = 14 * 1024 * 1024


def _normalize_images(images: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Validate + cap image attachments coming from the webview.

    Keeps at most _MAX_IMAGES_PER_TURN entries with a non-empty base64/data-URL
    ``data`` string under the size cap; each normalized to {data, media_type}.
    """
    if not images or not isinstance(images, list):
        return []
    out: list[dict[str, Any]] = []
    for item in images:
        if len(out) >= _MAX_IMAGES_PER_TURN:
            break
        if not isinstance(item, dict):
            continue
        data = item.get("data") or item.get("url") or ""
        if not isinstance(data, str) or not data.strip():
            continue
        if len(data) > _MAX_IMAGE_B64_BYTES:
            continue
        media_type = item.get("media_type") or item.get("mime_type") or "image/png"
        out.append({"data": data, "media_type": str(media_type)})
    return out


# File attachments (PDF/DOCX) are heavier than images — fewer per turn, but a
# slightly larger per-item cap (14MB b64 ≈ 10MB decoded, the core's own cap).
_MAX_FILES_PER_TURN = 4
_MAX_FILE_B64_BYTES = 14 * 1024 * 1024


def _safe_attachment_name(name: Any) -> str:
    """Reduce a client-supplied filename to a safe display basename."""
    base = str(name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(c for c in base if c >= " " and c != "\x7f").strip()
    return base[:120] or "attachment"


def _normalize_files(files: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Validate + cap file attachments coming from the webview.

    Keeps at most _MAX_FILES_PER_TURN entries with a non-empty base64/data-URL
    ``data`` string under the size cap; each normalized to
    {data, media_type, name}. Type policy (pdf/docx/other) lives in the core,
    which degrades unsupported types to a text note.
    """
    if not files or not isinstance(files, list):
        return []
    out: list[dict[str, Any]] = []
    for item in files:
        if len(out) >= _MAX_FILES_PER_TURN:
            break
        if not isinstance(item, dict):
            continue
        data = item.get("data") or item.get("url") or ""
        if not isinstance(data, str) or not data.strip():
            continue
        if len(data) > _MAX_FILE_B64_BYTES:
            continue
        media_type = (
            item.get("media_type") or item.get("mime_type") or "application/pdf"
        )
        out.append(
            {
                "data": data,
                "media_type": str(media_type),
                "name": _safe_attachment_name(item.get("name")),
            }
        )
    return out


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
    on_exit_plan_mode: Callable[..., Any] | None = None,
    caveman: bool = True,
    goal: bool = False,
    images: list[dict[str, Any]] | None = None,
    files: list[dict[str, Any]] | None = None,
    run_id: str | None = None,
    attach_run_context: Callable[[str, Any], None] | None = None,
) -> dict[str, Any]:
    """Run one multi-turn-aware agent invoke. Called from a worker thread's event loop."""
    from clawagents.agent import create_claw_agent
    from clawagents.run_context import RunContext
    from clawagents.session.backends import JsonlFileSession

    # Keys come from spawn_secrets via _resolve_model_kwargs(api_key=…);
    # sidecar also sets CLAWAGENTS_SKIP_DOTENV so clawagents won't reload .env.
    ensure_dirs()
    settings = load_settings()

    run_context = RunContext()
    run_context._metadata["workspace"] = str(WORKSPACE)
    if run_id and attach_run_context is not None:
        try:
            attach_run_context(run_id, run_context)
        except Exception:  # noqa: BLE001
            pass

    # Pre-flight: custom OpenAI-compatible gateway needs an explicit model id.
    provider = str(settings.get("provider") or "auto")
    base_url = str(settings.get("base_url") or "").strip()
    from url_trust import is_trusted_base_url

    trusted_custom = bool(
        base_url
        and not is_trusted_base_url(base_url)
        and settings.get("trust_custom_base_url")
    )
    effective_model = (model or settings.get("model") or "").strip()
    if effective_model.lower() in ("default",):
        effective_model = ""
    if (
        trusted_custom
        and provider in ("openai", "auto", "ollama")
        and not effective_model
    ):
        msg = (
            "Pick a model from the gateway list (header or Settings → Model). "
            f"Custom base URL is set ({base_url}) but model is empty/default."
        )
        on_event({"kind": "error", "text": msg})
        append_ui_event(chat_id, {"kind": "error", "text": msg})
        return {"ok": False, "error": msg}

    # Stale Settings: Provider=OpenAI (api.openai.com) but Model still an
    # Ollama local id (e.g. llama3.1) → opaque 404 from the API.
    _prov = provider.strip().lower()
    _ml = effective_model.lower()
    _ollama_local = bool(_ml) and not re.match(
        r"^(openai|anthropic|amazon|meta|deepseek|xai|zai|us|eu|apac|global)\.",
        _ml,
    ) and bool(
        re.match(
            r"^(llama|llava|qwen|mistral|mixtral|phi|deepseek|"
            r"codellama|gemma|nomic|tinyllama)",
            _ml,
        )
    )
    if _prov == "openai" and not base_url and _ollama_local:
        msg = (
            f"Model '{effective_model}' looks like an Ollama id, but Provider "
            "is OpenAI (api.openai.com). Pick an OpenAI model in Settings "
            "(e.g. gpt-5.6-luna), or switch Provider to Ollama."
        )
        on_event({"kind": "error", "text": msg})
        append_ui_event(chat_id, {"kind": "error", "text": msg})
        return {"ok": False, "error": msg}

    meta = get_chat(chat_id) or create_chat(
        chat_id=chat_id, title=_title_from_text(content), mode=mode
    )
    if meta.get("title") in (None, "", "New chat"):
        patch_chat(chat_id, title=_title_from_text(content), mode=mode)
    else:
        patch_chat(chat_id, mode=mode)

    # Chat history shows only what the user typed; full `content` (with optional
    # editor context) still goes to the agent below.
    append_ui_event(chat_id, {"kind": "user", "text": display_user_text(content)})

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
    # Cut tool-loop churn: named paths → read once → answer (Luna cost driver).
    instructions.append(
        "Tool efficiency: when the user names exact file paths, read those files "
        "directly (`read_file`) — do not grep/search to rediscover them. When they "
        "also name symbols, prefer scoped grep then one bounded read — do not page "
        "a large file sequentially. Once you have the requested facts, stop and "
        "answer; do not re-read the same range or load skills unless required. "
        "Use activate_tool_group for optional web/git/pty tools."
    )
    instructions.append(
        "Failure and credential discipline: classify a failed command before another "
        "tool attempt. Never source a workspace `.env`, echo credentials, interpolate "
        "passwords into shell command strings, or pass them as CLI arguments; use a "
        "literal env-file or a mode-0600 authentication file. If a remote client reports "
        "NT_STATUS_LOGON_FAILURE, authentication rejected, or access denied, the "
        "transport reached the service: stop changing clients/runtimes and report the "
        "exact response so the user can verify the domain-qualified username and rotate "
        "the credential. If a package is unavailable, do not hop package managers. "
        "After an apply_patch SEARCH miss, re-read the exact current span before retrying."
    )
    if caveman:
        instructions.append(CAVEMAN_INSTRUCTION)
    if goal:
        instructions.append(
            "You are in GOAL mode (Grok /goal-style autopilot). For any multi-step "
            "objective, call `start_goal` first to write a verifier contract, then "
            "work the plan and report via `update_goal`. Do not claim the goal is "
            "done until the verifier accepts."
        )
    else:
        # Leaving Goal (Act/Plan): pause any active disk-backed goal so the next
        # Goal turn does not immediately re-run a stale verifier contract, and so
        # Act turns cannot be hijacked by leftover `.clawagents/goal/state.json`.
        try:
            from clawagents.goal import GoalPauseReason, GoalTracker

            gt = GoalTracker(WORKSPACE)
            if gt.is_active():
                gt.pause(
                    GoalPauseReason.USER,
                    "Paused because UI is in Act/Plan (not Goal mode)",
                )
                on_event(
                    {
                        "kind": "status",
                        "text": "Paused active Goal — switch back to Goal to resume",
                    }
                )
        except Exception:  # noqa: BLE001
            pass
    if settings.get("trajectory"):
        kwargs["trajectory"] = True
    if settings.get("learn"):
        kwargs["learn"] = True

    # Capability probe once — older clawagents wheels omit newer kwargs.
    _agent_params = inspect.signature(create_claw_agent).parameters

    # Prefer workspace-scoped agent (no process chdir) when the library supports it.
    supports_workspace = "workspace" in _agent_params
    if supports_workspace:
        kwargs["workspace"] = str(WORKSPACE)

    # Goal autopilot — long-horizon completion path.
    if goal and "goal_mode" in _agent_params:
        kwargs["goal_mode"] = True

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
    if settings.get("graphify", False):
        try:
            from mcp_loader import (
                GRAPHIFY_ROUTING_INSTRUCTION,
                create_graphify_server,
            )

            already_gf = any(getattr(s, "name", "") == "graphify" for s in mcp_servers)
            gf_server = None if already_gf else create_graphify_server(
                graph_path=str(settings.get("graphify_graph_path") or ""),
                corpus=str(settings.get("graphify_corpus") or "workspace"),
            )
            if gf_server is not None:
                mcp_servers.append(gf_server)
            if already_gf or gf_server is not None:
                instructions.append(GRAPHIFY_ROUTING_INSTRUCTION)
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

    # Couple UI chat mode → OS sandbox via create_claw_agent (library contract).
    # full_access + allow_full_access → profile off; read_only → read-only.
    # read_only / plan also maps to PermissionMode.PLAN in newer wheels.
    if "chat_mode" in _agent_params:
        kwargs["chat_mode"] = mode
    if "allow_full_access" in _agent_params:
        kwargs["allow_full_access"] = bool(settings.get("allow_full_access"))
    elif (
        mode == "full_access"
        and bool(settings.get("allow_full_access"))
        and "sandbox_profile" in _agent_params
    ):
        # Older wheels without chat_mode — keep explicit off.
        kwargs["sandbox_profile"] = "off"
    if on_exit_plan_mode is not None and "on_exit_plan_mode" in _agent_params:
        kwargs["on_exit_plan_mode"] = on_exit_plan_mode

    # Browser tools (Playwright). Opt-in via Settings → Enable browser tools.
    if settings.get("browser_tools"):
        try:
            from clawagents.browser import create_browser_tools

            kwargs.setdefault("tools", [])
            kwargs["tools"] = list(kwargs["tools"]) + list(create_browser_tools())
        except Exception as exc:  # noqa: BLE001
            on_event(
                "warn",
                {
                    "message": (
                        "Browser tools enabled but failed to load "
                        f"({type(exc).__name__}: {exc}). "
                        "Install with: pip install 'clawagents[browser]' "
                        "&& playwright install chromium"
                    ),
                },
            )

    # ── Event forwarding ────────────────────────────────────────────────
    # The typed stream (on_stream_event) is the authoritative channel for
    # UI-visible events: it is the only one that carries assistant deltas,
    # per-turn assistant messages, tool args/output with call ids, and
    # per-request usage. The legacy on_event channel is forwarded only for
    # operational kinds (warn / error / checkpoint / compact_progress /
    # context / approval_required) that the webview needs.
    saw_assistant = False
    usage_totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_input_tokens": 0,
        "cache_creation_tokens": 0,
        "last_input_tokens": 0,
        "request_count": 0,
        "max_input_tokens": 0,
        "long_context_request_count": 0,
        "run_cost_usd": 0.0,
    }
    model_id_for_cost = str(
        kwargs.get("model") or settings.get("model") or MODEL or ""
    )
    provider_for_cost = str(
        kwargs.get("provider") or settings.get("provider") or ""
    )

    def _ev_usage_int(ev: Any, *names: str) -> int:
        """Read a usage int from typed StreamEvent fields or ``ev.data``."""
        for name in names:
            raw = getattr(ev, name, None)
            if raw is not None:
                try:
                    return int(raw or 0)
                except (TypeError, ValueError):
                    pass
        data = getattr(ev, "data", None)
        if isinstance(data, dict):
            for name in names:
                if name in data:
                    try:
                        return int(data.get(name) or 0)
                    except (TypeError, ValueError):
                        pass
        return 0

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
        # NOTE: the library emits ``approval_required`` for *every* native
        # tool call (its own opt-in HITL path, inert here because the sidecar
        # sets no approval_handler). The sidecar gates tools through
        # ``before_tool`` instead, which raises its own ``permission_required``.
        # Forwarding the library event too would double-prompt the webview, so
        # it is deliberately excluded from this set.
        if kind in {
            "compact_progress",
            "context",
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
            # Cumulative across LLM calls this run (for totals / cache %).
            # Cost is summed per-request so the >272K long-context multiplier
            # applies only to requests that actually exceed the cliff.
            inp = _ev_usage_int(ev, "input_tokens")
            out = _ev_usage_int(ev, "output_tokens")
            tot = _ev_usage_int(ev, "total_tokens")
            cached = _ev_usage_int(
                ev, "cached_input_tokens", "cache_read_tokens"
            )
            created = _ev_usage_int(ev, "cache_creation_tokens")
            usage_totals["prompt_tokens"] += inp
            usage_totals["completion_tokens"] += out
            usage_totals["total_tokens"] += tot
            usage_totals["cached_input_tokens"] += cached
            usage_totals["cache_creation_tokens"] += created
            usage_totals["request_count"] = int(usage_totals["request_count"]) + 1
            usage_totals["max_input_tokens"] = max(
                int(usage_totals["max_input_tokens"]), inp
            )
            if inp > 272_000:
                usage_totals["long_context_request_count"] = (
                    int(usage_totals["long_context_request_count"]) + 1
                )
            req_cost = estimate_usd(
                model_id_for_cost,
                prompt_tokens=inp,
                completion_tokens=out,
                cached_input_tokens=cached,
                cache_creation_tokens=created,
                provider=provider_for_cost,
            )
            if req_cost is not None:
                usage_totals["run_cost_usd"] = float(
                    usage_totals["run_cost_usd"]
                ) + float(req_cost)
            # Context meter needs the *latest* prompt size, not the sum —
            # summing every tool-loop round falsely pegs the bar at 100%.
            usage_totals["last_input_tokens"] = inp
            on_event(
                "usage",
                {
                    **usage_totals,
                    "last_input_tokens": inp,
                },
            )

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

    async def _run_turn() -> Any:
        # Drop kwargs unsupported by the installed clawagents version
        # (PyPI lag vs extension features).
        allowed = set(inspect.signature(create_claw_agent).parameters)
        agent = create_claw_agent(
            **{k: v for k, v in kwargs.items() if k in allowed}
        )
        bt = before_tool_factory(mode=mode, grants=GrantStore())
        agent.before_tool = bt
        # Route declarative permission "ask" into the VS Code approval UI.
        ask_h = getattr(bt, "ask_handler", None)
        pe = getattr(agent, "_permission_engine", None)
        if pe is None:
            pe = getattr(agent.tools, "_permission_engine", None)
        if pe is not None and callable(ask_h):
            pe.ask_handler = ask_h
            agent.tools._permission_engine = pe  # type: ignore[attr-defined]
        if ask_user_factory is not None:
            # Sidecar has no stdin — replace CLI ask_user with webview HITL.
            agent.tools.register(ask_user_factory())

        invoke_kwargs: dict[str, Any] = {
            "on_event": _on_legacy_event,
            "on_stream_event": _on_stream_event,
            "session": session,
            "features": {"session_persistence": True, "file_snapshots": True},
        }
        if "run_context" in inspect.signature(agent.invoke).parameters:
            invoke_kwargs["run_context"] = run_context
        # Image attachments require a newer clawagents (invoke(images=…));
        # older installs simply ignore them rather than crashing the turn.
        clean_images = _normalize_images(images)
        if clean_images and "images" in inspect.signature(agent.invoke).parameters:
            invoke_kwargs["images"] = clean_images
        elif clean_images:
            on_event(
                "warn",
                {
                    "message": (
                        "Image attachments need clawagents≥6.12.12; "
                        "the installed version ignored them."
                    )
                },
            )

        # File attachments (PDF/DOCX) follow the same capability gate.
        clean_files = _normalize_files(files)
        if clean_files and "files" in inspect.signature(agent.invoke).parameters:
            invoke_kwargs["files"] = clean_files
        elif clean_files:
            on_event(
                "warn",
                {
                    "message": (
                        "File attachments need clawagents≥6.12.12; "
                        "the installed version ignored them."
                    )
                },
            )

        return await agent.invoke(augmented, **invoke_kwargs)

    # Floor is clawagents≥6.20.18 — workspace= is required. No process chdir / turn lock.
    if not supports_workspace:
        raise RuntimeError(
            "ClawAgents sidecar requires clawagents≥6.20.18 with workspace= support. "
            "Run ClawAgents: Install/Upgrade Python Dependencies."
        )
    result = await _run_turn()

    status = getattr(result, "status", "done")
    iterations = getattr(result, "iterations", 0)
    out = getattr(result, "result", "")
    out_text = out if isinstance(out, str) else str(out)

    usage = getattr(result, "usage", None)
    result_usage: dict[str, Any] = {}
    if usage is not None:
        # Do NOT emit a usage event here — result.usage is often a single-call
        # blob without last_input_tokens, and the webview used to treat missing
        # last_input as prompt_tokens (run-cumulative), resetting the meter.
        result_usage = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None)
            or getattr(usage, "input_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None)
            or getattr(usage, "output_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None)
            or getattr(usage, "tokens_used", None),
            "cached_input_tokens": getattr(usage, "cached_input_tokens", None)
            or getattr(usage, "cache_read_tokens", None),
            "cache_creation_tokens": getattr(usage, "cache_creation_tokens", None),
        }

    # Prefer turn-accumulated totals (all LLM calls this run) over the last
    # response's usage blob when both exist.
    prompt_n = int(usage_totals.get("prompt_tokens") or result_usage.get("prompt_tokens") or 0)
    completion_n = int(
        usage_totals.get("completion_tokens") or result_usage.get("completion_tokens") or 0
    )
    total_n = int(
        usage_totals.get("total_tokens")
        or result_usage.get("total_tokens")
        or (prompt_n + completion_n)
    )
    cached_n = int(
        usage_totals.get("cached_input_tokens")
        or result_usage.get("cached_input_tokens")
        or 0
    )
    created_n = int(
        usage_totals.get("cache_creation_tokens")
        or result_usage.get("cache_creation_tokens")
        or 0
    )
    # last_input_tokens = size of the final LLM request (context meter).
    # prompt_tokens = sum across all rounds (run cumulative) — do not conflate.
    last_input_n = int(usage_totals.get("last_input_tokens") or 0)
    request_count = int(usage_totals.get("request_count") or 0)
    max_input_n = int(usage_totals.get("max_input_tokens") or 0)
    long_ctx_n = int(usage_totals.get("long_context_request_count") or 0)
    # Prefer summed per-request costs (correct for the 272K cliff). Fall back
    # to a single estimate on the cumulative blob only when no per-request
    # samples arrived (older engines / empty usage stream).
    run_cost_accum = usage_totals.get("run_cost_usd")
    if request_count > 0 and isinstance(run_cost_accum, (int, float)):
        run_cost_f = float(run_cost_accum)
    else:
        run_cost = estimate_usd(
            model_id_for_cost,
            prompt_tokens=prompt_n,
            completion_tokens=completion_n,
            cached_input_tokens=cached_n,
            cache_creation_tokens=created_n,
            provider=provider_for_cost,
        )
        run_cost_f = float(run_cost) if run_cost is not None else None
    # Rough next-prompt estimate: last request size (history+tools+system after
    # this turn). Not chars÷4 — that understates schema/system overhead.
    next_prompt_est = last_input_n or max_input_n or 0
    usage_payload = {
        "prompt_tokens": prompt_n,
        "completion_tokens": completion_n,
        "total_tokens": total_n,
        "cached_input_tokens": cached_n,
        "cache_creation_tokens": created_n,
        "last_input_tokens": last_input_n,
        "request_count": request_count,
        "max_input_tokens": max_input_n,
        "long_context_request_count": long_ctx_n,
        "next_prompt_est_tokens": next_prompt_est,
    }

    latest = get_chat(chat_id) or meta
    prev_session = float(latest.get("session_cost_usd") or 0.0)
    session_cost = prev_session + (run_cost_f if run_cost_f is not None else 0.0)
    session_prompt = int(latest.get("session_prompt_tokens") or 0) + prompt_n
    session_completion = int(latest.get("session_completion_tokens") or 0) + completion_n
    session_total = int(latest.get("session_total_tokens") or 0) + total_n
    if run_cost_f is not None:
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
