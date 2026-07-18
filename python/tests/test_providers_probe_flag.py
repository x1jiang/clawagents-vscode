"""Autosave must not live-probe remote /models (sidecar hang root cause)."""

from __future__ import annotations

import unittest
from unittest import mock


class ProvidersProbeFlagTests(unittest.TestCase):
    def test_build_catalog_skips_network_when_probe_keys_false(self):
        import providers as providers_mod

        with mock.patch.object(
            providers_mod, "_probe_compatible_endpoint"
        ) as probe_ep, mock.patch.object(
            providers_mod, "verify_api_key"
        ) as verify:
            catalog = providers_mod.build_provider_catalog(probe_keys=False)
            self.assertIsInstance(catalog, list)
            self.assertGreater(len(catalog), 0)
            probe_ep.assert_not_called()
            verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
