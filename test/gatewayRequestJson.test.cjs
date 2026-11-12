"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-request-json-"));
const outputFile = path.join(outputDir, "gatewayClient.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "gatewayClient.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  external: ["vscode"],
});
const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: () => false }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let requestJson;
let isSidecarTransportError;
try {
  ({ requestJson, isSidecarTransportError } = require(outputFile));
} finally {
  Module._load = originalLoad;
}

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run({ port: server.address().port, token: "t" });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("multibyte characters split across chunks decode intact", async () => {
  const text = "日本語のテキスト 🎉 ünïcödé";
  const body = Buffer.from(JSON.stringify({ text }), "utf8");
  // Cut inside a 3-byte CJK character and again inside the 4-byte emoji.
  const firstCut = body.indexOf(Buffer.from("日")) + 1;
  const secondCut = body.indexOf(Buffer.from("🎉")) + 2;
  const got = await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(body.subarray(0, firstCut));
      setTimeout(() => {
        res.write(body.subarray(firstCut, secondCut));
        setTimeout(() => res.end(body.subarray(secondCut)), 15);
      }, 15);
    },
    (handle) => requestJson(handle, "GET", "/chats/x"),
  );
  assert.equal(got.text, text);
  assert.ok(!JSON.stringify(got).includes("�"));
});

test("an empty 200 body is an empty object", async () => {
  const got = await withServer(
    (_req, res) => res.writeHead(200).end(),
    (handle) => requestJson(handle, "POST", "/noop", {}),
  );
  assert.deepEqual(got, {});
});

test("a non-JSON body is an error, not an empty success", async () => {
  await assert.rejects(
    withServer(
      (_req, res) => res.writeHead(200).end('{"chats": [{"id": "a"'),
      (handle) => requestJson(handle, "GET", "/chats"),
    ),
    /invalid JSON body/,
  );
});

test("a connection dropped mid-body rejects instead of hanging", async () => {
  const started = Date.now();
  let caught;
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 1000 });
      res.write('{"partial": ');
      setTimeout(() => res.socket.destroy(), 20);
    },
    async (handle) => {
      try {
        await requestJson(handle, "GET", "/chats/x", undefined, 5000);
      } catch (err) {
        caught = err;
      }
    },
  );
  assert.ok(caught, "request must reject");
  assert.ok(Date.now() - started < 3000, "must settle well before the idle timeout");
  assert.equal(isSidecarTransportError(caught), true);
});

test("HTTP errors still surface status and body", async () => {
  await assert.rejects(
    withServer(
      (_req, res) => res.writeHead(404).end(JSON.stringify({ error: "not found" })),
      (handle) => requestJson(handle, "GET", "/chats/x"),
    ),
    (err) => err.statusCode === 404 && /not found/.test(err.body ?? err.message),
  );
});
