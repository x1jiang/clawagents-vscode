const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-runtime-trust-"));
const outputFile = path.join(outputDir, "runtimeTrust.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "runtimeTrust.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const {
  mergeRuntimeTrust,
  parseRuntimeTrust,
  runtimeTrustFromSettings,
  runtimeTrustStorageKey,
} = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("runtime trust storage is scoped to the canonical workspace", () => {
  assert.equal(runtimeTrustStorageKey("/workspace/a"), runtimeTrustStorageKey("/workspace/a"));
  assert.notEqual(runtimeTrustStorageKey("/workspace/a"), runtimeTrustStorageKey("/workspace/b"));
});

test("malformed or weakly typed trust payloads fail closed", () => {
  assert.deepEqual(parseRuntimeTrust("not json"), {
    trusted_custom_base_url: "",
    mcp_trust_workspace: false,
    allow_full_access: false,
    allow_external_skill_dirs: false,
    trusted_external_graph_path: "",
  });
  assert.equal(parseRuntimeTrust('{"mcp_trust_workspace":"true"}').mcp_trust_workspace, false);
});

test("custom gateway approval is bound to the exact effective URL", () => {
  const trusted = runtimeTrustFromSettings({
    base_url: "https://gateway.example/v1/",
    trust_custom_base_url: true,
    mcp_trust_workspace: true,
  });
  assert.equal(trusted.trusted_custom_base_url, "https://gateway.example/v1");
  assert.equal(trusted.mcp_trust_workspace, true);
  assert.equal(
    runtimeTrustFromSettings({
      base_url: "https://evil.example/v1",
      trust_custom_base_url: false,
    }).trusted_custom_base_url,
    "",
  );
});

test("unrelated saves preserve prior gateway approval in SecretStorage merge", () => {
  const previous = {
    trusted_custom_base_url: "https://approved.example/v1",
    mcp_trust_workspace: true,
    allow_full_access: false,
    allow_external_skill_dirs: false,
    trusted_external_graph_path: "/graphs/approved.json",
  };
  const merged = mergeRuntimeTrust(previous, {
    base_url: "https://swapped.example/v1",
    trust_custom_base_url: false,
    mcp_trust_workspace: true,
    wire_api: "responses",
  });
  assert.equal(merged.trusted_custom_base_url, "https://approved.example/v1");
  assert.equal(merged.mcp_trust_workspace, true);
  assert.equal(merged.trusted_external_graph_path, "/graphs/approved.json");
});

test("clearing base_url revokes gateway approval", () => {
  const previous = {
    trusted_custom_base_url: "https://approved.example/v1",
    mcp_trust_workspace: false,
    allow_full_access: false,
    allow_external_skill_dirs: false,
  };
  const merged = mergeRuntimeTrust(
    previous,
    { base_url: "", trust_custom_base_url: false },
    { revokeGatewayTrust: true },
  );
  assert.equal(merged.trusted_custom_base_url, "");
});

test("newly trusted URL replaces the prior approval", () => {
  const previous = {
    trusted_custom_base_url: "https://old.example/v1",
    mcp_trust_workspace: false,
    allow_full_access: false,
    allow_external_skill_dirs: false,
  };
  const merged = mergeRuntimeTrust(previous, {
    base_url: "https://new.example/v1/",
    trust_custom_base_url: true,
  });
  assert.equal(merged.trusted_custom_base_url, "https://new.example/v1");
});
