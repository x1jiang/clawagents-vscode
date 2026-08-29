"""Cancellation must be scoped to the conversation that owns the UI action."""

from __future__ import annotations

import threading
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


AUTH_HEADERS = {"Authorization": "Bearer targeted-cancel-test"}


def _clear_runtime_state() -> None:
    with app._run_lock:
        app._active_runs.clear()
        app._plan_unlocked_runs.clear()
    with app._permission_lock:
        app._permission_events.clear()
        app._permission_results.clear()
        app._permission_meta.clear()
    with app._ask_lock:
        app._ask_events.clear()
        app._ask_results.clear()
        app._ask_run_ids.clear()
    with app._plan_lock:
        app._plan_pending.clear()
        app._plan_loops.clear()
        app._plan_comments.clear()
        app._plan_run_ids.clear()


def test_cancel_targets_one_chat_and_its_waiters(monkeypatch) -> None:
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "targeted-cancel-test")
    _clear_runtime_state()
    fired: list[str] = []
    try:
        event_a = threading.Event()
        event_b = threading.Event()
        run_a = app._register_run(event_a, chat_id="chat-a")
        run_b = app._register_run(event_b, chat_id="chat-b")
        app._set_run_canceller(run_a, lambda: fired.append("chat-a"))
        app._set_run_canceller(run_b, lambda: fired.append("chat-b"))

        permission_a = app._waiter.create({"tool": "execute", "run_id": run_a})
        permission_b = app._waiter.create({"tool": "execute", "run_id": run_b})

        ask_a = "ask-a"
        ask_b = "ask-b"
        with app._ask_lock:
            app._ask_events[ask_a] = threading.Event()
            app._ask_events[ask_b] = threading.Event()
            app._ask_run_ids[ask_a] = run_a
            app._ask_run_ids[ask_b] = run_b

        plan_a = app._plan_waiter.create(run_id=run_a)
        plan_b = app._plan_waiter.create(run_id=run_b)

        response = TestClient(app.create_app()).post(
            "/cancel", json={"chat_id": "chat-a"}, headers=AUTH_HEADERS
        )

        assert response.status_code == 200, response.text
        assert response.json()["cancelled_runs"] == 1
        assert event_a.is_set()
        assert not event_b.is_set()
        assert fired == ["chat-a"]

        with app._permission_lock:
            assert app._permission_results[permission_a] == "deny"
            assert permission_b not in app._permission_results
            assert app._permission_events[permission_a].is_set()
            assert not app._permission_events[permission_b].is_set()
        with app._ask_lock:
            assert app._ask_events[ask_a].is_set()
            assert not app._ask_events[ask_b].is_set()
        with app._plan_lock:
            assert app._plan_pending[plan_a] == "reject"
            assert app._plan_pending[plan_b] is None
    finally:
        _clear_runtime_state()


def test_cancel_rejects_invalid_chat_id(monkeypatch) -> None:
    monkeypatch.setattr(app, "GATEWAY_API_KEY", "targeted-cancel-test")
    response = TestClient(app.create_app()).post(
        "/cancel", json={"chat_id": "../outside"}, headers=AUTH_HEADERS
    )
    assert response.status_code == 400
