const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-pcat-"));
const outputFile = path.join(tempDir, "providerCatalog.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "providerCatalog.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const mod = require(outputFile);
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("apac geo prefix recognized (not ap.)", () => {
  assert.equal(
    mod.isNativeBedrockModelId("apac.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    true,
  );
  assert.equal(mod.isMantleAnthropicModel("apac.anthropic.claude-sonnet-4-5"), true);
  assert.equal(mod.isMantleCatalogModelId("apac.anthropic.claude-x"), false);
});

test("expandBedrockProviderChoices splits IAM vs Mantle availability", () => {
  const rows = mod.expandBedrockProviderChoices(
    [
      {
        id: "bedrock",
        name: "Bedrock",
        available: true,
        models: [
          { id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Claude" },
          { id: "anthropic.claude-sonnet-4-5", label: "Mantle Claude" },
        ],
      },
    ],
    { iam: false, mantle: true, bag: true },
  );
  const iam = rows.find((r) => r.id === mod.BEDROCK_SELECT_IAM);
  const mantle = rows.find((r) => r.id === mod.BEDROCK_SELECT_MANTLE);
  assert.equal(iam.available, false);
  assert.equal(mantle.available, true);
});

test("overlayHostKeyAvailability clears false (no key) when host has key", () => {
  const overlaid = mod.overlayHostKeyAvailability(
    [
      {
        id: "openai",
        name: "OpenAI",
        available: false,
        models: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", available: false }],
      },
    ],
    {
      openai: true,
      anthropic: false,
      gemini: false,
      iam: false,
      mantle: false,
      bag: false,
    },
  );
  assert.equal(overlaid[0].available, true);
  assert.equal(overlaid[0].models[0].available, true);
});

test("applyKeyFlagsToFallback leaves Ollama available without a key slot", () => {
  const rows = mod.applyKeyFlagsToFallback(
    [
      { id: "openai", name: "OpenAI", available: true, models: [] },
      { id: "ollama", name: "Ollama (local)", available: true, models: [] },
    ],
    { openai: false, anthropic: false, gemini: false, bedrock: false },
  );
  assert.equal(rows.find((r) => r.id === "openai").available, false);
  assert.equal(rows.find((r) => r.id === "ollama").available, true);
});

test("modelFitsProvider rejects ollama leftovers on OpenAI", () => {
  assert.equal(mod.modelLooksLikeOllamaLocalId("llama3.1"), true);
  assert.equal(mod.modelLooksLikeOllamaLocalId("meta.llama3-1-8b"), false);
  assert.equal(mod.modelFitsProvider("llama3.1", "openai"), false);
  assert.equal(mod.modelFitsProvider("gpt-5.6-luna", "openai"), true);
  assert.equal(mod.modelFitsProvider("llama3.1", "ollama"), true);
  assert.equal(mod.defaultModelForProvider("openai"), mod.PREFERRED_OPENAI_MODEL);
});

test("effectiveProviderLabel shows OpenAI for auto + gpt model", () => {
  assert.equal(
    mod.effectiveProviderLabel(
      { provider: "auto" },
      "gpt-5.6-luna",
      [
        {
          id: "openai",
          name: "OpenAI",
          available: true,
          models: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
        },
      ],
    ),
    "OpenAI",
  );
  assert.equal(
    mod.effectiveProviderLabel({ provider: "bedrock", bedrock_mode: "mantle" }, "x", []),
    "Bedrock Mantle",
  );
});
