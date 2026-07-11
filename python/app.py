"""FastAPI application for the ClawAgents VS Code sidecar."""

from __future__ import annotations

import asyncio
import json
import secrets
import threading
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from chats import (
    create_chat,
    delete_chat,
    get_chat,
    list_chats,
    patch_chat,
    read_ui_events,
    run_chat_turn,
    search_chats,
    truncate_after_last_user,
    _decide_by_mode,
)
from diagnostics import run_diagnostics
from grants import GrantStore
from mcp_loader import list_mcp_config
from paths import GATEWAY_API_KEY, MODEL, WORKSPACE, ensure_dirs, safe_id
from providers import build_provider_catalog, verify_api_key
from settings_store import load_settings, save_settings
from skills_catalog import preview_skills
from snapshots import latest_snapshot_for, list_snapshots, restore_file
from stats import get_stats, record_turn

Decision = Literal["allow_once", "allow_always", "deny"]
Mode = Literal["ask", "read_only", "auto", "full_access"]

_cancel = threading.Event()
_permission_lock = threading.Lock()
_permission_events: dict[str, threading.Event] = {}
_permission_results: dict[str, Decision] = {}
_permission_meta: dict[str, dict[str, Any]] = {}

# Currently running agent turn, so /cancel can actually stop it (the agent
# loop converts CancelledError into a clean "[cancelled]" state).
_run_lock = threading.Lock()
_current_run: dict[str, Any] = {}


def _register_run(canceller: Callable[[], None]) -> str:
    run_id = uuid.uuid4().hex
    with _run_lock:
        _current_run[run_id] = canceller
    return run_id


def _unregister_run(run_id: str) -> None:
    with _run_lock:
        _current_run.pop(run_id, None)


def _cancel_all_runs() -> None:
    with _run_lock:
        cancellers = list(_current_run.values())
    for cancel_fn in cancellers:
        try:
            cancel_fn()
        except Exception:  # noqa: BLE001
            pass


class PermissionWaiter:
    def create(self, meta: dict[str, Any] | None = None) -> str:
        request_id = uuid.uuid4().hex
        with _permission_lock:
            _permission_events[request_id] = threading.Event()
            if meta:
                _permission_meta[request_id] = meta
        return request_id

    def _pop(self, request_id: str) -> Decision:
        with _permission_lock:
            decision = _permission_results.pop(request_id, "deny")
            _permission_events.pop(request_id, None)
            _permission_meta.pop(request_id, None)
        return decision

    def wait(self, request_id: str, timeout: float = 600.0) -> Decision:
        with _permission_lock:
            event = _permission_events.get(request_id)
        if event is None:
            return "deny"
        if not event.wait(timeout=timeout):
            self.resolve(request_id, "deny")
            return self._pop(request_id)
        return self._pop(request_id)

    def resolve(self, request_id: str, decision: Decision) -> None:
        """Apply a permission decision. Orphan/stale IDs are ignored (no grants)."""
        try:
            safe_id(request_id, kind="request_id")
        except ValueError:
            return
        with _permission_lock:
            event = _permission_events.get(request_id)
            meta = _permission_meta.get(request_id)
            if event is None:
                # Timed-out, already resolved, or forged id — never persist grants.
                return
            _permission_results[request_id] = decision
        if decision == "allow_always" and isinstance(meta, dict):
            tool = str(meta.get("tool") or "").strip()
            path = meta.get("file_path")
            # Never default tool/path to "*" (that would disable all future prompts).
            if tool and tool != "*":
                if isinstance(path, str) and path.strip():
                    GrantStore().add(
                        path_pattern=path.strip(),
                        scope="write",
                        tool=tool,
                    )
                else:
                    # Tool-only grant (execute / web) — empty path, specific tool.
                    GrantStore().add(path_pattern="", scope="write", tool=tool)
        event.set()


_waiter = PermissionWaiter()

# ask_user HITL — same waiter pattern, but the result is free-text (or None = skip).
_ask_lock = threading.Lock()
_ask_events: dict[str, threading.Event] = {}
_ask_results: dict[str, str | None] = {}


class AskUserWaiter:
    def ask(self, question: str, sse_fn, timeout: float = 600.0) -> str | None:
        request_id = uuid.uuid4().hex
        with _ask_lock:
            _ask_events[request_id] = threading.Event()
        sse_fn(
            "ask_user_required",
            {"request_id": request_id, "question": question},
        )
        with _ask_lock:
            event = _ask_events.get(request_id)
        if event is None:
            return None
        if not event.wait(timeout=timeout):
            self.resolve(request_id, None)
            return None
        with _ask_lock:
            answer = _ask_results.pop(request_id, None)
            _ask_events.pop(request_id, None)
        return answer

    def resolve(self, request_id: str, answer: str | None) -> None:
        with _ask_lock:
            _ask_results[request_id] = answer
            event = _ask_events.get(request_id)
        if event is not None:
            event.set()


_ask_waiter = AskUserWaiter()


def _build_ask_user_tool(ask_fn):
    """Construct AskUserTool with ask_fn, compatible with clawagents <6.10.1."""
    from clawagents.tools.interactive import AskUserTool

    try:
        return AskUserTool(ask_fn=ask_fn)
    except TypeError:
        # Pre-6.10.1: AskUserTool() took no args (stdin only). Patch execute.
        tool = AskUserTool()

        async def execute(args):  # type: ignore[no-untyped-def]
            from clawagents.tools.registry import ToolResult
            import asyncio

            question = str(args.get("question", ""))
            if not question:
                return ToolResult(success=False, output="", error="No question provided")
            loop = asyncio.get_running_loop()
            try:
                answer = await loop.run_in_executor(None, ask_fn, question)
            except Exception as exc:  # noqa: BLE001
                return ToolResult(success=False, output="", error=f"ask_user failed: {exc}")
            if answer is None:
                return ToolResult(
                    success=False,
                    output="",
                    error="User skipped the question (or timed out).",
                )
            return ToolResult(success=True, output=f"User response: {answer}")

        tool.execute = execute  # type: ignore[method-assign]
        return tool


def make_ask_user_tool(sse_fn):
    """Replace the default stdin ask_user with a webview-backed one."""

    def ask_fn(question: str) -> str | None:
        return _ask_waiter.ask(question, sse_fn)

    return _build_ask_user_tool(ask_fn)


def make_auto_ask_user_tool():
    """Auto interaction: never block on the user — agent decides itself."""

    def ask_fn(question: str) -> str | None:
        return (
            "[auto mode] User is not available to answer. "
            f"Decide yourself based on the task. Original question: {question}"
        )

    return _build_ask_user_tool(ask_fn)


def _bad_request(message: str) -> Response:
    return Response(
        content=json.dumps({"error": message}),
        status_code=400,
        media_type="application/json",
    )


def _validate_chat_id(chat_id: str) -> Response | None:
    try:
        safe_id(chat_id, kind="chat_id")
    except ValueError:
        return _bad_request("invalid chat_id")
    return None


def _check_auth(request: Request) -> bool:
    # Fail closed: never serve without a session token (extension always sets one).
    if not GATEWAY_API_KEY:
        return False
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return secrets.compare_digest(auth[7:], GATEWAY_API_KEY)
    return secrets.compare_digest(request.headers.get("x-api-key", ""), GATEWAY_API_KEY)


def _auth_or_401(request: Request) -> Response | None:
    if _check_auth(request):
        return None
    return Response(
        content=json.dumps({"error": "Unauthorized"}),
        status_code=401,
        media_type="application/json",
    )


class AutoApprove(BaseModel):
    # Cline-style granular auto-approve. Reads are never gated. When present,
    # these are authoritative in Act mode (mode != read_only): a category set
    # to True runs without a confirmation prompt. Defaults are opt-in (safe).
    edit: bool = False
    execute: bool = False
    # Network egress (web_fetch / browser_*). Default off — ask first.
    web: bool = False


InteractionStyle = Literal["interactive", "auto"]


class ChatBody(BaseModel):
    task: str
    session_id: str | None = None
    chat_id: str | None = None
    lane: str = "main"
    mode: Mode = "auto"
    model: str | None = None
    auto_approve: AutoApprove | None = None
    # interactive = ask_user hits the webview; auto = agent decides without waiting.
    # Plan (read_only) always forces interactive on the server.
    interaction: InteractionStyle = "interactive"
    # Terse caveman-style replies (juliusbrussee/caveman).
    caveman: bool = False


# File-writing tools (the "Edit" auto-approve category); everything else in
# the gated set (execute/exec/bash/ctx_*/subagent/compose) is "Execute".
_EDIT_TOOLS = frozenset({
    "write_file",
    "edit_file",
    "create_file",
    "replace_in_file",
    "insert_in_file",
    "patch_file",
    "delete_file",
})

# Network / browser tools — gated under the "web" auto-approve category.
_WEB_TOOLS = frozenset({
    "web_fetch",
    "web_search",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_hover",
    "browser_select_option",
    "browser_screenshot",
    "browser_wait_for",
    "browser_back",
    "browser_forward",
    "browser_evaluate",
    "browser_close",
})

# Built-in tools that are safe to run without a permission prompt.
# Anything else (including MCP tools) is gated like execute — otherwise Plan
# mode and approval can be bypassed by a hostile MCP server.
_KNOWN_READONLY_TOOLS = frozenset({
    "read_file",
    "list_dir",
    "glob",
    "search_files",
    "grep",
    "ask_user",
    "ask_user_question",
    "clarify",
    "confirm",
    "approve_action",
    "ctx_search",
    "ctx_status",
    "ctx_list",
    "ctx_info",
})


def _tool_category(name: str) -> str:
    if name in _EDIT_TOOLS:
        return "edit"
    if name in _WEB_TOOLS:
        return "web"
    return "execute"


def _in_workspace(file_path: str | None) -> bool:
    if not file_path:
        return False
    try:
        resolved = Path(file_path).resolve()
        root = WORKSPACE.resolve()
        return resolved == root or root in resolved.parents
    except OSError:
        return False


class PermissionBody(BaseModel):
    decision: Decision


class AskUserBody(BaseModel):
    answer: str | None = None
    skip: bool = False


class SettingsBody(BaseModel):
    model: str | None = None
    provider: str | None = None
    base_url: str | None = None
    default_mode: str | None = None
    telemetry: bool | None = None
    trajectory: bool | None = None
    learn: bool | None = None
    browser_tools: bool | None = None
    mcp_enabled: bool | None = None
    mcp_trust_workspace: bool | None = None
    context_mode: bool | None = None
    workspace_system_prompt: str | None = None
    skill_dirs: list[str] | None = None
    skill_auto_discover: bool | None = None
    skill_ignore_dirs: list[str] | None = None
    skill_exclude: list[str] | None = None
    allow_full_access: bool | None = None
    allow_external_skill_dirs: bool | None = None
    trust_custom_base_url: bool | None = None


class CreateChatBody(BaseModel):
    title: str | None = None
    mode: Mode = "auto"


class PatchChatBody(BaseModel):
    title: str | None = None
    mode: Mode | None = None


class RestoreBody(BaseModel):
    snapshot_id: str
    rel: str
    dest_rel: str | None = None


class VerifyBody(BaseModel):
    provider: str


def _make_before_tool(
    mode: str,
    grants: GrantStore,
    sse_fn,
    auto_approve: AutoApprove | None = None,
):
    from clawagents import HookResult
    from clawagents.permissions.mode import WRITE_CLASS_TOOLS

    from mcp_loader import CONTEXT_MODE_WRITE_TOOLS

    # ctx_execute & co. run arbitrary code (their "sandbox" captures stdout,
    # it does not confine writes) — gate them like the built-in shell tool.
    # web_fetch / browser_* leave the machine — gated under auto_approve.web.
    gated_tools = frozenset(WRITE_CLASS_TOOLS) | CONTEXT_MODE_WRITE_TOOLS | _WEB_TOOLS

    def _pre_approved(category: str, file_path: str | None) -> bool:
        """Granular auto-approve (Cline-style). Authoritative when provided.

        'Edit' auto-approve only covers in-workspace files; edits outside the
        workspace still prompt. 'Execute' / 'web' have no path, so they cover all.
        """
        if auto_approve is None:
            # Legacy / direct-API behavior: fall back to mode heuristics.
            return _decide_by_mode(mode, file_path) == "allow_once"
        if category == "edit":
            return bool(auto_approve.edit) and _in_workspace(file_path)
        if category == "web":
            return bool(auto_approve.web)
        return bool(auto_approve.execute)

    def _is_readonly_shell(command: str | None) -> bool:
        """Allow read-only shell (ls/echo/pwd/…) without Execute auto-approve.

        Matches the 'Read files & search (always)' UX: inspecting the machine
        should not require ticking Execute. Destructive / unknown commands
        still go through the normal gate.
        """
        if not command or not command.strip():
            return False
        try:
            from clawagents.tools.bash_validator import (
                CommandCategory,
                Decision,
                validate_bash,
            )

            decision = validate_bash(command)
            return (
                decision.decision == Decision.ALLOW
                and decision.category == CommandCategory.READ_ONLY
            )
        except Exception:  # noqa: BLE001
            return False

    def before_tool(name: str, args: dict[str, Any]):
        if _cancel.is_set():
            return HookResult(allowed=False, reason="Cancelled by user")

        # Known read/search tools never need a prompt. Unknown names (MCP,
        # future builtins) are gated as execute — do not auto-allow.
        if name not in gated_tools:
            if name in _KNOWN_READONLY_TOOLS:
                return True
            category = "execute"
        else:
            category = _tool_category(name)

        file_path = args.get("path") or args.get("file_path") or args.get("target_path")
        file_path = file_path if isinstance(file_path, str) else None
        command = args.get("command") if isinstance(args.get("command"), str) else None
        if command is None and isinstance(args.get("code"), str):
            command = args["code"]  # ctx_execute-style tools: show the code being run
        if command is None and isinstance(args.get("url"), str):
            command = args["url"]  # web_fetch / browser_navigate: show the URL

        # Plan / read-only: mutating tools are hard-blocked so the agent reasons
        # and proposes instead of acting. Read-only shell is still allowed so
        # questions like "what's my home folder?" work in Plan.
        if mode == "read_only":
            if name == "execute" and _is_readonly_shell(command):
                return True
            return HookResult(
                allowed=False,
                reason=(
                    f"Blocked: '{name}' would modify state or leave the machine, "
                    "but the chat is in Plan (read-only) mode. Describe what you "
                    "would do; switch to Act to execute."
                ),
            )
        if mode == "full_access":
            return True
        # Read-only shell never needs Execute auto-approve (Act mode).
        if name == "execute" and _is_readonly_shell(command):
            return True
        if _pre_approved(category, file_path):
            return True
        if grants.match(file_path, tool=name, scope="write"):
            return True

        request_id = _waiter.create({"tool": name, "file_path": file_path})
        sse_fn(
            "permission_required",
            {
                "request_id": request_id,
                "tool": name,
                "file_path": file_path,
                "command": command,
                "reason": (
                    f"'{name}' ({category}) needs approval. Enable "
                    f"auto-approve for {category} to skip this next time."
                ),
            },
        )
        decision = _waiter.wait(request_id, timeout=600.0)
        if decision in ("allow_once", "allow_always"):
            return True
        return HookResult(
            allowed=False,
            reason=(
                f"The user denied permission for '{name}'. Do not retry this "
                "action; explain what you wanted to do instead."
            ),
        )

    return before_tool


def create_app() -> FastAPI:
    ensure_dirs()
    app = FastAPI(title="ClawAgents VS Code Bridge")

    @app.get("/health")
    async def health(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        settings = load_settings()
        return {
            "status": "ok",
            "workspace": str(WORKSPACE),
            "model": settings.get("model") or MODEL or "default",
            "provider": settings.get("provider") or "auto",
        }

    @app.get("/diagnostics")
    async def diagnostics(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return run_diagnostics()

    @app.get("/providers")
    async def providers(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return build_provider_catalog()

    @app.post("/settings/verify-key")
    async def verify_key(body: VerifyBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        import asyncio as _asyncio

        # Live probe (network call) — run off the event loop.
        return await _asyncio.to_thread(verify_api_key, body.provider, probe=True)

    @app.get("/settings")
    async def get_settings(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return load_settings()

    @app.put("/settings")
    async def put_settings(body: SettingsBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        patch = {k: v for k, v in body.model_dump().items() if v is not None}
        return save_settings(patch)

    @app.get("/skills")
    async def get_skills(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return preview_skills()

    @app.get("/mcp")
    async def mcp_list(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return list_mcp_config(
            trust_workspace=bool(load_settings().get("mcp_trust_workspace", False)),
        )

    @app.get("/stats")
    async def stats(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return get_stats()

    @app.get("/snapshots")
    async def snapshots(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return list_snapshots()

    @app.get("/snapshots/latest")
    async def snapshots_latest(path: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        hit = latest_snapshot_for(path)
        if not hit:
            return Response(status_code=404, content=json.dumps({"error": "not found"}))
        return hit

    @app.post("/snapshots/restore")
    async def snapshots_restore(body: RestoreBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            return restore_file(body.snapshot_id, body.rel, body.dest_rel)
        except FileNotFoundError as exc:
            return Response(status_code=404, content=json.dumps({"error": str(exc)}))
        except ValueError as exc:
            return Response(status_code=400, content=json.dumps({"error": str(exc)}))

    @app.get("/chats")
    async def chats_list(request: Request, q: str | None = None):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return search_chats(q) if q else list_chats()

    @app.post("/chats")
    async def chats_create(body: CreateChatBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return create_chat(title=body.title, mode=body.mode)

    @app.get("/chats/{chat_id}")
    async def chats_get(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        meta = get_chat(chat_id)
        if not meta:
            return Response(status_code=404, content=json.dumps({"error": "not found"}))
        return {**meta, "events": read_ui_events(chat_id)}

    @app.patch("/chats/{chat_id}")
    async def chats_patch(chat_id: str, body: PatchChatBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            return patch_chat(chat_id, title=body.title, mode=body.mode)
        except KeyError:
            return Response(status_code=404, content=json.dumps({"error": "not found"}))

    @app.delete("/chats/{chat_id}")
    async def chats_delete(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        delete_chat(chat_id)
        return {"ok": True}

    @app.post("/chats/{chat_id}/regenerate")
    async def chats_regenerate(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        events = read_ui_events(chat_id)
        last_user = None
        for ev in reversed(events):
            if ev.get("kind") == "user":
                last_user = ev.get("text")
                break
        if not last_user:
            return Response(status_code=400, content=json.dumps({"error": "no user message"}))
        truncate_after_last_user(chat_id)
        # Client should re-POST /chat/stream with the text; we just prepare state.
        return {"ok": True, "task": last_user, "chat_id": chat_id}

    @app.post("/permissions/{request_id}")
    async def resolve_permission(request_id: str, body: PermissionBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            safe_id(request_id, kind="request_id")
        except ValueError:
            return _bad_request("invalid request_id")
        _waiter.resolve(request_id, body.decision)
        return {"ok": True, "request_id": request_id, "decision": body.decision}

    @app.post("/ask_user/{request_id}")
    async def resolve_ask_user(request_id: str, body: AskUserBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        answer: str | None = None if body.skip else (body.answer or "")
        _ask_waiter.resolve(request_id, answer)
        return {"ok": True, "request_id": request_id}

    @app.post("/cancel")
    async def cancel(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        _cancel.set()
        with _permission_lock:
            ids = list(_permission_events.keys())
        for rid in ids:
            _waiter.resolve(rid, "deny")
        _cancel_all_runs()
        return {"ok": True}

    @app.post("/chat/stream")
    async def chat_stream(body: ChatBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied

        event_queue: asyncio.Queue[str | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        _cancel.clear()

        chat_id = body.chat_id or body.session_id
        if not chat_id:
            chat_id = create_chat(mode=body.mode)["id"]
        else:
            bad = _validate_chat_id(chat_id)
            if bad:
                return bad
            if not get_chat(chat_id):
                try:
                    create_chat(chat_id=chat_id, mode=body.mode)
                except ValueError:
                    return _bad_request("invalid chat_id")

        # Cap full_access unless the user explicitly opted in via Settings.
        effective_mode = body.mode
        if effective_mode == "full_access" and not load_settings().get("allow_full_access"):
            effective_mode = "auto"

        # Plan is always interactive — the point of planning is to ask/clarify.
        effective_interaction: InteractionStyle = (
            "interactive" if effective_mode == "read_only" else body.interaction
        )

        def sse(event: str, data: Any) -> None:
            payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            loop.call_soon_threadsafe(event_queue.put_nowait, payload)

        def close_stream() -> None:
            # Same scheduling path as sse() so the sentinel can never
            # overtake a previously emitted event.
            loop.call_soon_threadsafe(event_queue.put_nowait, None)

        # tool_started args by call id, so tool_completed can resolve which
        # file changed even though the result event carries no args.
        pending_tool_args: dict[str, dict[str, Any]] = {}
        try:
            from clawagents.permissions.mode import WRITE_CLASS_TOOLS
        except Exception:  # noqa: BLE001
            WRITE_CLASS_TOOLS = frozenset()

        def _extract_path(args: dict[str, Any]) -> str | None:
            fp = args.get("path") or args.get("file_path") or args.get("target_path")
            return fp if isinstance(fp, str) and fp else None

        def on_event(kind: str, data: dict[str, Any] | None = None) -> None:
            payload = data or {}
            if kind == "usage":
                sse("usage", payload)
                return
            sse("agent", {"kind": kind, "data": payload})
            if kind == "tool_started":
                call_id = str(payload.get("call_id") or "")
                args = payload.get("args") if isinstance(payload.get("args"), dict) else {}
                if call_id:
                    pending_tool_args[call_id] = args or {}
            elif kind == "tool_completed":
                name = str(payload.get("name") or "")
                call_id = str(payload.get("call_id") or "")
                args = pending_tool_args.pop(call_id, {})
                if name not in WRITE_CLASS_TOOLS or not payload.get("success", True):
                    return
                fp = _extract_path(args)
                if fp:
                    snap = latest_snapshot_for(fp)
                    sse(
                        "file_changed",
                        {
                            "path": fp,
                            "tool": name,
                            "snapshot_id": snap.get("snapshot_id") if snap else None,
                            "snapshot_rel": snap.get("rel") if snap else None,
                        },
                    )

        def before_tool_factory(*, mode: str, grants: GrantStore):
            # Respect the client's Auto-approve toggles even in "auto" interaction.
            # (Auto interaction only stubs ask_user — it must not silently enable
            # shell/network without the user opting in via Auto-approve.)
            return _make_before_tool(mode, grants, sse, auto_approve=body.auto_approve)

        def run_agent() -> dict[str, Any]:
            """Run the agent turn on a private event loop in this worker thread.

            The loop/task pair is registered so POST /cancel can cancel the
            task from the server thread; the agent loop converts the
            resulting CancelledError into a clean "[cancelled]" state.
            """
            worker_loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(worker_loop)

                def ask_factory():
                    if effective_interaction == "auto":
                        return make_auto_ask_user_tool()
                    return make_ask_user_tool(sse)

                task = worker_loop.create_task(
                    run_chat_turn(
                        chat_id=chat_id,
                        content=body.task,
                        mode=effective_mode,
                        model=body.model,
                        on_event=on_event,
                        before_tool_factory=before_tool_factory,
                        cancel_check=_cancel.is_set,
                        ask_user_factory=ask_factory,
                        caveman=bool(body.caveman),
                    )
                )
                run_id = _register_run(
                    lambda: worker_loop.call_soon_threadsafe(task.cancel)
                )
                try:
                    return worker_loop.run_until_complete(task)
                finally:
                    _unregister_run(run_id)
            finally:
                try:
                    worker_loop.run_until_complete(worker_loop.shutdown_asyncgens())
                except Exception:  # noqa: BLE001
                    pass
                asyncio.set_event_loop(None)
                worker_loop.close()

        async def _run() -> None:
            sse("queued", {"lane": body.lane, "chat_id": chat_id})
            sse("started", {"lane": body.lane, "chat_id": chat_id, "mode": effective_mode})
            try:
                result = await asyncio.to_thread(run_agent)
                if _cancel.is_set():
                    sse("error", {"error": "cancelled"})
                    record_turn(error=True)
                else:
                    usage = result.get("usage") or {}
                    tokens = int(usage.get("total_tokens") or 0)
                    record_turn(tokens=tokens)
                    sse(
                        "done",
                        {
                            "lane": body.lane,
                            "chat_id": chat_id,
                            "status": result.get("status", "done"),
                            "result": result.get("result", ""),
                            "iterations": result.get("iterations", 0),
                            "usage": usage,
                        },
                    )
            except asyncio.CancelledError:
                record_turn(error=True)
                sse("error", {"error": "cancelled"})
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                record_turn(error=True)
                if _cancel.is_set() or "cancelled" in str(exc).lower():
                    sse("error", {"error": "cancelled"})
                else:
                    sse("error", {"error": str(exc)})
            finally:
                close_stream()

        run_task = asyncio.create_task(_run())

        async def _stream():
            try:
                while True:
                    msg = await event_queue.get()
                    if msg is None:
                        break
                    yield msg
            finally:
                # Client disconnected mid-run: stop the agent instead of
                # letting it burn tokens into a closed pipe.
                if not run_task.done():
                    _cancel.set()
                    _cancel_all_runs()

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return app
