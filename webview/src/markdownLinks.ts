import { defaultUrlTransform } from "react-markdown";
import type { PathReference } from "../../src/pathReferences";

/** Explicit Markdown links can name files without inline-code path heuristics. */
export function markdownFileReference(href: string): PathReference | undefined {
  let target = href.trim();
  if (!target || target.startsWith("#") || target.startsWith("//")) return undefined;
  const isFileUrl = /^file:\/\//i.test(target);
  if (isFileUrl) {
    // Only local file URLs; never turn a network host into a workspace path.
    const match = target.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
    if (!match) return undefined;
    target = match[1];
  } else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    return undefined;
  }
  const fragment = target.indexOf("#");
  const hash = fragment >= 0 ? target.slice(fragment) : "";
  target = fragment >= 0 ? target.slice(0, fragment) : target;
  try {
    target = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  // File URLs spell Windows drive paths as /C:/...; the host needs C:/....
  // Normalize after decoding so encoded drive letters/colons work as well.
  if (isFileUrl && /^\/[a-z]:\//i.test(target)) target = target.slice(1);
  if (!target || /[\x00-\x1f\x7f?]/.test(target)) return undefined;
  const suffix = target.match(/:(\d+)(?::\d+)?$/);
  const hashLine = hash.match(/^#L(\d+)(?:C\d+)?$/i);
  const line = Number(hashLine?.[1] ?? suffix?.[1]);
  if (suffix) target = target.slice(0, -suffix[0].length);
  if ((hashLine || suffix) && (!Number.isSafeInteger(line) || line < 1)) return undefined;
  return line ? { path: target, line } : { path: target };
}

/** Preserve local anchor destinations only; retain Markdown's default URL safety for images. */
export function markdownUrlTransform(url: string, key: string): string {
  return key === "href" && markdownFileReference(url) ? url : defaultUrlTransform(url);
}
