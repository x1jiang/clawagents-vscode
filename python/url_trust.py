"""URL trust helpers for provider base_url / MCP endpoints."""

from __future__ import annotations

from urllib.parse import urlparse


def is_trusted_base_url(raw: str | None) -> bool:
    """True for empty or loopback hosts only."""
    text = (raw or "").strip()
    if not text:
        return True
    try:
        with_scheme = text if "://" in text else f"http://{text}"
        parsed = urlparse(with_scheme)
    except Exception:  # noqa: BLE001
        return False
    host = (parsed.hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0")
