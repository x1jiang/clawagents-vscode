"""Tests for grant path matching and path confinement helpers."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Allow importing sibling bridge modules when run as a script.
_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


class GrantPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "config.json").write_text("{}", encoding="utf-8")
        (self.root / "other").mkdir()
        (self.root / "other" / "config.json").write_text("{}", encoding="utf-8")
        os.environ["CLAW_WORKSPACE"] = str(self.root)
        os.environ["CLAWAGENTS_VSCODE_STATE_DIR"] = str(self.root / "user-state")
        # Fresh module imports so WORKSPACE picks up CLAW_WORKSPACE.
        for mod in ("paths", "grants", "pricing"):
            sys.modules.pop(mod, None)
        import paths as paths_mod  # noqa: WPS433
        import grants as grants_mod  # noqa: WPS433

        self.paths = paths_mod
        self.grants = grants_mod
        self.store = grants_mod.GrantStore()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_basename_grant_does_not_match_other_dirs(self) -> None:
        self.store.add(path_pattern="config.json", scope="write", tool="write_file")
        self.assertFalse(
            self.store.match("src/config.json", tool="write_file", scope="write"),
            "basename-only grant must not auto-allow every config.json",
        )
        self.assertFalse(
            self.store.match("other/config.json", tool="write_file", scope="write"),
        )

    def test_full_relative_path_grant_matches(self) -> None:
        self.store.add(path_pattern="src/config.json", scope="write", tool="write_file")
        self.assertTrue(self.store.match("src/config.json", tool="write_file", scope="write"))
        self.assertFalse(self.store.match("other/config.json", tool="write_file", scope="write"))

    def test_glob_matches_full_relative_only(self) -> None:
        self.store.add(path_pattern="src/*.json", scope="write", tool="*")
        self.assertTrue(self.store.match("src/config.json", tool="edit_file", scope="write"))
        self.assertFalse(self.store.match("other/config.json", tool="edit_file", scope="write"))

    def test_absolute_path_normalized_on_add(self) -> None:
        abs_path = str(self.root / "src" / "config.json")
        g = self.store.add(path_pattern=abs_path, scope="write", tool="write_file")
        self.assertEqual(g.path_pattern, "src/config.json")
        self.assertTrue(self.store.match(abs_path, tool="write_file", scope="write"))

    def test_under_workspace_rejects_escape(self) -> None:
        outside = Path(self._tmp.name).parent / "escape-target"
        # parent of TemporaryDirectory may vary; use a sibling under /tmp
        outside = Path(tempfile.gettempdir()) / f"claw-escape-{os.getpid()}"
        outside.mkdir(exist_ok=True)
        try:
            link = self.root / "link-out"
            try:
                link.symlink_to(outside)
            except OSError:
                self.skipTest("symlinks not available")
            self.assertFalse(self.paths.under_workspace(link))
            self.assertIsNone(self.paths.workspace_rel(str(link)))
        finally:
            try:
                outside.rmdir()
            except OSError:
                pass

    def test_atomic_write_uses_replace(self) -> None:
        target = self.root / ".clawagents" / "permission_grants.json"
        self.paths.atomic_write_json(target, [{"ok": True}])
        data = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(data, [{"ok": True}])
        # No leftover .tmp sibling from a fixed name
        self.assertFalse((target.parent / (target.name + ".tmp")).exists())

    def test_wildcard_grant_refused(self) -> None:
        with self.assertRaises(ValueError):
            self.store.add(path_pattern="*", scope="write", tool="*")

    def test_committed_wildcard_ignored_on_load(self) -> None:
        grants_path = self.root / ".clawagents" / "permission_grants.json"
        grants_path.parent.mkdir(parents=True, exist_ok=True)
        grants_path.write_text(
            json.dumps([{"path_pattern": "*", "scope": "write", "tool": "*", "granted_at": "x"}]),
            encoding="utf-8",
        )
        self.assertEqual(self.store.list(), [])
        self.assertFalse(self.store.match("src/config.json", tool="write_file", scope="write"))

    def test_committed_tool_grant_cannot_approve_execute(self) -> None:
        workspace_grants = self.root / ".clawagents" / "permission_grants.json"
        workspace_grants.parent.mkdir(parents=True, exist_ok=True)
        workspace_grants.write_text(
            json.dumps([{"path_pattern": "", "scope": "write", "tool": "execute"}]),
            encoding="utf-8",
        )
        self.assertFalse(self.store.match(None, tool="execute", scope="write"))
        self.assertFalse(self.paths.GRANTS_FILE.is_relative_to(self.root / ".clawagents"))

    def test_tool_only_grant(self) -> None:
        self.store.add(path_pattern="", scope="write", tool="execute")
        self.assertTrue(self.store.match(None, tool="execute", scope="write"))
        self.assertFalse(self.store.match(None, tool="write_file", scope="write"))
        self.assertFalse(self.store.match("src/config.json", tool="execute", scope="write"))

    def test_url_trust(self) -> None:
        for mod in ("url_trust",):
            sys.modules.pop(mod, None)
        import url_trust as ut  # noqa: WPS433

        self.assertTrue(ut.is_trusted_base_url(""))
        self.assertTrue(ut.is_trusted_base_url("http://127.0.0.1:11434/v1"))
        self.assertFalse(ut.is_trusted_base_url("https://evil.example/v1"))
        self.assertFalse(ut.is_trusted_base_url("http://169.254.169.254/"))

    def test_mcp_command_allowlist(self) -> None:
        for mod in ("mcp_loader",):
            sys.modules.pop(mod, None)
        import mcp_loader as ml  # noqa: WPS433

        self.assertTrue(ml._command_allowed("npx"))
        self.assertTrue(ml._command_allowed("/usr/bin/npx"))
        self.assertFalse(ml._command_allowed("/tmp/evil"))
        self.assertFalse(ml._command_allowed("bash"))
        self.assertTrue(ml._url_allowed("http://127.0.0.1:3100/sse"))
        self.assertFalse(ml._url_allowed("https://evil.example/sse"))

    def test_pricing_longest_prefix(self) -> None:
        for mod in ("pricing",):
            sys.modules.pop(mod, None)
        import pricing as pricing_mod  # noqa: WPS433

        self.assertEqual(pricing_mod.price_for("gpt-5.5-pro"), (30.0, 180.0))
        self.assertEqual(pricing_mod.price_for("gpt-5.5-pro-2026-01-01"), (30.0, 180.0))
        self.assertEqual(pricing_mod.price_for("gpt-5.4-mini-preview"), (0.75, 4.5))

    def test_pricing_bedrock_mantle_claude_opus(self) -> None:
        for mod in ("pricing",):
            sys.modules.pop(mod, None)
        import pricing as pricing_mod  # noqa: WPS433

        # Bedrock list: Opus 4.8 = $6 / $30 per 1M (aws.amazon.com/bedrock/pricing).
        self.assertEqual(
            pricing_mod.price_for("anthropic.claude-opus-4-8"), (6.0, 30.0)
        )
        self.assertEqual(
            pricing_mod.price_for("us.anthropic.claude-opus-4-8-20260501-v1:0"),
            (6.0, 30.0),
        )
        # Direct Anthropic API stays at $5 / $25.
        self.assertEqual(pricing_mod.price_for("claude-opus-4-8"), (5.0, 25.0))
        # Mantle OpenAI on Bedrock markup vs direct API.
        self.assertEqual(
            pricing_mod.price_for("openai.gpt-5.6-luna"), (1.1, 6.6)
        )
        self.assertEqual(pricing_mod.price_for("gpt-5.6-luna"), (1.0, 6.0))
        cost = pricing_mod.estimate_usd(
            "anthropic.claude-opus-4-8", prompt_tokens=1_000_000, completion_tokens=0
        )
        self.assertEqual(cost, 6.0)


if __name__ == "__main__":
    unittest.main()
