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
test("Astra offline OpenAI and Mantle pickers", () => {
  assert(catalog.FALLBACK_PROVIDERS.find(p => p.id === "openai").models.some(m => m.id === "gpt-6-astra"));
  const rows = catalog.expandBedrockProviderChoices(catalog.FALLBACK_PROVIDERS, {iam: false, mantle: true, bag: false});
  assert(catalog.modelsForKeys(rows, catalog.BEDROCK_SELECT_MANTLE).some(m => m.id === "openai.gpt-6-astra"));
  assert.equal(catalog.mantleWireApiForModel("openai.gpt-6-astra"), "responses");
});
for (const id of ["gpt-6-astra", "openai.gpt-6-astra"]) {
  test(`${id} effort choices and context`, () => {
    assert(selection.modelSupportsEffort(id));
    assert.deepEqual(selection.effortOptionsForModel(id).map(o => o.value), ["low","medium","high","xhigh","max"]);
    assert.equal(context.contextWindowFor(id), 1050000);
  });
}
test("Astra direct, Mantle, global and long-context estimates agree", () => {
  assert.equal(pricing.estimateCostUsd("gpt-6-astra", 100000, 10000),1.5);
  assert(Math.abs(pricing.estimateCostUsd("openai.gpt-6-astra", 100000, 10000) - 1.65) < 1e-12);
  assert.equal(pricing.estimateCostUsd("global.openai.gpt-6-astra", 100000, 10000),1.5);
  assert.equal(pricing.estimateCostUsd("gpt-6-astra", 300000, 10000),6.75);
});
