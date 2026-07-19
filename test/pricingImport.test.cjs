/**
 * Import the real webview pricing module (via esbuild) so TS and Node tests
 * cannot drift independently.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const src = path.join(root, "webview", "src", "pricing.ts");
const out = path.join(os.tmpdir(), `clawagents-pricing-${process.pid}.cjs`);

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "esbuild",
    src,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${out}`,
  ],
  { cwd: root, stdio: "pipe" },
);

const pricing = require(out);
try {
  fs.unlinkSync(out);
} catch {
  /* ignore */
}

assert.strictEqual(typeof pricing.estimateCostUsd, "function");

// Under cliff
const short = pricing.estimateCostUsd("gpt-5.6-luna", 200_000, 0);
assert.ok(Math.abs(short - 0.2) < 1e-9);

// Per-request sum of two 150K ≠ cumulative 300K long-context
const a = pricing.estimateCostUsd("gpt-5.6-luna", 150_000, 0);
const b = pricing.estimateCostUsd("gpt-5.6-luna", 150_000, 0);
assert.ok(Math.abs(a + b - 0.3) < 1e-9);
const wrong = pricing.estimateCostUsd("gpt-5.6-luna", 300_000, 0);
assert.ok(Math.abs(wrong - 0.6) < 1e-9);
assert.ok(a + b < wrong - 0.01);

console.log("pricingImport.test.cjs: ok");
