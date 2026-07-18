"""AWS Bedrock Mantle URL trust + helpers."""

from __future__ import annotations

import unittest
from pathlib import Path
import sys

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import providers  # noqa: E402
import url_trust  # noqa: E402


class TestMantleTrust(unittest.TestCase):
    def test_mantle_hosts_trusted(self) -> None:
        self.assertTrue(
            url_trust.is_trusted_base_url(
                "https://bedrock-mantle.us-east-1.api.aws/v1"
            )
        )
        self.assertTrue(url_trust.is_mantle_host("bedrock-mantle.us-west-2.api.aws"))

    def test_random_host_not_trusted(self) -> None:
        self.assertFalse(url_trust.is_trusted_base_url("https://evil.example/v1"))

    def test_mantle_base_from_mode(self) -> None:
        url = providers._mantle_base_from_settings(
            "", {"bedrock_mode": "mantle", "aws_region": "us-east-1"}
        )
        self.assertEqual(url, "https://bedrock-mantle.us-east-1.api.aws/v1")

    def test_mantle_catalog_nonempty(self) -> None:
        self.assertTrue(any(m["id"] == "openai.gpt-5.6-sol" for m in providers._MANTLE_MODELS))


if __name__ == "__main__":
    unittest.main()
