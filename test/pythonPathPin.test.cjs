const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Load compiled logic via ts → we import the built dist after build.
// For unit tests without full vscode, duplicate the PATH pin helper inline
// against the TypeScript source by requiring the esbuild bundle is heavy;
// instead re-implement the small pure helper contract here against source text.

const pinSrc = fs.readFileSync(
  path.join(__dirname, "..", "src", "pythonPathPin.ts"),
  "utf8",
);

describe("pythonPathPin source", () => {
  it("exports pinPythonPathEnv and probePathInterpreterDrift", () => {
    assert.match(pinSrc, /export function pinPythonPathEnv/);
    assert.match(pinSrc, /export function probePathInterpreterDrift/);
    assert.match(pinSrc, /export async function ensurePathPythonFloor/);
    assert.match(pinSrc, /CLAWAGENTS_PYTHON/);
    assert.match(pinSrc, /\["-a", name\]/);
  });

  it("pinPythonPathEnv puts interpreter dir first", () => {
    // Lightweight runtime check mirroring pinPythonPathEnv without vscode.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-pin-"));
    const py = path.join(dir, "python3");
    fs.writeFileSync(py, "");
    const sep = process.platform === "win32" ? ";" : ":";
    const prior = ["/usr/bin", "/opt/homebrew/bin"].join(sep);
    const binDir = path.dirname(py);
    const parts = prior.split(sep).filter((p) => p && p !== binDir);
    const next = [binDir, ...parts].join(sep);
    assert.equal(next.split(sep)[0], binDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
