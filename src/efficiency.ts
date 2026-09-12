/** Cumulative per-run measurements. Context token estimates are not billing savings. */
export type Efficiency = {
  round_trips_avoided: number;
  tokens_avoided_by_handles: number;
  reducer_bytes_saved: number;
  reducer_fallbacks: Record<string, number>;
  compactions: Record<string, number>;
  cache_debt_tokens: number;
};

export function normalizeEfficiency(value: unknown): Efficiency | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const reasons = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, n]) => count(n) > 0).map(([k, n]) => [k, count(n)]));
  };
  return {
    round_trips_avoided: count(raw.round_trips_avoided),
    tokens_avoided_by_handles: count(raw.tokens_avoided_by_handles),
    reducer_bytes_saved: count(raw.reducer_bytes_saved),
    reducer_fallbacks: reasons(raw.reducer_fallbacks),
    compactions: reasons(raw.compactions),
    cache_debt_tokens: count(raw.cache_debt_tokens),
  };
}

export function efficiencyLabel(value: Efficiency | undefined): string {
  if (!value) return "";
  const parts: string[] = [];
  if (value.round_trips_avoided) parts.push(`${value.round_trips_avoided} fused follow-ups`);
  if (value.tokens_avoided_by_handles) parts.push(`${value.tokens_avoided_by_handles.toLocaleString()} estimated context tokens removed by handles`);
  if (value.reducer_bytes_saved) parts.push(`${value.reducer_bytes_saved.toLocaleString()} diagnostic bytes reduced`);
  for (const [reason, count] of Object.entries(value.compactions)) parts.push(`${count} ${reason.replaceAll("_", " ")} compactions`);
  for (const [reason, count] of Object.entries(value.reducer_fallbacks)) parts.push(`${count} reducer fallbacks (${reason})`);
  return parts.join(" · ");
}
