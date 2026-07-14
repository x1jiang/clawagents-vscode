"""Security regression tests for checkpoint conversation restoration."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _reload_snapshots(tmp_path: Path):
    os.environ["CLAW_WORKSPACE"] = str(tmp_path)
    for name in ("paths", "chats", "snapshots"):
        sys.modules.pop(name, None)
    import snapshots  # noqa: WPS433

    return snapshots


def test_checkpoint_restore_rejects_traversal_chat_id(tmp_path: Path) -> None:
    snapshots = _reload_snapshots(tmp_path)
    result = snapshots.restore_shadow_checkpoint(
        "deadbeef", mode="conversation", chat_id="../../outside"
    )
    assert result["ok"] is False
    assert "invalid chat_id" in result["error"]


def test_checkpoint_restore_accepts_safe_chat_id_path(tmp_path: Path) -> None:
    snapshots = _reload_snapshots(tmp_path)
    session_path, ui_path = snapshots._checkpoint_chat_paths("chat_safe-1")
    assert session_path.parent == snapshots.SESSIONS_MEMORY_DIR
    assert session_path.name == "chat_safe-1.jsonl"
    assert ui_path.name == "chat_safe-1.ui.jsonl"
