"""The sidecar must exit when the extension host that spawned it goes away."""

from __future__ import annotations

import subprocess
import sys
import textwrap
import time
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]

_CHILD = textwrap.dedent(
    """
    import sys, time
    sys.path.insert(0, {python_dir!r})
    from parent_watchdog import start_parent_watchdog
    started = start_parent_watchdog(grace_s=0.5)
    print("watching" if started else "disabled", flush=True)
    time.sleep(30)
    """
)


def _spawn(env_flag: str | None) -> subprocess.Popen:
    import os

    env = {k: v for k, v in os.environ.items() if k != "CLAW_PARENT_WATCHDOG"}
    if env_flag is not None:
        env["CLAW_PARENT_WATCHDOG"] = env_flag
    return subprocess.Popen(
        [sys.executable, "-c", _CHILD.format(python_dir=str(PYTHON_DIR))],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )


def test_child_exits_when_parent_closes_stdin():
    proc = _spawn("1")
    try:
        assert proc.stdout.readline().strip() == b"watching"
        assert proc.poll() is None, "must keep running while the pipe is open"
        started = time.monotonic()
        proc.stdin.close()  # what the OS does when the extension host dies
        proc.wait(timeout=10)
        assert time.monotonic() - started < 5
        assert b"Extension host is gone" in proc.stdout.read()
    finally:
        if proc.poll() is None:
            proc.kill()


def test_watchdog_is_off_unless_opted_in():
    proc = _spawn(None)
    try:
        assert proc.stdout.readline().strip() == b"disabled"
        proc.stdin.close()
        time.sleep(1.0)
        assert proc.poll() is None, "closing stdin must not stop a manually run bridge"
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_callback_runs_on_eof_and_bytes_are_ignored(monkeypatch):
    import io
    import threading

    sys.path.insert(0, str(PYTHON_DIR))
    import parent_watchdog

    monkeypatch.setenv("CLAW_PARENT_WATCHDOG", "1")
    fired = threading.Event()
    thread = parent_watchdog.start_parent_watchdog(
        io.BytesIO(b"stray bytes"), on_parent_exit=fired.set
    )
    assert thread is not None
    assert fired.wait(timeout=5)


def test_disabled_returns_none(monkeypatch):
    sys.path.insert(0, str(PYTHON_DIR))
    import parent_watchdog

    monkeypatch.delenv("CLAW_PARENT_WATCHDOG", raising=False)
    assert parent_watchdog.start_parent_watchdog() is None
