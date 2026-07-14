"""Regression tests for the reusable skill catalog snapshot."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import skills_catalog as sc  # noqa: E402


class _FakeSkillStore:
    load_count = 0

    def __init__(self):
        self._dirs: list[str] = []
        self.ineligible = {}
        self.warnings = []
        self.quarantined = {}

    def add_directory(self, directory: str) -> None:
        self._dirs.append(directory)

    async def load_all(self) -> None:
        type(self).load_count += 1

    def list(self):
        path = Path(self._dirs[0]) / "demo" / "SKILL.md"
        return [SimpleNamespace(name="demo", description="Demo", path=path)]


class TestSkillCatalogCache(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        skill = self.root / "demo" / "SKILL.md"
        skill.parent.mkdir()
        skill.write_text("---\nname: demo\ndescription: Demo\n---\nBody one\n", encoding="utf-8")
        _FakeSkillStore.load_count = 0
        sc.clear_skill_catalog_cache()

    def tearDown(self):
        sc.clear_skill_catalog_cache()
        self._tmp.cleanup()

    def test_unchanged_snapshot_reuses_loaded_catalog(self):
        with patch("clawagents.tools.skills.SkillStore", _FakeSkillStore):
            first = sc._scan_skills([str(self.root)])
            first[0][0]["description"] = "caller mutation"
            second = sc._scan_skills([str(self.root)])

        self.assertEqual(_FakeSkillStore.load_count, 1)
        self.assertEqual(second[0][0]["description"], "Demo")

    def test_changed_skill_invalidates_snapshot(self):
        skill = self.root / "demo" / "SKILL.md"
        with patch("clawagents.tools.skills.SkillStore", _FakeSkillStore):
            sc._scan_skills([str(self.root)])
            skill.write_text(
                "---\nname: demo\ndescription: Demo\n---\nBody changed and longer\n",
                encoding="utf-8",
            )
            os.utime(skill, None)
            sc._scan_skills([str(self.root)])

        self.assertEqual(_FakeSkillStore.load_count, 2)


if __name__ == "__main__":
    unittest.main()
