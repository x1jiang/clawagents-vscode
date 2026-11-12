"""Exit the sidecar when the extension host that spawned it goes away.

The extension normally stops the sidecar with SIGTERM. That never happens if
the extension host crashes, is force-quit, or is torn down before its
deactivate hook finishes — and the sidecar would then live on with provider
keys in its environment and possibly an agent mid-tool-run.

The extension holds the write end of this process's stdin and never writes to
it. When the host dies for any reason the OS closes that pipe, stdin reads
EOF, and the watchdog shuts the process down. This works the same on POSIX
and Windows and needs no polling.

Opt-in via ``CLAW_PARENT_WATCHDOG=1`` so running ``bridge.py`` by hand (stdin
a terminal, ``/dev/null``, or already closed) is unaffected.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
from typing import Any, Callable

ENV_FLAG = "CLAW_PARENT_WATCHDOG"
DEFAULT_GRACE_S = 3.0


def watchdog_enabled(env: Any = None) -> bool:
    source = os.environ if env is None else env
    return str(source.get(ENV_FLAG, "")).strip() == "1"


def _request_shutdown(grace_s: float) -> None:
    """Ask for a graceful stop, then force the exit if it does not happen."""
    killer = threading.Timer(grace_s, lambda: os._exit(0))
    killer.daemon = True
    killer.start()
    try:
        # uvicorn turns SIGTERM into a graceful shutdown. On Windows this
        # terminates the process outright, which is also what we want.
        os.kill(os.getpid(), signal.SIGTERM)
    except OSError:
        os._exit(0)


def start_parent_watchdog(
    stream: Any = None,
    *,
    on_parent_exit: Callable[[], None] | None = None,
    grace_s: float = DEFAULT_GRACE_S,
) -> threading.Thread | None:
    """Watch ``stream`` (default: stdin) for EOF on a daemon thread.

    Returns the thread, or ``None`` when the watchdog is disabled or there is
    no usable stdin. ``on_parent_exit`` replaces the default shutdown and
    exists for tests.
    """
    if not watchdog_enabled():
        return None
    if stream is None:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
    if stream is None:
        return None

    def _watch() -> None:
        try:
            while stream.read(4096):
                pass  # the host never writes; ignore anything that arrives
        except (OSError, ValueError):
            pass  # a broken or closed pipe also means the host is gone
        print("Extension host is gone (stdin closed); shutting down sidecar.", flush=True)
        if on_parent_exit is not None:
            on_parent_exit()
        else:
            _request_shutdown(grace_s)

    thread = threading.Thread(target=_watch, name="parent-watchdog", daemon=True)
    thread.start()
    return thread
