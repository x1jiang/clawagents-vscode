"""Background job attribution survives the turn that started it.

The sidecar builds a fresh agent — and therefore a fresh tool registry — for
every turn, while background jobs deliberately outlive their turn. Without
re-attributing them, a job that finishes between turns is owned by nobody and
its completion is never announced to the model, which is how a long run's
result quietly disappears.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import jobs  # noqa: E402


class _FakeRegistry:
    """Stands in for clawagents ToolRegistry ownership bookkeeping."""

    def __init__(self, owned: set[str] | None = None) -> None:
        self._owned = set(owned or ())

    def owned_job_ids(self) -> set[str]:
        return set(self._owned)

    def adopt_owned_jobs(self, ids) -> None:
        self._owned.update(str(i) for i in ids)


class _LegacyRegistry:
    """An older clawagents wheel without the ownership methods."""


def _manager():
    from clawagents.tools.background_task import create_background_task_tools

    return next(
        m
        for m in (getattr(t, "_manager", None) for t in create_background_task_tools())
        if m is not None
    )


class TestAttribution(unittest.TestCase):
    def setUp(self) -> None:
        jobs.reset_for_tests()

    def test_harvest_then_attach_carries_a_job_across_turns(self):
        async def scenario():
            mgr = _manager()
            job = await mgr.start(["/bin/sh", "-c", "sleep 5"])
            try:
                first_turn = _FakeRegistry({job.id})
                jobs.harvest_registry(first_turn, "chat-1")

                next_turn = _FakeRegistry()
                jobs.attach_registry(next_turn, "chat-1")
                self.assertIn(job.id, next_turn.owned_job_ids())
            finally:
                await mgr.cancel(job.id)

        asyncio.run(scenario())

    def test_a_job_is_not_leaked_to_another_chat(self):
        async def scenario():
            mgr = _manager()
            job = await mgr.start(["/bin/sh", "-c", "sleep 5"])
            try:
                jobs.harvest_registry(_FakeRegistry({job.id}), "chat-1")
                other = _FakeRegistry()
                jobs.attach_registry(other, "chat-2")
                self.assertEqual(other.owned_job_ids(), set())
            finally:
                await mgr.cancel(job.id)

        asyncio.run(scenario())

    def test_ids_the_manager_forgot_are_not_re_adopted(self):
        """Claiming a dead id would make every completion check a lookup miss."""
        jobs.remember("chat-1", {"no-such-job"})
        registry = _FakeRegistry()
        jobs.attach_registry(registry, "chat-1")
        self.assertEqual(registry.owned_job_ids(), set())
        self.assertEqual(jobs.known_for("chat-1"), set())

    def test_older_clawagents_without_ownership_api_is_tolerated(self):
        """The extension ships ahead of the pinned wheel; this must not raise."""
        jobs.harvest_registry(_LegacyRegistry(), "chat-1")
        jobs.attach_registry(_LegacyRegistry(), "chat-1")

    def test_remember_ignores_blank_ids(self):
        jobs.remember("chat-1", {"", "   "})
        self.assertEqual(jobs.known_for("chat-1"), set())


class TestSnapshot(unittest.TestCase):
    def setUp(self) -> None:
        jobs.reset_for_tests()

    def test_running_job_is_reported_with_a_readable_command(self):
        async def scenario():
            mgr = _manager()
            job = await mgr.start(["/bin/sh", "-c", "sleep 5"])
            try:
                jobs.remember("chat-1", {job.id})
                snap = jobs.snapshot("chat-1")
                mine = [j for j in snap["jobs"] if j["job_id"] == job.id]
                self.assertEqual(len(mine), 1)
                # The /bin/sh -c wrapper is noise; show what was actually run.
                self.assertEqual(mine[0]["command"], "sleep 5")
                self.assertTrue(mine[0]["running"])
                self.assertGreaterEqual(snap["running"], 1)
            finally:
                await mgr.cancel(job.id)

        asyncio.run(scenario())

    def test_a_labelled_job_shows_the_command_as_typed(self):
        """The row a user actually sees, since `execute` always labels.

        Its argv is a session wrapper: a cd, the command, then trailers that
        echo cwd and env back. Unwrapping `sh -c` is not enough there -- the
        row would open on a cd and get truncated before the real command.
        """

        async def scenario():
            mgr = _manager()
            wrapped = (
                "cd /tmp || exit 121; uv run pytest -q\n"
                "__claw_ec=$?; printf '%s%s\\n' '__CLAW_PWD__' \"$(pwd -P)\""
            )
            job = await mgr.start(
                ["/bin/sh", "-c", wrapped], label="uv run pytest -q"
            )
            try:
                jobs.remember("chat-1", {job.id})
                row = next(
                    j for j in jobs.snapshot("chat-1")["jobs"] if j["job_id"] == job.id
                )
                self.assertEqual(row["command"], "uv run pytest -q")
            finally:
                await mgr.cancel(job.id)

        asyncio.run(scenario())

    def test_finished_job_reports_its_exit_code_and_output(self):
        async def scenario():
            mgr = _manager()
            job = await mgr.start(["/bin/sh", "-c", "echo done; exit 4"])
            await mgr.await_complete(job.id, timeout=10)
            jobs.remember("chat-1", {job.id})

            detail = jobs.output(job.id)
            self.assertEqual(detail["exit_code"], 4)
            self.assertFalse(detail["running"])
            self.assertIn("done", detail["stdout"])

        asyncio.run(scenario())

    def test_output_for_unknown_job_raises_keyerror(self):
        with self.assertRaises(KeyError):
            jobs.output("nope")

    def test_stop_cancels_a_running_job(self):
        async def scenario():
            mgr = _manager()
            job = await mgr.start(["/bin/sh", "-c", "sleep 30"])
            summary = await jobs.stop(job.id)
            self.assertTrue(summary["cancelled"])
            self.assertFalse(mgr.status(job.id).running)

        asyncio.run(scenario())


class TestPinnedContext(unittest.TestCase):
    def test_round_trip_and_rules_discovery(self):
        import tempfile

        from clawagents.memory.rules import (
            discover_rule_paths,
            read_pinned_context,
            write_pinned_context,
        )

        with tempfile.TemporaryDirectory() as tmp:
            write_pinned_context("use .venv311", tmp)
            self.assertIn("use .venv311", read_pinned_context(tmp))
            # Always-on: it must be a discovered rules source, not a one-shot.
            self.assertTrue(discover_rule_paths(tmp))


if __name__ == "__main__":
    unittest.main()
