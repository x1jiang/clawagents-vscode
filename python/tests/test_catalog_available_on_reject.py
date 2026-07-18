"""Live probe 401 must not mark a present OpenAI key as unavailable."""

from __future__ import annotations

import unittest
from unittest import mock


class CatalogAvailableOnRejectTests(unittest.TestCase):
    def test_openai_stays_available_when_models_probe_rejects(self):
        import providers as providers_mod

        with mock.patch.dict(
            "os.environ",
            {"OPENAI_API_KEY": "sk-test", "ANTHROPIC_API_KEY": "", "GEMINI_API_KEY": ""},
            clear=False,
        ), mock.patch.object(
            providers_mod,
            "verify_api_key",
            return_value={
                "ok": False,
                "provider": "openai",
                "detail": "Key REJECTED by openai (HTTP 401) - rotate or replace it",
            },
        ), mock.patch.object(
            providers_mod, "_probe_compatible_endpoint", return_value=(False, "401", [])
        ), mock.patch.object(
            providers_mod, "_settings_base_url", return_value=("", True)
        ), mock.patch.object(
            providers_mod, "_ollama_reachable", return_value=False
        ), mock.patch.object(
            providers_mod, "_has_aws_credentials", return_value=False
        ):
            catalog = providers_mod.build_provider_catalog(probe_keys=True)
        openai = next(p for p in catalog if p["id"] == "openai")
        self.assertTrue(
            openai["available"],
            f"expected available=True despite REJECTED probe, got {openai!r}",
        )


if __name__ == "__main__":
    unittest.main()
