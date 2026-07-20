import * as path from "path";

function canonical(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function present(roots: readonly string[], candidate?: string): string | undefined {
  if (!candidate) return undefined;
  const key = canonical(candidate);
  return roots.find((root) => canonical(root) === key);
}

/** Preferred root wins, then the active editor's root, then the first folder. */
export function chooseWorkspaceRoot(
  roots: readonly string[],
  preferred?: string,
  active?: string,
): string | undefined {
  return present(roots, preferred) || present(roots, active) || roots[0];
}
