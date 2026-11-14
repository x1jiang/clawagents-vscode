"""Harness² workspace optimizer job manager for the VS Code sidecar."""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from paths import WORKSPACE
from settings_store import load_settings


def _default_workspace_llm(workspace: Path) -> Any:
    """Resolve the active workspace LLM using the sidecar's configured route."""
    from chats import _resolve_model_kwargs
    from clawagents.agent import create_claw_agent

    settings = load_settings()
    model_kwargs = _resolve_model_kwargs(None, settings)
    agent = create_claw_agent(workspace=str(workspace), **model_kwargs)
    return agent.llm


class HarnessOptimizerManager:
    """Manages a single background Propose–Probe–Compose job per workspace."""

    def __init__(
        self,
        *,
        llm_factory: Callable[[Path], Any] | None = None,
        optimize_fn: Callable[..., Any] | None = None,
        apply_fn: Callable[..., dict[str, Any]] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._llm_factory = llm_factory or _default_workspace_llm
        self._optimize_fn = optimize_fn
        self._apply_fn = apply_fn

        self._state: str = "idle"  # idle | running | completed | failed | cancelled
        self._run_id: str | None = None
        self._task_prompt: str = ""
        self._k: int = 1
        self._mode: str = "parallel"
        self._adaptive_probe: bool = True
        self._max_usd: float | None = None
        self._started_at: float | None = None
        self._ended_at: float | None = None
        self._error: str | None = None
        self._stages: list[dict[str, Any]] = []
        self._ledger: dict[str, Any] | None = None
        self._chosen: str | None = None
        self._selection: dict[str, Any] | None = None
        self._diff_summary: str = ""
        self._unified_diffs: dict[str, str] = {}
        self._applied: dict[str, Any] | None = None
        self._rolled_back: bool = False

        self._last_base_tree: dict[str, str] | None = None
        self._last_adopted_tree: dict[str, str] | None = None
        self._async_task: asyncio.Task[Any] | None = None

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ok": True,
                "state": self._state,
                "run_id": self._run_id,
                "task": self._task_prompt,
                "k": self._k,
                "mode": self._mode,
                "adaptive_probe": self._adaptive_probe,
                "max_usd": self._max_usd,
                "started_at": self._started_at,
                "ended_at": self._ended_at,
                "error": self._error,
                "stages": list(self._stages),
                "ledger": dict(self._ledger) if self._ledger is not None else None,
                "chosen": self._chosen,
                "selection": dict(self._selection) if self._selection is not None else None,
                "diff_summary": self._diff_summary,
                "unified_diffs": dict(self._unified_diffs),
                "has_changes": bool(self._unified_diffs),
                "applied": dict(self._applied) if self._applied is not None else None,
                "rolled_back": self._rolled_back,
            }

    def start_optimize(
        self,
        workspace: Path | str | None = None,
        *,
        task: str,
        k: int = 1,
        mode: str = "parallel",
        adaptive_probe: bool = True,
        max_usd: float | None = None,
        deliverables_mode: str = "contents",
    ) -> dict[str, Any]:
        clean_task = (task or "").strip()
        if not clean_task:
            raise ValueError("Task prompt cannot be empty")
        if k < 1 or k > 3:
            raise ValueError("k must be between 1 and 3")
        if mode not in ("parallel", "sequential"):
            raise ValueError("mode must be 'parallel' or 'sequential'")
        if deliverables_mode not in ("contents", "names"):
            raise ValueError("deliverables_mode must be 'contents' or 'names'")
        if max_usd is not None and (max_usd <= 0 or max_usd > 1000):
            raise ValueError("max_usd must be positive and <= 1000")

        ws = Path(workspace or WORKSPACE).resolve()
        run_id = f"ppc_{int(time.time())}_{uuid.uuid4().hex[:8]}"

        with self._lock:
            if self._state == "running" and self._async_task is not None and not self._async_task.done():
                raise RuntimeError("A Harness² optimization run is already in progress")
            self._state = "running"
            self._run_id = run_id
            self._task_prompt = clean_task
            self._k = int(k)
            self._mode = mode
            self._adaptive_probe = bool(adaptive_probe)
            self._max_usd = float(max_usd) if max_usd is not None else None
            self._started_at = time.time()
            self._ended_at = None
            self._error = None
            self._stages = []
            self._ledger = None
            self._chosen = None
            self._selection = None
            self._diff_summary = ""
            self._unified_diffs = {}
            self._applied = None
            self._rolled_back = False
            self._last_base_tree = None
            self._last_adopted_tree = None

        loop = asyncio.get_running_loop()
        async_task = loop.create_task(
            self._run_job(
                ws,
                run_id=run_id,
                task=clean_task,
                k=int(k),
                mode=mode,
                adaptive_probe=bool(adaptive_probe),
                max_usd=float(max_usd) if max_usd is not None else None,
                deliverables_mode=deliverables_mode,
            )
        )
        with self._lock:
            self._async_task = async_task
        return self.get_status()

    async def _run_job(
        self,
        ws: Path,
        *,
        run_id: str,
        task: str,
        k: int,
        mode: str,
        adaptive_probe: bool,
        max_usd: float | None,
        deliverables_mode: str,
    ) -> None:
        def _on_stage(event: str, payload: dict[str, Any]) -> None:
            entry = {"event": event, "ts": time.time(), **dict(payload or {})}
            with self._lock:
                self._stages = [*self._stages[-49:], entry]
                if isinstance(payload.get("ledger"), dict):
                    self._ledger = dict(payload["ledger"])

        try:
            opt_fn = self._optimize_fn
            if opt_fn is None:
                from clawagents.trajectory.harness_substrate import (
                    optimize_workspace_harness,
                )

                opt_fn = optimize_workspace_harness

            llm = await asyncio.to_thread(self._llm_factory, ws)
            run_dir = ws / ".clawagents" / "harness_runs" / run_id
            exp_dir = ws / ".clawagents" / "experience_library"

            library = None
            try:
                from clawagents.trajectory.harness_surface import ExperienceLibrary

                library = ExperienceLibrary(exp_dir)
            except Exception:  # noqa: BLE001
                library = None

            out = await opt_fn(
                task,
                ws,
                llm=llm,
                k=k,
                mode=mode,
                task_id=run_id,
                adaptive_probe=adaptive_probe,
                max_usd=max_usd,
                deliverables_mode=deliverables_mode,
                run_dir=run_dir,
                library=library,
                apply=False,
                on_stage_event=_on_stage,
            )

            ppc_res = out.get("result")
            h_ledger = getattr(ppc_res, "harness_ledger", None)
            ledger_dict: dict[str, Any] | None = None
            if h_ledger is not None and hasattr(h_ledger, "to_dict"):
                ledger_dict = h_ledger.to_dict()
            elif isinstance(getattr(ppc_res, "ledger", None), dict):
                ledger_dict = dict(ppc_res.ledger)

            sel = getattr(ppc_res, "selection", None)
            sel_dict: dict[str, Any] | None = None
            if isinstance(sel, dict):
                sel_dict = dict(sel)
            elif sel is not None:
                sel_dict = {
                    "chosen_id": getattr(sel, "chosen_id", ""),
                    "chosen_label": getattr(sel, "chosen_label", ""),
                    "reasoning": getattr(sel, "reasoning", ""),
                }

            with self._lock:
                self._state = "completed"
                self._ended_at = time.time()
                self._chosen = str(getattr(ppc_res, "chosen", "") or "")
                self._selection = sel_dict
                self._ledger = ledger_dict
                self._diff_summary = str(out.get("diff_summary") or "")
                self._unified_diffs = dict(out.get("unified_diffs") or {})
                self._last_base_tree = dict(out.get("base_tree") or {})
                self._last_adopted_tree = dict(out.get("adopted_tree") or {})
        except asyncio.CancelledError:
            with self._lock:
                self._state = "cancelled"
                self._ended_at = time.time()
            raise
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._state = "failed"
                self._ended_at = time.time()
                self._error = f"{type(exc).__name__}: {exc}"

    def cancel_optimize(self) -> dict[str, Any]:
        with self._lock:
            task = self._async_task
            if task is not None and not task.done():
                task.cancel()
                self._state = "cancelled"
                self._ended_at = time.time()
        return self.get_status()

    def apply_optimized(self, workspace: Path | str | None = None) -> dict[str, Any]:
        with self._lock:
            if self._state != "completed" or self._last_adopted_tree is None:
                raise RuntimeError("No completed Harness² optimization result is available to apply")
            if not self._unified_diffs:
                raise ValueError("Selected candidate matched base harness (no changes to apply)")
            base_tree = dict(self._last_base_tree or {})
            adopted_tree = dict(self._last_adopted_tree)
            run_id = self._run_id or "manual"

        ws = Path(workspace or WORKSPACE).resolve()
        backup_dir = ws / ".clawagents" / "harness_runs" / run_id / "backup"
        apply_fn = self._apply_fn
        if apply_fn is None:
            from clawagents.trajectory.harness_substrate import backup_and_apply_harness

            apply_fn = backup_and_apply_harness

        applied_info = apply_fn(
            ws,
            base_tree,
            adopted_tree,
            backup_dir=backup_dir,
        )
        with self._lock:
            self._applied = dict(applied_info)
            self._rolled_back = False
        return self.get_status()

    def rollback_optimized(self, workspace: Path | str | None = None) -> dict[str, Any]:
        with self._lock:
            if self._state == "running":
                raise RuntimeError("Cannot roll back while a Harness² optimization run is active")
            applied = dict(self._applied) if self._applied is not None else None
            if applied is None or not applied.get("backup_dir"):
                raise RuntimeError("No applied Harness² backup is available to roll back")
            backup_dir = str(applied["backup_dir"])

        ws = Path(workspace or WORKSPACE).resolve()
        from clawagents.trajectory.harness_substrate import rollback_workspace_harness

        rollback_workspace_harness(ws, backup_dir)
        with self._lock:
            self._applied = None
            self._rolled_back = True
        return self.get_status()


_manager = HarnessOptimizerManager()


def get_harness_optimizer() -> HarnessOptimizerManager:
    return _manager
