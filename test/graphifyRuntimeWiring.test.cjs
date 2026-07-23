const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extension = fs.readFileSync(
  path.join(__dirname, "..", "src", "extension.ts"),
  "utf8",
);
const webviewProvider = fs.readFileSync(
  path.join(__dirname, "..", "src", "webviewProvider.ts"),
  "utf8",
);

function commandBody(command, nextCommand) {
  const start = extension.indexOf(`vscode.commands.registerCommand("${command}"`);
  const end = extension.indexOf(
    `vscode.commands.registerCommand("${nextCommand}"`,
    start,
  );
  assert.notEqual(start, -1, `missing ${command} command`);
  assert.notEqual(end, -1, `missing command following ${command}`);
  return extension.slice(start, end);
}

test("Graphify commands use the sidecar runtime rather than its base Python", () => {
  assert.match(
    extension,
    /const resolveGraphifyPython = async \(\): Promise<string> => \{[\s\S]*?sidecar\.resolvePythonRuntime\(\)/,
  );

  for (const [command, nextCommand] of [
    ["clawagents.ensureCompanions", "clawagents.graphifyExtract"],
    ["clawagents.graphifyExtract", "clawagents.graphifyExtractFull"],
    ["clawagents.graphifyExtractFull", "clawagents.graphifyUpdate"],
    ["clawagents.graphifyUpdate", "clawagents.graphifyAdoptUpstream"],
    ["clawagents.graphifyAdoptUpstream", "clawagents.graphifyStatus"],
    ["clawagents.graphifyStatus", "clawagents.graphifyOpenFolder"],
  ]) {
    const body = commandBody(command, nextCommand);
    assert.match(body, /resolveGraphifyPython\(\)/, `${command} bypasses sidecar Python`);
    assert.doesNotMatch(body, /config\.pythonPath/, `${command} uses base Python`);
  }
});

test("Settings Build graph button uses sidecar runtime (webview graphify_action)", () => {
  const start = webviewProvider.indexOf("private async handleGraphifyAction(");
  assert.notEqual(start, -1, "missing handleGraphifyAction");
  const end = webviewProvider.indexOf("\n  private ", start + 1);
  assert.notEqual(end, -1, "could not bound handleGraphifyAction");
  const body = webviewProvider.slice(start, end);
  assert.match(body, /await this\.sidecar\.resolvePythonRuntime\(\)/);
  assert.doesNotMatch(body, /this\.config\.pythonPath/);
});
