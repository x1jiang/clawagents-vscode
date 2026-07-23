const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("VS Code prompt stops credential and environment workaround churn", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "python", "chats.py"),
    "utf8",
  );
  assert.match(source, /Never source a workspace `\.env`/);
  assert.match(source, /NT_STATUS_LOGON_FAILURE/);
  assert.match(source, /re-read the exact current span/);
});
