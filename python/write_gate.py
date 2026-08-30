"""Cross-run serialization for tools that may mutate the shared workspace."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from typing import Any


def _allowed(result: Any) -> bool:
    allowed = getattr(result, "allowed", None)
    return bool(allowed) if allowed is not None else bool(result)


class WorkspaceWriteGate:
    """Allow one run at a time to execute mutation tools.

    Ownership is a lease token rather than a thread id. This matters because a
    subagent may execute on another worker thread while still belonging to the
    same top-level run. Multiple approved writes in one tool batch are
    reentrant and remain atomic relative to other conversations.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._owner: object | None = None
        self._depth = 0

    def lease(self, mutation_tools: Iterable[str]) -> "RunWriteLease":
        return RunWriteLease(self, frozenset(mutation_tools))

    def _acquire(self, token: object) -> None:
        with self._condition:
            self._condition.wait_for(
                lambda: self._owner is None or self._owner is token
            )
            self._owner = token
            self._depth += 1

    def _release(self, token: object) -> None:
        with self._condition:
            if self._owner is not token or self._depth <= 0:
                return
            self._depth -= 1
            if self._depth == 0:
                self._owner = None
                self._condition.notify_all()


class RunWriteLease:
    def __init__(self, gate: WorkspaceWriteGate, mutation_tools: frozenset[str]) -> None:
        self._gate = gate
        self._mutation_tools = mutation_tools
        self._token = object()
        self._held = 0
        self._state_lock = threading.Lock()

    def wrap_before(self, before_tool: Callable[[str, dict[str, Any]], Any]):
        def guarded(name: str, args: dict[str, Any]):
            result = before_tool(name, args)
            if name in self._mutation_tools and _allowed(result):
                self._gate._acquire(self._token)
                with self._state_lock:
                    self._held += 1
            return result

        ask_handler = getattr(before_tool, "ask_handler", None)
        if ask_handler is not None:
            guarded.ask_handler = ask_handler  # type: ignore[attr-defined]
        return guarded

    def wrap_after(self, after_tool: Callable[..., Any] | None):
        def guarded(name: str, args: dict[str, Any], result: Any):
            try:
                return after_tool(name, args, result) if after_tool else result
            finally:
                if name in self._mutation_tools:
                    self._release_one()

        return guarded

    def _release_one(self) -> None:
        with self._state_lock:
            if self._held <= 0:
                return
            self._held -= 1
        self._gate._release(self._token)

    def close(self) -> None:
        """Release approvals stranded by cancellation or an engine failure."""
        while True:
            with self._state_lock:
                if self._held <= 0:
                    return
            self._release_one()


workspace_write_gate = WorkspaceWriteGate()

