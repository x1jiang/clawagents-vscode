"""Manual Compact must free context even after a prior compact left ≤7 lines."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import chats


def _write_session(mem: Path, messages: list[dict]) -> None:
    mem.parent.mkdir(parents=True, exist_ok=True)
    mem.write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in messages) + "\n",
        encoding="utf-8",
    )


def test_compact_skips_only_when_truly_small(tmp_path, monkeypatch):
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "append_ui_event", lambda *_a, **_k: None)
    monkeypatch.setattr(chats, "load_settings", lambda: {"model": ""})

    mem = tmp_path / "c1.jsonl"
    _write_session(
        mem,
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ],
    )
    res = asyncio.run(chats.compact_chat("c1"))
    assert res["compacted"] is False
    assert "not enough history" in res["reason"]


def test_compact_trims_fat_payloads_when_few_lines(tmp_path, monkeypatch):
    """Regression: after head/tail compact left 7 lines, Compact refused.

    Fat tool dumps must still be truncatable so the button works when the
    meter shows 100% from the last Goal turn.
    """
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "append_ui_event", lambda *_a, **_k: None)
    monkeypatch.setattr(chats, "load_settings", lambda: {"model": ""})

    fat = "TOOL_DUMP " * 2000  # ~20k chars
    msgs = [
        {"role": "user", "content": "review this"},
        {"role": "assistant", "content": "", "tool_calls_meta": [{"name": "execute", "id": "1"}]},
        {"role": "tool", "content": fat, "tool_call_id": "1"},
        {"role": "user", "content": "[Compacted conversation] stub"},
        {"role": "assistant", "content": "", "tool_calls_meta": [{"name": "execute", "id": "2"}]},
        {"role": "tool", "content": fat, "tool_call_id": "2"},
        {"role": "assistant", "content": "done"},
    ]
    assert len(msgs) < 8
    _write_session(tmp_path / "c2.jsonl", msgs)

    res = asyncio.run(chats.compact_chat("c2"))
    assert res["compacted"] is True
    assert res["est_tokens_after"] < res["est_tokens_before"]
    assert res.get("meter_reset") is True

    after = [
        json.loads(ln)
        for ln in (tmp_path / "c2.jsonl").read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    tool_lens = [len(m["content"]) for m in after if m.get("role") == "tool"]
    assert tool_lens
    assert max(tool_lens) < len(fat)


def test_compact_drops_middle_turns_when_long(tmp_path, monkeypatch):
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "append_ui_event", lambda *_a, **_k: None)
    monkeypatch.setattr(chats, "load_settings", lambda: {"model": ""})

    msgs = [{"role": "user", "content": f"m{i}"} for i in range(20)]
    _write_session(tmp_path / "c3.jsonl", msgs)
    res = asyncio.run(chats.compact_chat("c3"))
    assert res["compacted"] is True
    assert res["after"] < res["before"]
    assert res["after"] == 7  # head2 + stub + tail4


def test_compact_rejects_growth(tmp_path, monkeypatch):
    """Compaction that would enlarge stored tokens must keep the original."""
    monkeypatch.setattr(chats, "SESSIONS_MEMORY_DIR", tmp_path)
    monkeypatch.setattr(chats, "ensure_dirs", lambda: None)
    monkeypatch.setattr(chats, "append_ui_event", lambda *_a, **_k: None)
    monkeypatch.setattr(chats, "load_settings", lambda: {"model": "gpt-5.6-luna"})
    monkeypatch.setattr(chats, "get_chat", lambda _cid: {"session_cost_usd": 0.0})
    patched: dict = {}

    def _patch(cid: str, **fields: object) -> dict:
        patched.update(fields)
        return {"id": cid, **fields}

    monkeypatch.setattr(chats, "patch_chat", _patch)

    # Already-compact shape: few short messages. Force LLM path to return a
    # huge "summary" that would grow the file if accepted.
    msgs = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
        {"role": "user", "content": "e"},
        {"role": "assistant", "content": "f"},
        {"role": "user", "content": "g"},
        {"role": "assistant", "content": "h"},
        {"role": "user", "content": "i"},
    ]
    mem = tmp_path / "c4.jsonl"
    _write_session(mem, msgs)
    original = mem.read_text(encoding="utf-8")

    class _Resp:
        content = "X" * 20_000
        prompt_tokens = 500
        completion_tokens = 200
        cached_input_tokens = 0
        cache_creation_tokens = 0
        model = "gpt-5.6-luna"

    class _Prov:
        async def chat(self, **_kwargs):
            return _Resp()

    import types

    fake_llm = types.SimpleNamespace(
        LLMMessage=lambda **kw: types.SimpleNamespace(**kw),
        create_provider=lambda *_a, **_k: _Prov(),
    )
    fake_cfg = types.SimpleNamespace(load_config=lambda: {})

    import sys

    monkeypatch.setitem(sys.modules, "clawagents.config.config", fake_cfg)
    monkeypatch.setitem(sys.modules, "clawagents.providers.llm", fake_llm)

    res = asyncio.run(chats.compact_chat("c4"))
    assert res["compacted"] is False
    assert res.get("rejected_growth") is True
    assert res.get("meter_reset") is False
    assert mem.read_text(encoding="utf-8") == original
    # Summarizer usage still recorded / charged.
    assert res.get("usage", {}).get("prompt_tokens") == 500
    assert res.get("compact_cost_usd") is not None
    assert res["compact_cost_usd"] > 0
    assert patched.get("session_cost_usd", 0) > 0
