"""Curated catalog ∩ live /models for faithful OpenAI dropdowns."""

from __future__ import annotations

import unittest
from pathlib import Path
import sys

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import providers  # noqa: E402


class TestMergeCuratedWithRemote(unittest.TestCase):
    def test_keeps_curated_order_for_listed_ids(self) -> None:
        curated = [
            {"id": "gpt-5.6-luna", "label": "GPT-5.6 Luna"},
            {"id": "gpt-5.6-sol", "label": "GPT-5.6 Sol"},
            {"id": "gpt-4o", "label": "GPT-4o"},
        ]
        remote = [
            {"id": "gpt-4o", "label": "gpt-4o"},
            {"id": "gpt-5.6-luna", "label": "gpt-5.6-luna"},
        ]
        out = providers._merge_curated_with_remote(curated, remote)
        self.assertEqual([m["id"] for m in out], ["gpt-5.6-luna", "gpt-4o"])
        self.assertEqual(out[0]["label"], "GPT-5.6 Luna")

    def test_falls_back_when_no_overlap(self) -> None:
        curated = [{"id": "gpt-5.6-luna", "label": "GPT-5.6 Luna"}]
        remote = [{"id": "davinci-002", "label": "davinci-002"}]
        out = providers._merge_curated_with_remote(curated, remote)
        self.assertEqual(out, curated)


if __name__ == "__main__":
    unittest.main()
