"""Rewind must not throw away what the abandoned attempt learned.

Without this, rewinding after a failed approach makes the agent re-derive —
and frequently re-attempt — exactly what just failed.
"""

from __future__ import annotations

import os
import tempfile
import unittest


class TestBranchSummary(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["CLAW_WORKSPACE"] = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_summary_captures_ask_result_and_failure(self):
        from chats import summarize_abandoned_branch

        note = summarize_abandoned_branch(
            [
                {"kind": "user", "text": "patch middleware.py to fix auth"},
                {"kind": "assistant", "text": "Short-circuited the session check."},
                {"kind": "error", "text": "TypeError: NoneType has no attribute 'user_id'"},
            ]
        )
        self.assertIn("patch middleware.py", note)
        self.assertIn("Short-circuited", note)
        self.assertIn("FAILED", note)
        self.assertIn("user_id", note)
        # The whole point: discourage a blind retry of the same approach.
        self.assertIn("Do not repeat", note)

    def test_empty_or_contentless_branch_yields_no_note(self):
        from chats import summarize_abandoned_branch

        self.assertEqual(summarize_abandoned_branch([]), "")
        self.assertEqual(
            summarize_abandoned_branch([{"kind": "done"}, {"kind": "status", "text": ""}]),
            "",
        )

    def test_long_branch_is_capped(self):
        from chats import summarize_abandoned_branch

        note = summarize_abandoned_branch(
            [{"kind": "assistant", "text": f"step {i}"} for i in range(50)]
        )
        # Capped, and keeps the most recent state rather than the oldest.
        self.assertLessEqual(note.count("- Result:"), 6)
        self.assertIn("step 49", note)

    def test_rewind_appends_the_note_to_the_surviving_branch(self):
        from chats import (
            append_ui_event,
            create_chat,
            read_ui_events,
            truncate_to_prompt_index,
        )

        chat_id = create_chat(mode="auto")["id"]
        for event in [
            {"kind": "user", "text": "add caching to the API"},
            {"kind": "assistant", "text": "Added an in-memory cache."},
            {"kind": "user", "text": "make it persistent with redis"},
            {"kind": "assistant", "text": "Wired redis into api/cache.py."},
            {"kind": "error", "text": "ConnectionRefusedError: redis not running"},
        ]:
            append_ui_event(chat_id, event)

        result = truncate_to_prompt_index(
            chat_id, 0, user_text="add caching to the API"
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["branch_summary"])

        events = read_ui_events(chat_id)
        notes = [e for e in events if e.get("branch_summary")]
        self.assertEqual(len(notes), 1)
        self.assertIn("redis", notes[0]["text"])
        self.assertIn("ConnectionRefusedError", notes[0]["text"])
        # The abandoned turns themselves are still gone.
        self.assertFalse(any(e.get("kind") == "assistant" and "redis" in str(e.get("text")) for e in events))

    def test_rewind_with_nothing_dropped_adds_no_note(self):
        from chats import (
            append_ui_event,
            create_chat,
            read_ui_events,
            truncate_to_prompt_index,
        )

        chat_id = create_chat(mode="auto")["id"]
        append_ui_event(chat_id, {"kind": "user", "text": "only turn"})
        truncate_to_prompt_index(chat_id, 0, user_text="only turn")
        events = read_ui_events(chat_id)
        self.assertFalse(any(e.get("branch_summary") for e in events))


if __name__ == "__main__":
    unittest.main()
