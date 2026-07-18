/**
 * Helpers for clawagents.autoOpenChangedFiles — keep secret paths closed.
 */
import * as path from "path";

/** Align with clawagents.security.secret_paths — never auto-open credentials. */
export function looksLikeSecretPath(filePath: string): boolean {
  const base = path.basename(filePath || "").toLowerCase();
  if (!base) {
    return false;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (/\.(pem|key|p12|pfx)$/i.test(base)) {
    return true;
  }
  if (base === "id_rsa" || base === "id_ed25519") {
    return true;
  }
  if (base.includes("credentials") || base.includes("secrets")) {
    return true;
  }
  return false;
}

export function pathHasDotDot(filePath: string): boolean {
  return (filePath || "").split(/[/\\]/).some((p) => p === "..");
}

/** Debounced queue: coalesce multi-file edits into the latest safe path. */
export class AutoOpenScheduler {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly open: (filePath: string) => void,
    private readonly log: (message: string) => void,
    private readonly debounceMs = 450,
  ) {}

  schedule(filePath: string): void {
    const p = (filePath || "").trim();
    if (!p || looksLikeSecretPath(p) || pathHasDotDot(p)) {
      if (p) {
        this.log(`autoOpen: skipped ${p}`);
      }
      return;
    }
    if (!this.pending.includes(p)) {
      this.pending.push(p);
    }
    if (this.pending.length > 24) {
      this.pending.splice(0, this.pending.length - 24);
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const batch = this.pending.splice(0);
      const last = [...batch].reverse().find((x) => !looksLikeSecretPath(x));
      if (last) {
        this.open(last);
      }
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.length = 0;
  }
}
