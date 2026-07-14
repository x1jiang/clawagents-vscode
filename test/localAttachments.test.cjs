const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-attachments-"));
const outputFile = path.join(outputDir, "localAttachments.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "localAttachments.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const {
  MAX_LOCAL_ATTACHMENT_BYTES,
  decodeLocalAttachment,
  detectDocumentMediaType,
  detectImageMediaType,
  safeLocalAttachmentName,
} = require(outputFile);

test.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

test("decodes valid browser base64 and identifies PNG bytes", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const decoded = decodeLocalAttachment(pngHeader.toString("base64"));

  assert.ok(decoded);
  assert.deepEqual(decoded.bytes, pngHeader);
  assert.equal(detectImageMediaType(decoded.bytes), "image/png");
});

test("rejects malformed, empty, and oversized attachment payloads", () => {
  assert.equal(decodeLocalAttachment(""), undefined);
  assert.equal(decodeLocalAttachment("not base64!"), undefined);
  const oversizedLength = Math.ceil(MAX_LOCAL_ATTACHMENT_BYTES / 3) * 4 + 4;
  assert.equal(decodeLocalAttachment("A".repeat(oversizedLength)), undefined);
});

test("uses image magic bytes instead of a client-provided MIME claim", () => {
  assert.equal(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(detectImageMediaType(Buffer.from("GIF89a payload")), "image/gif");
  assert.equal(detectImageMediaType(Buffer.from("RIFFxxxxWEBPpayload")), "image/webp");
  assert.equal(detectImageMediaType(Buffer.from("not an image")), undefined);
});

test("requires document container signatures instead of filename claims", () => {
  assert.equal(detectDocumentMediaType(Buffer.from("%PDF-1.7\nbody")), "application/pdf");
  assert.equal(
    detectDocumentMediaType(Buffer.from("PK\u0003\u0004...[Content_Types].xml...word/document.xml")),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(detectDocumentMediaType(Buffer.from("arbitrary bytes named report.pdf")), undefined);
  assert.equal(detectDocumentMediaType(Buffer.from("PK\u0003\u0004 ordinary.zip")), undefined);
});

test("normalizes local filenames without retaining client paths or controls", () => {
  assert.equal(safeLocalAttachmentName("C:\\Users\\me\\shot\u0000.png"), "shot.png");
  assert.equal(safeLocalAttachmentName("/tmp/report.pdf"), "report.pdf");
  assert.equal(safeLocalAttachmentName("\u0000"), "attachment");
});
