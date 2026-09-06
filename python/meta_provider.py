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
    """Default name, the configured env name, or any Glimmer variant.

    Mirrors the webview's prefix rule (``providerCatalog.ts`` treats
    ``muse-glimmer*`` as Meta): an exact-only check made the host "heal" a
    served alias such as ``Muse-Glimmer-30B-FP8`` back to the default on every
    settings round-trip while the webview believed it fit.
    """
    value = str(model or "").strip().lower()
    if not value:
        return False
    return value in {META_DEFAULT_MODEL.lower(), meta_model().lower()} or "glimmer" in value
