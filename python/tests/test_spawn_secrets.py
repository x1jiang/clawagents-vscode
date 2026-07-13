"""Tests for spawn_secrets snapshot / restore."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import spawn_secrets  # noqa: E402


class TestSpawnSecrets(unittest.TestCase):
    def test_restore_beats_dotenv_pollution(self):
        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "secret-storage-key"},
            clear=False,
        ):
            spawn_secrets.snapshot_spawn_secrets()
            os.environ["OPENAI_API_KEY"] = "from-dotenv"
            spawn_secrets.restore_spawn_secrets()
            self.assertEqual(os.environ["OPENAI_API_KEY"], "secret-storage-key")


if __name__ == "__main__":
    unittest.main()
