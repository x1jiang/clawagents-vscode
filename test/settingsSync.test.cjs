const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-settings-sync-"));
const outputFile = path.join(outputDir, "settingsSync.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "src", "settingsSync.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const sync = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("older settings replies cannot replace a newer save", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 4,
      latestRevision: 5,
      pendingRevision: 4,
      localMatchesPending: false,
    }),
    { kind: "ignore_stale" },
  );
});

test("latest reply applies when local settings still match the sent snapshot", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 5,
      latestRevision: 5,
      pendingRevision: 5,
      localMatchesPending: true,
    }),
    { kind: "apply" },
  );
});

test("latest reply preserves edits made after the request was sent", () => {
  assert.deepEqual(
    sync.decideSettingsReply({
      replyRevision: 5,
      latestRevision: 5,
      pendingRevision: 5,
      localMatchesPending: false,
    }),
    { kind: "keep_local" },
  );
});

test("initial empty draft accepts the first persisted settings snapshot", () => {
  const committedKey = "";
  const localKey = sync.settingsSaveKey({});
  assert.equal(localKey, "");
  assert.equal(Boolean(localKey) && localKey !== committedKey, false);
  assert.notEqual(sync.settingsSaveKey({ model: "gpt-6.1-terra", reasoning_effort: "medium" }), "");
});

test("later model edits remain dirty until acknowledged", () => {
  const saved = { model: "gpt-6.1-terra", reasoning_effort: "medium" };
  assert.notEqual(sync.settingsSaveKey({ ...saved, model: "gpt-6-astra" }), sync.settingsSaveKey(saved));
});

// Exercise the actual startup effect, including key-before-settings ordering.
function runPreferredModelEffect(settings) {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../webview/src/App.tsx"), "utf8");
  const effect = source.slice(source.indexOf("  // Fill a default model only"), source.indexOf("  // Heal leftovers"));
  let saved;
  const deps = {
    useEffect: callback => callback(), providerKeysHydrated: true,
    settings, preferredModelFilled: { current: false },
    preferredPick: { model: "gpt-6.1-terra", effort: "medium", provider: "openai" },
    isWeakAutoDefaultModel: () => false,
    skipSettingsAutosave: {}, setModel: () => {}, setSettings: () => {},
    normalizeSettingsForSave: sync.normalizeSettingsForSave,
    inflightSettingsKey: {}, settingsSaveKey: sync.settingsSaveKey,
    pendingSettingsPatch: {}, postSettingsSave: patch => { saved = patch; }, post: () => {},
  };
  const js = ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { saved, filled: deps.preferredModelFilled.current };
}

test("credentials arriving before settings cannot overwrite a saved default", () => {
  assert.deepEqual(runPreferredModelEffect({}), { saved: undefined, filled: false });
  assert.deepEqual(runPreferredModelEffect({ provider: "openai", model: "gpt-6-astra", reasoning_effort: "high" }),
    { saved: undefined, filled: true });
  assert.deepEqual(runPreferredModelEffect({ provider: "auto", model: "gpt-6.1-terra", reasoning_effort: "high" }),
    { saved: undefined, filled: true });
});

test("loaded settings without a model select Terra with Medium effort", () => {
  const result = runPreferredModelEffect({ provider: "auto", model: "", reasoning_effort: "" });
  assert.equal(result.saved.model, "gpt-6.1-terra");
  assert.equal(result.saved.reasoning_effort, "medium");
  assert.equal(result.saved.provider, "openai");
});

test("skill usage preference participates in settings autosave", () => {
  assert.notEqual(sync.settingsSaveKey({ skill_usage: false }), sync.settingsSaveKey({ skill_usage: true }));
});
