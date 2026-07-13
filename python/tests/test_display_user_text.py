"""UI chat history must not store auto-injected editor context."""

from __future__ import annotations

from chats import display_user_text


def test_display_user_text_strips_editor_context():
    raw = (
        "Hi\n\n---\nEditor context:\nActive file: .env:7\n\n"
        "Nearby code (±20 lines):\n```\nSECRET=1\n```"
    )
    assert display_user_text(raw) == "Hi"


def test_display_user_text_leaves_plain_messages():
    assert display_user_text("Just a question") == "Just a question"
    assert display_user_text("") == ""
