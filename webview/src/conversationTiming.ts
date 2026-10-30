import type { ConversationTiming } from "../../src/protocol";

export function formatConversationDuration(milliseconds?: number | null): string {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** Project from receipt time, avoiding clock skew between remote hosts and UI. */
export function projectConversationTiming(timing: ConversationTiming, sinceReceiptMs: number) {
  const extra = timing.active_runs > 0 ? Math.max(0, sinceReceiptMs) : 0;
  const lastActivity = timing.last_activity_at == null ? undefined : timing.last_activity_at * 1000 + extra;
  return {
    cumulativeMs: timing.cumulative_ms + extra * timing.active_runs,
    lastRunMs: timing.last_run_ms == null ? undefined : timing.last_run_ms + extra,
    spanMs: timing.created_at == null || lastActivity == null
      ? undefined : Math.max(0, lastActivity - timing.created_at * 1000),
    lastActivity,
  };
}
