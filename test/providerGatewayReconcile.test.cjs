"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-gateway-"));
const outputFile = path.join(tempDir, "bedrockGateway.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "bedrockGateway.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const gw = require(outputFile);

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("OpenAI + stale Mantle URL clears base_url (no force back to bedrock)", () => {
  const incoming = {
    provider: "openai",
    bedrock_mode: "mantle",
    base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
    model: "gpt-5.6-luna",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "mantle",
    base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
  });
  assert.equal(incoming.provider, "openai");
  assert.equal(incoming.base_url, "");
  assert.equal(incoming.bedrock_mode, "iam");
});

test("empty base_url + mantle mode does not override OpenAI provider", () => {
  const incoming = {
    provider: "openai",
    bedrock_mode: "mantle",
    base_url: "",
    model: "gpt-5.6-luna",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "mantle",
    base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
  });
  assert.equal(incoming.provider, "openai");
  assert.equal(incoming.base_url, "");
  assert.equal(incoming.bedrock_mode, "iam");
});

test("Anthropic clears leftover BAG URL when leaving Bedrock", () => {
  const incoming = {
    provider: "anthropic",
    bedrock_mode: "bag",
    base_url: "http://localhost:8000/api/v1",
    model: "claude-sonnet-4-5",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "bag",
    base_url: "http://localhost:8000/api/v1",
  });
  assert.equal(incoming.provider, "anthropic");
  assert.equal(incoming.base_url, "");
  assert.equal(incoming.bedrock_mode, "iam");
});

test("Gemini clears leftover Mantle URL", () => {
  const incoming = {
    provider: "gemini",
    bedrock_mode: "mantle",
    base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
    model: "gemini-3.5-flash",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "mantle",
    base_url: incoming.base_url,
  });
  assert.equal(incoming.base_url, "");
  assert.equal(incoming.bedrock_mode, "iam");
});

test("Bedrock IAM clears leftover Mantle URL", () => {
  const incoming = {
    provider: "bedrock",
    bedrock_mode: "iam",
    base_url: "https://bedrock-mantle.us-east-1.api.aws/v1",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "mantle",
    base_url: incoming.base_url,
  });
  assert.equal(incoming.base_url, "");
  assert.equal(incoming.bedrock_mode, "iam");
});

test("Bedrock + mantle mode still fills Mantle URL when base empty", () => {
  const incoming = {
    provider: "bedrock",
    bedrock_mode: "mantle",
    aws_region: "us-east-1",
    base_url: "",
  };
  gw.reconcileProviderGatewaySettings(incoming, {});
  assert.equal(incoming.provider, "bedrock");
  assert.match(String(incoming.base_url), /bedrock-mantle\.us-east-1/);
});

test("leaving Bedrock resets wire_api from Mantle responses", () => {
  const incoming = {
    provider: "openai",
    bedrock_mode: "mantle",
    base_url: "",
    wire_api: "responses",
  };
  gw.reconcileProviderGatewaySettings(incoming, {
    provider: "bedrock",
    bedrock_mode: "mantle",
    wire_api: "responses",
  });
  assert.equal(incoming.wire_api, "auto");
});
