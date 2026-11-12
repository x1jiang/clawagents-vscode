import { execFile } from "child_process";

/** Result of a finished child process, shaped like `spawnSync`'s. */
export type CapturedProcess = {
  /** Exit code; `null` when the process failed to start or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned or hit the timeout. */
  error?: NodeJS.ErrnoException;
};

export type CaptureOptions = {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Run a command to completion without blocking the extension host.
 *
 * `spawnSync` freezes the host's single thread — shared with every other
 * extension — for as long as the child runs, which for an interpreter probe
 * on a cold or network-mounted Python can be many seconds. This resolves with
 * the same fields callers read from `spawnSync`, and never rejects.
 */
export function execCapture(
  command: string,
  args: string[],
  options: CaptureOptions = {},
): Promise<CapturedProcess> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: options.timeout,
          env: options.env,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ status: 0, stdout, stderr });
            return;
          }
          const err = error as NodeJS.ErrnoException & { code?: number | string };
          // A numeric `code` is the child's exit status; a string code
          // (ENOENT, ETIMEDOUT…) or a kill means it never exited normally.
          if (typeof err.code === "number") {
            resolve({ status: err.code, stdout, stderr });
            return;
          }
          resolve({ status: null, stdout, stderr, error: err });
        },
      );
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: err as NodeJS.ErrnoException });
    }
  });
}
