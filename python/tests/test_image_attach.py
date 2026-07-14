"""Sidecar image-attachment normalization (validation + caps)."""

from __future__ import annotations

from chats import (
    _MAX_IMAGES_PER_TURN,
    _MAX_IMAGE_B64_BYTES,
    _normalize_images,
)


def test_none_and_empty():
    assert _normalize_images(None) == []
    assert _normalize_images([]) == []
    assert _normalize_images("not a list") == []  # type: ignore[arg-type]


def test_keeps_valid_and_defaults_media_type():
    out = _normalize_images([{"data": "AAAA"}])
    assert out == [{"data": "AAAA", "media_type": "image/png"}]


def test_accepts_data_url_and_mime_aliases():
    out = _normalize_images(
        [
            {"url": "data:image/jpeg;base64,AAAA", "mime_type": "image/jpeg"},
        ]
    )
    assert out == [{"data": "data:image/jpeg;base64,AAAA", "media_type": "image/jpeg"}]


def test_drops_malformed_entries():
    out = _normalize_images(
        [
            {"data": ""},           # empty
            {"data": "   "},        # blank
            {"no_data": "x"},       # missing
            "not a dict",           # wrong type
            {"data": 123},          # non-string
            {"data": "GOOD"},       # kept
        ]
    )
    assert out == [{"data": "GOOD", "media_type": "image/png"}]


def test_caps_count():
    many = [{"data": f"img{i}"} for i in range(_MAX_IMAGES_PER_TURN + 5)]
    assert len(_normalize_images(many)) == _MAX_IMAGES_PER_TURN


def test_rejects_oversized_payload():
    huge = "A" * (_MAX_IMAGE_B64_BYTES + 1)
    assert _normalize_images([{"data": huge}]) == []


def test_cap_covers_extension_ten_mib_decoded_limit():
    ten_mib_as_base64 = ((10 * 1024 * 1024 + 2) // 3) * 4
    assert _MAX_IMAGE_B64_BYTES >= ten_mib_as_base64
