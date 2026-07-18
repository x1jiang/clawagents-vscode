/**
 * OpenAI-compatible endpoint helpers (OpenAI, Ollama, OpenRouter, Bedrock Access
 * Gateway, LiteLLM, Azure OpenAI-style /v1 proxies, AWS Bedrock Mantle, …).
 */

export const BAG_LOCAL_BASE_URL = "http://localhost:8000/api/v1";
export const BAG_DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const OLLAMA_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_OFFICIAL_BASE_URL = ""; // empty = api.openai.com
/** AWS Bedrock Mantle (OneHUB) — OpenAI-compatible `/v1` (not BAG `/api/v1`). */
export const MANTLE_DEFAULT_REGION = "us-east-1";
export const MANTLE_DEFAULT_MODEL = "openai.gpt-5.6-sol";

export type CompatibleUrlStyle = "openai" | "bag" | "mantle";
export type BedrockAccessMode = "iam" | "mantle" | "bag";

/** True for `bedrock-mantle.<region>.api.aws` hosts. */
export function isMantleHost(hostname: string): boolean {
  const host = (hostname || "").toLowerCase();
  return (
    host === "bedrock-mantle.api.aws" ||
    /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/.test(host)
  );
}

export function isMantleBaseUrl(raw: string): boolean {
  const text = (raw || "").trim();
  if (!text) {
    return false;
  }
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
    return isMantleHost(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

/** Build Mantle base URL for a region (default us-east-1 — fullest catalog). */
export function mantleBaseUrlForRegion(region?: string): string {
  const r = (region || "").trim() || MANTLE_DEFAULT_REGION;
  return `https://bedrock-mantle.${r}.api.aws/v1`;
}

/** Normalize Mantle URL to `https://bedrock-mantle.<region>.api.aws/v1`. */
export function normalizeMantleBaseUrl(raw: string, region?: string): string {
  const text = (raw || "").trim();
  if (!text) {
    return mantleBaseUrlForRegion(region);
  }
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
    const u = new URL(withScheme);
    if (!isMantleHost(u.hostname)) {
      return mantleBaseUrlForRegion(region);
    }
    u.protocol = "https:";
    u.pathname = "/v1";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return mantleBaseUrlForRegion(region);
  }
}

/** Normalize a pasted OpenAI-compatible base URL (…/v1). */
export function normalizeOpenAICompatibleBaseUrl(raw: string): string {
  let text = (raw || "").trim();
  if (!text) {
    return OLLAMA_LOCAL_BASE_URL;
  }
  text = text.replace(/\/+$/, "");
  text = text.replace(/\/chat\/completions$/i, "");
  text = text.replace(/\/models$/i, "");

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") {
      u.pathname = "/v1";
    } else if (path === "/api") {
      // Prefer OpenAI-style /v1 unless this already looks like BAG (/api/v1).
      u.pathname = "/v1";
    } else if (path === "/api/v1") {
      // Keep BAG / LiteLLM path as-is.
    } else if (!path.endsWith("/v1") && !path.includes("/openai")) {
      // Leave custom paths (e.g. Azure deployment paths) alone if they already
      // have structure; only append /v1 for bare hosts handled above.
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return text;
  }
}

/** Normalize a Bedrock Access Gateway base URL (…/api/v1).
 *  Mantle URLs keep OpenAI-style `/v1` — never rewrite them to `/api/v1`. */
export function normalizeBagBaseUrl(raw: string): string {
  let text = (raw || "").trim();
  if (!text) {
    return BAG_LOCAL_BASE_URL;
  }
  if (isMantleBaseUrl(text)) {
    return normalizeMantleBaseUrl(text);
  }
  text = text.replace(/\/+$/, "");
  text = text.replace(/\/chat\/completions$/i, "");
  text = text.replace(/\/models$/i, "");

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    if (isMantleHost(u.hostname)) {
      return normalizeMantleBaseUrl(text);
    }
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") {
      u.pathname = "/api/v1";
    } else if (path === "/v1") {
      u.pathname = "/api/v1";
    } else if (path === "/api") {
      u.pathname = "/api/v1";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return text;
  }
}

export async function probeCompatibleEndpoint(
  baseUrl: string,
  apiKey: string,
  opts?: { style?: CompatibleUrlStyle; allowEmptyKey?: boolean; label?: string },
): Promise<{ ok: boolean; detail: string }> {
  const style = opts?.style || "openai";
  const label = opts?.label || (style === "bag" ? "Bedrock Access Gateway" : "compatible endpoint");
  const base =
    style === "bag"
      ? normalizeBagBaseUrl(baseUrl)
      : normalizeOpenAICompatibleBaseUrl(baseUrl);

  if (!apiKey.trim() && !opts?.allowEmptyKey) {
    return {
      ok: false,
      detail: `API key is empty — paste the ${label} key (or a placeholder like ollama / bedrock).`,
    };
  }

  const url = `${base}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  try {
    const res = await fetch(url, { method: "GET", headers });
    if (res.ok) {
      let count = "";
      try {
        const body = (await res.json()) as { data?: unknown[] };
        if (Array.isArray(body.data)) {
          count = ` — ${body.data.length} models`;
        }
      } catch {
        /* ignore */
      }
      return { ok: true, detail: `Connected to ${base}${count}` };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        detail: `Auth failed (HTTP ${res.status}) — check the API key for ${label}`,
      };
    }
    return { ok: false, detail: `${label} returned HTTP ${res.status} for ${url}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `Cannot reach ${base} (${msg}). Is ${label} running / reachable?`,
    };
  }
}

/** @deprecated use probeCompatibleEndpoint */
export async function probeBagGateway(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  return probeCompatibleEndpoint(baseUrl, apiKey, { style: "bag", label: "Bedrock Access Gateway" });
}
