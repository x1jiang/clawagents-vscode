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
  window: {
    showInformationMessage() {},
    showWarningMessage() { return Promise.resolve(undefined); },
    showErrorMessage() {},
  },
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

test("sanitizeApiKey strips CRLF and lone CR", () => {
  const { sanitizeApiKey } = require(outputFile);
  assert.equal(sanitizeApiKey("sk-test\r\n"), "sk-test");
  assert.equal(sanitizeApiKey("sk-test\r"), "sk-test");
  assert.equal(sanitizeApiKey('  "sk-quoted"  '), "sk-quoted");
});

test("sanitizeApiKey rejects Windows python.exe paths", () => {
  const { sanitizeApiKey, looksLikeFilesystemPath } = require(outputFile);
  const winPy =
    "C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
  assert.equal(looksLikeFilesystemPath(winPy), true);
  assert.equal(sanitizeApiKey(winPy), "");
  assert.equal(sanitizeApiKey("/usr/bin/python3"), "");
  assert.equal(sanitizeApiKey("sk-proj-realkey123"), "sk-proj-realkey123");
  assert.equal(looksLikeFilesystemPath("sk-proj-realkey123"), false);
});

test("sanitizeApiKey rejects chat UI / error pastes", () => {
  const { sanitizeApiKey, looksLikePastedJunk } = require(outputFile);
  const chatPaste = "You\nCopy\nhi\nClawAgents\nCopy\n[provider_auth] Authentication failed";
  assert.equal(looksLikePastedJunk(chatPaste), true);
  assert.equal(sanitizeApiKey(chatPaste), "");
  assert.equal(sanitizeApiKey("You Copy sk-should-not-matter"), "");
  assert.equal(
    sanitizeApiKey(
      "Error code: 401 - {'error': {'message': 'Incorrect API key provided: x'}}",
    ),
    "",
  );
  assert.equal(sanitizeApiKey("sk-proj-realkey123"), "sk-proj-realkey123");
});

test("resolveProviderApiKey skips path in SecretStorage and uses dotenv", async () => {
  const cfg = makeConfig();
  cfg.getApiKeyEnv = async () => ({}); // purged / empty after path reject
  cfg.loadWorkspaceDotenv = () => ({ OPENAI_API_KEY: "sk-from-dotenv" });
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY =
    "C:\\Users\\bob\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
  try {
    assert.equal(await cfg.resolveProviderApiKey("openai"), "sk-from-dotenv");
  } finally {
    if (prev === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prev;
    }
  }
});

test("readSecretKey purges path-like SecretStorage values", async () => {
  let stored = {
    "clawagents.openaiApiKey":
      "C:\\Users\\alice\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
  };
  const secrets = {
    get: async (k) => stored[k],
    store: async (k, v) => {
      stored[k] = v;
    },
    delete: async (k) => {
      delete stored[k];
    },
  };
  const cfg = new ExtensionConfig(secrets);
  cfg.loadWorkspaceDotenv = () => ({ OPENAI_API_KEY: "sk-dotenv-ok" });
  const env = await cfg.getApiKeyEnv();
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(stored["clawagents.openaiApiKey"], undefined);
  assert.equal(await cfg.resolveProviderApiKey("openai"), "sk-dotenv-ok");
});