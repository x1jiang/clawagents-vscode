"""Sidecar file-attachment normalization (validation + caps + name hygiene)."""

from __future__ import annotations

from chats import (
    _MAX_FILES_PER_TURN,
    _MAX_FILE_B64_BYTES,
    _normalize_files,
)


def test_none_and_empty():
    assert _normalize_files(None) == []
    assert _normalize_files([]) == []
    assert _normalize_files("not a list") == []  # type: ignore[arg-type]


def test_keeps_valid_and_defaults_media_type():
    out = _normalize_files([{"data": "AAAA", "name": "r.pdf"}])
    assert out == [{"data": "AAAA", "media_type": "application/pdf", "name": "r.pdf"}]


def test_accepts_mime_type_alias():
    docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    out = _normalize_files([{"data": "AAAA", "mime_type": docx, "name": "n.docx"}])
    assert out[0]["media_type"] == docx


def test_name_reduced_to_safe_basename():
    out = _normalize_files(
        [
            {"data": "AAAA", "name": "../../etc/passwd.pdf"},
            {"data": "BBBB", "name": "dir\\sub\\report.pdf"},
            {"data": "CCCC", "name": "bad\x00name\x1f.pdf"},
            {"data": "DDDD"},  # missing name
        ]
    )
    assert out[0]["name"] == "passwd.pdf"
    assert out[1]["name"] == "report.pdf"
    assert "\x00" not in out[2]["name"] and "\x1f" not in out[2]["name"]
    assert out[3]["name"] == "attachment"
    (long,) = _normalize_files([{"data": "EEEE", "name": "x" * 500}])
    assert len(long["name"]) <= 120


def test_drops_malformed_entries():
    out = _normalize_files(
        [
            {"data": ""},
            {"data": "   "},
            {"no_data": "x"},
            "not a dict",
            {"data": 123},
            {"data": "GOOD", "name": "ok.pdf"},
        ]
    )
    assert len(out) == 1
    assert out[0]["data"] == "GOOD"


def test_caps_count():
    many = [{"data": f"f{i}", "name": f"{i}.pdf"} for i in range(_MAX_FILES_PER_TURN + 3)]
    assert len(_normalize_files(many)) == _MAX_FILES_PER_TURN


def test_rejects_oversized_payload():
    huge = "A" * (_MAX_FILE_B64_BYTES + 1)
    assert _normalize_files([{"data": huge, "name": "big.pdf"}]) == []
