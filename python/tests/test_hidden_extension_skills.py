"""Extension-banned skills must not appear in Settings preview."""

from __future__ import annotations

import skills_catalog


def test_openviking_hidden_from_preview(monkeypatch):
    monkeypatch.setattr(
        skills_catalog,
        "_scan_skills",
        lambda _dirs: (
            [
                {"name": "openviking", "description": "cloud kb"},
                {"name": "useful", "description": "ok"},
            ],
            {"openviking": "missing binary: ov", "other": "missing binary: x"},
            ["openviking/SKILL.md: something", "useful ok"],
            {"openviking": "quarantine"},
        ),
    )
    monkeypatch.setattr(skills_catalog, "resolve_skill_dirs", lambda _s: [])
    monkeypatch.setattr(skills_catalog, "load_settings", lambda: {"skill_exclude": []})

    prev = skills_catalog.preview_skills({})
    names = {s["name"] for s in prev["skills"]}
    assert "openviking" not in names
    assert "useful" in names
    assert "openviking" not in prev["unavailable"]
    assert "openviking" not in prev["quarantined"]
    assert "openviking" in prev["excluded"]
    assert all("openviking" not in str(w).lower() for w in prev["warnings"])
