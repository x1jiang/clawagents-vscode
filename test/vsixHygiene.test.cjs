const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("VSIX excludes tests and local caches", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".vscodeignore"), "utf8");
  assert.match(ignore, /(?:^|\n)test\/\*\*/);
  assert.match(ignore, /(?:^|\n)python\/tests\/\*\*/);
  assert.match(ignore, /\.ruff_cache/);
});
