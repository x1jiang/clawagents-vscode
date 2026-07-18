"""URL trust helpers for provider base_url / MCP endpoints."""

from __future__ import annotations

from urllib.parse import urlparse


def is_mantle_host(hostname: str | None) -> bool:
    """True for AWS Bedrock Mantle (OneHUB) OpenAI-compatible hosts."""
    host = (hostname or "").lower()
    if host == "bedrock-mantle.api.aws":
        return True
    # bedrock-mantle.us-east-1.api.aws
    parts = host.split(".")
    return (
        len(parts) >= 4
        and parts[0] == "bedrock-mantle"
        and parts[-2] == "api"
        and parts[-1] == "aws"
    )


def is_trusted_base_url(raw: str | None) -> bool:
    """True for empty, loopback, or official AWS Mantle hosts."""
    text = (raw or "").strip()
    if not text:
        return True
    try:
        with_scheme = text if "://" in text else f"http://{text}"
        parsed = urlparse(with_scheme)
    except Exception:  # noqa: BLE001
        return False
    host = (parsed.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
        return True
    return is_mantle_host(host)
