/** Format a unix-seconds timestamp for compact UI chips. */
export function formatCheckpointWhen(ts: number | undefined | null, nowMs = Date.now()): string | null {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const ago = nowMs - ms;
  if (ago < 45_000) return "just now";
  if (ago < 3_600_000) return `${Math.max(1, Math.floor(ago / 60_000))}m ago`;
  const d = new Date(ms);
  const sameDay =
    d.getFullYear() === new Date(nowMs).getFullYear() &&
    d.getMonth() === new Date(nowMs).getMonth() &&
    d.getDate() === new Date(nowMs).getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function checkpointTs(row: Record<string, unknown>): number | undefined {
  const raw = row.ts ?? row.created_at ?? row.committed_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}
