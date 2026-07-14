import { createHash } from "crypto";

export type RuntimeTrust = {
  trusted_custom_base_url: string;
  mcp_trust_workspace: boolean;
  allow_full_access: boolean;
  allow_external_skill_dirs: boolean;
};

export const EMPTY_RUNTIME_TRUST: RuntimeTrust = {
  trusted_custom_base_url: "",
  mcp_trust_workspace: false,
  allow_full_access: false,
  allow_external_skill_dirs: false,
};

export function runtimeTrustStorageKey(canonicalWorkspace: string): string {
  const workspaceId = createHash("sha256")
    .update(canonicalWorkspace || "<no-workspace>", "utf8")
    .digest("hex");
  return `clawagents.runtimeTrust.v1.${workspaceId}`;
}

export function parseRuntimeTrust(raw: string | undefined): RuntimeTrust {
  let value: Record<string, unknown> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch {
    value = {};
  }
  return {
    trusted_custom_base_url:
      typeof value.trusted_custom_base_url === "string"
        ? value.trusted_custom_base_url.trim().replace(/\/+$/, "")
        : "",
    mcp_trust_workspace: value.mcp_trust_workspace === true,
    allow_full_access: value.allow_full_access === true,
    allow_external_skill_dirs: value.allow_external_skill_dirs === true,
  };
}

/** Build the SecretStorage value from the sidecar's effective settings. */
export function runtimeTrustFromSettings(settings: Record<string, unknown>): RuntimeTrust {
  const baseUrl =
    typeof settings.base_url === "string"
      ? settings.base_url.trim().replace(/\/+$/, "")
      : "";
  return {
    trusted_custom_base_url:
      settings.trust_custom_base_url === true ? baseUrl : "",
    mcp_trust_workspace: settings.mcp_trust_workspace === true,
    allow_full_access: settings.allow_full_access === true,
    allow_external_skill_dirs: settings.allow_external_skill_dirs === true,
  };
}
