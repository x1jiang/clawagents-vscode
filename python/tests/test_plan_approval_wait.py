"""The plan approval waiter has to outlast a person reading a plan.

Two timeouts govern one wait: this waiter's, and the tool registry's ceiling for
human-gated tools. If the registry's fires first the model gets a generic "tool
timed out" and the plan is lost, so the ordering between them is load-bearing
rather than incidental.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import app as sidecar_app  # noqa: E402


class TestApprovalTimeoutOrdering(unittest.TestCase):
    def test_the_waiter_gives_up_before_the_registry_does(self):
        """So the reviewer's silence is reported as such, with a reason.

        Both numbers are defensible alone; only their order makes the failure
        legible to the model.
        """
        from clawagents.tools.registry import HUMAN_TOOL_TIMEOUT_S

        self.assertLess(sidecar_app.PLAN_APPROVAL_TIMEOUT_S, HUMAN_TOOL_TIMEOUT_S)

    def test_the_waiter_outlasts_the_default_tool_timeout(self):
        """The bug this replaced: a 120s default killing a human decision."""
        from clawagents.tools.registry import DEFAULT_TOOL_TIMEOUT_S

        self.assertGreater(sidecar_app.PLAN_APPROVAL_TIMEOUT_S, DEFAULT_TOOL_TIMEOUT_S)


class TestPlanApprovalWaiter(unittest.TestCase):
    def setUp(self) -> None:
        self.waiter = sidecar_app.PlanApprovalWaiter()

    def test_feedback_text_survives_the_round_trip(self):
        """The comment is the whole point of "request changes"; dropping it
        leaves the model knowing only that someone objected."""

        async def scenario():
            request_id = self.waiter.create()
            feedback = "Use the existing .venv; confirm the cohort count first."

            async def answer():
                await asyncio.sleep(0)
                self.waiter.resolve(request_id, "request_changes", comment=feedback)

            asyncio.ensure_future(answer())
            decision, comment = await self.waiter.wait(request_id, timeout=5)
            self.assertEqual(decision, "request_changes")
            self.assertEqual(comment, feedback)

        asyncio.run(scenario())

    def test_a_decision_that_lands_before_the_wait_is_not_lost(self):
        """The UI can answer faster than the tool gets around to waiting."""

        async def scenario():
            request_id = self.waiter.create()
            self.waiter.resolve(request_id, "approve", comment="looks right")
            decision, comment = await self.waiter.wait(request_id, timeout=5)
            self.assertEqual(decision, "approve")
            self.assertEqual(comment, "looks right")

        asyncio.run(scenario())

    def test_waiting_past_the_timeout_raises_rather_than_approving(self):
        """Failing open here would run an unreviewed plan."""

        async def scenario():
            request_id = self.waiter.create()
            with self.assertRaises(asyncio.TimeoutError):
                await self.waiter.wait(request_id, timeout=0.05)

        asyncio.run(scenario())

    def test_resolving_an_unknown_request_is_a_no_op(self):
        """A stale card in the UI must not raise inside the sidecar."""
        self.waiter.resolve("nosuchrequest", "approve")

    def test_a_timed_out_request_stops_being_pending(self):
        """This is what makes a leftover approval card stale rather than live:
        the id is gone, so a late click cannot resolve anything."""

        async def scenario():
            request_id = self.waiter.create()
            with self.assertRaises(asyncio.TimeoutError):
                await self.waiter.wait(request_id, timeout=0.05)
            self.assertNotIn(request_id, sidecar_app._plan_pending)
            self.waiter.resolve(request_id, "approve")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
