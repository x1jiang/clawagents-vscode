import * as path from "path";

export const MAX_LOCAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_LOCAL_ATTACHMENT_B64_LENGTH = Math.ceil(MAX_LOCAL_ATTACHMENT_BYTES / 3) * 4;

export function safeLocalAttachmentName(value: unknown): string {
  const raw = typeof value === "string" ? value : "attachment";
  const name = path.basename(raw.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (name || "attachment").slice(0, 120);
}

export function decodeLocalAttachment(
  value: unknown,
): { bytes: Buffer; base64: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const base64 = value.trim();
  if (
    !base64 ||
    base64.length > MAX_LOCAL_ATTACHMENT_B64_LENGTH ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOCAL_ATTACHMENT_BYTES) {
    return undefined;
  }
  return { bytes, base64 };
}

export function detectImageMediaType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export function detectDocumentMediaType(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  const zipHeader = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (
    zipHeader &&
    bytes.includes(Buffer.from("[Content_Types].xml")) &&
    bytes.includes(Buffer.from("word/"))
  ) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return undefined;
}
