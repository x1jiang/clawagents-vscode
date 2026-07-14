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

/**
 * Merge sidecar-effective trust into SecretStorage without letting an
 * unrelated save wipe a prior URL-bound gateway approval.
 *
 * `trust_custom_base_url` is false whenever the committed base_url does not
 * match the approved endpoint (including after a repo swaps the URL). In that
 * case process memory / SecretStorage must keep the prior approval so the
 * user can restore the original endpoint without re-prompting — unless they
 * explicitly cleared base_url (`revokeGatewayTrust`).
 */
export function mergeRuntimeTrust(
  previous: RuntimeTrust,
  settings: Record<string, unknown>,
  options?: { revokeGatewayTrust?: boolean },
): RuntimeTrust {
  const derived = runtimeTrustFromSettings(settings);
  return {
    mcp_trust_workspace: derived.mcp_trust_workspace,
    allow_full_access: derived.allow_full_access,
    allow_external_skill_dirs: derived.allow_external_skill_dirs,
    trusted_custom_base_url: options?.revokeGatewayTrust
      ? ""
      : derived.trusted_custom_base_url || previous.trusted_custom_base_url,
  };
}
