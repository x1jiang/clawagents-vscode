/** Polling policy for a turn that outlived its event stream. */

export const DETACHED_POLL_INTERVAL_MS = 1500;

/** Consecutive failed polls tolerated before the run is treated as lost. */
export const DETACHED_POLL_MAX_FAILURES = 8;

const DETACHED_POLL_MAX_BACKOFF_MS = 15_000;

/**
 * Delay before the next poll after `consecutiveFailures` failed polls, or
 * `undefined` to stop polling.
 *
 * A single timeout only means the sidecar was busy, so failures are retried
 * with exponential backoff (1.5s, 3s, 6s, 12s, then 15s — about 80s in all).
 * Polling stops at once when the chat is confirmed deleted, and after
 * {@link DETACHED_POLL_MAX_FAILURES} consecutive failures.
 */
export function detachedPollRetryDelay(
  consecutiveFailures: number,
  chatNotFound: boolean,
): number | undefined {
  if (chatNotFound || consecutiveFailures >= DETACHED_POLL_MAX_FAILURES) {
    return undefined;
  }
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(DETACHED_POLL_INTERVAL_MS * 2 ** exponent, DETACHED_POLL_MAX_BACKOFF_MS);
}
