"""UI Plan is the only mode allowed to expose the plan lifecycle."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from chats import (  # noqa: E402
    _PLAN_ONLY_TOOL_NAMES,
    _plan_approval_for_ui_mode,
    _restrict_plan_tools_to_ui_mode,
)


class _Registry:
    def __init__(self, *, active: set[str] | None = None) -> None:
        self.tools = {
            name: SimpleNamespace(name=name)
            for name in {*_PLAN_ONLY_TOOL_NAMES, "read_file", "edit_file"}
        }
        self._active = None if active is None else set(active)
        self._description_cache = "cached"

    def active_tool_names(self) -> set[str] | None:
        return None if self._active is None else set(self._active)

    def set_active_tools(self, names: set[str]) -> None:
        self._active = set(names)

    def list_registered(self):
        return list(self.tools.values())


class TestPlanModeScope(unittest.TestCase):
    def test_only_explicit_ui_plan_receives_the_human_approval_callback(self):
        callback = object()

        self.assertIs(_plan_approval_for_ui_mode("read_only", callback), callback)
        for mode in ("ask", "auto", "full_access"):
            with self.subTest(mode=mode):
                self.assertIsNone(_plan_approval_for_ui_mode(mode, callback))

    def test_explicit_ui_plan_keeps_the_full_plan_lifecycle(self):
        registry = _Registry()
        _restrict_plan_tools_to_ui_mode(SimpleNamespace(tools=registry), "read_only")

        self.assertTrue(_PLAN_ONLY_TOOL_NAMES.issubset(registry.tools))
        self.assertIsNone(registry.active_tool_names())
        self.assertEqual(registry._description_cache, "cached")

    def test_act_removes_plan_tools_from_registration_and_active_schema(self):
        registry = _Registry()
        agent = SimpleNamespace(tools=registry, _default_permission_mode="plan")
        _restrict_plan_tools_to_ui_mode(agent, "auto")

        self.assertTrue(_PLAN_ONLY_TOOL_NAMES.isdisjoint(registry.tools))
        self.assertTrue(_PLAN_ONLY_TOOL_NAMES.isdisjoint(registry.active_tool_names() or set()))
        self.assertEqual(registry.active_tool_names(), {"read_file", "edit_file"})
        self.assertIsNone(registry._description_cache)
        self.assertIsNone(agent._default_permission_mode)

    def test_non_plan_permission_override_is_preserved(self):
        registry = _Registry()
        agent = SimpleNamespace(tools=registry, _default_permission_mode="acceptEdits")

        _restrict_plan_tools_to_ui_mode(agent, "auto")

        self.assertEqual(agent._default_permission_mode, "acceptEdits")

    def test_goal_and_full_access_cannot_retain_profiled_plan_tools(self):
        for mode in ("ask", "full_access"):
            with self.subTest(mode=mode):
                registry = _Registry(
                    active={"read_file", "edit_file", *_PLAN_ONLY_TOOL_NAMES}
                )
                _restrict_plan_tools_to_ui_mode(SimpleNamespace(tools=registry), mode)

                self.assertTrue(_PLAN_ONLY_TOOL_NAMES.isdisjoint(registry.tools))
                self.assertEqual(registry.active_tool_names(), {"read_file", "edit_file"})


if __name__ == "__main__":
    unittest.main()
