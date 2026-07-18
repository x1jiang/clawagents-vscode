const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-keyflags-"));
const outputFile = path.join(tempDir, "config.cjs");
const vscodeStubDir = path.join(tempDir, "node_modules", "vscode");
fs.mkdirSync(vscodeStubDir, { recursive: true });
fs.writeFileSync(
  path.join(vscodeStubDir, "index.js"),
  `module.exports = {
  workspace: {
    workspaceFolders: undefined,
    getConfiguration() { return { get: (_k, d) => d }; },
  },
  window: { showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {} },
};`,
);

buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "config.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});

const { ExtensionConfig } = require(outputFile);
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function makeConfig() {
  const secrets = {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
  };
  return new ExtensionConfig(secrets);
}

test("hasProviderKeyFromEnv sees workspace .env when SecretStorage empty", () => {
  const cfg = makeConfig();
  cfg.loadWorkspaceDotenv = () => ({ OPENAI_API_KEY: "sk-from-dotenv" });
  assert.equal(cfg.hasProviderKeyFromEnv({}, "openai"), true);
  assert.equal(cfg.hasProviderKeyFromEnv({}, "anthropic"), false);
  assert.equal(cfg.hasAnyApiKeyFromEnv({}), true);
});

test("hasProviderKeyFromEnv prefers SecretStorage env snapshot", () => {
  const cfg = makeConfig();
  cfg.loadWorkspaceDotenv = () => ({});
  assert.equal(
    cfg.hasProviderKeyFromEnv({ OPENAI_API_KEY: "sk-secret" }, "openai"),
    true,
  );
});

test("resolveProviderApiKey falls back to dotenv", async () => {
  const cfg = makeConfig();
  cfg.getApiKeyEnv = async () => ({});
  cfg.loadWorkspaceDotenv = () => ({ OPENAI_API_KEY: "sk-dotenv" });
  assert.equal(await cfg.resolveProviderApiKey("openai"), "sk-dotenv");
});
