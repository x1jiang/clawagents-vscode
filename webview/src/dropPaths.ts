export function hasVsCodeUriPayload(data: DataTransfer): boolean {
  return Array.from(data.types ?? []).some((type) => {
    const normalized = type.toLowerCase();
    return normalized === "application/vnd.code.uri-list" || normalized === "resourceurls";
  });
}

/** Collect file URIs from a VS Code explorer drag onto the composer. */
export function collectDropUris(dt: DataTransfer): string[] {
  const found: string[] = [];
  const pushLine = (raw: string) => {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) {
        found.push(t);
      }
    }
  };
  const pushPayload = (type: string, data: string) => {
    if (!data) {
      return;
    }
    const lower = type.toLowerCase();
    // VS Code explorer uses JSON string arrays for ResourceURLs.
    if (lower === "resourceurls" || data.startsWith("[")) {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              found.push(item.trim());
            }
          }
          return;
        }
      } catch {
        /* fall through to line split */
      }
    }
    pushLine(data);
  };
  const types = [
    "application/vnd.code.uri-list",
    "text/uri-list",
    "ResourceURLs",
    "resourceurls",
  ];
  for (const type of types) {
    const actualType = Array.from(dt.types).find((candidate) => candidate.toLowerCase() === type.toLowerCase());
    if (!actualType) continue;
    try {
      pushPayload(type, dt.getData(actualType));
    } catch {
      /* ignore */
    }
  }

  if (found.length === 0 && dt.types.includes("text/plain")) {
    try {
      pushPayload("text/plain", dt.getData("text/plain"));
    } catch {
      /* ignore */
    }
  }
  for (const file of Array.from(dt.files ?? [])) {
    const filePath = (file as File & { path?: string }).path;
    if (filePath) found.push(filePath);
  }
  return [...new Set(found)].filter((value) =>
    /^(?:file:|vscode-remote:|\/|[A-Za-z]:[\\/])/.test(value) ||
    (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/[\r\n]/.test(value)),
  );
}
