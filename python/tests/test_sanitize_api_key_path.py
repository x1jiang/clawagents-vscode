"""Path-like values must not be treated as API keys (Windows paste mistake)."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import providers  # noqa: E402
import spawn_secrets  # noqa: E402


class SanitizeApiKeyPathTests(unittest.TestCase):
    def test_rejects_windows_python_exe(self):
        path = r"C:\Users\alice\AppData\Local\Programs\Python\Python312\python.exe"
        self.assertEqual(providers._sanitize_api_key(path), "")
        self.assertTrue(providers._looks_like_filesystem_path(path))

    def test_rejects_unix_python(self):
        self.assertEqual(providers._sanitize_api_key("/usr/bin/python3"), "")
        self.assertEqual(providers._sanitize_api_key("/opt/homebrew/bin/python3.12"), "")

    def test_keeps_real_keys(self):
        self.assertEqual(providers._sanitize_api_key("sk-proj-abc123"), "sk-proj-abc123")
        self.assertEqual(providers._sanitize_api_key("sk-ant-api03-xyz"), "sk-ant-api03-xyz")

    def test_rejects_chat_paste(self):
        junk = "You\nCopy\nhi\nClawAgents\n[provider_auth] Authentication failed"
        self.assertEqual(providers._sanitize_api_key(junk), "")
        self.assertTrue(providers._looks_like_pasted_junk(junk))

    def test_snapshot_skips_path(self):
        path = r"C:\Users\bob\python.exe"
        with mock.patch.dict(
            os.environ,
            {"OPENAI_API_KEY": path, "ANTHROPIC_API_KEY": "sk-ant-ok"},
            clear=False,
        ):
            spawn_secrets.snapshot_spawn_secrets()
            self.assertEqual(spawn_secrets.get_secret("OPENAI_API_KEY"), "")
            self.assertEqual(spawn_secrets.get_secret("ANTHROPIC_API_KEY"), "sk-ant-ok")

    def test_snapshot_skips_chat_junk(self):
        junk = "You Copy " + ("x" * 20)
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": junk}, clear=False):
            spawn_secrets.snapshot_spawn_secrets()
            self.assertEqual(spawn_secrets.get_secret("OPENAI_API_KEY"), "")


if __name__ == "__main__":
    unittest.main()
