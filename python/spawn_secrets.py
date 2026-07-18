"""Host-injected API keys for the VS Code sidecar.

Captured once at process start (extension SecretStorage / spawn env).
Chat turns pass these as explicit ``api_key=`` and do not re-read a
possibly polluted ``os.environ`` after clawagents loads ``.env``.
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
    """Freeze provider secrets from the spawn environment (call once at start)."""
    _SPAWN_SECRETS.clear()
    for key in _SPAWN_SECRET_KEYS:
        val = (os.environ.get(key) or "").strip()
        if val:
            _SPAWN_SECRETS[key] = val
    # Keep GEMINI alias in the snapshot too.
    if "GOOGLE_API_KEY" in _SPAWN_SECRETS and "GEMINI_API_KEY" not in _SPAWN_SECRETS:
        _SPAWN_SECRETS["GEMINI_API_KEY"] = _SPAWN_SECRETS["GOOGLE_API_KEY"]
    normalize_provider_aliases()


def get_secret(key: str) -> str:
    """Return a spawn-time secret (empty if unset). Never reads live os.environ."""
    return (_SPAWN_SECRETS.get(key) or "").strip()


def resolve_api_key(provider: str, model: str | None = None) -> str | None:
    """Pick the host-injected key for this provider/model, if any.

    Provider wins over model-name heuristics so Bedrock Mantle models like
    ``anthropic.claude-*`` do not accidentally select ``ANTHROPIC_API_KEY``.
    """
    p = (provider or "auto").strip().lower()
    m = (model or "").strip().lower()

    if p == "bedrock":
        # Mantle/BAG key only — never fall back to OPENAI_API_KEY (401 on Mantle).
        key = get_secret("BEDROCK_API_KEY")
        return key or None
    if p == "anthropic":
        key = get_secret("ANTHROPIC_API_KEY")
        return key or None
    if p == "gemini":
        key = get_secret("GEMINI_API_KEY") or get_secret("GOOGLE_API_KEY")
        return key or None
    if p in ("openai", "ollama"):
        key = get_secret("OPENAI_API_KEY")
        return key or None

    # auto / unknown — infer from model id
    # Bedrock / Mantle catalog shapes must not pick Anthropic/OpenAI keys.
    try:
        from clawagents.config.config import is_bedrock_model_id

        if is_bedrock_model_id(m):
            key = get_secret("BEDROCK_API_KEY")
            return key or None
    except Exception:  # noqa: BLE001
        if m.startswith(("us.", "eu.", "apac.", "global.", "bedrock/")) or m.startswith(
            ("anthropic.", "amazon.", "meta.", "openai.")
        ):
            key = get_secret("BEDROCK_API_KEY")
            return key or None
    if m.startswith("claude") or m.startswith("anthropic/"):
        key = get_secret("ANTHROPIC_API_KEY")
        return key or None
    if m.startswith("gemini"):
        key = get_secret("GEMINI_API_KEY") or get_secret("GOOGLE_API_KEY")
        return key or None
    key = get_secret("OPENAI_API_KEY")
    return key or None


def restore_spawn_secrets() -> None:
    """Optional: re-apply spawn secrets into os.environ (diagnostics / tools)."""
    for key, value in _SPAWN_SECRETS.items():
        os.environ[key] = value
    normalize_provider_aliases()
