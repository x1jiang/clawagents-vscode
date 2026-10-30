from __future__ import annotations

import pytest

import conversation_timing as timing


@pytest.fixture
def clock(tmp_path, monkeypatch):
    values = {"wall": 1000.0, "mono": 10.0}
    monkeypatch.setattr(timing, "chat_meta_path", lambda cid: tmp_path / f"{cid}.json")
    monkeypatch.setattr(timing.time, "time", lambda: values["wall"])
    monkeypatch.setattr(timing.time, "monotonic", lambda: values["mono"])
    for cid in ("chat_one", "chat_two"):
        (tmp_path / f"{cid}.json").write_text("{}")
    return values


def test_accumulates_runs_excluding_idle_and_survives_restart(clock):
    store = timing.ConversationTimingStore()
    meta = {"id": "chat_one", "created_at": 900, "updated_at": 950}
    store.start("chat_one", "run1")
    clock.update(wall=1003, mono=13)
    assert store.snapshot(meta)["cumulative_ms"] == 3000
    store.finish("run1")
    store.finish("run1")  # Duplicate terminal events cannot double count.
    clock.update(wall=2000, mono=1010)
    store.start("chat_one", "run2")
    clock.update(wall=2002, mono=1012)
    store.finish("run2")
    saved = timing.ConversationTimingStore().snapshot(meta)
    assert saved["cumulative_ms"] == 5000
    assert saved["last_run_ms"] == 2000
    assert saved["run_count"] == 2
    assert saved["active_runs"] == 0
    assert saved["tracked_since"] == 1000
    assert saved["last_activity_at"] == 2002


def test_conversations_are_isolated_and_active_runs_are_not_restored(clock):
    store = timing.ConversationTimingStore()
    store.start("chat_one", "r1")
    clock.update(wall=1005, mono=15)
    one = store.snapshot({"id": "chat_one"})
    two = store.snapshot({"id": "chat_two"})
    assert (one["cumulative_ms"], one["active_runs"]) == (5000, 1)
    assert (two["cumulative_ms"], two["active_runs"]) == (0, 0)
    assert two["tracked_since"] is None
    restarted = timing.ConversationTimingStore().snapshot({"id": "chat_one"})
    assert restarted["active_runs"] == 0
    assert restarted["cumulative_ms"] == 0


def test_elapsed_uses_monotonic_clock_and_finish_does_not_resurrect_deleted_chat(clock):
    store = timing.ConversationTimingStore()
    store.start("chat_one", "r1")
    clock.update(wall=990, mono=15)
    store.finish("r1")
    assert store.snapshot({"id": "chat_one"})["cumulative_ms"] == 5000
    store.start("chat_two", "r2")
    timing.chat_meta_path("chat_two").unlink()
    store.finish("r2")
    assert not timing.timing_path("chat_two").exists()


def test_stream_records_success_error_and_cancellation_and_restores_timing(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    project = Path(__file__).resolve().parents[2]
    script = r'''
import asyncio
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "python"))
sys.path.insert(0, str(Path.cwd().parent / "clawagents_py" / "src"))
import app
from fastapi.testclient import TestClient

async def fake_turn(**kwargs):
    await asyncio.sleep(0.01)
    if kwargs["content"] == "error":
        raise RuntimeError("test failure")
    if kwargs["content"] == "cancel":
        raise asyncio.CancelledError()
    return {"status": "done", "usage": {}}

app.run_chat_turn = fake_turn
headers = {"Authorization": "Bearer timing-test-token"}
with TestClient(app.create_app()) as client:
    cid = client.post("/chats", headers=headers, json={}).json()["id"]
    previous = 0
    for count, content in enumerate(("success", "error", "cancel"), 1):
        response = client.post("/chat/stream", headers=headers, json={"task": content, "chat_id": cid})
        assert response.status_code == 200, response.text
        assert '"kind": "conversation_timing"' in response.text
        meta = client.get(f"/chats/{cid}/meta", headers=headers).json()
        assert meta["timing"]["run_count"] == count, meta
        assert meta["timing"]["active_runs"] == 0, meta
        assert meta["timing"]["cumulative_ms"] > previous, meta
        previous = meta["timing"]["cumulative_ms"]
    restored = client.get(f"/chats/{cid}?tail=1", headers=headers).json()
    assert restored["timing"]["cumulative_ms"] == previous
    assert len(client.get("/chats", headers=headers).json()) == 1
    assert not app._active_runs
'''
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=project,
        env={**os.environ, "GATEWAY_API_KEY": "timing-test-token", "CLAW_WORKSPACE": str(tmp_path), "CLAWAGENTS_VSCODE_STATE_DIR": str(tmp_path / "state")},
        text=True, capture_output=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
