"""Meta Glimmer endpoint defaults shared by catalog and chat routing."""
from __future__ import annotations

import os

META_DEFAULT_BASE_URL = ""
META_DEFAULT_MODEL = "Muse-Glimmer-30B"


def meta_base_url() -> str:
    return (os.environ.get("glimmer_30B_backend") or os.environ.get("GLIMMER_30B_BACKEND") or META_DEFAULT_BASE_URL).strip().rstrip("/")


def meta_model() -> str:
    return (os.environ.get("glimmer_30B_model") or os.environ.get("GLIMMER_30B_MODEL") or META_DEFAULT_MODEL).strip()


def is_meta_model(model: str) -> bool:
    return model.strip().lower() in {META_DEFAULT_MODEL.lower(), meta_model().lower()}
