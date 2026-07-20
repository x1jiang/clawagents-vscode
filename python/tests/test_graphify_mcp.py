"""Graphify path resolution + server gating."""

from __future__ import annotations

import json
from pathlib import Path

import mcp_loader


def test_resolve_graphify_prefers_clawagents_layout(tmp_path: Path):
    preferred = tmp_path / ".clawagents" / "graphify" / "graph.json"
    preferred.parent.mkdir(parents=True)
    preferred.write_text(json.dumps({"nodes": [{"id": "a"}], "links": []}), encoding="utf-8")
    upstream = tmp_path / "graphify-out" / "graph.json"
    upstream.parent.mkdir(parents=True)
    upstream.write_text(json.dumps({"nodes": [], "links": []}), encoding="utf-8")

    got = mcp_loader.resolve_graphify_graph_path(workspace=tmp_path)
    assert got == preferred.resolve()


def test_resolve_graphify_falls_back_to_upstream(tmp_path: Path):
    upstream = tmp_path / "graphify-out" / "graph.json"
    upstream.parent.mkdir(parents=True)
    upstream.write_text("{}", encoding="utf-8")
    got = mcp_loader.resolve_graphify_graph_path(workspace=tmp_path)
    assert got == upstream.resolve()


def test_resolve_graphify_explicit_path(tmp_path: Path):
    custom = tmp_path / "kb" / "graph.json"
    custom.parent.mkdir(parents=True)
    custom.write_text("{}", encoding="utf-8")
    got = mcp_loader.resolve_graphify_graph_path(
        graph_path=str(custom),
        corpus="path",
        workspace=tmp_path,
    )
    assert got == custom.resolve()


def test_resolve_graphify_directory_appends_graph_json(tmp_path: Path):
    d = tmp_path / "kb"
    d.mkdir()
    (d / "graph.json").write_text("{}", encoding="utf-8")
    got = mcp_loader.resolve_graphify_graph_path(
        graph_path=str(d),
        corpus="path",
        workspace=tmp_path,
    )
    assert got == (d / "graph.json").resolve()


def test_create_graphify_server_none_without_graph(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        mcp_loader,
        "graphify_status",
        lambda **_k: {
            "package_ok": True,
            "ok": False,
            "graph_exists": False,
            "graph_path": str(tmp_path / ".clawagents" / "graphify" / "graph.json"),
        },
    )
    assert mcp_loader.create_graphify_server(workspace=tmp_path) is None


def test_graphify_status_counts_nodes(tmp_path: Path, monkeypatch):
    g = tmp_path / ".clawagents" / "graphify" / "graph.json"
    g.parent.mkdir(parents=True)
    g.write_text(
        json.dumps({"nodes": [{"id": "1"}, {"id": "2"}], "links": []}),
        encoding="utf-8",
    )

    class _Stub:
        found = True
        version = "0.9.20"
        ok_vs_floor = True
        min_version = "0.9.20"
        path = "py"
        hint = "ok"

        def summary(self) -> str:
            return "graphify: 0.9.20 (ok)"

    monkeypatch.setattr(
        "clawagents.companions.probe_graphify",
        lambda **_k: _Stub(),
    )
    status = mcp_loader.graphify_status(workspace=tmp_path)
    assert status["graph_exists"] is True
    assert status["node_count"] == 2
    assert status["graph_path"] == str(g.resolve())
    assert status["package_ok"] is True
    assert status["ok"] is True
