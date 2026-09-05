const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-ctxwin-"));
const outputFile = path.join(tempDir, "contextWindow.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "contextWindow.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const { contextWindowFor, contextUsage } = require(outputFile);

test("Claude 1M generation resolves to 1M regardless of id spelling", () => {
  for (const id of [
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "anthropic.claude-opus-4-8",
    "anthropic.claude-fable-5",
    "us.anthropic.claude-opus-4-7-20250514-v1:0",
    "bedrock/global.anthropic.claude-sonnet-5-v1:0",
  ]) {
    assert.equal(contextWindowFor(id), 1_000_000, id);
  }
});

test("Claude 200K models stay at 200K", () => {
  for (const id of [
    "claude-sonnet-4-5",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "claude-haiku-4-5",
    "anthropic.claude-haiku-4-5",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-opus-4-5",
    "claude-opus-4",
    "claude-sonnet-4",
  ]) {
    assert.equal(contextWindowFor(id), 200_000, id);
  }
});

test("Gemini flash and pro are 1M (pro is 1,048,576, not 2M)", () => {
  for (const id of [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ]) {
    assert.equal(contextWindowFor(id), 1_000_000, id);
  }
});

test("xAI Grok windows match the Python model profiles", () => {
  assert.equal(contextWindowFor("grok-4.5"), 500_000);
  assert.equal(contextWindowFor("grok-4.3"), 1_000_000);
  assert.equal(contextWindowFor("xai.grok-4.3"), 1_000_000);
  assert.equal(contextWindowFor("grok-4.20-0309-reasoning"), 1_000_000);
  assert.equal(contextWindowFor("grok-build-0.1"), 256_000);
});

test("Bedrock Mantle third-party ids resolve", () => {
  assert.equal(contextWindowFor("deepseek.v3.2"), 164_000);
  assert.equal(contextWindowFor("deepseek.v3.1"), 128_000);
  assert.equal(contextWindowFor("moonshotai.kimi-k2.5"), 256_000);
  assert.equal(contextWindowFor("moonshot.kimi-k2-thinking"), 256_000);
  assert.equal(contextWindowFor("zai.glm-5"), 200_000);
  assert.equal(contextWindowFor("zai.glm-4.7"), 200_000);
  assert.equal(contextWindowFor("openai.gpt-oss-120b"), 128_000);
  assert.equal(contextWindowFor("openai.gpt-oss-120b-1:0"), 128_000);
  assert.equal(contextWindowFor("amazon.nova-pro-v1:0"), 300_000);
  assert.equal(contextWindowFor("us.amazon.nova-micro-v1:0"), 128_000);
});

test("gpt-oss does not collapse into the GPT-5 family", () => {
  assert.equal(contextWindowFor("gpt-oss-20b"), 128_000);
  assert.equal(contextWindowFor("openai.gpt-5.6-luna"), 1_050_000);
  assert.equal(contextWindowFor("gpt-5.5"), 400_000);
});

test("unknown or empty ids yield null and no meter", () => {
  assert.equal(contextWindowFor(undefined), null);
  assert.equal(contextWindowFor(null), null);
  assert.equal(contextWindowFor(""), null);
  assert.equal(contextWindowFor("   "), null);
  assert.equal(contextWindowFor("some-local-model"), null);
  assert.equal(contextUsage("some-local-model", 1000), null);
  assert.equal(contextUsage("gpt-5.6-sol", 0), null);
});

test("contextUsage clamps the ratio at 1", () => {
  const usage = contextUsage("claude-sonnet-4-5", 250_000);
  assert.deepEqual(usage, { ratio: 1, window: 200_000 });
  const half = contextUsage("Claude-Opus-4-8", 500_000);
  assert.deepEqual(half, { ratio: 0.5, window: 1_000_000 });
});
