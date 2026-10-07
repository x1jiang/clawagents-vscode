const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");
const ts = require("typescript");
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
test("Fast toggle is available only for supported direct OpenAI models", () => {
  for (const id of ["gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
    assert.equal(selection.modelSupportsFastMode(id, "openai", ""), true);
    assert.equal(selection.modelSupportsFastMode(id, "auto", "https://api.openai.com/v1/"), true);
    assert.equal(selection.modelSupportsFastMode(id, "anthropic", ""), false);
    assert.equal(selection.modelSupportsFastMode(id, "openai", "https://proxy.example.test/v1"), false);
  }
  for (const id of ["gpt-4o", "openai.gpt-6-sol", "gpt-6"]) {
    assert.equal(selection.modelSupportsFastMode(id, "openai", ""), false);
  }
});
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
  assert(Math.abs(pricing.estimateCostUsd("gpt-6-sol", 100000, 10000, undefined, "openai", 0, 0, true) - .6) < 1e-12);
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

function appHandler(name, scope) {
  const source = fs.readFileSync(path.join(__dirname, "../webview/src/App.tsx"), "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert(declaration, `Missing App handler ${name}`);
  const compiled = ts.transpileModule(`const ${name} = ${declaration.initializer.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn ${name};`)(...Object.values(scope));
}

test("GPT-6.1 Sol coding chats explicitly select Responses for direct OpenAI", () => {
  for (const provider of ["openai", "auto", "profile:openai"]) {
    assert(selection.modelRequiresResponsesForTools("gpt-6.1-sol", provider));
    assert.equal(selection.compatibleWireApiForModel("gpt-6.1-sol", provider, "chat_completions"), "responses");
    for (const wire of ["auto", "responses"]) {
      assert.equal(selection.compatibleWireApiForModel("gpt-6.1-sol", provider, wire), "responses");
    }
  }
  for (const provider of ["openai", "auto", "profile:openai"]) {
    assert(selection.modelRequiresResponsesForTools("gpt-6-astra", provider));
    assert.equal(selection.compatibleWireApiForModel("gpt-6-astra", provider, "chat_completions"), "responses");
  }
  for (const [model, provider] of [["gpt-6-sol", "openai"], ["gpt-6-luna", "openai"], ["gpt-6.1-sol", "bedrock"],
    ["openai.gpt-6-astra", "bedrock"], ["openai.gpt-6-astra", "auto"],
    ["gpt-6.1-sol", "ollama"], ["openai.gpt-6.1-sol", "auto"]]) {
    assert(!selection.modelRequiresResponsesForTools(model, provider));
    assert.equal(selection.compatibleWireApiForModel(model, provider, "chat_completions"), "chat_completions");
  }
});

test("thread and default model changes persist the GPT-6.1 Sol wire correction", () => {
  const inherited = { provider: "openai", model: "gpt-6-sol", wire_api: "chat_completions", reasoning_effort: "none" };
  let persisted;
  const selectThread = appHandler("selectModel", {
    threadSettings: inherited,
    isMantleSettings: () => false,
    compatibleEffortForModel: selection.compatibleEffortForModel,
    compatibleWireApiForModel: selection.compatibleWireApiForModel,
    modelSupportsFastMode: selection.modelSupportsFastMode,
    modelRouteForSettings: value => value,
    persistThreadModelRoute: value => { persisted = value; return true; },
    setModel: () => {},
  });
  selectThread("gpt-6.1-sol");
  assert.equal(persisted.wire_api, "responses");
  assert.equal(persisted.reasoning_effort, "low");

  let saved;
  const selectDefault = appHandler("selectDefaultModel", {
    settings: inherited,
    setModel: () => {}, isMantleSettings: () => false,
    compatibleEffortForModel: selection.compatibleEffortForModel,
    compatibleWireApiForModel: selection.compatibleWireApiForModel,
    skipSettingsAutosave: {}, setSettings: () => {},
    normalizeSettingsForSave: value => value,
    settingsSaveKey: () => "test", inflightSettingsKey: {}, pendingSettingsPatch: {},
    setVerifyMsg: () => {}, postSettingsSave: value => { saved = value; },
  });
  selectDefault("gpt-6.1-sol");
  assert.equal(saved.wire_api, "responses");
  assert.equal(saved.reasoning_effort, "low");
});

test("Wire API control cannot reintroduce incompatible GPT-6.1 Sol chat tools", () => {
  let saved;
  const selectWire = appHandler("selectWireApi", {
    settings: { provider: "openai", model: "gpt-6.1-sol" },
    compatibleWireApiForModel: selection.compatibleWireApiForModel,
    skipSettingsAutosave: {}, setSettings: () => {},
    settingsSaveKey: () => "test", inflightSettingsKey: {}, pendingSettingsPatch: {},
    setVerifyMsg: () => {}, postSettingsSave: value => { saved = value; },
  });
  selectWire("chat_completions");
  assert.equal(saved.wire_api, "responses");
  const app = fs.readFileSync(path.join(__dirname, "../webview/src/App.tsx"), "utf8");
  assert.match(app, /<option value="chat_completions"\s+disabled=\{modelRequiresResponsesForTools\(/);
  assert.match(app, /Chat Completions is supported without tools/);
});
