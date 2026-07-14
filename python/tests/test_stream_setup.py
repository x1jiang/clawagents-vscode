"""Integration regression tests for stream request setup."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_invalid_chat_id_does_not_leak_active_run(tmp_path: Path) -> None:
    project = Path(__file__).resolve().parents[2]
    script = r'''
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "python"))
monorepo = Path.cwd().parent / "clawagents_py" / "src"
if monorepo.is_dir():
    sys.path.insert(0, str(monorepo))
import app
from fastapi.testclient import TestClient
client = TestClient(app.create_app())
before = len(app._active_runs)
response = client.post(
    "/chat/stream",
    headers={"Authorization": "Bearer review-token"},
    json={"task": "x", "chat_id": "../bad"},
)
after = len(app._active_runs)
assert response.status_code == 400, response.text
assert (before, after) == (0, 0), (before, after)
'''
    env = {
        **os.environ,
        "GATEWAY_API_KEY": "review-token",
        "CLAW_WORKSPACE": str(tmp_path),
        "CLAWAGENTS_VSCODE_STATE_DIR": str(tmp_path / "user-state"),
    }
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=project,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
