"""Personal skill homes (~/.codex/skills) resolve into the catalog."""

from __future__ import annotations

from pathlib import Path

import skills_catalog as sc


def test_resolve_skill_dirs_includes_user_homes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    codex = home / ".codex" / "skills" / "demo"
    codex.mkdir(parents=True)
    (codex / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo\n---\n\nHi\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(home))
    # Expanduser uses HOME; also patch Path.home if needed via env.
    settings = {
        "skill_dirs": [],
        "skill_auto_discover": False,
        "skill_user_homes": True,
        "skill_ignore_dirs": [],
        "allow_external_skill_dirs": False,
    }
    # Point the constant at our temp home skills via monkeypatch of the tuple.
    monkeypatch.setattr(
        sc,
        "_USER_SKILL_HOMES",
        (str(home / ".codex" / "skills"),),
    )
    folders = sc.resolve_skill_dirs(settings)
    paths = [f["path"] for f in folders]
    assert str((home / ".codex" / "skills").resolve()) in paths
    assert any(f["origin"] == "user_home" for f in folders)


def test_clawagents_own_home_is_registered():
    assert "~/.clawagents/skills" in sc._USER_SKILL_HOMES
    # Precedence: ClawAgents' own home must be last (highest) among homes.
    assert sc._USER_SKILL_HOMES[-1] == "~/.clawagents/skills"


def test_preview_reports_unavailable_and_warnings(tmp_path, monkeypatch):
    root = tmp_path / "ws" / "skills"
    gated = root / "gated"
    gated.mkdir(parents=True)
    (gated / "SKILL.md").write_text(
        "---\nname: gated\ndescription: d\n"
        "requires:\n  bins: [definitely-not-a-real-binary-xyz]\n---\n\nBody\n",
        encoding="utf-8",
    )
    ok = root / "ok-skill"
    ok.mkdir(parents=True)
    (ok / "SKILL.md").write_text(
        "---\nname: ok-skill\ndescription: d\n---\n\nBody\n", encoding="utf-8"
    )
    settings = {
        "skill_dirs": [str(root)],
        "skill_auto_discover": False,
        "skill_user_homes": False,
        "skill_ignore_dirs": [],
        "allow_external_skill_dirs": True,
    }
    preview = sc.preview_skills(settings)
    names = [s["name"] for s in preview["skills"]]
    assert "ok-skill" in names
    assert "gated" not in names
    # Requires the in-repo clawagents (ineligible tracking); on older
    # installs the key is present but empty.
    assert "unavailable" in preview
    assert "warnings" in preview
    if preview["unavailable"]:
        assert "missing binary" in preview["unavailable"].get("gated", "")


def test_skill_user_homes_can_be_disabled(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".codex" / "skills").mkdir(parents=True)
    monkeypatch.setattr(sc, "_USER_SKILL_HOMES", (str(home / ".codex" / "skills"),))
    folders = sc.resolve_skill_dirs(
        {
            "skill_dirs": [],
            "skill_auto_discover": False,
            "skill_user_homes": False,
            "skill_ignore_dirs": [],
        }
    )
    assert folders == []
