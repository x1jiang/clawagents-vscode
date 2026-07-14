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
    PERSISTED_KEYS,
    load_settings,
    set_runtime_trust,
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
        set_runtime_trust(
            {
                "trusted_custom_base_url": "",
                "mcp_trust_workspace": False,
                "allow_full_access": False,
                "allow_external_skill_dirs": False,
            }
        )

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
        self.assertEqual(set(raw.keys()), set(PERSISTED_KEYS))

    def test_untrusted_base_url_cleared_without_trust(self):
        out = save_settings({"base_url": "https://evil.example/v1"})
        self.assertEqual(out["base_url"], "")
        self.assertFalse(out["trust_custom_base_url"])

    def test_ssl_verify_false_persists(self):
        out = save_settings({"ssl_verify": False})
        self.assertIs(out["ssl_verify"], False)

    def test_repository_file_cannot_preapprove_gateway_or_mcp(self):
        self._settings_path.write_text(
            json.dumps(
                {
                    "base_url": "https://attacker.example/v1",
                    "trust_custom_base_url": True,
                    "mcp_trust_workspace": True,
                    "allow_full_access": True,
                    "allow_external_skill_dirs": True,
                }
            ),
            encoding="utf-8",
        )

        loaded = load_settings()
        self.assertEqual(loaded["base_url"], "https://attacker.example/v1")
        self.assertFalse(loaded["trust_custom_base_url"])
        self.assertFalse(loaded["mcp_trust_workspace"])
        self.assertFalse(loaded["allow_full_access"])
        self.assertFalse(loaded["allow_external_skill_dirs"])

    def test_runtime_gateway_grant_is_bound_to_approved_url(self):
        save_settings(
            {
                "base_url": "https://approved.example/v1",
                "trust_custom_base_url": True,
            }
        )
        self.assertTrue(load_settings()["trust_custom_base_url"])

        raw = json.loads(self._settings_path.read_text(encoding="utf-8"))
        self.assertNotIn("trust_custom_base_url", raw)
        raw["base_url"] = "https://swapped.example/v1"
        self._settings_path.write_text(json.dumps(raw), encoding="utf-8")
        self.assertFalse(load_settings()["trust_custom_base_url"])

    def test_mismatched_url_autosave_does_not_wipe_prior_gateway_grant(self):
        save_settings(
            {
                "base_url": "https://approved.example/v1",
                "trust_custom_base_url": True,
            }
        )
        # Repo (or prior commit) swapped the URL; effective trust is false, but
        # process memory must keep the approved endpoint across unrelated saves.
        raw = json.loads(self._settings_path.read_text(encoding="utf-8"))
        raw["base_url"] = "https://swapped.example/v1"
        self._settings_path.write_text(json.dumps(raw), encoding="utf-8")

        out = save_settings(
            {
                "base_url": "https://swapped.example/v1",
                "trust_custom_base_url": False,
                "wire_api": "responses",
            }
        )
        self.assertEqual(out["wire_api"], "responses")
        # Untrusted swapped URL is refused for persistence.
        self.assertEqual(out["base_url"], "")
        self.assertFalse(out["trust_custom_base_url"])
        self.assertEqual(
            settings_store.runtime_trust_snapshot()["trusted_custom_base_url"],
            "https://approved.example/v1",
        )

    def test_clearing_base_url_revokes_gateway_grant(self):
        save_settings(
            {
                "base_url": "https://approved.example/v1",
                "trust_custom_base_url": True,
            }
        )
        out = save_settings({"base_url": "", "trust_custom_base_url": False})
        self.assertEqual(out["base_url"], "")
        self.assertFalse(out["trust_custom_base_url"])
        self.assertEqual(
            settings_store.runtime_trust_snapshot()["trusted_custom_base_url"],
            "",
        )


if __name__ == "__main__":
    unittest.main()
