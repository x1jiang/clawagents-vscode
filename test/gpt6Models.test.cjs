const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-astra-"));
function load(name) {
  const outfile = path.join(dir, `${name}.cjs`);
  buildSync({ entryPoints: [path.join(__dirname, "../webview/src", `${name}.ts`)], outfile, bundle:true, platform:"node", format:"cjs", logLevel:"silent" });
  return require(outfile);
}
const catalog = load("providerCatalog");
const selection = load("modelSelection");
const pricing = load("pricing");
const context = load("contextWindow");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test("GPT-6 Sol and Luna are OpenAI-only additions without changing defaults", () => {
  const openai = catalog.FALLBACK_PROVIDERS.find(p => p.id === "openai");
  assert.equal(openai.models[0].id, "gpt-5.6-terra");
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    assert(openai.models.some(m => m.id === id));
    const rows = catalog.expandBedrockProviderChoices(catalog.FALLBACK_PROVIDERS, {iam: false, mantle: true, bag: false});
    assert(!catalog.modelsForKeys(rows, catalog.BEDROCK_SELECT_MANTLE).some(m => m.id.includes(id)));
  }
});
for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6-sol-2026-09-22", "gpt-6-luna-2026-09-22"]) {
  test(`${id} reasoning and context`, () => {
    assert(selection.modelSupportsEffort(id));
    assert.deepEqual(selection.effortOptionsForModel(id).map(o => o.value), ["low","medium","high","xhigh","none","max"]);
    assert.equal(selection.compatibleEffortForModel(id, "none"), "none");
    assert.equal(selection.compatibleEffortForModel(id, "max"), "max");
    assert.equal(selection.compatibleEffortForModel(id, "minimal"), "low");
    assert.equal(context.contextWindowFor(id), 1050000);
  });
}
test("GPT-6 direct pricing includes cached input, with no inferred Bedrock prices", () => {
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-sol", 100000, 10000) - .3) < 1e-12);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-luna", 100000, 10000) - .015) < 1e-12);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-sol", 100000, 10000, undefined, "openai", 50000) - .21) < 1e-12);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-sol", 300000, 10000) - 1.35) < 1e-12);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-luna", 300000, 10000) - .0675) < 1e-12);
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    assert.equal(pricing.estimateCostUsd(id, 100000, 10000, undefined, "bedrock"), null);
    assert.equal(pricing.estimateCostUsd(`openai.${id}`, 100000, 10000), null);
  }
});

test("GPT-6.1 Sol is selectable in the catalog and thread route picker", () => {
  const openai = catalog.FALLBACK_PROVIDERS.find(p => p.id === "openai");
  assert(openai.models.some(m => m.id === "gpt-6.1-sol" && m.label === "GPT-6.1 Sol"));
  const routeSource = fs.readFileSync(path.join(__dirname, "../webview/src/ModelRouteCapsule.tsx"), "utf8");
  assert(routeSource.includes('"gpt-6.1-sol"'));
});

test("GPT-6.1 Sol uses its own reasoning, context, and cache pricing contract", () => {
  assert(selection.modelSupportsEffort("gpt-6.1-sol"));
  assert.deepEqual(selection.effortOptionsForModel("gpt-6.1-sol").map(o => o.value), ["low", "medium", "high", "xhigh", "max"]);
  for (const effort of ["none", "minimal"]) {
    assert.equal(selection.compatibleEffortForModel("gpt-6.1-sol", effort), "low");
  }
  assert.equal(selection.compatibleEffortForModel("gpt-6.1-sol", "max"), "max");
  assert.equal(context.contextWindowFor("gpt-6.1-sol"), 1050000);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6.1-sol", 100000, 10000, undefined, "openai", 50000) - .205) < 1e-12);
  assert(Math.abs(pricing.estimateCostUsd("gpt-6.1-sol", 300000, 10000, undefined, "openai", 100000) - .97) < 1e-12);
  assert.equal(pricing.estimateCostUsd("gpt-6.1-sol", 100000, 10000, undefined, "bedrock"), null);
  assert.equal(pricing.estimateCostUsd("openai.gpt-6.1-sol", 100000, 10000), null);
});
