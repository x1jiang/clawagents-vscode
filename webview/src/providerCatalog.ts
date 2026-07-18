/** Provider / Bedrock catalog helpers for Settings + model pickers. */

export type Provider = {
  id: string;
  name: string;
  available?: boolean;
  models?: Array<{
    id: string;
    label: string;
    available?: boolean;
    input_per_mtok?: number;
    output_per_mtok?: number;
  }>;
  base_url?: string;
};

export const MAX_LOCAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_ATTACHMENTS_PER_PICK = 12;
export const LOCAL_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const LOCAL_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const PREFERRED_OPENAI_MODEL = "gpt-5.6-luna";
export const PREFERRED_GEMINI_MODEL = "gemini-3.5-flash";
export const PREFERRED_EFFORT = "medium";

/** Shown when the sidecar has not returned a catalog yet (e.g. remote Python missing deps). */
export const FALLBACK_PROVIDERS: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: PREFERRED_OPENAI_MODEL, label: "GPT-5.6 Luna" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-4o", label: "GPT-4o" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    models: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    models: [{ id: "llama3.1", label: "Llama 3.1" }],
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    models: [
      {
        id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        label: "Claude Sonnet 4.5 (US)",
      },
      {
        id: "us.anthropic.claude-opus-4-6-20251101-v1:0",
        label: "Claude Opus 4.6 (US)",
      },
      {
        id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        label: "Claude Haiku 4.5 (US)",
      },
      { id: "amazon.nova-pro-v1:0", label: "Amazon Nova Pro" },
      { id: "amazon.nova-lite-v1:0", label: "Amazon Nova Lite" },
      { id: "amazon.nova-micro-v1:0", label: "Amazon Nova Micro" },
      { id: "meta.llama3-3-70b-instruct-v1:0", label: "Llama 3.3 70B" },
      { id: "openai.gpt-oss-120b-1:0", label: "GPT-OSS 120B" },
    ],
  },
];

/** Default Mantle model — chat-completions safe (frontier GPT/Claude use other paths). */
export const MANTLE_DEFAULT_MODEL = "openai.gpt-oss-20b";

/** Client fallback when sidecar catalog is empty but Settings say Mantle. */
export const MANTLE_FALLBACK_MODELS: Array<{ id: string; label: string }> = [
  { id: "openai.gpt-oss-20b", label: "GPT-OSS 20B (Mantle · chat)" },
  { id: "deepseek.v3.2", label: "DeepSeek V3.2 (Mantle · chat)" },
  { id: "anthropic.claude-haiku-4-5", label: "Claude Haiku 4.5 (Mantle · messages)" },
  { id: "anthropic.claude-sonnet-5", label: "Claude Sonnet 5 (Mantle · messages)" },
  { id: "anthropic.claude-opus-4-8", label: "Claude Opus 4.8 (Mantle · messages)" },
  { id: "anthropic.claude-fable-5", label: "Claude Fable 5 (Mantle · messages)" },
  { id: "openai.gpt-5.6-sol", label: "GPT-5.6 Sol (Mantle · responses)" },
  { id: "openai.gpt-5.6-luna", label: "GPT-5.6 Luna (Mantle · responses)" },
  { id: "openai.gpt-5.6-terra", label: "GPT-5.6 Terra (Mantle · responses)" },
  { id: "openai.gpt-5.5", label: "GPT-5.5 (Mantle · responses)" },
  { id: "xai.grok-4.3", label: "xAI Grok 4.3 (Mantle · chat)" },
  { id: "zai.glm-5", label: "Z.ai GLM-5 (Mantle · chat)" },
];

export function isMantleSettings(settings: Record<string, unknown>): boolean {
  const mode = String(settings.bedrock_mode || "").toLowerCase();
  const base = String(settings.base_url || "");
  return mode === "mantle" || /bedrock-mantle\./i.test(base);
}

export function isMantleAnthropicModel(id: string): boolean {
  let m = String(id || "")
    .trim()
    .toLowerCase();
  if (m.startsWith("bedrock/")) m = m.slice("bedrock/".length);
  // AWS APAC geo prefix is ``apac.`` (not ``ap.``).
  for (const p of ["us.", "eu.", "apac.", "global."] as const) {
    if (m.startsWith(p)) {
      m = m.slice(p.length);
      break;
    }
  }
  return m.startsWith("anthropic.") || m.startsWith("claude");
}

export function isMantleOpenAIResponsesModel(id: string): boolean {
  const m = String(id || "")
    .trim()
    .toLowerCase();
  if (!m.startsWith("openai.") || m.includes("gpt-oss")) return false;
  return /gpt-5\.[3456]/.test(m);
}

/** Wire API to save with a Mantle model (Claude Messages ignores wire_api). */
export function mantleWireApiForModel(id: string): string {
  if (isMantleAnthropicModel(id)) return "auto";
  if (isMantleOpenAIResponsesModel(id)) return "responses";
  return "chat_completions";
}

export function providerIsAvailable(provider: Provider): boolean {
  return provider.available !== false;
}

/** UI-only provider ids for Bedrock access modes (saved provider stays `bedrock`). */
export const BEDROCK_SELECT_IAM = "bedrock-iam";
export const BEDROCK_SELECT_MANTLE = "bedrock-mantle";
export const BEDROCK_SELECT_BAG = "bedrock-bag";

export function bedrockModeFromSettings(settings: Record<string, unknown>): "iam" | "mantle" | "bag" {
  const mode = String(settings.bedrock_mode || "iam").toLowerCase();
  if (mode === "mantle" || isMantleSettings(settings)) return "mantle";
  if (mode === "bag") return "bag";
  return "iam";
}

export function providerSelectValue(settings: Record<string, unknown>): string {
  const p = String(settings.provider || "auto");
  if (p !== "bedrock") return p;
  const mode = bedrockModeFromSettings(settings);
  if (mode === "mantle") return BEDROCK_SELECT_MANTLE;
  if (mode === "bag") return BEDROCK_SELECT_BAG;
  return BEDROCK_SELECT_IAM;
}

export function isNativeBedrockModelId(id: string): boolean {
  const m = String(id || "").trim();
  if (!m) return false;
  if (/^(us|eu|apac|global)\./i.test(m)) return true;
  if (/^(amazon|meta)\./i.test(m)) return true;
  // Bedrock-hosted OSS (inference profile style)
  if (/gpt-oss/i.test(m) && (m.includes(":") || m.startsWith("openai.gpt-oss"))) {
    return true;
  }
  return false;
}

export function isMantleCatalogModelId(id: string): boolean {
  const m = String(id || "").trim().toLowerCase();
  if (!m || /^(us|eu|apac|global)\./.test(m)) return false;
  return (
    m.startsWith("openai.") ||
    m.startsWith("anthropic.") ||
    m.startsWith("deepseek.") ||
    m.startsWith("xai.") ||
    m.startsWith("zai.")
  );
}

/** Per-access-mode Bedrock credential flags (do not OR them into one boolean). */
export type BedrockCredFlags = {
  /** Native AWS credential chain (IAM / profile / env). */
  iam: boolean;
  /** Mantle / OneHUB API key (BEDROCK_API_KEY or MANTLE_API_KEY). */
  mantle: boolean;
  /** Bedrock Access Gateway API key. */
  bag: boolean;
};

/** Split sidecar `bedrock` into IAM / Mantle / Gateway rows in the Provider menu. */
export function expandBedrockProviderChoices(
  providers: Provider[],
  creds: boolean | BedrockCredFlags,
): Provider[] {
  const flags: BedrockCredFlags =
    typeof creds === "boolean"
      ? { iam: creds, mantle: creds, bag: creds }
      : creds;
  const fallbackIam =
    FALLBACK_PROVIDERS.find((p) => p.id === "bedrock")?.models || [];
  const out: Provider[] = [];
  for (const p of providers) {
    if (p.id !== "bedrock") {
      out.push(p);
      continue;
    }
    const catalog = p.models || [];
    const iamModels = catalog.filter((m) => isNativeBedrockModelId(m.id));
    const mantleModels = catalog.filter((m) => isMantleCatalogModelId(m.id));
    const mark = (
      models: Array<{
        id: string;
        label?: string;
        available?: boolean;
        input_per_mtok?: number;
        output_per_mtok?: number;
      }>,
      modeAvail: boolean,
    ) =>
      models.map((m) => ({
        ...m,
        label: m.label || m.id,
        available: modeAvail && ("available" in m ? m.available !== false : true),
      }));
    out.push({
      id: BEDROCK_SELECT_IAM,
      name: "AWS Bedrock (IAM)",
      available: flags.iam,
      models: mark(iamModels.length ? iamModels : fallbackIam, flags.iam),
    });
    out.push({
      id: BEDROCK_SELECT_MANTLE,
      name: "AWS Bedrock Mantle",
      available: flags.mantle,
      models: mark(
        mantleModels.length ? mantleModels : MANTLE_FALLBACK_MODELS,
        flags.mantle,
      ),
    });
    out.push({
      id: BEDROCK_SELECT_BAG,
      name: "AWS Bedrock Gateway",
      available: flags.bag,
      models: mark(iamModels.length ? iamModels : fallbackIam, flags.bag),
    });
  }
  return out;
}

export function modelsForKeys(
  providers: Provider[],
  selectedProvider: string,
  autoBedrockSelectId?: string,
) {
  const visibleProviders = providers.filter(providerIsAvailable);
  const selected =
    selectedProvider === "auto"
      ? visibleProviders.filter(
          (p) =>
            !p.id.startsWith("bedrock-") ||
            p.id === (autoBedrockSelectId || BEDROCK_SELECT_IAM),
        )
      : visibleProviders.filter((p) => p.id === selectedProvider);
  const seen = new Set<string>();
  return selected.flatMap((p) =>
    (p.models || []).filter((m) => {
      if (!m?.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return m.available !== false;
    }),
  );
}

export function pickPreferredModel(providers: Provider[]) {
  const openai = providers.find((p) => p.id === "openai" && providerIsAvailable(p));
  if (openai?.models?.some((m) => m.id === PREFERRED_OPENAI_MODEL)) {
    return { model: PREFERRED_OPENAI_MODEL, effort: PREFERRED_EFFORT };
  }
  const gemini = providers.find((p) => p.id === "gemini" && providerIsAvailable(p));
  if (gemini?.models?.some((m) => m.id === PREFERRED_GEMINI_MODEL)) {
    return { model: PREFERRED_GEMINI_MODEL };
  }
  return { model: modelsForKeys(providers, "auto")[0]?.id || "" };
}

export function applyKeyFlagsToFallback(
  providers: Provider[],
  keys: Record<string, boolean>,
): Provider[] {
  return providers.map((provider) => ({
    ...provider,
    available: keys[provider.id] === true,
    models: (provider.models || []).map((model) => ({
      ...model,
      available: keys[provider.id] === true,
    })),
  }));
}

/**
 * Host key flags win over a stale/failed sidecar catalog probe so the
 * Provider menu does not show "(no key)" when a key is already saved.
 */
export function overlayHostKeyAvailability(
  providers: Provider[],
  flags: {
    openai: boolean;
    anthropic: boolean;
    gemini: boolean;
    iam: boolean;
    mantle: boolean;
    bag: boolean;
  },
): Provider[] {
  const hostHas = (id: string): boolean | undefined => {
    if (id === "openai") return flags.openai;
    if (id === "anthropic") return flags.anthropic;
    if (id === "gemini") return flags.gemini;
    if (id === BEDROCK_SELECT_IAM) return flags.iam;
    if (id === BEDROCK_SELECT_MANTLE) return flags.mantle;
    if (id === BEDROCK_SELECT_BAG) return flags.bag;
    if (id === "bedrock") return flags.iam || flags.mantle || flags.bag;
    return undefined;
  };
  return providers.map((p) => {
    const has = hostHas(p.id);
    if (has !== true) {
      return p;
    }
    return {
      ...p,
      available: true,
      models: (p.models || []).map((m) => ({
        ...m,
        // Parent was gated false → models inherited false; re-open them.
        available: true,
      })),
    };
  });
}

/** Short provider label for the chat header. */
export function providerDisplayLabel(settings: Record<string, unknown>): string {
  const p = String(settings.provider || "auto").trim().toLowerCase();
  if (p === "bedrock") {
    const mode = bedrockModeFromSettings(settings);
    if (mode === "mantle") return "Bedrock Mantle";
    if (mode === "bag") return "Bedrock Gateway";
    return "Bedrock IAM";
  }
  if (p === "openai") return "OpenAI";
  if (p === "anthropic") return "Anthropic";
  if (p === "gemini") return "Gemini";
  if (p === "ollama") return "Ollama";
  if (p.startsWith("profile:")) return p.slice("profile:".length) || "profile";
  return "auto";
}

/** When provider is ``auto``, show which catalog row owns the active model. */
export function effectiveProviderLabel(
  settings: Record<string, unknown>,
  modelId: string,
  providers: Provider[],
): string {
  const saved = providerDisplayLabel(settings);
  if (saved !== "auto") {
    return saved;
  }
  const mid = String(modelId || "").trim();
  if (!mid) {
    return "auto";
  }
  for (const p of providers) {
    if (p.available === false) continue;
    if ((p.models || []).some((m) => m.id === mid)) {
      if (p.id === BEDROCK_SELECT_IAM) return "Bedrock IAM";
      if (p.id === BEDROCK_SELECT_MANTLE) return "Bedrock Mantle";
      if (p.id === BEDROCK_SELECT_BAG) return "Bedrock Gateway";
      if (p.id === "openai") return "OpenAI";
      if (p.id === "anthropic") return "Anthropic";
      if (p.id === "gemini") return "Gemini";
      if (p.id === "ollama") return "Ollama";
      return p.name || p.id;
    }
  }
  return "auto";
}