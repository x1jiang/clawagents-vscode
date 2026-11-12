import type { ChildProcess } from "child_process";

/** Grace between SIGTERM and SIGKILL when stopping the sidecar. */
export const SIDECAR_KILL_GRACE_MS = 1500;

export type Terminable = Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "once">;

/**
 * Terminate a child process: SIGTERM, then SIGKILL after `graceMs`. The
 * returned promise settles when the process has exited, and never later than
 * shortly after the SIGKILL, so callers can await it during shutdown.
 */
export function terminateProcess(child: Terminable, graceMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let lastResort: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(escalate);
      clearTimeout(lastResort);
      resolve();
    };
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      // SIGKILL cannot be ignored; don't hold shutdown open if the exit
      // event is somehow lost.
      lastResort = setTimeout(finish, 500);
    }, graceMs);
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });
}
