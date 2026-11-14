"""Tests for Harness² workspace optimizer endpoints and inference telemetry."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from types import SimpleNamespace
from typing import Any

import app
import chats
import pytest
import snapshots
from clawagents.stream_events import stream_event_from_kind
from fastapi.testclient import TestClient
from harness_optimizer import HarnessOptimizerManager
from write_gate import WorkspaceWriteGate


def test_harness_endpoints_require_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "secret-token")
    client = TestClient(app.create_app())
    assert client.get("/skills/harness/status").status_code == 401
    assert client.post("/skills/harness/optimize", json={"task": "fix bug"}).status_code == 401
    assert client.post("/skills/harness/cancel").status_code == 401
    assert client.post("/skills/harness/apply").status_code == 401
    assert client.post("/skills/harness/rollback").status_code == 401


def test_harness_optimize_full_lifecycle_and_apply(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text("# Old rules\n", encoding="utf-8")

    async def fake_optimize(task: str, ws: Any, **kwargs: Any) -> dict[str, Any]:
        on_stage = kwargs.get("on_stage_event")
        if callable(on_stage):
            on_stage("stage_start", {"stage": "p0", "task": task})
        ledger_stub = SimpleNamespace(
            to_dict=lambda: {
                "rollouts_total": 4,
                "rollouts_executed": 3,
                "rollouts_saved": 1,
                "sessions_executed": 3,
                "total_usd": 0.0425,
            }
        )
        ppc_res = SimpleNamespace(
            chosen="s1",
            selection={
                "chosen_id": "B",
                "chosen_label": "s1",
                "reasoning": "Candidate B eliminated redundant grep loops.",
            },
            ledger={"rollouts": 3, "stages": 3},
            harness_ledger=ledger_stub,
        )
        return {
            "ok": True,
            "result": ppc_res,
            "base_tree": {"AGENTS.md": "# Old rules\n"},
            "adopted_tree": {"AGENTS.md": "# Improved rules\n- Prefer direct read_file.\n"},
            "diff_summary": "modified AGENTS.md",
            "unified_diffs": {
                "AGENTS.md": "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n-# Old rules\n+# Improved rules\n+- Prefer direct read_file.\n"
            },
        }

    mgr = HarnessOptimizerManager(
        llm_factory=lambda _ws: SimpleNamespace(model="stub"),
        optimize_fn=fake_optimize,
    )
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "test-token")
    monkeypatch.setattr(app, "WORKSPACE", tmp_path)
    monkeypatch.setattr(app, "get_harness_optimizer", lambda: mgr)

    headers = {"Authorization": "Bearer test-token"}
    client = TestClient(app.create_app())

    # Validation checks
    bad_empty = client.post("/skills/harness/optimize", headers=headers, json={"task": "   "})
    assert bad_empty.status_code == 400
    bad_k = client.post("/skills/harness/optimize", headers=headers, json={"task": "x", "k": 5})
    assert bad_k.status_code == 400

    # Launch optimization
    started = client.post(
        "/skills/harness/optimize",
        headers=headers,
        json={"task": "Fix failing pytest suite", "k": 1, "mode": "parallel", "adaptive_probe": True},
    )
    assert started.status_code == 200

    # Poll until background asyncio task finishes
    deadline = time.monotonic() + 5.0
    status_json: dict[str, Any] = {}
    while time.monotonic() < deadline:
        res = client.get("/skills/harness/status", headers=headers)
        assert res.status_code == 200
        status_json = res.json()
        if status_json["state"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.02)

    assert status_json["state"] == "completed", status_json
    assert status_json["chosen"] == "s1"
    assert status_json["selection"]["reasoning"] == "Candidate B eliminated redundant grep loops."
    assert status_json["ledger"]["rollouts_executed"] == 3
    assert status_json["ledger"]["rollouts_saved"] == 1
    assert "AGENTS.md" in status_json["unified_diffs"]

    # Apply optimized harness to workspace and verify backup + write
    applied = client.post("/skills/harness/apply", headers=headers)
    assert applied.status_code == 200
    applied_json = applied.json()
    assert applied_json["applied"] is not None
    assert "Improved rules" in agents_md.read_text(encoding="utf-8")
    backup_file = (
        tmp_path
        / ".clawagents"
        / "harness_runs"
        / str(status_json["run_id"])
        / "backup"
        / "AGENTS.md"
    )
    assert backup_file.read_text(encoding="utf-8") == "# Old rules\n"

    # Rollback restores original AGENTS.md and clears applied state
    rolled_back = client.post("/skills/harness/rollback", headers=headers)
    assert rolled_back.status_code == 200
    rb_json = rolled_back.json()
    assert rb_json["rolled_back"] is True
    assert rb_json["applied"] is None
    assert agents_md.read_text(encoding="utf-8") == "# Old rules\n"


def test_harness_optimize_cancellation() -> None:
    async def _exercise() -> None:
        gate = asyncio.Event()

        async def slow_optimize(_task: str, _ws: Any, **_kwargs: Any) -> dict[str, Any]:
            await gate.wait()
            return {"ok": True}

        mgr = HarnessOptimizerManager(
            llm_factory=lambda _ws: object(),
            optimize_fn=slow_optimize,
        )
        st = mgr.start_optimize(task="Long benchmark", k=1)
        assert st["state"] == "running"
        await asyncio.sleep(0.02)
        cancelled = mgr.cancel_optimize()
        assert cancelled["state"] == "cancelled"
        await asyncio.sleep(0.02)
        assert mgr.get_status()["state"] == "cancelled"

    asyncio.run(_exercise())


def test_run_chat_turn_accumulates_inference_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    meta = {
        "id": "telemetry-chat",
        "session_cost_usd": 0,
        "model_route": {"provider": "openai", "model": "gpt-4o"},
    }
    persisted: list[dict[str, Any]] = []
    events: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(chats, "WORKSPACE", tmp_path)
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "get_chat", lambda _: meta)
    monkeypatch.setattr(chats, "patch_chat", lambda _, **fields: {**meta, **fields})
    monkeypatch.setattr(chats, "append_ui_event", lambda _, ev: persisted.append(ev) or 0)
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {"context_mode": False, "mcp_enabled": False, "provider": "openai", "model": "gpt-4o"},
    )
    monkeypatch.setattr(chats, "_resolve_model_kwargs", lambda *_args: {})
    monkeypatch.setattr(chats, "build_augmented_task", lambda _, content, _s: content)
    monkeypatch.setattr(chats, "apply_scoped_pinned_context", lambda *_args: None)
    monkeypatch.setattr("skills_catalog.resolve_skill_dir_paths", lambda _: [])

    class Agent:
        tools = SimpleNamespace(tools={})
        after_tool = None

        async def invoke(self, task: str, on_stream_event: Any, **_kwargs: Any) -> Any:
            # Call 0 (warmup): slower decode (20 tok/s), TTFT 400ms, step 2900ms
            on_stream_event(
                stream_event_from_kind(
                    "usage",
                    {
                        "prompt_tokens": 1000,
                        "output_tokens": 50,
                        "total_tokens": 1050,
                        "cached_input_tokens": 500,
                        "time_to_first_token_ms": 400.0,
                        "elapsed_ms": 2900.0,
                        "decode_tokens_per_sec": 20.0,
                    },
                )
            )
            # Call 1 (steady): faster decode (80 tok/s), TTFT 200ms, step 1200ms
            on_stream_event(
                stream_event_from_kind(
                    "usage",
                    {
                        "prompt_tokens": 1000,
                        "output_tokens": 80,
                        "total_tokens": 1080,
                        "cached_input_tokens": 900,
                        "time_to_first_token_ms": 200.0,
                        "elapsed_ms": 1200.0,
                        "decode_tokens_per_sec": 80.0,
                    },
                )
            )
            return SimpleNamespace(status="done", result="done", iterations=2)

    monkeypatch.setattr("clawagents.agent.create_claw_agent", lambda workspace=None: Agent())
    out = asyncio.run(
        chats.run_chat_turn(
            chat_id="telemetry-chat",
            content="benchmark",
            mode="auto",
            model="gpt-4o",
            on_event=lambda k, d: events.append((k, d)),
            before_tool_factory=lambda **_kwargs: lambda *_args: None,
            cancel_check=lambda: False,
            caveman=False,
        )
    )
    usage = out["usage"]
    assert usage["avg_ttft_ms"] == 300.0
    # Warmup call #0 (20 tok/s) excluded once >=2 calls exist -> steady_decode_tps == 80.0
    assert usage["steady_decode_tps"] == 80.0
    assert usage["max_step_ms"] == 2900.0
    assert usage["cache_hit_ratio"] == 0.7
    assert persisted[-1]["usage"]["steady_decode_tps"] == 80.0


def test_harness_optimize_conflict_force_and_cleanup(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agents_md = tmp_path / "AGENTS.md"
    agents_md.write_text("# Initial rules\n", encoding="utf-8")

    # Populate 7 older harness runs to verify pruning keeps 5 old runs + current.
    runs_root = tmp_path / ".clawagents" / "harness_runs"
    base_ts = time.time() - 100.0
    for idx in range(7):
        old_dir = runs_root / f"ppc_old_{idx}"
        old_dir.mkdir(parents=True, exist_ok=True)
        (old_dir / "marker.txt").write_text("old", encoding="utf-8")
        os.utime(old_dir, (base_ts + idx, base_ts + idx))

    seen_kwargs: dict[str, Any] = {}

    async def fake_optimize(task: str, ws: Any, **kwargs: Any) -> dict[str, Any]:
        seen_kwargs.update(kwargs)
        staging = kwargs["run_dir"] / "staging" / "cand"
        staging.mkdir(parents=True, exist_ok=True)
        (staging / "tmp.txt").write_text("temp", encoding="utf-8")
        ppc_res = SimpleNamespace(
            chosen="s1",
            selection={"chosen_id": "B", "chosen_label": "s1", "reasoning": "Clean suite win."},
            ledger={"rollouts": 2},
            harness_ledger=None,
        )
        return {
            "ok": True,
            "result": ppc_res,
            "base_tree": {"AGENTS.md": "# Initial rules\n"},
            "adopted_tree": {"AGENTS.md": "# Adopted suite rules\n"},
            "diff_summary": "modified AGENTS.md",
            "unified_diffs": {"AGENTS.md": "@@ -1 +1 @@\n-# Initial rules\n+# Adopted suite rules\n"},
            "experience": {"cue": "pytest suite", "lesson": "Prefer direct read_file"},
        }

    mgr = HarnessOptimizerManager(
        llm_factory=lambda _ws: SimpleNamespace(model="stub"),
        optimize_fn=fake_optimize,
    )
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "test-token")
    monkeypatch.setattr(app, "WORKSPACE", tmp_path)
    monkeypatch.setattr(app, "get_harness_optimizer", lambda: mgr)

    headers = {"Authorization": "Bearer test-token"}
    client = TestClient(app.create_app())

    started = client.post(
        "/skills/harness/optimize",
        headers=headers,
        json={
            "task": "Task A",
            "tasks": ["Task A", "Task B"],
            "k": 3,
            "mode": "parallel",
            "adaptive_probe": True,
            "reflect": True,
        },
    )
    assert started.status_code == 200

    deadline = time.monotonic() + 5.0
    status_json: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status_json = client.get("/skills/harness/status", headers=headers).json()
        if status_json["state"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.02)

    assert status_json["state"] == "completed"
    assert status_json["tasks"] == ["Task A", "Task B"]
    assert status_json["reflect"] is True
    assert status_json["experience"] == {"cue": "pytest suite", "lesson": "Prefer direct read_file"}
    assert seen_kwargs["tasks"] == ["Task A", "Task B"]
    assert seen_kwargs["reflect"] is True

    run_id = str(status_json["run_id"])
    assert not (runs_root / run_id / "staging").exists()
    remaining_old = sorted(p.name for p in runs_root.iterdir() if p.name.startswith("ppc_old_"))
    assert len(remaining_old) == 5
    assert "ppc_old_0" not in remaining_old
    assert "ppc_old_1" not in remaining_old

    # Concurrent manual edit on disk triggers 409 conflict before force=True.
    agents_md.write_text("# User manual edit\n", encoding="utf-8")
    conflict_res = client.post("/skills/harness/apply", headers=headers)
    assert conflict_res.status_code == 409
    assert conflict_res.json()["conflict"] is True
    assert mgr.get_status()["conflict"] is True

    # Force apply overwrites, snapshots the live manual edit, and rollback restores it.
    forced_res = client.post("/skills/harness/apply", headers=headers, json={"force": True})
    assert forced_res.status_code == 200
    assert forced_res.json()["conflict"] is False
    assert agents_md.read_text(encoding="utf-8") == "# Adopted suite rules\n"

    rb_res = client.post("/skills/harness/rollback", headers=headers)
    assert rb_res.status_code == 200
    assert agents_md.read_text(encoding="utf-8") == "# User manual edit\n"


def test_snapshots_meta_fast_path_and_cache(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    snap_root = tmp_path / ".clawagents" / "snapshots"
    snap_dir = snap_root / "20260101T000000"
    (snap_dir / "nested").mkdir(parents=True)
    (snap_dir / "nested" / "file.txt").write_text("hi", encoding="utf-8")
    old_ts = time.time() - 10.0
    os.utime(snap_dir, (old_ts, old_ts))

    monkeypatch.setattr(snapshots, "SNAPSHOTS_DIR", snap_root)
    monkeypatch.setattr(snapshots, "ensure_dirs", lambda: None)

    listed = snapshots.list_snapshots()
    assert len(listed) == 1
    assert listed[0]["files"] == ["nested/file.txt"]

    meta_file = snap_root.parent / "snapshots_meta" / "20260101T000000.json"
    assert meta_file.is_file()

    # Subsequent read uses snapshots_meta without descending into snapshot directory.
    meta_file.write_text(json.dumps({"files": ["cached/path.py"]}), encoding="utf-8")
    cached = snapshots.list_snapshots()
    assert cached[0]["files"] == ["cached/path.py"]


def test_workspace_write_gate_exclusive_serializes() -> None:
    gate = WorkspaceWriteGate()
    events: list[str] = []
    entered_exclusive = threading.Event()
    release_tool = threading.Event()

    lease = gate.lease(frozenset({"write_file"}))
    before = lease.wrap_before(lambda _n, _a: {"allow": True})
    after = lease.wrap_after(lambda _n, _a, r: r)

    before("write_file", {})
    events.append("tool_start")

    def _run_exclusive() -> None:
        with gate.exclusive():
            entered_exclusive.set()
            events.append("exclusive")

    t = threading.Thread(target=_run_exclusive)
    t.start()
    assert not entered_exclusive.wait(timeout=0.1)

    events.append("tool_end")
    after("write_file", {}, {"ok": True})
    lease.close()

    assert entered_exclusive.wait(timeout=2.0)
    t.join(timeout=2.0)
    assert events == ["tool_start", "tool_end", "exclusive"]
    release_tool.set()


def test_compact_chat_rejects_invalid_chat_id() -> None:
    with pytest.raises(ValueError, match="invalid chat_id"):
        asyncio.run(chats.compact_chat("../escape"))
