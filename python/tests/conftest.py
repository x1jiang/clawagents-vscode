"""Prefer monorepo clawagents_py when developing beside this extension."""

from __future__ import annotations

import sys
from pathlib import Path

_monorepo = Path(__file__).resolve().parents[3] / "clawagents_py" / "src"
if _monorepo.is_dir():
    p = str(_monorepo)
    if p not in sys.path:
        sys.path.insert(0, p)
