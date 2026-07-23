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
    fork_chat,
    get_chat,
    list_chats,
    patch_chat,
    read_ui_events,
    read_ui_events_page,
    run_chat_turn,
    search_chats,
    truncate_after_last_user,
    truncate_to_prompt_index,
    _decide_by_mode,
)
from diagnostics import run_diagnostics
from grants import GrantStore
from mcp_loader import GRAPHIFY_READ_TOOLS, list_mcp_config
from paths import GATEWAY_API_KEY, MODEL, WORKSPACE, ensure_dirs, safe_id
from providers import build_provider_catalog, verify_api_key
from settings_store import load_settings, save_settings
from skills_catalog import preview_skills
from snapshots import (
    latest_snapshot_for,
    list_shadow_checkpoints,
    list_snapshots,
    restore_file,
    restore_shadow_checkpoint,
    shadow_checkpoint_diff,
)
from stats import get_stats, record_turn

Decision = Literal["allow_once", "allow_always", "deny"]
Mode = Literal["ask", "read_only", "auto", "full_access"]

_permission_lock = threading.Lock()
_permission_events: dict[str, threading.Event] = {}
_permission_results: dict[str, Decision] = {}
_permission_meta: dict[str, dict[str, Any]] = {}

# Active agent turns, keyed by run id. Each run owns a *per-run* cancel
# event (a global flag would let a new turn un-cancel — or inherit the
# cancellation of — a concurrent one) plus a canceller that cancels the
# asyncio task, which the agent loop converts into a clean "[cancelled]"
# state.
_run_lock = threading.Lock()
_active_runs: dict[str, dict[str, Any]] = {}
# After exit_plan_mode is Approved, Plan (read_only) unlocks write gates for
# the rest of that run so the agent can implement (Grok Build parity).
_plan_unlocked_runs: set[str] = set()


def _register_run(cancel_ev: threading.Event, *, chat_id: str | None = None) -> str:
    run_id = uuid.uuid4().hex
    with _run_lock:
        _active_runs[run_id] = {
            "ev": cancel_ev,
            "cancel": None,
            "run_context": None,
            "chat_id": chat_id,
        }
    return run_id


def _set_run_canceller(run_id: str, canceller: Callable[[], None]) -> None:
    fire = False
    with _run_lock:
        run = _active_runs.get(run_id)
        if run is not None:
            run["cancel"] = canceller
            # /cancel may have raced registration: apply it now (outside the lock).
            fire = run["ev"].is_set()
    if fire:
        _fire_canceller(canceller)


def _set_run_context(run_id: str, run_context: Any) -> None:
    with _run_lock:
        run = _active_runs.get(run_id)
        if run is not None:
            run["run_context"] = run_context


def _unregister_run(run_id: str) -> list[str]:
    """Remove run; return any stranded interject texts for host queue promotion."""
    with _run_lock:
        run = _active_runs.pop(run_id, None)
        _plan_unlocked_runs.discard(run_id)
    if run is None:
        return []
    ctx = run.get("run_context")
    stranded: list[str] = []
    try:
        from clawagents.interjection import take_stranded_interjects

        stranded = take_stranded_interjects(ctx)
        # Also pick up leftovers already parked by the agent loop
        meta = getattr(ctx, "_metadata", None) if ctx is not None else None
        if isinstance(meta, dict):
            parked = meta.pop("stranded_interjects", None)
            if isinstance(parked, list):
                for p in parked:
                    t = str(p).strip()
                    if t and t not in stranded:
                        stranded.append(t)
    except Exception:  # noqa: BLE001
        pass
    return stranded


def _fire_canceller(cancel_fn: Callable[[], None] | None) -> None:
    if cancel_fn is None:
        return
    try:
        cancel_fn()
    except Exception:  # noqa: BLE001
        pass


def _cancel_run(run_id: str) -> None:
    with _run_lock:
        run = _active_runs.get(run_id)
        if run is None:
            return
        run["ev"].set()
        cancel_fn = run["cancel"]
    _fire_canceller(cancel_fn)


def _cancel_all_runs() -> list[str]:
    """Cancel every active run; return stranded interject prompts (FIFO)."""
    with _run_lock:
        runs = list(_active_runs.values())
        for run in runs:
            run["ev"].set()
    for run in runs:
        _fire_canceller(run["cancel"])
    stranded: list[str] = []
    for run in runs:
        ctx = run.get("run_context")
        try:
            from clawagents.interjection import take_stranded_interjects

            stranded.extend(take_stranded_interjects(ctx))
        except Exception:  # noqa: BLE001
            pass
    return stranded


def _interject_runs(text: str, chat_id: str | None = None) -> int:
    """Queue a mid-turn user redirect on matching active run(s).

    When ``chat_id`` is set, only that chat's run is targeted. Multiple
    redirects are kept as separate list entries (never merged into one blob).
    """
    msg = (text or "").strip()
    if not msg:
        return 0
    n = 0
    with _run_lock:
        runs = list(_active_runs.values())
    for run in runs:
        if chat_id and run.get("chat_id") and run.get("chat_id") != chat_id:
            continue
        if chat_id and not run.get("chat_id"):
            continue
        ctx = run.get("run_context")
        if ctx is None:
            continue
        try:
            from clawagents.interjection import enqueue_interject

            if enqueue_interject(ctx, msg):
                n += 1
        except Exception:  # noqa: BLE001
            # Fallback: legacy string key
            meta = getattr(ctx, "_metadata", None)
            if not isinstance(meta, dict):
                continue
            buf = meta.get("pending_interjects")
            if not isinstance(buf, list):
                buf = []
                meta["pending_interjects"] = buf
            buf.append(msg)
            n += 1
    return n


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

# exit_plan_mode HITL — Approve / Request changes / Reject (desktop parity).
PlanDecision = Literal["approve", "request_changes", "reject"]
_plan_lock = threading.Lock()
_plan_pending: dict[str, Any] = {}  # None | asyncio.Future | str (pre-resolved)
_plan_loops: dict[str, asyncio.AbstractEventLoop] = {}
_plan_comments: dict[str, str] = {}


def _safe_plan_set_result(fut: "asyncio.Future[PlanDecision]", value: PlanDecision) -> None:
    if not fut.done():
        fut.set_result(value)


class PlanApprovalWaiter:
    def create(self) -> str:
        request_id = uuid.uuid4().hex
        with _plan_lock:
            _plan_pending[request_id] = None
        return request_id

    async def wait(
        self, request_id: str, *, timeout: float = 600.0
    ) -> tuple[PlanDecision, str]:
        loop = asyncio.get_running_loop()
        with _plan_lock:
            entry = _plan_pending.get(request_id)
            if isinstance(entry, str):
                _plan_pending.pop(request_id, None)
                comment = _plan_comments.pop(request_id, "")
                return entry, comment  # type: ignore[return-value]
            if entry is None:
                fut: asyncio.Future[PlanDecision] = loop.create_future()
                _plan_pending[request_id] = fut
                _plan_loops[request_id] = loop
            else:
                fut = entry
        try:
            decision = await asyncio.wait_for(fut, timeout=timeout)
            with _plan_lock:
                comment = _plan_comments.pop(request_id, "")
            return decision, comment
        finally:
            with _plan_lock:
                _plan_pending.pop(request_id, None)
                _plan_loops.pop(request_id, None)
                _plan_comments.pop(request_id, None)

    def resolve(
        self,
        request_id: str,
        decision: PlanDecision,
        *,
        comment: str = "",
    ) -> None:
        try:
            safe_id(request_id, kind="request_id")
        except ValueError:
            return
        with _plan_lock:
            if request_id not in _plan_pending:
                return
            if comment:
                _plan_comments[request_id] = comment
            entry = _plan_pending.get(request_id)
            if entry is None or isinstance(entry, str):
                _plan_pending[request_id] = decision
                return
            fut = entry
            loop = _plan_loops.get(request_id)
        if fut.done():
            return
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(_safe_plan_set_result, fut, decision)
        else:
            try:
                fut.set_result(decision)
            except asyncio.InvalidStateError:
                pass

    def reject_all(self, comment: str = "cancelled") -> None:
        with _plan_lock:
            ids = list(_plan_pending.keys())
        for rid in ids:
            self.resolve(rid, "reject", comment=comment)


_plan_waiter = PlanApprovalWaiter()


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
    # web_fetch / web_search. Default off — ask first.
    web: bool = False
    # browser_* tools (also requires settings.browser_tools). Default off.
    browser: bool = False


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
    # Terse caveman-style replies (juliusbrussee/caveman). Default on.
    caveman: bool = True
    # Goal autopilot (planner→verify→strategist).
    goal: bool = False
    # Record full LLM context events to Context Observatory UI (.clawagents/context-observatory/)
    enable_context_observatory: bool = False
    # Image attachments for the first user turn. Each item is
    # {"data": <base64 or data-URL>, "media_type": "image/png"}. The sidecar
    # forwards them to agent.invoke(images=…); ignored on older clawagents.
    images: list[dict[str, Any]] | None = None
    # File attachments (PDF/DOCX). Each item is {"data": <base64 or data-URL>,
    # "media_type": "application/pdf", "name": "report.pdf"}. Forwarded to
    # agent.invoke(files=…); ignored on older clawagents.
    files: list[dict[str, Any]] | None = None


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

# Network search/fetch — gated under the "web" auto-approve category.
_WEB_TOOLS = frozenset({
    "web_fetch",
    "web_search",
})

# Headless browser — gated under the "browser" auto-approve category.
# Also requires settings.browser_tools so the tools are registered at all.
_BROWSER_TOOLS = frozenset({
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
    "hashline_read",
    "hashline_grep",
    "repo_map",
    "git_status",
    "git_diff",
    "snapshot_diff",
    "checkpoint_list",
    "checkpoint_diff",
    "list_skills",
    "use_skill",
    "retrieve_tool_result",
    "ask_user",
    "ask_user_question",
    "clarify",
    "confirm",
    "approve_action",
    "ctx_search",
    "ctx_status",
    "ctx_list",
    "ctx_info",
}) | GRAPHIFY_READ_TOOLS

# Plan (read_only) UI: exploration + plan artifact + exit gate (Grok Build).
# Mutating tools stay blocked except writes targeting .clawagents/plan.md.
_PLAN_MODE_ALLOWED_TOOLS = _KNOWN_READONLY_TOOLS | frozenset({
    "write_plan",
    "enter_plan_mode",
    "exit_plan_mode",
})


def _tool_category(name: str) -> str:
    if name in _EDIT_TOOLS:
        return "edit"
    if name in _WEB_TOOLS:
        return "web"
    if name in _BROWSER_TOOLS:
        return "browser"
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


class PlanApprovalBody(BaseModel):
    decision: PlanDecision
    comment: str = ""


class CreateChatBody(BaseModel):
    title: str | None = None
    mode: Mode = "auto"


class PatchChatBody(BaseModel):
    title: str | None = None
    mode: Mode | None = None
    pinned: bool | None = None
    archived: bool | None = None


class RestoreBody(BaseModel):
    snapshot_id: str
    rel: str
    dest_rel: str | None = None


class CheckpointRestoreBody(BaseModel):
    sha: str
    mode: str = "files"
    chat_id: str | None = None


class InterjectBody(BaseModel):
    text: str
    chat_id: str | None = None


class HunkActionBody(BaseModel):
    hunk_id: str | None = None
    path: str | None = None


class RewindBody(BaseModel):
    prompt_index: int
    chat_id: str | None = None


class CompactBody(BaseModel):
    pass


class VerifyBody(BaseModel):
    provider: str


def _workspace_rel_path_or_400(path: str | None) -> Response | str | None:
    """Return None when path is absent; validated relative path; or a 400 Response."""
    if path is None or path == "":
        return None
    raw = str(path).strip()
    if not raw:
        return None
    if Path(raw).is_absolute() or ".." in Path(raw).parts:
        return _bad_request("path must be workspace-relative without '..'")
    return raw


def _make_before_tool(
    mode: str,
    grants: GrantStore,
    sse_fn,
    auto_approve: AutoApprove | None = None,
    cancel_check: Callable[[], bool] = lambda: False,
    run_id: str | None = None,
):
    from clawagents import HookResult
    from clawagents.permissions.mode import WRITE_CLASS_TOOLS

    from mcp_loader import CONTEXT_MODE_WRITE_TOOLS, GRAPHIFY_WRITE_TOOLS

    # web_fetch / web_search / browser_* leave the machine — gated under
    # auto_approve.web and auto_approve.browser respectively.
    gated_tools = (
        frozenset(WRITE_CLASS_TOOLS)
        | CONTEXT_MODE_WRITE_TOOLS
        | GRAPHIFY_WRITE_TOOLS
        | _WEB_TOOLS
        | _BROWSER_TOOLS
    )

    def _plan_unlocked() -> bool:
        if not run_id:
            return False
        with _run_lock:
            return run_id in _plan_unlocked_runs

    def _pre_approved(category: str, file_path: str | None) -> bool:
        """Granular auto-approve (Cline-style). Authoritative when provided.

        'Edit' auto-approve only covers in-workspace files; edits outside the
        workspace still prompt. 'Execute' / 'web' / 'browser' have no path.
        """
        if auto_approve is None:
            # Legacy / direct-API behavior: fall back to mode heuristics.
            return _decide_by_mode(mode, file_path) == "allow_once"
        if category == "edit":
            return bool(auto_approve.edit) and _in_workspace(file_path)
        if category == "web":
            return bool(auto_approve.web)
        if category == "browser":
            return bool(auto_approve.browser)
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
        if cancel_check():
            return HookResult(allowed=False, reason="Cancelled by user")

        # Known read/search tools never need a prompt. Unknown names (MCP,
        # future builtins) are gated as execute — do not auto-allow.
        if name not in gated_tools:
            if name in _KNOWN_READONLY_TOOLS or name in _PLAN_MODE_ALLOWED_TOOLS:
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

        # Plan / read-only: explore + write_plan + exit_plan_mode only
        # (Grok Build parity). Other mutations stay hard-blocked until the
        # host Approves exit_plan_mode (unlocks this run) or the user
        # switches to Act. Read-only shell still works for inspection.
        if mode == "read_only" and not _plan_unlocked():
            if name == "execute" and _is_readonly_shell(command):
                return True
            if name in _PLAN_MODE_ALLOWED_TOOLS:
                return True
            try:
                from clawagents.permissions.mode import is_plan_file_path
            except Exception:  # noqa: BLE001
                is_plan_file_path = lambda _p: False  # type: ignore[assignment]
            if name in WRITE_CLASS_TOOLS and is_plan_file_path(file_path):
                return True
            return HookResult(
                allowed=False,
                reason=(
                    f"Blocked: '{name}' would modify state or leave the machine, "
                    "but the chat is in Plan mode. Explore, write_plan, then "
                    "exit_plan_mode for approval — or switch to Act to execute."
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

    def ask_handler(tool_name: str, args: dict[str, Any], message: str = "") -> bool:
        """Route PermissionEngine 'ask' rules into the same approval UI."""
        if cancel_check():
            return False
        file_path = args.get("path") or args.get("file_path") or args.get("target_path")
        file_path = file_path if isinstance(file_path, str) else None
        command = args.get("command") if isinstance(args.get("command"), str) else None
        if command is None and isinstance(args.get("code"), str):
            command = args["code"]
        if command is None and isinstance(args.get("url"), str):
            command = args["url"]
        category = _tool_category(tool_name) if tool_name in gated_tools else "execute"
        # Respect Auto-approve for ask rules too (sudo/env write still gated by
        # category toggles).
        if _pre_approved(category, file_path):
            return True
        request_id = _waiter.create({"tool": tool_name, "file_path": file_path})
        sse_fn(
            "permission_required",
            {
                "request_id": request_id,
                "tool": tool_name,
                "file_path": file_path,
                "command": command,
                "reason": message
                or (
                    f"Permission rule asks for approval to run '{tool_name}'. "
                    f"Enable auto-approve for {category} to skip this next time."
                ),
            },
        )
        decision = _waiter.wait(request_id, timeout=600.0)
        return decision in ("allow_once", "allow_always")

    before_tool.ask_handler = ask_handler  # type: ignore[attr-defined]
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

    @app.get("/capabilities")
    async def capabilities(request: Request):
        """Versioned feature flags — prefer this over inspect.signature / patches."""
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            import clawagents
            from clawagents.capabilities import get_capabilities

            caps = get_capabilities()
            caps["clawagents_version"] = getattr(clawagents, "__version__", "?")
            return caps
        except Exception as exc:  # noqa: BLE001
            return {
                "contract_version": 0,
                "error": str(exc),
                "gemini_array_items": False,
                "workspace_scoped_agent": False,
                "raw_tool_output": False,
                "artifact_workspace_arg": False,
            }

    @app.get("/diagnostics")
    async def diagnostics(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return run_diagnostics()

    @app.get("/graphify/status")
    async def graphify_status_endpoint(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        from mcp_loader import graphify_status
        from settings_store import load_settings

        settings = load_settings()
        return {
            "enabled": bool(settings.get("graphify")),
            **graphify_status(
                graph_path=str(settings.get("graphify_graph_path") or ""),
                corpus=str(settings.get("graphify_corpus") or "workspace"),
                allow_external_path=bool(settings.get("allow_external_graph_path")),
            ),
        }

    @app.get("/providers")
    async def providers(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        import asyncio as _asyncio

        # Default: cheap catalog (no live network). Autosave used to call this
        # with probes on every settings keystroke → Mantle/OpenAI /models
        # stampeded the thread pool, hung the sidecar, and exhausted sockets
        # (ETIMEDOUT / EADDRNOTAVAIL). Pass ?probe=1 only for explicit refresh.
        probe_raw = (request.query_params.get("probe") or "0").strip().lower()
        probe_keys = probe_raw in ("1", "true", "yes", "on")
        return await _asyncio.to_thread(build_provider_catalog, probe_keys=probe_keys)

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
    async def put_settings(body: dict[str, Any], request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        # Single source of truth: DEFAULTS / sanitize_patch — no duplicate Pydantic
        # schema that can silently drop new keys (wire_api / effort / ssl_verify).
        from settings_store import sanitize_patch, save_settings as _save

        clean, dropped = sanitize_patch(body if isinstance(body, dict) else {})
        if dropped:
            import logging

            logging.getLogger("clawagents.vscode").warning(
                "PUT /settings dropped unknown keys: %s", ", ".join(sorted(dropped))
            )
        return _save(clean)

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

    @app.get("/checkpoints")
    async def checkpoints_list(request: Request, limit: int = 30):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return list_shadow_checkpoints(limit=limit)

    @app.post("/checkpoints/restore")
    async def checkpoints_restore(body: CheckpointRestoreBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        if body.chat_id:
            bad = _validate_chat_id(body.chat_id)
            if bad:
                return bad
        return restore_shadow_checkpoint(
            body.sha, mode=body.mode or "files", chat_id=body.chat_id
        )

    @app.get("/checkpoints/diff")
    async def checkpoints_diff(
        request: Request, lhs: str, rhs: str | None = None
    ):
        denied = _auth_or_401(request)
        if denied:
            return denied
        return shadow_checkpoint_diff(lhs, rhs)

    @app.get("/modes")
    async def modes_list(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.modes import load_modes

            modes = load_modes(workspace=str(WORKSPACE))
            return [
                {
                    "id": m.id,
                    "name": m.display_name(),
                    "permission_mode": m.permission_mode,
                    "auto_approve": m.auto_approve,
                }
                for m in modes.values()
            ]
        except Exception as exc:  # noqa: BLE001
            return [{"error": str(exc)}]

    @app.post("/chats/{chat_id}/compact")
    async def chats_compact(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        from chats import compact_chat

        return await compact_chat(chat_id)

    @app.post("/goal/pause")
    async def goal_pause(request: Request):
        """Pause disk-backed Goal when UI leaves Goal mode (Act/Plan)."""
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.goal import GoalPauseReason, GoalTracker

            gt = GoalTracker(WORKSPACE)
            if not gt.is_active():
                return {"ok": True, "paused": False, "reason": "no active goal"}
            gt.pause(
                GoalPauseReason.USER,
                "Paused because UI is in Act/Plan (not Goal mode)",
            )
            return {"ok": True, "paused": True, "goal_id": gt.state.id if gt.state else None}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    @app.post("/goal/resume")
    async def goal_resume(request: Request):
        """Resume a Goal paused by leaving Goal mode."""
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.goal import GoalStatus, GoalTracker

            gt = GoalTracker(WORKSPACE)
            if gt.state is None or gt.state.status != GoalStatus.PAUSED:
                return {"ok": True, "resumed": False, "reason": "no paused goal"}
            gt.resume()
            return {"ok": True, "resumed": True, "goal_id": gt.state.id if gt.state else None}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

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
        # Paginate by default so long sessions do not load megabytes of JSONL.
        # ?all=1 restores the previous full-log behaviour for tooling.
        qs = request.query_params
        if qs.get("all") in ("1", "true", "yes"):
            events = read_ui_events(chat_id)
            return {
                **meta,
                "events": events,
                "events_total": len(events),
                "events_offset": 0,
                "events_has_more": False,
            }
        try:
            tail = int(qs.get("tail") or 400)
        except ValueError:
            tail = 400
        before_raw = qs.get("before")
        before: int | None
        try:
            before = int(before_raw) if before_raw is not None else None
        except ValueError:
            before = None
        page = read_ui_events_page(chat_id, tail=tail, before=before)
        return {
            **meta,
            "events": page["events"],
            "events_total": page["total"],
            "events_offset": page["offset"],
            "events_has_more": page["has_more"],
        }

    @app.patch("/chats/{chat_id}")
    async def chats_patch(chat_id: str, body: PatchChatBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            return patch_chat(
                chat_id,
                title=body.title,
                mode=body.mode,
                pinned=body.pinned,
                archived=body.archived,
            )
        except KeyError:
            return Response(status_code=404, content=json.dumps({"error": "not found"}))

    @app.delete("/chats/{chat_id}")
    async def chats_delete(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        delete_chat(chat_id)
        return {"ok": True}

    @app.post("/chats/{chat_id}/fork")
    async def chats_fork(chat_id: str, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            meta = fork_chat(chat_id)
            return {"ok": True, "chat": meta, "chat_id": meta["id"]}
        except KeyError:
            return Response(status_code=404, content=json.dumps({"error": "chat not found"}))
        except RuntimeError as e:
            return Response(
                status_code=500,
                content=json.dumps({"error": str(e)}),
                media_type="application/json",
            )

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

    @app.post("/plan_approvals/{request_id}")
    async def resolve_plan_approval(
        request_id: str, body: PlanApprovalBody, request: Request
    ):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            safe_id(request_id, kind="request_id")
        except ValueError:
            return _bad_request("invalid request_id")
        with _plan_lock:
            if request_id not in _plan_pending:
                return Response(
                    status_code=404,
                    content=json.dumps({"error": f"unknown request {request_id}"}),
                    media_type="application/json",
                )
        _plan_waiter.resolve(
            request_id, body.decision, comment=body.comment or ""
        )
        return {
            "ok": True,
            "request_id": request_id,
            "decision": body.decision,
            "comment": body.comment,
        }

    @app.post("/cancel")
    async def cancel(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        stranded = _cancel_all_runs()
        with _permission_lock:
            ids = list(_permission_events.keys())
        for rid in ids:
            _waiter.resolve(rid, "deny")
        # Unblock any agent turn waiting on an ask_user prompt.
        with _ask_lock:
            ask_ids = list(_ask_events.keys())
        for rid in ask_ids:
            _ask_waiter.resolve(rid, None)
        # Unblock exit_plan_mode approval waiters.
        _plan_waiter.reject_all(comment="cancelled")
        return {"ok": True, "stranded_prompts": stranded}

    @app.post("/interject")
    async def interject(body: InterjectBody, request: Request):
        """Redirect the agent mid-turn without cancelling (Grok-style)."""
        denied = _auth_or_401(request)
        if denied:
            return denied
        if body.chat_id:
            bad = _validate_chat_id(body.chat_id)
            if bad:
                return bad
        n = _interject_runs(body.text, chat_id=body.chat_id)
        return {"ok": True, "applied": n}

    @app.get("/hunks")
    async def hunks_list(request: Request, path: str | None = None):
        denied = _auth_or_401(request)
        if denied:
            return denied
        path_or_err = _workspace_rel_path_or_400(path)
        if isinstance(path_or_err, Response):
            return path_or_err
        try:
            from clawagents.memory.attributed_hunks import list_hunks

            rows = list_hunks(workspace=str(WORKSPACE), path=path_or_err)
            return {"ok": True, "hunks": [h.to_dict() for h in rows]}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "hunks": []}

    @app.post("/hunks/accept")
    async def hunks_accept(body: HunkActionBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        path_or_err = _workspace_rel_path_or_400(body.path)
        if isinstance(path_or_err, Response):
            return path_or_err
        try:
            from clawagents.memory.attributed_hunks import accept_all, accept_hunk

            if path_or_err and not body.hunk_id:
                result = accept_all(path_or_err, workspace=str(WORKSPACE))
            elif body.hunk_id:
                result = accept_hunk(body.hunk_id, workspace=str(WORKSPACE))
            else:
                return {"ok": False, "error": "provide hunk_id or path"}
            return {"ok": bool(result.get("ok")), **result}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    @app.post("/hunks/reject")
    async def hunks_reject(body: HunkActionBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.memory.attributed_hunks import reject_hunk

            if not body.hunk_id:
                return {"ok": False, "error": "hunk_id required"}
            result = reject_hunk(body.hunk_id, workspace=str(WORKSPACE))
            return {"ok": bool(result.get("ok")), **result}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    @app.get("/rewind")
    async def rewind_list(request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.memory.hunk_watcher import get_watcher

            rows = get_watcher(str(WORKSPACE)).list_snapshots()
            return {"ok": True, "snapshots": rows}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "snapshots": []}

    @app.post("/rewind")
    async def rewind_to(body: RewindBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied
        try:
            from clawagents.memory.hunk_watcher import get_watcher

            result = get_watcher(str(WORKSPACE)).rewind_to_prompt(int(body.prompt_index))
            if body.chat_id and result.get("ok"):
                try:
                    trunc = truncate_to_prompt_index(
                        body.chat_id,
                        int(body.prompt_index),
                        user_text=str(result.get("truncate_to_user_text") or ""),
                        message_count=result.get("message_count"),
                    )
                    result["conversation_truncated"] = trunc
                except Exception as trunc_exc:  # noqa: BLE001
                    result["conversation_truncated"] = {
                        "ok": False,
                        "error": str(trunc_exc),
                    }
            return {"ok": bool(result.get("ok")), **result}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    @app.post("/chat/stream")
    async def chat_stream(body: ChatBody, request: Request):
        denied = _auth_or_401(request)
        if denied:
            return denied

        # Bound + coalesce so a slow webview cannot OOM the sidecar on long runs.
        _SSE_QUEUE_MAX = 512
        event_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=_SSE_QUEUE_MAX)
        loop = asyncio.get_running_loop()
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

        # Register only after request validation. From this point ownership is
        # transferred to _run(), whose finally block always unregisters it.
        cancel_ev = threading.Event()
        run_id = _register_run(cancel_ev, chat_id=chat_id)

        # Cap full_access unless the user explicitly opted in via Settings.
        effective_mode = body.mode
        if effective_mode == "full_access" and not load_settings().get("allow_full_access"):
            effective_mode = "auto"

        # Plan is always interactive — the point of planning is to ask/clarify.
        effective_interaction: InteractionStyle = (
            "interactive" if effective_mode == "read_only" else body.interaction
        )

        def _enqueue_sse(payload: str | None) -> None:
            def _put() -> None:
                # Close sentinel always wins: make room if needed.
                if payload is None:
                    while True:
                        try:
                            event_queue.put_nowait(None)
                            return
                        except asyncio.QueueFull:
                            try:
                                event_queue.get_nowait()
                            except asyncio.QueueEmpty:
                                return
                # Prefer dropping oldest high-churn frames (usage/agent) over blocking
                # the agent thread. Critical events (error/done) still get through.
                for _ in range(_SSE_QUEUE_MAX + 1):
                    try:
                        event_queue.put_nowait(payload)
                        return
                    except asyncio.QueueFull:
                        try:
                            dropped = event_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        # Never discard an already-queued close sentinel.
                        if dropped is None:
                            try:
                                event_queue.put_nowait(None)
                            except asyncio.QueueFull:
                                pass
                            return

            loop.call_soon_threadsafe(_put)

        def sse(event: str, data: Any) -> None:
            payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            _enqueue_sse(payload)

        def close_stream() -> None:
            # Same scheduling path as sse() so the sentinel can never
            # overtake a previously emitted event.
            _enqueue_sse(None)

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
            if kind == "stranded_interject":
                sse("stranded_interject", payload)
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
            return _make_before_tool(
                mode,
                grants,
                sse,
                auto_approve=body.auto_approve,
                cancel_check=cancel_ev.is_set,
                run_id=run_id,
            )

        async def on_exit_plan_mode(plan_text: str, _run_context: Any) -> Any:
            """Host gate for exit_plan_mode (Grok / desktop parity)."""
            from clawagents.permissions.plan_approval import (
                PlanApprovalAction,
                PlanApprovalDecision,
            )

            request_id = _plan_waiter.create()
            sse(
                "plan_approval_required",
                {
                    "request_id": request_id,
                    "plan_text": plan_text or "",
                },
            )
            try:
                decision, comment = await _plan_waiter.wait(
                    request_id, timeout=600.0
                )
            except asyncio.TimeoutError:
                return PlanApprovalDecision(
                    PlanApprovalAction.REJECT, comment="timeout"
                )
            if decision == "approve":
                with _run_lock:
                    _plan_unlocked_runs.add(run_id)
                # Flip UI to Act so the next turn isn't stuck in Plan.
                sse("plan_approved", {"mode": "auto", "chat_id": chat_id})
            action = {
                "approve": PlanApprovalAction.APPROVE,
                "request_changes": PlanApprovalAction.REQUEST_CHANGES,
                "reject": PlanApprovalAction.REJECT,
            }.get(decision, PlanApprovalAction.REJECT)
            return PlanApprovalDecision(action, comment=comment or "")

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
                        cancel_check=cancel_ev.is_set,
                        ask_user_factory=ask_factory,
                        on_exit_plan_mode=on_exit_plan_mode,
                        caveman=bool(body.caveman),
                        goal=bool(body.goal),
                        enable_context_observatory=bool(body.enable_context_observatory),
                        images=body.images,
                        files=body.files,
                        run_id=run_id,
                        attach_run_context=_set_run_context,
                    )
                )
                # Attach the task canceller to the pre-registered run. If
                # /cancel already fired during setup, it is applied here.
                _set_run_canceller(
                    run_id, lambda: worker_loop.call_soon_threadsafe(task.cancel)
                )
                return worker_loop.run_until_complete(task)
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
                if cancel_ev.is_set():
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
                if cancel_ev.is_set() or "cancelled" in str(exc).lower():
                    sse("error", {"error": "cancelled"})
                else:
                    sse("error", {"error": str(exc)})
            finally:
                stranded = _unregister_run(run_id)
                if stranded:
                    sse(
                        "stranded_interject",
                        {"prompts": stranded, "count": len(stranded)},
                    )
                close_stream()

        run_task = asyncio.create_task(_run())

        async def _stream():
            try:
                while True:
                    # Keep-alive comment every 15s of silence so the client
                    # can tell a quiet long-running tool from a hung sidecar
                    # (its idle timeout is a multiple of this interval).
                    try:
                        msg = await asyncio.wait_for(event_queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
                        continue
                    if msg is None:
                        break
                    yield msg
            finally:
                # Client disconnected mid-run: stop *this* agent turn instead
                # of letting it burn tokens into a closed pipe. Other turns
                # are unaffected.
                if not run_task.done():
                    _cancel_run(run_id)

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return app
