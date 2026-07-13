"""Host-injected API key snapshot for the VS Code sidecar.

The extension spawn env (SecretStorage) must beat workspace ``.env``.
clawagents may call ``load_dotenv(override=True)`` on first agent create;
we snapshot secrets at sidecar start and re-apply them before each turn.
"""

from __future__ import annotations

import os

_SPAWN_SECRET_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "BEDROCK_API_KEY",
    "TAVILY_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)

_SPAWN_SECRETS: dict[str, str] = {}


def normalize_provider_aliases() -> None:
    if os.environ.get("GOOGLE_API_KEY") and not os.environ.get("GEMINI_API_KEY"):
        os.environ["GEMINI_API_KEY"] = os.environ["GOOGLE_API_KEY"]


def snapshot_spawn_secrets() -> None:
    _SPAWN_SECRETS.clear()
    for key in _SPAWN_SECRET_KEYS:
        val = os.environ.get(key)
        if val:
            _SPAWN_SECRETS[key] = val
    normalize_provider_aliases()


def restore_spawn_secrets() -> None:
    for key, value in _SPAWN_SECRETS.items():
        os.environ[key] = value
    normalize_provider_aliases()
