"""Sidecar transport totals stay consistent with provider cache and run counters."""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chats
from clawagents.stream_events import stream_event_from_kind


def test_usage_aliases_do_not_lose_cached_prompt_tokens():
    event = stream_event_from_kind(
        "usage",
        {
            "prompt_tokens": 1000,
            "input_tokens": 100,
            "cached_input_tokens": 800,
            "cache_creation_tokens": 100,
        },
    )
    assert chats._ev_usage_int(event, "prompt_tokens", "input_tokens") == 1000
    legacy = stream_event_from_kind("usage", {"input_tokens": 1000})
    assert chats._ev_usage_int(legacy, "prompt_tokens", "input_tokens") == 1000
    assert (
        chats._ev_usage_int(
            SimpleNamespace(data={"cache_write_tokens": 100}),
            "cache_creation_tokens",
            "cache_write_tokens",
        )
        == 100
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_turn_stream_final_and_persisted_usage_agree(
    monkeypatch, tmp_path, legacy
):
    meta = {
        "id": "usage-test",
        "session_cost_usd": 0,
        "model_route": {"provider": "openai", "model": "gpt-4o"},
    }
    persisted = []
    events = []
    patches = []
    monkeypatch.setattr(chats, "WORKSPACE", tmp_path)
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "get_chat", lambda _: meta)
    monkeypatch.setattr(
        chats,
        "patch_chat",
        lambda _, **fields: patches.append(fields) or {**meta, **fields},
    )
    monkeypatch.setattr(
        chats, "append_ui_event", lambda _, event: persisted.append(event) or 0
    )
    monkeypatch.setattr(
        chats,
        "load_settings",
        lambda: {
            "context_mode": False,
            "mcp_enabled": False,
            "provider": "openai",
            "model": "gpt-4o",
        },
    )
    monkeypatch.setattr(chats, "_resolve_model_kwargs", lambda *args: {})
    monkeypatch.setattr(
        chats, "build_augmented_task", lambda _, content, settings: content
    )
    monkeypatch.setattr(chats, "apply_scoped_pinned_context", lambda *args: None)
    monkeypatch.setattr("skills_catalog.resolve_skill_dir_paths", lambda _: [])
    efficiency = {"round_trips_avoided": 1, "compactions": {"micro": 2}}

    class Agent:
        tools = SimpleNamespace(tools={})
        after_tool = None

        async def invoke(self, task, on_stream_event, **kwargs):
            for _ in range(2):
                data = {
                    "prompt_tokens": 1000,
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "total_tokens": 1020,
                    "cached_input_tokens": 800,
                    "cache_creation_tokens": 100,
                }
                if legacy:
                    data.pop("prompt_tokens")
                    data["input_tokens"] = 1000
                else:
                    data["efficiency"] = efficiency
                on_stream_event(stream_event_from_kind("usage", data))
            if not legacy:
                on_stream_event(
                    stream_event_from_kind("efficiency", {"efficiency": efficiency})
                )
            result = SimpleNamespace(status="done", result="ok", iterations=2)
            if not legacy:
                result.efficiency = efficiency
            return result

    def factory(workspace=None):
        return Agent()

    monkeypatch.setattr("clawagents.agent.create_claw_agent", factory)
    result = await chats.run_chat_turn(
        chat_id="usage-test",
        content="task",
        mode="auto",
        model="gpt-4o",
        on_event=lambda k, d: events.append((k, d)),
        before_tool_factory=lambda **kwargs: lambda *args: None,
        cancel_check=lambda: False,
        caveman=False,
    )
    usage = result["usage"]
    assert usage["prompt_tokens"] == 2000
    assert usage["cached_input_tokens"] == 1600
    assert usage["cache_creation_tokens"] == 200
    assert usage["last_input_tokens"] == 1000
    assert usage["request_count"] == 2
    assert patches[-1]["session_prompt_tokens"] == usage["session_prompt_tokens"]
    assert persisted[-1]["usage"] == usage
    if legacy:
        assert "efficiency" not in usage
    else:
        assert usage["efficiency"] == efficiency
        assert [d for k, d in events if k == "efficiency"] == [
            {"efficiency": efficiency}
        ]


@pytest.mark.parametrize(
    "payload, changed",
    [
        ({"success": False, "mutation_success": True}, True),
        ({"success": False, "mutation_success": False}, False),
        ({"success": True}, True),
        ({"success": False}, False),
    ],
)
def test_fused_validation_failure_keeps_changed_file_signal(payload, changed):
    assert chats.tool_mutation_succeeded(payload) is changed
