"""Tests for settings_store sanitize / round-trip / trust behavior."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import settings_store  # noqa: E402
from settings_store import (  # noqa: E402
    DEFAULTS,
    KNOWN_KEYS,
    load_settings,
    sanitize_patch,
    save_settings,
)


class TestSanitizePatch(unittest.TestCase):
    def test_keeps_known_drops_unknown(self):
        clean, dropped = sanitize_patch(
            {"wire_api": "responses", "not_a_real_key": 1, "_internal": True}
        )
        self.assertEqual(clean, {"wire_api": "responses"})
        self.assertEqual(dropped, ["not_a_real_key"])

    def test_non_dict(self):
        clean, dropped = sanitize_patch(None)  # type: ignore[arg-type]
        self.assertEqual(clean, {})
        self.assertEqual(dropped, [])


class TestSettingsRoundTrip(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._settings_path = Path(self._tmp.name) / "vscode_settings.json"
        self._patcher = patch.object(settings_store, "SETTINGS_FILE", self._settings_path)
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()
        self._tmp.cleanup()

    def test_every_default_key_round_trips(self):
        # Build a patch that differs from defaults for every key.
        patch: dict = {}
        for key, default in DEFAULTS.items():
            if isinstance(default, bool):
                patch[key] = not default
            elif isinstance(default, list):
                patch[key] = ["one", "two"]
            elif key == "wire_api":
                patch[key] = "responses"
            elif key == "reasoning_effort":
                patch[key] = "high"
            elif key == "provider":
                patch[key] = "openai"
            elif key == "action_mode":
                patch[key] = "code"
            elif key == "base_url":
                # localhost is trusted without trust_custom_base_url
                patch[key] = "http://127.0.0.1:11434/v1"
            else:
                patch[key] = f"val-{key}"

        out = save_settings(patch)
        for key in DEFAULTS:
            self.assertIn(key, out)
            self.assertEqual(out[key], patch[key], msg=f"round-trip failed for {key}")

        # Reload from disk
        reloaded = load_settings()
        for key in DEFAULTS:
            self.assertEqual(reloaded[key], patch[key], msg=f"disk reload failed for {key}")

    def test_partial_wire_api_preserves_base_url_and_trust(self):
        save_settings(
            {
                "base_url": "https://gateway.example.edu:7782/v1",
                "trust_custom_base_url": True,
                "ssl_verify": False,
                "provider": "openai",
            }
        )
        out = save_settings({"wire_api": "responses", "reasoning_effort": "high"})
        self.assertEqual(out["wire_api"], "responses")
        self.assertEqual(out["reasoning_effort"], "high")
        self.assertEqual(out["base_url"], "https://gateway.example.edu:7782/v1")
        self.assertTrue(out["trust_custom_base_url"])
        self.assertFalse(out["ssl_verify"])
        self.assertEqual(out["provider"], "openai")

    def test_unknown_keys_not_persisted(self):
        save_settings({"wire_api": "responses", "evil": "nope"})
        raw = json.loads(self._settings_path.read_text(encoding="utf-8"))
        self.assertNotIn("evil", raw)
        self.assertEqual(raw["wire_api"], "responses")
        self.assertEqual(set(raw.keys()), set(KNOWN_KEYS))

    def test_untrusted_base_url_cleared_without_trust(self):
        out = save_settings({"base_url": "https://evil.example/v1"})
        self.assertEqual(out["base_url"], "")
        self.assertFalse(out["trust_custom_base_url"])

    def test_ssl_verify_false_persists(self):
        out = save_settings({"ssl_verify": False})
        self.assertIs(out["ssl_verify"], False)


if __name__ == "__main__":
    unittest.main()
