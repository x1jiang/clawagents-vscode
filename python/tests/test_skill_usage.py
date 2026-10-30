from concurrent.futures import ThreadPoolExecutor

import pytest

import skill_usage as usage
from settings_store import DEFAULTS, PERSISTED_KEYS


@pytest.fixture
def store(tmp_path, monkeypatch):
    settings = {"skill_usage": True, "telemetry": False}
    monkeypatch.setattr(usage, "USAGE_FILE", tmp_path / "usage.json")
    monkeypatch.setattr(usage, "load_settings", lambda: settings)
    monkeypatch.setattr(usage, "now_ts", lambda: 1234.0)
    return settings


def page(name="Canonical-Skill", start=0, end=100, total=100):
    return f"[Skill {name} sha256={'a' * 64}: characters {start}-{end} of {total}]\nbody"


def emit(tracker, call_id="c1", output=None, success=True, name="use_skill", args=None):
    tracker.on_event("tool_started", {"call_id": call_id, "name": name, "args": args or {"name": "alias"}})
    tracker.on_event("tool_completed", {"call_id": call_id, "name": name, "output": output or page(), "success": success})


def test_default_off_and_independent_persisted_preference():
    assert DEFAULTS["skill_usage"] is False
    assert "skill_usage" in PERSISTED_KEYS


def test_opt_in_disable_retains_history(store):
    store["skill_usage"] = False
    emit(usage.SkillUsageTracker("one"))
    assert not usage.USAGE_FILE.exists()
    store["skill_usage"] = True
    emit(usage.SkillUsageTracker("one"))
    store["skill_usage"] = False
    emit(usage.SkillUsageTracker("two"))
    assert usage.get_skill_usage() == {"enabled": False, "skills": [
        {"name": "Canonical-Skill", "loads": 1, "chats": 1, "last_used": 1234.0}]}


def test_counts_chats_across_runs_and_clear_while_disabled(store):
    for chat in ("one", "one", "two"):
        emit(usage.SkillUsageTracker(chat))
    # A new tracker represents another run/restart, not a new chat.
    row = usage.get_skill_usage()["skills"][0]
    assert (row["loads"], row["chats"]) == (3, 2)
    assert "chat_keys" not in row
    store["skill_usage"] = False
    assert usage.clear_skill_usage() == {"enabled": False, "skills": []}
    store["skill_usage"] = True
    emit(usage.SkillUsageTracker("one"))
    assert usage.get_skill_usage()["skills"][0]["loads"] == 1


def test_failures_aborts_continuations_and_duplicate_events(store):
    tracker = usage.SkillUsageTracker("chat")
    emit(tracker, "failed", success=False)
    emit(tracker, "abort", args={"name": "alias", "abort": True})
    emit(tracker, "other", name="read_file")
    emit(tracker, "first", output=page(end=50))
    assert usage.get_skill_usage()["skills"] == []
    emit(tracker, "last", output=page(start=50), args={"name": "alias", "continue": True})
    emit(tracker, "last", output=page(start=50))
    tracker.on_event("tool_completed", {"call_id": "unmatched", "success": True, "output": page()})
    assert usage.get_skill_usage()["skills"][0]["loads"] == 1


def test_auto_drain_counts_complete_load_even_if_next_tool_fails(store):
    tracker = usage.SkillUsageTracker("chat")
    emit(tracker, "partial", output=page(end=50))
    emit(tracker, "next", name="execute", success=False,
         output="Error: command failed\nOutput:\n[Harness auto-continued skill 'Canonical-Skill' to EOF (2 page(s)).]\n" + page(start=50))
    assert usage.get_skill_usage()["skills"][0]["loads"] == 1


def test_legacy_output_and_ranking(store):
    tracker = usage.SkillUsageTracker("chat")
    emit(tracker, "legacy", output="# Skill: Legacy\nbody")
    emit(tracker, "one")
    emit(tracker, "two")
    assert [row["name"] for row in usage.get_skill_usage()["skills"]] == ["Canonical-Skill", "Legacy"]


def test_concurrent_runs_do_not_lose_counts(store):
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda i: emit(usage.SkillUsageTracker(f"chat{i % 3}")), range(24)))
    row = usage.get_skill_usage()["skills"][0]
    assert (row["loads"], row["chats"]) == (24, 3)


def test_storage_failure_does_not_interrupt_run(store, monkeypatch):
    def fail(*args):
        raise OSError("disk unavailable")
    monkeypatch.setattr(usage, "atomic_write_json", fail)
    emit(usage.SkillUsageTracker("chat"))


def test_endpoints_require_auth_and_clear(store, monkeypatch):
    import app
    from fastapi.testclient import TestClient
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "test-token")
    client = TestClient(app.create_app())
    assert client.get("/skills/usage").status_code == 401
    assert client.post("/skills/usage/clear").status_code == 401
    headers = {"Authorization": "Bearer test-token"}
    emit(usage.SkillUsageTracker("one"))
    response = client.get("/skills/usage", headers=headers)
    assert response.status_code == 200
    assert response.json()["skills"][0]["loads"] == 1
    assert client.post("/skills/usage/clear", headers=headers).json()["skills"] == []


def test_chat_stream_records_tool_events_in_workspace(tmp_path):
    """Exercise the real SSE callback and preference file without a provider."""
    import os
    from pathlib import Path
    import subprocess
    import sys

    script = r'''
from fastapi.testclient import TestClient
import app
from settings_store import save_settings
from skill_usage import get_skill_usage

async def fake_turn(**kwargs):
    event = kwargs["on_event"]
    event("tool_started", {"name": "use_skill", "call_id": "load1", "args": {"name": "Alias"}})
    event("tool_completed", {"name": "use_skill", "call_id": "load1", "success": True,
                            "output": "[Skill Real-Name sha256=" + "a" * 64 + ": characters 0-42 of 42]\\nbody"})
    return {"ok": True}

app.run_chat_turn = fake_turn
save_settings({"skill_usage": True})
client = TestClient(app.create_app())
response = client.post("/chat/stream", headers={"Authorization": "Bearer integration"}, json={"task": "load a skill"})
assert response.status_code == 200, response.text
rows = get_skill_usage()["skills"]
assert len(rows) == 1 and rows[0]["name"] == "Real-Name", (rows, response.text)
assert (rows[0]["loads"], rows[0]["chats"]) == (1, 1), rows
'''
    project = Path(__file__).resolve().parents[2]
    result = subprocess.run([sys.executable, "-c", script], cwd=project, env={
        **os.environ, "PYTHONPATH": os.pathsep.join([str(project / "python"), str(project.parent / "clawagents_py" / "src")]),
        "CLAW_WORKSPACE": str(tmp_path), "GATEWAY_API_KEY": "integration",
        "CLAWAGENTS_VSCODE_STATE_DIR": str(tmp_path / "state"),
    }, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
