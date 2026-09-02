/**
 * Parse file and directory references emitted as inline Markdown code.
 *
 * This deliberately recognises only unambiguous path shapes.  The extension
 * host remains responsible for resolving the path and enforcing workspace
 * boundaries before anything is opened.
 */
export type PathReference = {
  path: string;
  line?: number;
};

const BARE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const SEARCH_ARTIFACT_DIRS = new Set([".clawagents", ".git", "node_modules"]);

/** True only for a plain file name that is safe to use in a workspace glob.
 *
 * This is used only after a host request already contains a file path.  It is
 * deliberately not used to infer a path from an inline code span: dotted
 * identifiers such as `PATIENT.BIRTH_DATE` are common in prose and queries.
 */
export function isBareFileName(value: string): boolean {
  return BARE_FILE_NAME.test(value);
}

/** Keep generated snapshots and dependency trees out of basename fallback results. */
export function isWorkspaceSearchCandidate(relativePath: string): boolean {
  return !relativePath.split(/[\\/]/).some((segment) => SEARCH_ARTIFACT_DIRS.has(segment));
}

/**
 * Turn inline-code text such as `src/app.ts:42` or `reports/` into an open
 * request. URLs, prose, shell flags, and code blocks are intentionally not
 * recognised.
 */
export function parseInlinePathReference(value: string): PathReference | undefined {
  // Models sometimes escape Markdown punctuation even inside a code span;
  // there it is literal, so recover the intended workspace path first.
  const raw = value.trim().replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g, "$1");
  if (!raw || raw.length > 4_096 || /[\r\n]/.test(raw)) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) || raw.startsWith("#") || raw.startsWith("-")) {
    return undefined;
  }

  let path = raw;
  let line: number | undefined;
  const hashLine = path.match(/#L(\d+)(?:C\d+)?$/i);
  if (hashLine) {
    line = Number(hashLine[1]);
    path = path.slice(0, -hashLine[0].length);
  } else {
    const colonLine = path.match(/:(\d+)$/);
    if (colonLine) {
      line = Number(colonLine[1]);
      path = path.slice(0, -colonLine[0].length);
    }
  }
  if (!path || (line !== undefined && line < 1)) return undefined;

  const isDirectory = path.endsWith("/");
  const normalized = isDirectory ? path.slice(0, -1) : path;
  if (!normalized || normalized.includes("\\")) return undefined;

  const absolute = normalized.startsWith("/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < (absolute ? 1 : 2) || segments.some((segment) => !PATH_SEGMENT.test(segment))) {
    return undefined;
  }
  const basename = segments.at(-1)!;
  if (!isDirectory && !isBareFileName(basename)) return undefined;
  return line ? { path: normalized, line } : { path: normalized };
}
