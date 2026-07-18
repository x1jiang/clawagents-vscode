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
