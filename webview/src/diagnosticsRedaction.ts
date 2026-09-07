function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactDiagnosticText(value: string, workspacePaths: string[]): string {
  let redacted = value;
  for (const path of workspacePaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(path), "g"), "<workspace>");
  }
  return redacted
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\/home\/[^/\s]+/g, "~")
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, "~");
}

export function redactDiagnosticValue(value: unknown, workspacePaths: string[]): unknown {
  if (typeof value === "string") return redactDiagnosticText(value, workspacePaths);
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, workspacePaths));
  }
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      redactDiagnosticValue(item, workspacePaths),
    ]),
  );
}
