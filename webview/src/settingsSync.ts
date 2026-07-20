import { isMantleSettings } from "./providerCatalog";

export function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export function normalizeSettingsForSave(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...settings,
    skill_dirs: asStringList(settings.skill_dirs).map((d) => d.trim()).filter(Boolean),
    skill_ignore_dirs: asStringList(settings.skill_ignore_dirs)
      .map((d) => d.trim())
      .filter(Boolean),
    skill_exclude: asStringList(settings.skill_exclude).map((d) => d.trim()).filter(Boolean),
  };
}

const SETTINGS_SAVE_KEYS = [
  "model", "provider", "base_url", "default_mode", "telemetry", "trajectory",
  "learn", "browser_tools", "mcp_enabled", "mcp_trust_workspace", "context_mode",
  "workspace_system_prompt", "skill_dirs", "skill_auto_discover", "skill_ignore_dirs",
  "skill_exclude", "allow_full_access", "allow_external_skill_dirs", "skill_user_homes",
  "aws_region", "aws_profile", "bedrock_mode", "reasoning_effort", "wire_api",
  "ssl_verify", "agent_mode", "action_mode",
] as const;

export function settingsSaveKey(settings: Record<string, unknown>): string {
  try {
    const norm = normalizeSettingsForSave(settings);
    const slim: Record<string, unknown> = {};
    for (const key of SETTINGS_SAVE_KEYS) {
      if (key in norm) slim[key] = norm[key];
    }
    return JSON.stringify(slim);
  } catch {
    return "";
  }
}

function normalizeBaseUrlKey(raw: unknown): string {
  return String(raw || "").trim().replace(/\/+$/, "").toLowerCase();
}

export function settingsPatchMismatches(
  patch: Record<string, unknown>,
  saved: Record<string, unknown>,
): string[] {
  const critical = new Set([
    "wire_api", "reasoning_effort", "ssl_verify", "model", "provider", "agent_mode",
    "action_mode", "bedrock_mode", "base_url", "aws_region",
  ]);
  const keys = Object.keys(patch).filter((key) => !key.startsWith("_"));
  const checkKeys = keys.length <= 5 ? keys : keys.filter((key) => critical.has(key));
  const failed: string[] = [];
  const bothMantle = isMantleSettings(patch) && isMantleSettings(saved);
  for (const key of checkKeys) {
    const expected = patch[key];
    const actual = saved[key];
    let same = Array.isArray(expected) && Array.isArray(actual)
      ? JSON.stringify(expected) === JSON.stringify(actual)
      : expected === actual;
    if (!same && key === "base_url") {
      const a = normalizeBaseUrlKey(expected);
      const b = normalizeBaseUrlKey(actual);
      same = a === b || (bothMantle && /bedrock-mantle\./i.test(a) && /bedrock-mantle\./i.test(b));
    }
    if (!same && key === "bedrock_mode") {
      same = String(expected || "iam").toLowerCase() === String(actual || "iam").toLowerCase();
      if (!same && String(actual || "").toLowerCase() === "mantle") {
        same = bothMantle || /bedrock-mantle\./i.test(String(patch.base_url || ""));
      }
    }
    if (!same) failed.push(key);
  }
  if (
    failed.length > 0 && bothMantle
    && failed.every((key) => key === "bedrock_mode" || key === "base_url" || key === "aws_region")
  ) {
    return [];
  }
  return failed;
}

export type SettingsReplyDecision =
  | { kind: "apply" }
  | { kind: "keep_local" }
  | { kind: "ignore_stale" };

/** Decide whether an acknowledged save may replace the current local draft. */
export function decideSettingsReply(args: {
  replyRevision: number;
  latestRevision: number;
  pendingRevision?: number;
  localMatchesPending: boolean;
}): SettingsReplyDecision {
  if (
    args.replyRevision !== args.latestRevision
    || args.replyRevision !== args.pendingRevision
  ) {
    return { kind: "ignore_stale" };
  }
  if (!args.localMatchesPending) {
    return { kind: "keep_local" };
  }
  return { kind: "apply" };
}
