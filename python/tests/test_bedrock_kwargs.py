"""Tests for Bedrock native vs gateway routing in chats._resolve_model_kwargs."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import chats  # noqa: E402


class TestBedrockResolveKwargs(unittest.TestCase):
    def test_native_bedrock_no_base_url(self):
        with patch.dict(os.environ, {}, clear=False):
            kwargs = chats._resolve_model_kwargs(
                None,
                {
                    "provider": "bedrock",
                    "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    "base_url": "",
                    "aws_region": "us-west-2",
                    "aws_profile": "hipaa",
                },
            )
            self.assertEqual(
                kwargs["model"],
                "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            )
            self.assertNotIn("base_url", kwargs)
            self.assertNotIn("api_key", kwargs)
            self.assertEqual(os.environ.get("AWS_REGION"), "us-west-2")
            self.assertEqual(os.environ.get("AWS_PROFILE"), "hipaa")

    def test_gateway_bedrock_sets_api_key(self):
        kwargs = chats._resolve_model_kwargs(
            None,
            {
                "provider": "bedrock",
                "model": "amazon.nova-pro-v1:0",
                "base_url": "http://127.0.0.1:8000/api/v1",
                "trust_custom_base_url": True,
            },
        )
        self.assertEqual(kwargs["base_url"], "http://127.0.0.1:8000/api/v1")
        self.assertIn("api_key", kwargs)
        self.assertEqual(kwargs["model"], "amazon.nova-pro-v1:0")

    def test_default_model_when_empty(self):
        kwargs = chats._resolve_model_kwargs(
            None,
            {"provider": "bedrock", "model": "", "base_url": ""},
        )
        self.assertTrue(str(kwargs["model"]).startswith("us.anthropic."))


if __name__ == "__main__":
    unittest.main()
