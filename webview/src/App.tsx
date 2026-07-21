import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  post,
  type AgentMode,
  type AutoApprove,
  type ChatSummary,
  type HostToWebview,
  type InteractionStyle,
} from "./vscodeApi";
import { estimateCostUsd, formatUsd, type ModelPrice } from "./pricing";
import { contextUsage } from "./contextWindow";
import { checkpointTs, formatCheckpointWhen } from "./formatTime";
import {
  asStringList,
  decideSettingsReply,
  normalizeSettingsForSave,
  settingsPatchMismatches,
  settingsSaveKey,
} from "./settingsSync";

/** OpenAI reasoning effort — labels match Cursor / ChatGPT Effort UI. */
const EFFORT_OPTIONS = [
  { value: "low", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "none", label: "None" },
] as const;

function modelSupportsEffort(model: string): boolean {
  let m = model.trim().toLowerCase();
  if (!m) return false;
  // Mantle catalog prefixes the OpenAI id (openai.gpt-5.6-…).
  if (m.startsWith("openai.")) m = m.slice("openai.".length);
  if (m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return true;
  if (m.startsWith("gpt-5.5") || m.startsWith("gpt-5.6")) return true;
  if (m === "gpt-5" || m.startsWith("gpt-5-")) return true;
  return false;
}

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      success?: boolean;
      output?: string;
      filePath?: string;
      status: "running" | "done";
    }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "file";
      path: string;
      snapshotId?: string;
      snapshotRel?: string;
    }
  | {
      kind: "permission";
      requestId: string;
      tool: string;
      filePath?: string;
      command?: string;
      reason?: string;
      resolved?: boolean;
    }
  | {
      kind: "ask";
      requestId: string;
      question: string;
      draft?: string;
      resolved?: boolean;
    }
  | {
      kind: "plan_approval";
      requestId: string;
      planText: string;
      resolved?: "approve" | "request_changes" | "reject";
    };

import {
  type Provider,
  PREFERRED_OPENAI_MODEL,
  FALLBACK_PROVIDERS,
  MANTLE_DEFAULT_MODEL,
  BEDROCK_SELECT_IAM,
  BEDROCK_SELECT_MANTLE,
  BEDROCK_SELECT_BAG,
  MAX_LOCAL_ATTACHMENT_BYTES,
  MAX_LOCAL_ATTACHMENTS_PER_PICK,
  LOCAL_IMAGE_TYPES,
  LOCAL_DOCUMENT_TYPES,
  isMantleSettings,
  mantleWireApiForModel,
  providerSelectValue,
  expandBedrockProviderChoices,
  modelsForKeys,
  pickPreferredModel,
  applyKeyFlagsToFallback,
  overlayHostKeyAvailability,
  effectiveProviderLabel,
  defaultModelForProvider,
  modelFitsProvider,
} from "./providerCatalog";



type SkillsPreview = {
  folders: Array<{ path: string; origin: string }>;
  skills: Array<{
    name: string;
    description: string;
    when_to_use?: string;
    paths?: string[];
    path: string;
    source_dir: string;
    excluded?: boolean;
  }>;
  excluded: string[];
  ignored_dirs: string[];
  auto_discover: boolean;
  /** name → why the skill can't run here (missing binary/env/OS). */
  unavailable?: Record<string, string>;
  /** name → why the skill was blocked by the content scanner. */
  quarantined?: Record<string, string>;
  /** Loader diagnostics (spec violations, oversized/skipped files). */
  warnings?: string[];
};

type Panel = "chat" | "history" | "settings" | "diagnostics";

function resolvePerm(
  requestId: string,
  decision: "allow_once" | "allow_always" | "deny",
  setItems: Dispatch<SetStateAction<ChatItem[]>>,
) {
  post({ type: "permission", requestId, decision });
  setItems((prev) =>
    prev.map((it) =>
      it.kind === "permission" && it.requestId === requestId ? { ...it, resolved: true } : it,
    ),
  );
}

function resolveAsk(
  requestId: string,
  answer: string,
  skip: boolean,
  setItems: Dispatch<SetStateAction<ChatItem[]>>,
) {
  post({ type: "ask_user_reply", requestId, answer, skip });
  setItems((prev) =>
    prev.map((it) =>
      it.kind === "ask" && it.requestId === requestId ? { ...it, resolved: true } : it,
    ),
  );
}

function resolvePlan(
  requestId: string,
  decision: "approve" | "request_changes" | "reject",
  setItems: Dispatch<SetStateAction<ChatItem[]>>,
  comment?: string,
) {
  post({ type: "plan_approval", requestId, decision, comment });
  // Approve unlocks writes for the rest of the run and switches UI to Act
  // (Grok Build: exit plan → implement).
  if (decision === "approve") {
    post({ type: "set_mode", mode: "auto" });
  }
  setItems((prev) =>
    prev.map((it) =>
      it.kind === "plan_approval" && it.requestId === requestId
        ? { ...it, resolved: decision }
        : it,
    ),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function looksLikeDiff(text: string): boolean {
  return /^@@ |^\+\+\+ |^--- |^diff --git /m.test(text);
}

type TranscriptItemProps = {
  item: ChatItem;
  showStreamingCursor: boolean;
  setItems: Dispatch<SetStateAction<ChatItem[]>>;
  onAskDraftChange: (requestId: string, draft: string) => void;
};

const TranscriptItem = memo(function TranscriptItem({
  item,
  showStreamingCursor,
  setItems,
  onAskDraftChange,
}: TranscriptItemProps) {
  return (
    <div className={`item item-${item.kind}`}>
      {item.kind === "user" && (
        <>
          <div className="label-row">
            <div className="label">You</div>
            <button type="button" className="ghost tiny" onClick={() => copyText(item.text)}>
              Copy
            </button>
          </div>
          <pre className="user-text">{item.text}</pre>
        </>
      )}
      {item.kind === "assistant" && (
        <>
          <div className="label-row">
            <div className="label">ClawAgents</div>
            <button type="button" className="ghost tiny" onClick={() => copyText(item.text)}>
              Copy
            </button>
          </div>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
            {showStreamingCursor && <span className="cursor" />}
          </div>
        </>
      )}
      {item.kind === "tool" && (
        <details open={item.status === "running" || item.success === false}>
          <summary>
            <span className={`dot ${item.status}${item.success === false ? " fail-dot" : ""}`} />
            <code>{item.name}</code>
            {item.status === "done" && (
              <span className={item.success ? "ok" : "fail"}>
                {item.success ? "ok" : "fail"}
              </span>
            )}
            {item.filePath && (
              <button
                type="button"
                className="linkish"
                onClick={(e) => {
                  e.preventDefault();
                  post({ type: "open_file", path: item.filePath! });
                }}
              >
                open
              </button>
            )}
          </summary>
          {item.args != null && <pre className="tool-body">{safeJson(item.args)}</pre>}
          {item.output ? (
            <pre className={`tool-body ${looksLikeDiff(item.output) ? "diff" : ""}`}>
              {item.output}
            </pre>
          ) : (
            item.status === "done" &&
            item.success === false && (
              <pre className="tool-body muted">No error details returned.</pre>
            )
          )}
        </details>
      )}
      {item.kind === "permission" && (
        <div className="permission">
          <div className="label">Permission required</div>
          <div className="perm-body">
            <strong>{item.tool}</strong>
            {item.filePath && (
              <>
                {" · "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => post({ type: "open_file", path: item.filePath! })}
                >
                  {item.filePath}
                </button>
              </>
            )}
            {item.command && <pre className="tool-body">{item.command}</pre>}
            {item.reason && <div className="muted">{item.reason}</div>}
          </div>
          {!item.resolved && (
            <div className="perm-actions">
              <button
                type="button"
                className="primary"
                onClick={() => resolvePerm(item.requestId, "allow_once", setItems)}
              >
                Allow once
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => resolvePerm(item.requestId, "allow_always", setItems)}
              >
                Always
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => resolvePerm(item.requestId, "deny", setItems)}
              >
                Deny
              </button>
            </div>
          )}
        </div>
      )}
      {item.kind === "plan_approval" && (
        <div className="permission plan-approval">
          <div className="label">Plan approval required</div>
          <div className="perm-body">
            <pre className="tool-body plan-text">
              {(item.planText || "").trim() || "(empty plan)"}
            </pre>
          </div>
          {item.resolved ? (
            <div className="muted">
              Plan exit:{" "}
              {item.resolved === "approve"
                ? "Approved"
                : item.resolved === "request_changes"
                  ? "Changes requested"
                  : "Rejected"}
            </div>
          ) : (
            <div className="perm-actions">
              <button
                type="button"
                className="primary"
                onClick={() => resolvePlan(item.requestId, "approve", setItems)}
              >
                Approve
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const comment =
                    window.prompt("What should change in the plan?") || "";
                  resolvePlan(item.requestId, "request_changes", setItems, comment);
                }}
              >
                Request changes
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => resolvePlan(item.requestId, "reject", setItems)}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
      {item.kind === "ask" && (
        <div className="permission ask-user">
          <div className="label">Agent asks</div>
          <div className="perm-body">{item.question}</div>
          {!item.resolved ? (
            <>
              <textarea
                className="ask-input"
                rows={3}
                value={item.draft || ""}
                placeholder="Type your answer…"
                onChange={(e) => onAskDraftChange(item.requestId, e.target.value)}
              />
              <div className="perm-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!item.draft?.trim()}
                  onClick={() => resolveAsk(item.requestId, item.draft || "", false, setItems)}
                >
                  Reply
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => resolveAsk(item.requestId, "", true, setItems)}
                >
                  Skip
                </button>
              </div>
            </>
          ) : (
            <div className="muted tiny">Answered</div>
          )}
        </div>
      )}
      {item.kind === "file" && (
        <div className="file-row">
          <button
            type="button"
            className="file-chip"
            onClick={() => post({ type: "open_file", path: item.path })}
          >
            Changed · {item.path}
          </button>
          <button
            type="button"
            className="ghost tiny"
            onClick={() =>
              post({
                type: "diff_snapshot",
                path: item.path,
                snapshotId: item.snapshotId,
                snapshotRel: item.snapshotRel,
              })
            }
          >
            Diff
          </button>
          {item.snapshotId && item.snapshotRel && (
            <button
              type="button"
              className="ghost tiny"
              onClick={() =>
                post({
                  type: "restore_snapshot",
                  snapshotId: item.snapshotId!,
                  rel: item.snapshotRel!,
                })
              }
            >
              Restore
            </button>
          )}
        </div>
      )}
      {item.kind === "status" && <div className="status">{item.text}</div>}
      {item.kind === "error" && <div className="error">{item.text}</div>}
    </div>
  );
});

/** Cap DOM nodes for long transcripts; "Show more" expands the window. */
const TRANSCRIPT_RENDER_CHUNK = 120;

export function App() {
  const [items, setItems] = useState<ChatItem[]>([]);
  /** How many trailing items to mount (virtualization window). */
  const [renderWindow, setRenderWindow] = useState(TRANSCRIPT_RENDER_CHUNK);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; name: string }>>([]);
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; name: string }>>([]);
  const [workspace, setWorkspace] = useState<string | undefined>();
  const [model, setModel] = useState("default");
  const [mode, setMode] = useState<AgentMode>("auto");
  const [interaction, setInteraction] = useState<InteractionStyle>("interactive");
  const [autoApprove, setAutoApprove] = useState<AutoApprove>({
    edit: true,
    execute: true,
    web: false,
    browser: false,
  });
  const [caveman, setCaveman] = useState(true);
  const [goalMode, setGoalMode] = useState(false);
  const [autoApproveOpen, setAutoApproveOpen] = useState(false);
  const [includeContext, setIncludeContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [hasTavilyKey, setHasTavilyKey] = useState(false);
  const [hasBedrockKey, setHasBedrockKey] = useState(false);
  const [hasAwsCreds, setHasAwsCreds] = useState(false);
  const [hasOpenAIKey, setHasOpenAIKey] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [providerKeyDraft, setProviderKeyDraft] = useState("");
  const [providerSetupMsg, setProviderSetupMsg] = useState("");
  const [sidecar, setSidecar] = useState<"stopped" | "starting" | "running" | "error">(
    "stopped",
  );
  const [sidecarDetail, setSidecarDetail] = useState<string | undefined>();
  const [chatId, setChatId] = useState<string | undefined>();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySearching, setHistorySearching] = useState(false);
  const [panel, setPanel] = useState<Panel>("chat");
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [skillsPreview, setSkillsPreview] = useState<SkillsPreview | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [diagnostics, setDiagnostics] = useState<unknown>();
  const [graphifyStatus, setGraphifyStatus] = useState<Record<string, unknown> | null>(
    null,
  );
  const [stats, setStats] = useState<unknown>();
  const [usage, setUsage] = useState<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    lastInputTokens?: number;
    requestCount?: number;
    maxInputTokens?: number;
    longContextRequestCount?: number;
    nextPromptEstTokens?: number;
    runCostUsd?: number;
  }>({});
  const [compactPhase, setCompactPhase] = useState<string | undefined>();
  const [checkpoints, setCheckpoints] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [hunks, setHunks] = useState<Array<Record<string, unknown>>>([]);
  const [hunksOpen, setHunksOpen] = useState(false);
  const [rewindSnaps, setRewindSnaps] = useState<Array<Record<string, unknown>>>([]);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [dictating, setDictating] = useState(false);
  /** Forces relative checkpoint labels ("2m ago") to refresh while the panel is open. */
  const [nowTick, setNowTick] = useState(() => Date.now());
  /** Sum of estimated USD for completed runs in this chat (not including the in-flight run). */
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
  const runCommittedRef = useRef(false);
  const runUsageRef = useRef<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    lastInputTokens?: number;
    requestCount?: number;
    maxInputTokens?: number;
    longContextRequestCount?: number;
    nextPromptEstTokens?: number;
    runCostUsd?: number;
  }>({});
  const modelRef = useRef("");
  const modelMetaRef = useRef<ModelPrice | undefined>(undefined);
  const [verifyMsg, setVerifyMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLElement | null>(null);
  /** When false, streaming tokens must not yank scroll away from the user. */
  const stickToBottomRef = useRef(true);
  const streamingRef = useRef(false);
  const handleAskDraftChange = useCallback((requestId: string, draft: string) => {
    setItems((prev) =>
      prev.map((it) => (it.kind === "ask" && it.requestId === requestId ? { ...it, draft } : it)),
    );
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bugReportTextareaRef = useRef<HTMLTextAreaElement>(null);
  const localAttachInputRef = useRef<HTMLInputElement>(null);
  const persistTimer = useRef<number | undefined>();
  const settingsSaveTimer = useRef<number | undefined>();
  /** Skip one effect cycle after applying host-pushed settings (avoid save loops). */
  const skipSettingsAutosave = useRef(true);
  /** True after the first host settings payload — blocks empty initial autosave. */
  const settingsAutosaveReady = useRef(false);
  /** Last settings patch we asked the host to persist — verified on `settings` reply. */
  const pendingSettingsPatch = useRef<Record<string, unknown> | null>(null);
  /** Revisioned saves make host replies deterministic even when several are queued. */
  const settingsRevision = useRef(0);
  const pendingSettingsSaves = useRef(
    new Map<number, { key: string; patch: Record<string, unknown> }>(),
  );
  /**
   * Fingerprint of last *confirmed* settings (host ok / cancelled revert).
   * Autosave only runs when local settings differ — prevents forever PUT loops.
   */
  const committedSettingsKey = useRef<string>("");
  /** Fingerprint of in-flight save — not committed until host confirms. */
  const inflightSettingsKey = useRef<string>("");
  /** Latest settings for message-handler stale-echo checks (avoid clobber). */
  const settingsRef = useRef<Record<string, unknown>>({});
  const postSettingsSave = useCallback((
    patch: Record<string, unknown>,
    localSettings: Record<string, unknown>,
  ) => {
    const revision = ++settingsRevision.current;
    const key = settingsSaveKey(localSettings);
    settingsRef.current = localSettings;
    pendingSettingsPatch.current = patch;
    inflightSettingsKey.current = key;
    pendingSettingsSaves.current.set(revision, { key, patch });
    for (const oldRevision of pendingSettingsSaves.current.keys()) {
      if (oldRevision < revision - 32) pendingSettingsSaves.current.delete(oldRevision);
    }
    post({ type: "save_settings", revision, settings: patch });
    return revision;
  }, []);
  /** One-shot preferred-model fill (empty model only) — never loop on catalog mismatch. */
  const preferredModelFilled = useRef(false);
  /** Dedupe one-shot heal of vendor-incompatible leftovers (e.g. llama3.1 on OpenAI). */
  const incompatibleModelHealKey = useRef("");
  const historySearchTimer = useRef<number | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const attachmentRequestsRef = useRef(new Set<string>());
  const [attachmentUploads, setAttachmentUploads] = useState(0);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportText, setBugReportText] = useState("");
  const [bugReportShots, setBugReportShots] = useState<
    Array<{ name: string; mediaType: string; data: string }>
  >([]);
  const [bugReportBusy, setBugReportBusy] = useState(false);
  const [bugReportStatus, setBugReportStatus] = useState("");
  const [bugReportDictating, setBugReportDictating] = useState(false);

  const commitRunCost = (u: {
    promptTokens?: number;
    completionTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
  }, serverSession?: number) => {
    if (runCommittedRef.current) {
      return;
    }
    if (typeof serverSession === "number") {
      setSessionCostUsd(serverSession);
      runCommittedRef.current = true;
      return;
    }
    const cost = estimateCostUsd(
      modelRef.current,
      u.promptTokens || 0,
      u.completionTokens || 0,
      modelMetaRef.current,
      String(settingsRef.current.provider || ""),
      u.cachedInputTokens || 0,
      u.cacheCreationTokens || 0,
    );
    if (cost != null && cost > 0) {
      setSessionCostUsd((s) => s + cost);
    }
    runCommittedRef.current = true;
  };

  const resetSessionCost = (seed = 0) => {
    setUsage({});
    runUsageRef.current = {};
    setSessionCostUsd(seed);
    runCommittedRef.current = false;
  };

  const workspaceName = useMemo(
    () => (workspace ? workspace.split(/[/\\]/).pop() : "No workspace"),
    [workspace],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !("type" in msg)) {
        return;
      }
      switch (msg.type) {
        case "ready":
          setWorkspace(msg.workspace);
          setModel(msg.model || "default");
          setMode(msg.mode);
          if (msg.interaction === "interactive" || msg.interaction === "auto") {
            setInteraction(msg.mode === "read_only" ? "interactive" : msg.interaction);
          } else if (msg.mode === "read_only") {
            setInteraction("interactive");
          }
          if (typeof msg.caveman === "boolean") {
            setCaveman(msg.caveman);
          }
          if (typeof msg.goal === "boolean") {
            setGoalMode(msg.goal);
          }
          setHasApiKey(msg.hasApiKey);
          if (typeof msg.hasTavilyKey === "boolean") {
            setHasTavilyKey(msg.hasTavilyKey);
          }
          if (typeof msg.hasBedrockKey === "boolean") {
            setHasBedrockKey(msg.hasBedrockKey);
          }
          if (typeof msg.hasAwsCreds === "boolean") {
            setHasAwsCreds(msg.hasAwsCreds);
          }
          if (typeof msg.hasOpenAIKey === "boolean") {
            setHasOpenAIKey(msg.hasOpenAIKey);
          }
          if (typeof msg.hasAnthropicKey === "boolean") {
            setHasAnthropicKey(msg.hasAnthropicKey);
          }
          if (typeof msg.hasGeminiKey === "boolean") {
            setHasGeminiKey(msg.hasGeminiKey);
          }
          if (typeof msg.includeContextByDefault === "boolean") {
            setIncludeContext(msg.includeContextByDefault);
          }
          setSidecar(msg.sidecar);
          setChatId(msg.chatId);
          setChats(msg.chats || []);
          if (msg.settings) {
            const localKey = settingsSaveKey(settingsRef.current);
            const dirty =
              Boolean(localKey) && localKey !== committedSettingsKey.current;
            if (!dirty) {
              skipSettingsAutosave.current = true;
              settingsAutosaveReady.current = true;
              committedSettingsKey.current = settingsSaveKey(msg.settings);
              settingsRef.current = msg.settings;
              setSettings(msg.settings);
              if (typeof msg.settings.model === "string" && msg.settings.model) {
                setModel(msg.settings.model);
              }
            } else {
              settingsAutosaveReady.current = true;
            }
          }
          if (msg.providers) {
            setProviders(msg.providers as Provider[]);
          }
          if (msg.diagnostics) {
            setDiagnostics(msg.diagnostics);
          }
          if (msg.stats) {
            setStats(msg.stats);
          }
          // Quiet refresh so the Checkpoints chip can show last time.
          post({ type: "list_checkpoints", open: false });
          break;
        case "sidecar":
          setSidecar(msg.state);
          setSidecarDetail(msg.detail);
          break;
        case "stranded_interject": {
          // Host normally queues these; if an event leaks here, surface it and
          // re-queue so the redirect is not silently dropped.
          const prompts = (msg.prompts || [])
            .map((p: unknown) => String(p || "").trim())
            .filter(Boolean);
          if (prompts.length) {
            setItems((prev) => [
              ...prev,
              {
                kind: "status",
                text: `Queued stranded redirect${prompts.length > 1 ? "s" : ""}`,
              },
            ]);
            for (const text of prompts) {
              post({ type: "queue_send", text });
            }
          }
          break;
        }
        case "chats":
          setChats(msg.chats || []);
          setHistorySearching(false);
          if (msg.chatId) {
            setChatId(msg.chatId);
          }
          break;
        case "settings": {
          const incoming = msg.settings || {};
          if (msg.providers) {
            setProviders(msg.providers as Provider[]);
          }
          // Authoritative host key flags travel with every catalog push.
          if (typeof msg.hasApiKey === "boolean") setHasApiKey(msg.hasApiKey);
          if (typeof msg.hasTavilyKey === "boolean") setHasTavilyKey(msg.hasTavilyKey);
          if (typeof msg.hasBedrockKey === "boolean") setHasBedrockKey(msg.hasBedrockKey);
          if (typeof msg.hasAwsCreds === "boolean") setHasAwsCreds(msg.hasAwsCreds);
          if (typeof msg.hasOpenAIKey === "boolean") setHasOpenAIKey(msg.hasOpenAIKey);
          if (typeof msg.hasAnthropicKey === "boolean") {
            setHasAnthropicKey(msg.hasAnthropicKey);
          }
          if (typeof msg.hasGeminiKey === "boolean") setHasGeminiKey(msg.hasGeminiKey);
          const applySettingsSnapshot = (status: string) => {
            pendingSettingsPatch.current = null;
            inflightSettingsKey.current = "";
            skipSettingsAutosave.current = true;
            settingsAutosaveReady.current = true;
            committedSettingsKey.current = settingsSaveKey(incoming);
            settingsRef.current = incoming;
            setSettings(incoming);
            if (typeof incoming.model === "string" && incoming.model) {
              setModel(incoming.model);
            }
            setVerifyMsg(status);
          };
          if (msg.saveOutcome && typeof msg.revision === "number") {
            const pendingSave = pendingSettingsSaves.current.get(msg.revision);
            const decision = decideSettingsReply({
              replyRevision: msg.revision,
              latestRevision: settingsRevision.current,
              pendingRevision: pendingSave ? msg.revision : undefined,
              localMatchesPending: Boolean(
                pendingSave
                && settingsSaveKey(settingsRef.current) === pendingSave.key
              ),
            });
            pendingSettingsSaves.current.delete(msg.revision);
            if (decision.kind === "ignore_stale") {
              break;
            }
            if (decision.kind === "keep_local") {
              pendingSettingsPatch.current = null;
              inflightSettingsKey.current = "";
              committedSettingsKey.current = settingsSaveKey(incoming);
              setVerifyMsg("Saved; preserving newer local edits…");
              break;
            }
            applySettingsSnapshot(
              msg.saveOutcome === "cancelled" ? "Settings save cancelled" : "Saved ✓",
            );
            break;
          }
          // Trust-modal cancel (or explicit host revert) — always apply snapshot.
          if (msg.saveOutcome === "cancelled") {
            applySettingsSnapshot("Settings save cancelled");
            break;
          }
          const pending = pendingSettingsPatch.current;
          if (pending) {
            const failed = settingsPatchMismatches(pending, incoming);
            if (failed.length > 0) {
              // Stale reply (e.g. IAM echo after user chose Mantle) — keep local
              // UI and keep pending so a matching reply can still land. Clear
              // inflight only after a short window via retry (local ≠ committed).
              setVerifyMsg(
                `Ignoring stale settings (${failed.join(", ")}) — keeping your Access mode`,
              );
              break;
            }
            applySettingsSnapshot("Saved ✓");
            break;
          }
          // Unsolicited push (load/ready) — never clobber in-progress edits.
          const localKey = settingsSaveKey(settingsRef.current);
          if (
            localKey &&
            (localKey !== committedSettingsKey.current ||
              Boolean(inflightSettingsKey.current))
          ) {
            break;
          }
          // Post-commit race: a late getSettings can still push IAM while the
          // UI is on Mantle. Never demote Mantle → IAM without an explicit save.
          if (
            msg.saveOutcome !== "ok" &&
            isMantleSettings(settingsRef.current) &&
            !isMantleSettings(incoming)
          ) {
            break;
          }
          // Inverse: never hijack OpenAI/Anthropic/Gemini back to Bedrock on a
          // stale push (same class of bug as Mantle URL sticking after switch).
          const localProv = String(settingsRef.current.provider || "").toLowerCase();
          const incomingProv = String(incoming.provider || "").toLowerCase();
          if (
            msg.saveOutcome !== "ok" &&
            ["openai", "anthropic", "gemini", "ollama"].includes(localProv) &&
            incomingProv === "bedrock"
          ) {
            break;
          }
          skipSettingsAutosave.current = true;
          settingsAutosaveReady.current = true;
          committedSettingsKey.current = settingsSaveKey(incoming);
          settingsRef.current = incoming;
          setSettings(incoming);
          if (typeof incoming.model === "string" && incoming.model) {
            setModel(incoming.model);
          }
          setVerifyMsg((v) => (v === "Saving…" ? "Saved ✓" : v));
          break;
        }
        case "skill_dir_picked": {
          const path = (msg.path || "").trim();
          if (!path) break;
          setSettings((s) => {
            const cur = asStringList(s.skill_dirs);
            if (cur.includes(path)) return s;
            const ignored = asStringList(s.skill_ignore_dirs).filter((d) => d !== path);
            return { ...s, skill_dirs: [...cur, path], skill_ignore_dirs: ignored };
          });
          break;
        }
        case "skills_preview":
          setSkillsPreview({
            folders: msg.folders || [],
            skills: msg.skills || [],
            excluded: msg.excluded || [],
            ignored_dirs: msg.ignored_dirs || [],
            auto_discover: Boolean(msg.auto_discover),
            unavailable: msg.unavailable || {},
            quarantined: msg.quarantined || {},
            warnings: msg.warnings || [],
          });
          break;
        case "verify_result":
          setVerifyMsg(
            `${msg.provider}: ${msg.ok ? "✓" : "✗"} ${msg.detail || (msg.ok ? "ok" : "missing")}`,
          );
          if (
            msg.provider === "bedrock" ||
            msg.provider === "openai" ||
            msg.provider === "anthropic" ||
            msg.provider === "gemini" ||
            msg.provider === "tavily"
          ) {
            setProviderSetupMsg(`${msg.ok ? "✓" : "✗"} ${msg.detail || ""}`);
          }
          // Never parse "saved"/"cleared" from detail — that clobbered workspace
          // .env keys after Clear. Prefer explicit host flags when present.
          if (typeof msg.hasApiKey === "boolean") setHasApiKey(msg.hasApiKey);
          if (typeof msg.hasTavilyKey === "boolean") setHasTavilyKey(msg.hasTavilyKey);
          if (typeof msg.hasBedrockKey === "boolean") setHasBedrockKey(msg.hasBedrockKey);
          if (typeof msg.hasAwsCreds === "boolean") setHasAwsCreds(msg.hasAwsCreds);
          if (typeof msg.hasOpenAIKey === "boolean") setHasOpenAIKey(msg.hasOpenAIKey);
          if (typeof msg.hasAnthropicKey === "boolean") {
            setHasAnthropicKey(msg.hasAnthropicKey);
          }
          if (typeof msg.hasGeminiKey === "boolean") setHasGeminiKey(msg.hasGeminiKey);
          break;
        case "diagnostics":
          setDiagnostics(msg.data);
          break;
        case "graphify_status":
          setGraphifyStatus(msg.data || null);
          break;
        case "stats":
          setStats(msg.data);
          break;
        case "restore":
          setItems((msg.items as ChatItem[]) || []);
          setRenderWindow(TRANSCRIPT_RENDER_CHUNK);
          setEventsHasMore(Boolean(msg.eventsHasMore));
          setDraft(msg.draft || "");
          setMode(msg.mode);
          if (msg.interaction === "interactive" || msg.interaction === "auto") {
            setInteraction(msg.mode === "read_only" ? "interactive" : msg.interaction);
          } else if (msg.mode === "read_only") {
            setInteraction("interactive");
          }
          if (msg.autoApprove) {
            setAutoApprove((prev) => ({ ...prev, ...msg.autoApprove }));
          }
          if (typeof msg.caveman === "boolean") {
            setCaveman(msg.caveman);
          }
          if (typeof msg.goal === "boolean") {
            setGoalMode(msg.goal);
          }
          if (msg.chatId) {
            setChatId(msg.chatId);
          }
          // Prefer persisted session total from chat meta (survives reload).
          resetSessionCost(
            typeof msg.sessionCostUsd === "number" ? msg.sessionCostUsd : 0,
          );
          setBusy(false);
          streamingRef.current = false;
          setPanel("chat");
          break;
        case "prepend_items": {
          const older = (msg.items as ChatItem[]) || [];
          if (older.length) {
            setItems((prev) => [...older, ...prev]);
            setRenderWindow((w) => w + older.length);
          }
          setEventsHasMore(Boolean(msg.eventsHasMore));
          break;
        }
        case "prepend":
          setDraft((d) => msg.text + d);
          textareaRef.current?.focus();
          break;
        case "images_pending":
          setPendingImages(msg.images);
          break;
        case "files_pending":
          setPendingFiles(msg.files);
          break;
        case "attachment_staged":
          if (attachmentRequestsRef.current.delete(msg.requestId)) {
            setAttachmentUploads(attachmentRequestsRef.current.size);
          }
          break;
        case "user_echo":
          setItems((prev) => [...prev, { kind: "user", text: msg.text }]);
          setBusy(true);
          streamingRef.current = false;
          setUsage({});
          runUsageRef.current = {};
          runCommittedRef.current = false;
          break;
        case "status":
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.kind === "status") {
              next[next.length - 1] = { kind: "status", text: msg.message };
              return next;
            }
            return [...next, { kind: "status", text: msg.message }];
          });
          break;
        case "assistant_delta":
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.kind === "assistant" && streamingRef.current) {
              next[next.length - 1] = { kind: "assistant", text: last.text + msg.delta };
              return next;
            }
            streamingRef.current = true;
            return [...next, { kind: "assistant", text: msg.delta }];
          });
          break;
        case "assistant_message": {
          const wasStreaming = streamingRef.current;
          streamingRef.current = false;
          if (!msg.text.trim()) {
            break;
          }
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "assistant") {
              // The canonical message replaces the delta-accumulated text
              // (they can differ slightly after sanitization) instead of
              // duplicating it.
              if (wasStreaming || last.text === msg.text) {
                const next = [...prev];
                next[next.length - 1] = { kind: "assistant", text: msg.text };
                return next;
              }
            }
            return [...prev, { kind: "assistant", text: msg.text }];
          });
          break;
        }
        case "tool_started":
          streamingRef.current = false;
          setItems((prev) => [
            ...prev,
            {
              kind: "tool",
              id: msg.id,
              name: msg.name,
              args: msg.args,
              filePath: msg.filePath,
              status: "running",
            },
          ]);
          break;
        case "tool_completed":
          setItems((prev) => {
            let matched = false;
            const next = prev.map((it) => {
              if (
                it.kind === "tool" &&
                (it.id === msg.id ||
                  (!msg.id && it.name === msg.name && it.status === "running"))
              ) {
                matched = true;
                return {
                  ...it,
                  status: "done" as const,
                  success: msg.success,
                  output: msg.output,
                  filePath: msg.filePath || it.filePath,
                };
              }
              return it;
            });
            // tool_skipped (and similar) may arrive with no prior tool_started
            if (!matched) {
              next.push({
                kind: "tool",
                id: msg.id || msg.name,
                name: msg.name,
                status: "done",
                success: msg.success,
                output: msg.output,
                filePath: msg.filePath,
              });
            }
            return next;
          });
          break;
        case "permission_required":
          setItems((prev) => [
            ...prev,
            {
              kind: "permission",
              requestId: msg.requestId,
              tool: msg.tool,
              filePath: msg.filePath,
              command: msg.command,
              reason: msg.reason,
            },
          ]);
          break;
        case "ask_user_required":
          setItems((prev) => [
            ...prev,
            {
              kind: "ask",
              requestId: msg.requestId,
              question: msg.question,
              draft: "",
            },
          ]);
          break;
        case "plan_approval_required":
          setItems((prev) => [
            ...prev,
            {
              kind: "plan_approval",
              requestId: msg.requestId,
              planText: msg.planText || "",
            },
          ]);
          break;
        case "plan_approved":
          setMode(msg.mode || "auto");
          setGoalMode(false);
          break;
        case "file_changed":
          if (msg.path) {
            setItems((prev) => [
              ...prev,
              {
                kind: "file",
                path: msg.path,
                snapshotId: msg.snapshotId,
                snapshotRel: msg.snapshotRel,
              },
            ]);
          }
          break;
        case "usage": {
          // Never treat missing lastInputTokens as promptTokens — the latter is
          // run-cumulative and would inflate the context meter after multi-round loops.
          const next = {
            promptTokens: msg.promptTokens,
            completionTokens: msg.completionTokens,
            totalTokens: msg.totalTokens,
            cachedInputTokens: msg.cachedInputTokens,
            cacheCreationTokens: msg.cacheCreationTokens,
            lastInputTokens:
              msg.lastInputTokens ?? runUsageRef.current?.lastInputTokens,
            requestCount: msg.requestCount ?? runUsageRef.current?.requestCount,
            maxInputTokens:
              msg.maxInputTokens ?? runUsageRef.current?.maxInputTokens,
            longContextRequestCount:
              msg.longContextRequestCount ??
              runUsageRef.current?.longContextRequestCount,
            nextPromptEstTokens:
              msg.nextPromptEstTokens ?? runUsageRef.current?.nextPromptEstTokens,
            runCostUsd: msg.runCostUsd ?? runUsageRef.current?.runCostUsd,
          };
          runUsageRef.current = next;
          setUsage(next);
          break;
        }
        case "compact_progress": {
          setCompactPhase(msg.phase || undefined);
          if (msg.phase === "end" || msg.phase === "failed" || msg.phase === "dropped") {
            window.setTimeout(() => setCompactPhase(undefined), 2500);
          }
          break;
        }
        case "checkpoint": {
          if (msg.sha) {
            setCheckpoints((prev) => {
              const next = [
                {
                  sha: msg.sha,
                  tool: msg.tool,
                  phase: msg.phase,
                  label: msg.label,
                  message_count: msg.messageCount,
                  ts: msg.ts ?? Math.floor(Date.now() / 1000),
                },
                ...prev.filter((r) => r.sha !== msg.sha),
              ];
              return next.slice(0, 30);
            });
          }
          break;
        }
        case "checkpoints": {
          setCheckpoints(msg.checkpoints || []);
          if (msg.open !== false) {
            setCheckpointsOpen(true);
          }
          break;
        }
        case "hunks": {
          setHunks(msg.hunks || []);
          if (msg.open !== false) setHunksOpen(true);
          break;
        }
        case "rewind": {
          setRewindSnaps(msg.snapshots || []);
          if (msg.open !== false) setRewindOpen(true);
          break;
        }
        case "done": {
          setBusy(false);
          streamingRef.current = false;
          let finalUsage = runUsageRef.current;
          let serverSession: number | undefined = msg.sessionCostUsd;
          let serverRun: number | undefined = msg.runCostUsd;
          if (msg.usage && typeof msg.usage === "object") {
            const u = msg.usage as Record<string, number>;
            // prompt_tokens = run-cumulative (sum of rounds). last_input_tokens =
            // size of the latest LLM request — that alone drives the context %.
            const lastIn =
              typeof u.last_input_tokens === "number" && u.last_input_tokens > 0
                ? u.last_input_tokens
                : runUsageRef.current?.lastInputTokens;
            finalUsage = {
              promptTokens: u.prompt_tokens,
              completionTokens: u.completion_tokens,
              totalTokens: u.total_tokens,
              cachedInputTokens: u.cached_input_tokens ?? u.cache_read_tokens,
              cacheCreationTokens: u.cache_creation_tokens,
              lastInputTokens: lastIn,
              requestCount: u.request_count,
              maxInputTokens: u.max_input_tokens,
              longContextRequestCount: u.long_context_request_count,
              nextPromptEstTokens: u.next_prompt_est_tokens,
              runCostUsd:
                typeof u.run_cost_usd === "number" ? u.run_cost_usd : undefined,
            };
            runUsageRef.current = finalUsage;
            setUsage(finalUsage);
            if (typeof u.session_cost_usd === "number") {
              serverSession = u.session_cost_usd;
            }
            if (typeof u.run_cost_usd === "number") {
              serverRun = u.run_cost_usd;
            }
          }
          commitRunCost(finalUsage, serverSession);
          const runCost =
            serverRun ??
            estimateCostUsd(
              modelRef.current,
              finalUsage.promptTokens || 0,
              finalUsage.completionTokens || 0,
              modelMetaRef.current,
              String(settingsRef.current.provider || ""),
              finalUsage.cachedInputTokens || 0,
              finalUsage.cacheCreationTokens || 0,
            );
          setItems((prev) => [
            ...prev.filter((it) => it.kind !== "status"),
            {
              kind: "status",
              text: `Done · ${msg.status}${msg.iterations != null ? ` · ${msg.iterations} iters` : ""}${
                runCost != null ? ` · run ~${formatUsd(runCost)}` : ""
              }`,
            },
          ]);
          break;
        }
        case "error":
          setBusy(false);
          streamingRef.current = false;
          commitRunCost(runUsageRef.current);
          // A failed settings save posts type:"error" without saveOutcome —
          // clear the sticky pending patch so later Settings edits can save.
          if (pendingSettingsPatch.current) {
            pendingSettingsPatch.current = null;
            inflightSettingsKey.current = "";
            settingsAutosaveReady.current = true;
          }
          if (msg.message === "cancelled") {
            setItems((prev) => [...prev, { kind: "status", text: "Cancelled" }]);
          } else {
            setItems((prev) => [...prev, { kind: "error", text: msg.message }]);
          }
          break;
        case "cancelled":
          setBusy(false);
          streamingRef.current = false;
          commitRunCost(runUsageRef.current);
          setItems((prev) => [...prev, { kind: "status", text: "Cancelled" }]);
          break;
        case "bug_report_screenshot":
          setBugReportBusy(false);
          if (msg.ok && msg.screenshot) {
            setBugReportShots((prev) => [...prev, msg.screenshot!].slice(0, 6));
            setBugReportStatus("Screenshot attached");
          } else {
            setBugReportStatus(msg.detail || "Screenshot cancelled");
          }
          break;
        case "bug_report_result":
          setBugReportBusy(false);
          setBugReportStatus(msg.detail || (msg.ok ? "Sent" : "Failed"));
          if (msg.ok) {
            setBugReportText("");
            setBugReportShots([]);
            setTimeout(() => setBugReportOpen(false), 800);
          }
          break;
        case "dictation_focus":
          if (msg.target === "bug_report") {
            bugReportTextareaRef.current?.focus();
          } else {
            textareaRef.current?.focus();
          }
          break;
        case "dictation_state":
          if (msg.target === "bug_report") {
            setBugReportDictating(msg.recording);
            if (msg.detail) setBugReportStatus(msg.detail);
          } else {
            setDictating(msg.recording);
          }
          break;
        case "dictation_result": {
          const piece = msg.text.trim();
          if (!piece) break;
          if (msg.target === "bug_report") {
            setBugReportText((prev) => {
              const sep = prev && !/\s$/.test(prev) ? " " : "";
              return `${prev}${sep}${piece}`;
            });
            setBugReportStatus("Transcribed");
          } else {
            setDraft((prev) => {
              const sep = prev && !/\s$/.test(prev) ? " " : "";
              return `${prev}${sep}${piece}${piece.endsWith(" ") ? "" : " "}`;
            });
          }
          break;
        }
        case "dictation_error":
          if (msg.target === "bug_report") {
            setBugReportDictating(false);
            setBugReportStatus(msg.detail);
          } else {
            setDictating(false);
            setItems((prev) => [
              ...prev,
              { kind: "status", text: msg.detail },
            ]);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = gap < 96;
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [panel]);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  useEffect(() => {
    if (!bugReportOpen) {
      return;
    }
    const t = window.setTimeout(() => bugReportTextareaRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      if (bugReportDictating) {
        post({ type: "dictation_toggle", target: "bug_report" });
      }
      setBugReportDictating(false);
      setBugReportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [bugReportOpen, bugReportDictating]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data;
      if (data && data.type === "view_hidden" && dictating) {
        post({ type: "dictation_toggle", target: "composer" });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [dictating]);

  useEffect(() => {
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      post({ type: "persist", draft, mode, chatId, autoApprove, interaction, caveman, goal: goalMode });
    }, 400);
    return () => window.clearTimeout(persistTimer.current);
  }, [draft, mode, chatId, autoApprove, interaction, caveman, goalMode]);

  // Debounced autosave — only when local settings differ from last *confirmed*
  // commit. Do not optimistically commit before the host replies (that blocked
  // retries when a stale echo was ignored).
  useEffect(() => {
    if (!settingsAutosaveReady.current) {
      return;
    }
    if (skipSettingsAutosave.current) {
      skipSettingsAutosave.current = false;
      return;
    }
    const key = settingsSaveKey(settings);
    if (
      !key ||
      key === committedSettingsKey.current ||
      key === inflightSettingsKey.current
    ) {
      return;
    }
    window.clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = window.setTimeout(() => {
      const patch = normalizeSettingsForSave(settings);
      const keyNow = settingsSaveKey(settings);
      if (
        !keyNow ||
        keyNow === committedSettingsKey.current ||
        keyNow === inflightSettingsKey.current
      ) {
        return;
      }
      inflightSettingsKey.current = keyNow;
      pendingSettingsPatch.current = patch;
      setVerifyMsg("Saving…");
      postSettingsSave(patch, settings);
      // If the host never confirms, clear inflight so a later effect can retry.
      window.setTimeout(() => {
        if (inflightSettingsKey.current === keyNow && pendingSettingsPatch.current) {
          inflightSettingsKey.current = "";
        }
      }, 15_000);
    }, 500);
    return () => window.clearTimeout(settingsSaveTimer.current);
  }, [settings, postSettingsSave]);

  useEffect(() => {
    if (panel !== "history") {
      return;
    }
    window.clearTimeout(historySearchTimer.current);
    setHistorySearching(true);
    historySearchTimer.current = window.setTimeout(() => {
      post({ type: "search_chats", query: historyQuery });
      setHistorySearching(false);
    }, 250);
    return () => window.clearTimeout(historySearchTimer.current);
  }, [historyQuery, panel]);

  // Goal / Plan / Act is the primary control.
  // Goal = Act permissions + goal_mode (planner→verify→strategist).
  // Plan = read-only. Act = execute with auto-approve toggles.
  // Interactive / Auto: Plan always forces Interactive.
  const workMode: "goal" | "plan" | "act" =
    goalMode ? "goal" : mode === "read_only" ? "plan" : "act";
  const planAct: "plan" | "act" = workMode === "plan" ? "plan" : "act";
  const effectiveInteraction: InteractionStyle =
    planAct === "plan" ? "interactive" : interaction;
  const actModeForAccess = (): AgentMode =>
    settings.allow_full_access ? "full_access" : "auto";
  const setWorkMode = (next: "goal" | "plan" | "act") => {
    if (next === "goal") {
      setGoalMode(true);
      setMode("auto");
      post({ type: "set_mode", mode: "auto" });
      post({ type: "set_goal", goal: true });
      return;
    }
    setGoalMode(false);
    post({ type: "set_goal", goal: false });
    const nextMode: AgentMode =
      next === "plan" ? "read_only" : actModeForAccess();
    setMode(nextMode);
    post({ type: "set_mode", mode: nextMode });
    if (next === "plan") {
      setInteraction("interactive");
      post({ type: "set_interaction", interaction: "interactive" });
    }
  };
  const setInteractionStyle = (next: InteractionStyle) => {
    if (planAct === "plan") {
      return;
    }
    setInteraction(next);
    post({ type: "set_interaction", interaction: next });
  };
  const toggleApprove = (key: keyof AutoApprove) =>
    setAutoApprove((a) => ({ ...a, [key]: !a[key] }));
  const setAllowFullAccess = (on: boolean) => {
    const nextSettings: Record<string, unknown> = {
      ...settings,
      allow_full_access: on,
    };
    skipSettingsAutosave.current = true;
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    const patch = normalizeSettingsForSave(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    pendingSettingsPatch.current = patch;
    postSettingsSave(patch, nextSettings);
    if (on) {
      // Full access = auto-approve edits/commands + OS sandbox off (sidecar).
      setAutoApprove((a) => ({ ...a, edit: true, execute: true }));
      if (workMode !== "plan") {
        setMode("full_access");
        post({ type: "set_mode", mode: "full_access" });
      }
    } else if (mode === "full_access") {
      setMode("auto");
      post({ type: "set_mode", mode: "auto" });
    }
  };

  const keepSkillFolder = (folderPath: string) => {
    setSettings((s) => {
      const dirs = asStringList(s.skill_dirs);
      const ignored = asStringList(s.skill_ignore_dirs).filter((d) => d !== folderPath);
      return {
        ...s,
        skill_dirs: dirs.includes(folderPath) ? dirs : [...dirs, folderPath],
        skill_ignore_dirs: ignored,
      };
    });
  };

  const removeSkillFolder = (folderPath: string, origin: string) => {
    setSettings((s) => {
      const dirs = asStringList(s.skill_dirs).filter((d) => d !== folderPath);
      if (origin === "registered") {
        return { ...s, skill_dirs: dirs };
      }
      const ignored = asStringList(s.skill_ignore_dirs);
      return {
        ...s,
        skill_dirs: dirs,
        skill_ignore_dirs: ignored.includes(folderPath)
          ? ignored
          : [...ignored, folderPath],
      };
    });
  };

  const restoreIgnoredFolder = (folderPath: string) => {
    setSettings((s) => ({
      ...s,
      skill_ignore_dirs: asStringList(s.skill_ignore_dirs).filter((d) => d !== folderPath),
    }));
  };

  const excludeSkill = (name: string) => {
    setSettings((s) => {
      const excluded = asStringList(s.skill_exclude);
      return {
        ...s,
        skill_exclude: excluded.includes(name) ? excluded : [...excluded, name],
      };
    });
    setSkillsPreview((prev) =>
      prev
        ? {
            ...prev,
            skills: prev.skills.map((sk) =>
              sk.name === name ? { ...sk, excluded: true } : sk,
            ),
            excluded: prev.excluded.includes(name)
              ? prev.excluded
              : [...prev.excluded, name],
          }
        : prev,
    );
  };

  const keepSkill = (name: string, sourceDir?: string) => {
    setSettings((s) => {
      const excluded = asStringList(s.skill_exclude).filter((n) => n !== name);
      const next: Record<string, unknown> = { ...s, skill_exclude: excluded };
      if (sourceDir) {
        const dirs = asStringList(s.skill_dirs);
        const ignored = asStringList(s.skill_ignore_dirs).filter((d) => d !== sourceDir);
        next.skill_dirs = dirs.includes(sourceDir) ? dirs : [...dirs, sourceDir];
        next.skill_ignore_dirs = ignored;
      }
      return next;
    });
    setSkillsPreview((prev) =>
      prev
        ? {
            ...prev,
            skills: prev.skills.map((sk) =>
              sk.name === name ? { ...sk, excluded: false } : sk,
            ),
            excluded: prev.excluded.filter((n) => n !== name),
          }
        : prev,
    );
  };

  const selectedProvider = String(settings.provider || "auto");
  const providerMenuValue = providerSelectValue(settings);
  const keyFlags = {
    openai: hasOpenAIKey,
    anthropic: hasAnthropicKey,
    gemini: hasGeminiKey,
    // Fallback catalog only: any Bedrock-related cred makes the parent row exist;
    // expandBedrockProviderChoices splits IAM vs Mantle vs BAG availability.
    bedrock: hasBedrockKey || hasAwsCreds,
  };
  const providerCatalog = (() => {
    const base = providers.length
      ? providers
      : applyKeyFlagsToFallback(FALLBACK_PROVIDERS, keyFlags);
    // Distinct Provider rows for IAM / Mantle / Gateway (saved provider = bedrock).
    const expanded = expandBedrockProviderChoices(base, {
      iam: hasAwsCreds,
      mantle: hasBedrockKey,
      bag: hasBedrockKey,
    });
    // Host SecretStorage / .env wins over a stale sidecar "(no key)" probe.
    return overlayHostKeyAvailability(expanded, {
      openai: hasOpenAIKey,
      anthropic: hasAnthropicKey,
      gemini: hasGeminiKey,
      iam: hasAwsCreds,
      mantle: hasBedrockKey,
      bag: hasBedrockKey,
    });
  })();
  const modelFilterId =
    selectedProvider === "bedrock" ? providerMenuValue : selectedProvider;
  const allModels = modelsForKeys(
    providerCatalog,
    modelFilterId,
    providerMenuValue.startsWith("bedrock-")
      ? providerMenuValue
      : BEDROCK_SELECT_IAM,
  );
  const providerModels = allModels;
  const preferredPick = pickPreferredModel(providerCatalog);

  const rawModelId =
    (typeof settings.model === "string" && settings.model) ||
    (model !== "default" ? model : "") ||
    "";
  // Never render a vendor-mismatched leftover (llama3.1 under OpenAI) as the
  // selected option — even for one frame before the persist heal runs.
  const headerProviderId = String(settings.provider || "auto").trim().toLowerCase();
  const activeModelId =
    rawModelId &&
    headerProviderId &&
    headerProviderId !== "auto" &&
    headerProviderId !== "bedrock" &&
    !modelFitsProvider(rawModelId, headerProviderId)
      ? defaultModelForProvider(headerProviderId) || rawModelId
      : rawModelId;
  const activeModelMeta = allModels.find((m) => m.id === activeModelId);
  const headerProviderLabel = effectiveProviderLabel(
    settings,
    activeModelId || model,
    providerCatalog,
  );
  modelRef.current = activeModelId || model;
  modelMetaRef.current = activeModelMeta;
  // Fill a default model only when unset. Never replace a saved model just
  // because it's missing from the current catalog (probe=0 / Mantle IDs) —
  // that used to PUT /settings forever (skills "loading" storm).
  useEffect(() => {
    if (preferredModelFilled.current) return;
    const savedModel =
      typeof settings.model === "string" ? settings.model.trim() : "";
    if (savedModel) {
      preferredModelFilled.current = true;
      return;
    }
    if (!preferredPick.model) return;
    preferredModelFilled.current = true;
    const nextSettings: Record<string, unknown> = {
      ...settings,
      model: preferredPick.model,
      ...(preferredPick.effort ? { reasoning_effort: preferredPick.effort } : {}),
    };
    skipSettingsAutosave.current = true;
    setModel(preferredPick.model);
    setSettings(nextSettings);
    const patch = normalizeSettingsForSave(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    pendingSettingsPatch.current = patch;
    postSettingsSave(patch, nextSettings);
  }, [preferredPick.model, preferredPick.effort, post, settings]);

  // Heal leftovers that cannot belong to the selected vendor (Ollama llama3.1
  // after switching to OpenAI). Unlike "missing from catalog", this is a hard
  // mismatch — keeping it produces 404s and a permanent "(unavailable)" header.
  useEffect(() => {
    const prov = String(settings.provider || "auto").trim().toLowerCase();
    const saved =
      typeof settings.model === "string" ? settings.model.trim() : "";
    if (!saved || !prov || prov === "auto" || prov === "bedrock") return;
    if (modelFitsProvider(saved, prov)) return;
    const nextModel = defaultModelForProvider(prov);
    if (!nextModel || nextModel === saved) return;
    const key = `${prov}|${saved}->${nextModel}`;
    if (incompatibleModelHealKey.current === key) return;
    incompatibleModelHealKey.current = key;
    const nextSettings: Record<string, unknown> = {
      ...settings,
      model: nextModel,
    };
    skipSettingsAutosave.current = true;
    settingsRef.current = nextSettings;
    setModel(nextModel);
    setSettings(nextSettings);
    const patch = normalizeSettingsForSave(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    pendingSettingsPatch.current = patch;
    postSettingsSave(patch, nextSettings);
    setProviderSetupMsg(
      `Model "${saved}" does not belong to Provider ${prov} — switched to ${nextModel}.`,
    );
  }, [settings, post]);
  const promptTok = usage.promptTokens || 0;
  const completionTok = usage.completionTokens || 0;
  const cachedTok = usage.cachedInputTokens || 0;
  const cacheCreateTok = usage.cacheCreationTokens || 0;
  const totalTok =
    usage.totalTokens ?? (promptTok || completionTok ? promptTok + completionTok : 0);
  const cacheHitPct =
    promptTok > 0 && cachedTok > 0
      ? Math.round(Math.min(100, (cachedTok / promptTok) * 100))
      : null;
  // Context % = latest request size only. Fall back to promptTok only when
  // we have never received a last-request sample (pre-fix chats / legacy).
  const contextTok = usage.lastInputTokens || (busy ? 0 : promptTok) || 0;
  const ctx = contextUsage(activeModelId || model, contextTok);
  const ctxPct = ctx ? Math.round(Math.min(1, ctx.ratio) * 100) : null;
  const lastCheckpointTs = useMemo(() => {
    for (const row of checkpoints) {
      const ts = checkpointTs(row);
      if (ts != null) return ts;
    }
    return undefined;
  }, [checkpoints]);
  useEffect(() => {
    if (lastCheckpointTs == null) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [lastCheckpointTs]);
  const lastCheckpointLabel = formatCheckpointWhen(lastCheckpointTs, nowTick);
  // Prefer server-summed per-request cost (correct for >272K cliff). Fall back
  // to a local estimate on cumulative tokens only when the sidecar omitted it.
  const runCost =
    typeof usage.runCostUsd === "number"
      ? usage.runCostUsd
      : estimateCostUsd(
          activeModelId || model,
          promptTok,
          completionTok,
          activeModelMeta,
          selectedProvider,
          cachedTok,
          cacheCreateTok,
        );
  // While a run is in flight, include its live estimate in the session total.
  const sessionCostShown =
    sessionCostUsd + (busy && runCost != null ? runCost : 0);

  const selectModel = (next: string) => {
    setModel(next || "default");
    const nextSettings: Record<string, unknown> = { ...settings, model: next };
    if (isMantleSettings(nextSettings) && next) {
      nextSettings.wire_api = mantleWireApiForModel(next);
    }
    // Immediate save for the next turn; skip the debounced effect to avoid a double write.
    skipSettingsAutosave.current = true;
    setSettings(nextSettings);
    const patch = normalizeSettingsForSave(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    pendingSettingsPatch.current = patch;
    setVerifyMsg("Saving…");
    postSettingsSave(patch, nextSettings);
  };

  const applyBedrockMode = (mode: string) => {
    const region = String(settings.aws_region || "").trim() || "us-east-1";
    let next: Record<string, unknown>;
    if (mode === "mantle") {
      const model =
        String(settings.model || "").includes("anthropic.claude-") &&
        !String(settings.model || "").startsWith("us.")
          ? String(settings.model)
          : String(settings.model || "").startsWith("openai.gpt-oss") ||
              String(settings.model || "").startsWith("deepseek.")
            ? String(settings.model)
            : MANTLE_DEFAULT_MODEL;
      next = {
        ...settings,
        provider: "bedrock",
        bedrock_mode: "mantle",
        aws_region: region,
        base_url: `https://bedrock-mantle.${region}.api.aws/v1`,
        wire_api: mantleWireApiForModel(model),
        model,
      };
      setProviderSetupMsg(
        `Mantle (OneHUB) — ${next.base_url}. Paste Mantle API key below. Claude uses Messages; GPT-5.x uses Responses; others use chat.`,
      );
    } else if (mode === "bag") {
      next = {
        ...settings,
        provider: "bedrock",
        bedrock_mode: "bag",
        aws_region: region,
        base_url: "http://localhost:8000/api/v1",
        // Mantle often leaves wire_api=responses; BAG is chat-completions only.
        wire_api: "auto",
        model:
          String(settings.model || "") ||
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      };
      setProviderSetupMsg("BAG / LiteLLM gateway — save gateway key, then Test.");
    } else {
      next = {
        ...settings,
        provider: "bedrock",
        bedrock_mode: "iam",
        aws_region: region,
        base_url: "",
        // Drop Mantle Responses/chat pin — native IAM does not use wire_api.
        wire_api: "auto",
        model:
          String(settings.model || "").startsWith("openai.") ||
          String(settings.model || "").startsWith("anthropic.")
            ? "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
            : String(settings.model || "") ||
              "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      };
      setProviderSetupMsg(
        "Native IAM — uses ~/.aws credentials (no Mantle/BAG key).",
      );
    }
    skipSettingsAutosave.current = true;
    settingsRef.current = next;
    inflightSettingsKey.current = settingsSaveKey(next);
    setSettings(next);
    setModel(String(next.model || ""));
    const patch = normalizeSettingsForSave(next);
    pendingSettingsPatch.current = patch;
    setVerifyMsg("Saving…");
    postSettingsSave(patch, next);
  };

  const selectEffort = (next: string) => {
    const nextSettings = { ...settings, reasoning_effort: next };
    skipSettingsAutosave.current = true;
    setSettings(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    const patch = { reasoning_effort: next };
    pendingSettingsPatch.current = patch;
    setVerifyMsg("Saving…");
    // Effort-only patch: avoid trust prompts from an unsaved base_url draft.
    postSettingsSave(patch, nextSettings);
  };

  const selectWireApi = (next: string) => {
    skipSettingsAutosave.current = true;
    const nextSettings = { ...settings, wire_api: next };
    setSettings(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    const patch = { wire_api: next };
    pendingSettingsPatch.current = patch;
    setVerifyMsg("Saving…");
    postSettingsSave(patch, nextSettings);
  };

  const selectSslVerify = (next: boolean) => {
    skipSettingsAutosave.current = true;
    const nextSettings = { ...settings, ssl_verify: next };
    setSettings(nextSettings);
    inflightSettingsKey.current = settingsSaveKey(nextSettings);
    const patch = { ssl_verify: next };
    pendingSettingsPatch.current = patch;
    setVerifyMsg("Saving…");
    postSettingsSave(patch, nextSettings);
  };

  /** OS dictation; mic picker once per session (⌥/Alt+Mic to change). */
  const toggleDictation = (forcePick = false) => {
    textareaRef.current?.focus();
    if (!dictating) {
      setItems((previous) => [
        ...previous.filter((it) => it.kind !== "status"),
        {
          kind: "status",
          text: forcePick ? "Choose a microphone…" : "Dictation…",
        },
      ]);
    }
    window.setTimeout(() => {
      post({
        type: "dictation_toggle",
        target: "composer",
        forcePick: forcePick || undefined,
      });
    }, 40);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord =
        (e.code === "Space" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) ||
        e.key === "F8";
      if (!chord) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        t !== textareaRef.current &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggleDictation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const flushPendingSettingsSave = () => {
    // Cancel debounced autosave and push the latest patch before send so the
    // sidecar cannot pair a new model with a stale base_url / bedrock_mode.
    window.clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = undefined;
    const patch =
      pendingSettingsPatch.current || normalizeSettingsForSave(settings);
    const keyNow = settingsSaveKey(settings);
    if (
      patch &&
      keyNow &&
      keyNow !== committedSettingsKey.current
    ) {
      inflightSettingsKey.current = keyNow;
      pendingSettingsPatch.current = patch;
      postSettingsSave(patch, settings);
    }
  };

  const send = () => {
    if (attachmentRequestsRef.current.size > 0) {
      setItems((previous) => [
        ...previous,
        { kind: "status", text: "Finishing attachment upload…" },
      ]);
      return;
    }
    const value = draft.trim();
    if (!value) {
      return;
    }
    // Slash commands work without a provider key; chat turns do not.
    const isSlash =
      value === "/compact" ||
      value === "/checkpoints" ||
      value === "/hunks" ||
      value === "/review" ||
      value === "/rewind";
    if (!hasApiKey && !busy && !isSlash) {
      setItems((previous) => [
        ...previous,
        {
          kind: "status",
          text: "Add a provider API key first — open Settings or run ClawAgents: Set API Key.",
        },
      ]);
      setPanel("settings");
      return;
    }
    if (value === "/compact") {
      setDraft("");
      setCompactPhase("start");
      post({ type: "compact_chat" });
      return;
    }
    if (value === "/checkpoints") {
      setDraft("");
      post({ type: "list_checkpoints", open: true });
      return;
    }
    if (value === "/hunks" || value === "/review") {
      setDraft("");
      post({ type: "list_hunks", open: true });
      return;
    }
    if (value === "/rewind") {
      setDraft("");
      post({ type: "list_rewind", open: true });
      return;
    }
    setDraft("");
    if (busy) {
      post({ type: "interject", text: value });
      return;
    }
    flushPendingSettingsSave();
    // Keep send mode in sync with the Auto-approve Full access checkbox
    // (Settings allow_full_access + Act → full_access → OS sandbox off).
    const sendMode: AgentMode =
      planAct === "plan"
        ? "read_only"
        : settings.allow_full_access
          ? "full_access"
          : mode === "full_access"
            ? "auto"
            : mode;
    if (sendMode !== mode) {
      setMode(sendMode);
      post({ type: "set_mode", mode: sendMode });
    }
    // Never send a leftover Ollama/etc. id to OpenAI even if heal hasn't run yet.
    const prov = String(settings.provider || "auto").trim().toLowerCase();
    let sendModel = activeModelId || undefined;
    if (
      sendModel &&
      prov &&
      prov !== "auto" &&
      prov !== "bedrock" &&
      !modelFitsProvider(sendModel, prov)
    ) {
      sendModel = defaultModelForProvider(prov);
    }
    post({
      type: "send",
      text: value,
      mode: sendMode,
      includeContext,
      chatId,
      autoApprove,
      model: sendModel,
      interaction: effectiveInteraction,
      caveman,
      goal: goalMode,
    });
  };

  const beginAttachmentRequest = (requestId: string) => {
    attachmentRequestsRef.current.add(requestId);
    setAttachmentUploads(attachmentRequestsRef.current.size);
  };

  const finishAttachmentRequest = (requestId: string) => {
    if (attachmentRequestsRef.current.delete(requestId)) {
      setAttachmentUploads(attachmentRequestsRef.current.size);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="brand">ClawAgents</div>
          <div className={`pill sidecar-${sidecar}`} title={sidecarDetail || sidecar}>
            <span className="pill-dot" />
            {sidecar === "running"
              ? "Ready"
              : sidecar === "starting"
                ? "Starting"
                : sidecar === "error"
                  ? "Error"
                  : "Idle"}
          </div>
        </div>
        <div className="meta">
          <span className="meta-workspace" title={workspace}>
            {workspaceName}
          </span>
          <span
            className="meta-provider"
            title="Provider (change in Settings)"
            aria-label={`Provider ${headerProviderLabel}`}
          >
            {headerProviderLabel}
          </span>
          <select
            className="model-select"
            value={activeModelId}
            title={`${headerProviderLabel} · only models for providers with a saved key`}
            aria-label="Model"
            onChange={(e) => selectModel(e.target.value)}
          >
            <option value="">{allModels.length ? "default" : "no key — Settings"}</option>
            {activeModelId && !allModels.some((m) => m.id === activeModelId) && (
              <option value={activeModelId}>{activeModelId} (unavailable)</option>
            )}
            {allModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label || m.id}
              </option>
            ))}
          </select>
          {modelSupportsEffort(activeModelId || model) && (
            <select
              className="model-select effort-select"
              value={String(settings.reasoning_effort || "medium")}
              title="Thinking effort (OpenAI reasoning models)"
              aria-label="Effort"
              onChange={(e) => selectEffort(e.target.value)}
            >
              {EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {compactPhase && (
            <span className="compact-chip" title="Compaction in progress">
              compact · {compactPhase}
            </span>
          )}
          {(contextTok > 0 || totalTok > 0) && (
            <span
              className="meta-stat"
              title={
                `Current request ${contextTok.toLocaleString()} in` +
                ` · Run ${promptTok.toLocaleString()} in / ${completionTok.toLocaleString()} out` +
                (usage.requestCount
                  ? ` across ${usage.requestCount} request(s)`
                  : "") +
                (usage.maxInputTokens
                  ? ` · max ${usage.maxInputTokens.toLocaleString()}`
                  : "") +
                (usage.longContextRequestCount
                  ? ` · ${usage.longContextRequestCount} long-context (>272K)`
                  : "") +
                (usage.nextPromptEstTokens
                  ? ` · next prompt est. ${usage.nextPromptEstTokens.toLocaleString()}`
                  : "") +
                (cachedTok
                  ? ` · ${cachedTok.toLocaleString()} cache read`
                  : "")
              }
            >
              {contextTok > 0
                ? `${(contextTok / 1000).toFixed(contextTok >= 10_000 ? 0 : 1)}K`
                : "—"}
              {" · "}
              {(promptTok / 1000).toFixed(promptTok >= 10_000 ? 0 : 1)}K
              {cacheHitPct != null ? ` · ${cacheHitPct}% cached` : ""}
              {usage.nextPromptEstTokens
                ? ` · next ~${(usage.nextPromptEstTokens / 1000).toFixed(
                    usage.nextPromptEstTokens >= 10_000 ? 0 : 1,
                  )}K`
                : ""}
            </span>
          )}
          {cacheHitPct != null && (
            <span
              className="meta-stat cache-hit"
              title={`${cachedTok.toLocaleString()} of ${promptTok.toLocaleString()} run-cumulative prompt tokens hit the provider cache${
                cacheCreateTok
                  ? ` · ${cacheCreateTok.toLocaleString()} written to cache`
                  : ""
              }`}
            >
              cache {cacheHitPct}%
            </span>
          )}
          {runCost != null && totalTok > 0 && (
            <span
              className="cost"
              title={
                cachedTok
                  ? "Estimated API cost for this run with prompt-cache discount applied. List price — not a bill."
                  : "Estimated API cost for this run (last/current turn). List price — not a bill. Cache hits appear here when the provider reports them."
              }
            >
              run ~{formatUsd(runCost)}
            </span>
          )}
          {sessionCostShown > 0 && (
            <span
              className="cost session"
              title="Estimated total for this chat (all runs, cache-aware when reported). Persisted with the chat — survives reload."
            >
              session ~{formatUsd(sessionCostShown)}
            </span>
          )}
          <div className="meta-actions">
            <button
              type="button"
              className={`tool-chip${checkpointsOpen ? " active" : ""}`}
              title={
                lastCheckpointLabel
                  ? `Last checkpoint ${lastCheckpointLabel} — open restore panel (/checkpoints)`
                  : "Shadow-git checkpoints (/checkpoints)"
              }
              onClick={() => post({ type: "list_checkpoints", open: true })}
            >
              Checkpoints
              {lastCheckpointLabel ? (
                <span className="tool-chip-meta">{lastCheckpointLabel}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`tool-chip${hunksOpen ? " active" : ""}`}
              title="Attributed hunk accept/reject (/hunks)"
              onClick={() => post({ type: "list_hunks", open: true })}
            >
              Review
              {hunks.length ? (
                <span className="tool-chip-meta">{hunks.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`tool-chip${rewindOpen ? " active" : ""}`}
              title="Rewind workspace files to a prior prompt (/rewind)"
              onClick={() => post({ type: "list_rewind", open: true })}
            >
              Rewind
              {rewindSnaps.length ? (
                <span className="tool-chip-meta">{rewindSnaps.length}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="tool-chip compact-action"
              title={
                ctx && ctxPct != null
                  ? `Current-request context ~${ctxPct}% (${contextTok.toLocaleString()} / ${ctx.window.toLocaleString()}). ` +
                    `Not run-cumulative tokens. Compact session (/compact).`
                  : "Compact session (/compact)"
              }
              disabled={compactPhase === "start"}
              onClick={() => {
                setCompactPhase("start");
                post({ type: "compact_chat" });
              }}
            >
              {ctx && ctxPct != null ? (
                <span className="context-meter in-chip" aria-hidden>
                  <span className="context-meter-bar">
                    <span
                      className={
                        ctx.ratio < 0.5
                          ? "context-meter-fill ok"
                          : ctx.ratio < 0.8
                            ? "context-meter-fill warn"
                            : "context-meter-fill hot"
                      }
                      style={{ width: `${Math.max(2, ctxPct)}%` }}
                    />
                  </span>
                  <span className="context-meter-pct">{ctxPct}%</span>
                </span>
              ) : null}
              Compact
            </button>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="Panels">
          {(["chat", "history", "settings", "diagnostics"] as Panel[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={panel === p}
              className={panel === p ? "tab active" : "tab"}
              onClick={() => {
                setPanel(p);
                if (p === "settings") {
                  post({ type: "load_settings" });
                  post({ type: "graphify_action", action: "status" });
                }
                if (p === "diagnostics") {
                  post({ type: "load_diagnostics" });
                  post({ type: "load_stats" });
                }
              }}
            >
              {p}
            </button>
          ))}
        </nav>
        {!hasApiKey && panel === "chat" && (
          <div className="banner warn">
            No provider credential.{" "}
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setPanel("settings");
                post({ type: "load_settings" });
              }}
            >
              Open settings
            </button>
            {" or "}
            <button
              type="button"
              className="linkish"
              onClick={() => post({ type: "set_api_key" })}
            >
              Set API key
            </button>
            .
          </div>
        )}
        {sidecar === "error" && (
          <div className="banner error-banner" role="alert">
            <strong>Sidecar failed to start</strong>
            {sidecarDetail ? <> — {sidecarDetail}</> : null}
            <div className="banner-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => post({ type: "restart_sidecar" })}
              >
                Restart sidecar
              </button>
              On a remote SSH host, install packages into the <em>remote</em> Python (
              <code>clawagents.pythonPath</code>), then Restart Sidecar:
              <pre>
                python3 -m pip install &apos;clawagents[gemini,anthropic,bedrock,mcp]&apos; fastapi uvicorn
                pydantic
              </pre>
              Details: Output panel → <em>ClawAgents Sidecar</em>
            </div>
          </div>
        )}
      </header>

      {checkpointsOpen && (
        <div className="checkpoint-panel" role="region" aria-label="Checkpoints">
          <div className="checkpoint-panel-head">
            <div>
              <strong>Checkpoints</strong>
              <span className="checkpoint-sub">Restore files, chat, or both</span>
            </div>
            <button
              type="button"
              className="tool-chip"
              onClick={() => setCheckpointsOpen(false)}
            >
              Close
            </button>
          </div>
          {checkpoints.length === 0 ? (
            <p className="checkpoint-empty">No checkpoints yet — they appear after write tools.</p>
          ) : (
            <ul className="checkpoint-list">
              {checkpoints.slice(0, 12).map((cp) => {
                const sha = String(cp.sha || "");
                if (!sha) return null;
                const label = String(cp.tool || cp.label || cp.message || "checkpoint");
                const when = formatCheckpointWhen(checkpointTs(cp), nowTick);
                return (
                  <li key={sha}>
                    <div className="checkpoint-main">
                      <code className="checkpoint-sha">{sha.slice(0, 10)}</code>
                      <span className="checkpoint-label" title={label}>
                        {label}
                      </span>
                      {when ? <span className="checkpoint-when">{when}</span> : null}
                    </div>
                    <div className="checkpoint-actions">
                      <button
                        type="button"
                        className="tool-chip"
                        title="Restore workspace files only"
                        onClick={() => {
                          const ok = window.confirm(
                            `Restore files from checkpoint ${sha.slice(0, 10)}?\n\nWorkspace files will be overwritten to that snapshot.`,
                          );
                          if (!ok) return;
                          post({ type: "restore_checkpoint", sha, mode: "files" });
                        }}
                      >
                        Files
                      </button>
                      <button
                        type="button"
                        className="tool-chip"
                        title="Restore conversation only"
                        onClick={() => {
                          const ok = window.confirm(
                            `Restore chat from checkpoint ${sha.slice(0, 10)}?\n\nThe current conversation view will be replaced.`,
                          );
                          if (!ok) return;
                          post({
                            type: "restore_checkpoint",
                            sha,
                            mode: "conversation",
                          });
                        }}
                      >
                        Chat
                      </button>
                      <button
                        type="button"
                        className="tool-chip primary"
                        title="Restore files and conversation"
                        onClick={() => {
                          const ok = window.confirm(
                            `Restore files + chat from checkpoint ${sha.slice(0, 10)}?\n\nWorkspace files and this conversation will be overwritten.`,
                          );
                          if (!ok) return;
                          post({ type: "restore_checkpoint", sha, mode: "both" });
                        }}
                      >
                        Both
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {hunksOpen && (
        <div className="checkpoint-panel" role="region" aria-label="Hunk review">
          <div className="checkpoint-panel-head">
            <div>
              <strong>Hunk review</strong>
              <span className="checkpoint-sub">Accept or reject attributed diffs</span>
            </div>
            <button
              type="button"
              className="tool-chip"
              onClick={() => setHunksOpen(false)}
            >
              Close
            </button>
          </div>
          {hunks.length === 0 ? (
            <p className="checkpoint-empty">No pending hunks — agent edits will appear here.</p>
          ) : (
            <ul className="checkpoint-list">
              {hunks.slice(0, 40).map((h) => {
                const id = String(h.id || "");
                if (!id) return null;
                const path = String(h.path || "");
                const header = String(h.header || h.body || "").slice(0, 120);
                return (
                  <li key={id}>
                    <div className="checkpoint-main">
                      <code className="checkpoint-sha">{id.slice(0, 8)}</code>
                      <span className="checkpoint-label" title={path}>
                        {path || "file"}
                      </span>
                      {header ? (
                        <span className="checkpoint-when" title={header}>
                          {header}
                        </span>
                      ) : null}
                    </div>
                    <div className="checkpoint-actions">
                      <button
                        type="button"
                        className="tool-chip primary"
                        onClick={() => post({ type: "accept_hunk", hunkId: id })}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="tool-chip"
                        onClick={() => post({ type: "reject_hunk", hunkId: id })}
                      >
                        Reject
                      </button>
                      {path ? (
                        <button
                          type="button"
                          className="tool-chip"
                          onClick={() => post({ type: "open_file", path })}
                        >
                          Open
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {rewindOpen && (
        <div className="checkpoint-panel" role="region" aria-label="Session rewind">
          <div className="checkpoint-panel-head">
            <div>
              <strong>Session rewind</strong>
              <span className="checkpoint-sub">Restore workspace files to a prior prompt</span>
            </div>
            <button type="button" className="tool-chip" onClick={() => setRewindOpen(false)}>
              Close
            </button>
          </div>
          {rewindSnaps.length === 0 ? (
            <p className="checkpoint-empty">No rewind snapshots yet — send a prompt to create one.</p>
          ) : (
            <ul className="checkpoint-list">
              {rewindSnaps.slice().reverse().slice(0, 40).map((s) => {
                const idx = Number(s.prompt_index);
                if (!Number.isFinite(idx)) return null;
                const preview = String(s.user_text || "").slice(0, 120);
                const files = Number(s.files || 0);
                return (
                  <li key={`rw-${idx}`}>
                    <div className="checkpoint-main">
                      <code className="checkpoint-sha">#{idx}</code>
                      <span className="checkpoint-label" title={preview}>
                        {preview || "prompt"}
                      </span>
                      <span className="checkpoint-when">{files} file(s)</span>
                    </div>
                    <div className="checkpoint-actions">
                      <button
                        type="button"
                        className="tool-chip primary"
                        onClick={() => {
                          const ok = window.confirm(
                            `Rewind to prompt ${idx}?\n\nThis overwrites up to ${files || "many"} workspace files with the snapshot from that turn. Your later edits will be lost.`,
                          );
                          if (ok) post({ type: "rewind_to", promptIndex: idx });
                        }}
                      >
                        Rewind
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {panel === "history" && (
        <div className="panel">
          <div className="panel-actions history-toolbar">
            <input
              className="history-search"
              type="search"
              value={historyQuery}
              placeholder="Search titles & messages…"
              aria-label="Search chat history"
              onChange={(e) => setHistoryQuery(e.target.value)}
            />
            <button type="button" className="primary" onClick={() => post({ type: "new_chat" })}>
              New
            </button>
          </div>
          {historySearching && historyQuery.trim() ? (
            <div className="muted tiny history-hint">Searching…</div>
          ) : null}
          <ul className="chat-list">
            {chats.map((c) => (
              <li key={c.id} className={c.id === chatId ? "active" : ""}>
                <button type="button" className="chat-item" onClick={() => post({ type: "select_chat", chatId: c.id })}>
                  <div className="chat-title">{c.title || c.id}</div>
                  <div className="muted tiny">
                    {c.message_count || 0} msgs
                    {c.updated_at ? ` · ${new Date(c.updated_at * 1000).toLocaleString()}` : ""}
                  </div>
                </button>
                <div className="chat-actions">
                  <button
                    type="button"
                    className="chat-action-btn"
                    title="Fork this conversation"
                    onClick={() => post({ type: "fork_chat", chatId: c.id })}
                  >
                    ⑂
                  </button>
                  <button
                    type="button"
                    className="chat-action-btn danger"
                    title="Delete this conversation"
                    onClick={() => {
                      const title = c.title || c.id;
                      const ok = window.confirm(
                        `Delete chat "${title}"?\n\nThis permanently removes the conversation history.`,
                      );
                      if (!ok) return;
                      post({ type: "delete_chat", chatId: c.id });
                    }}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
            {!chats.length && (
              <div className="muted">
                {historyQuery.trim() ? "No chats match that search." : "No chats yet."}
              </div>
            )}
          </ul>
        </div>
      )}

      {panel === "settings" && (
        <div className="panel settings">
          <section className="settings-section">
            <h3 className="settings-heading">Model</h3>
            <label>
              Provider
              <select
                value={providerMenuValue}
                onChange={(e) => {
                  const choice = e.target.value;
                  setProviderKeyDraft("");
                  setProviderSetupMsg("");
                  // Bedrock IAM / Mantle / Gateway are separate menu rows.
                  if (
                    choice === BEDROCK_SELECT_IAM ||
                    choice === BEDROCK_SELECT_MANTLE ||
                    choice === BEDROCK_SELECT_BAG
                  ) {
                    const mode =
                      choice === BEDROCK_SELECT_MANTLE
                        ? "mantle"
                        : choice === BEDROCK_SELECT_BAG
                          ? "bag"
                          : "iam";
                    applyBedrockMode(mode);
                    return;
                  }
                  // Immediate save — autosave alone left stale bedrock_mode=mantle
                  // which the host used to rewrite provider back to Bedrock.
                  const prev = settingsRef.current;
                  const leavingBedrock =
                    String(prev.provider || "") === "bedrock";
                  const prevUrl = String(prev.base_url || "");
                  const prevModel = String(prev.model || "");
                  const next: Record<string, unknown> = {
                    ...prev,
                    provider: choice,
                  };
                  if (
                    leavingBedrock ||
                    /bedrock-mantle\./i.test(prevUrl) ||
                    /\/api\/v1\/?$/i.test(prevUrl)
                  ) {
                    next.base_url = "";
                    next.bedrock_mode = "iam";
                    next.wire_api = "auto";
                  }
                  // Drop leftover models from another vendor (e.g. Ollama
                  // llama3.1 after switching Provider to OpenAI → 404).
                  if (
                    choice !== "auto" &&
                    prevModel &&
                    !modelFitsProvider(prevModel, choice)
                  ) {
                    next.model = defaultModelForProvider(choice);
                  }
                  skipSettingsAutosave.current = true;
                  settingsRef.current = next;
                  inflightSettingsKey.current = settingsSaveKey(next);
                  setSettings(next);
                  if (typeof next.model === "string" && next.model) {
                    setModel(next.model);
                  }
                  const patch = normalizeSettingsForSave(next);
                  pendingSettingsPatch.current = patch;
                  setVerifyMsg("Saving…");
                  postSettingsSave(patch, next);
                  if (choice === "openai") {
                    setProviderSetupMsg(
                      "OpenAI — uses OPENAI_API_KEY (api.openai.com). Base URL left empty.",
                    );
                  } else if (choice === "gemini") {
                    setProviderSetupMsg(
                      "Paste a Gemini API key below (Google AI Studio).",
                    );
                  } else if (choice === "anthropic") {
                    setProviderSetupMsg(
                      "Paste an Anthropic API key below.",
                    );
                  }
                }}
              >
                <option value="auto">auto</option>
                {providerCatalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.available === false ? " (no key)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {(selectedProvider === "auto" || selectedProvider === "ollama") && (
              <p className="settings-hint">
                {selectedProvider === "ollama"
                  ? "Ollama usually needs no key. For a remote OpenAI-compatible host, switch Provider to OpenAI and set Base URL + key there."
                  : "Pick OpenAI, Anthropic, Gemini, or Bedrock above to save/verify that provider’s API key in one place."}
              </p>
            )}
            <label>
              Model
              <select
                value={String(settings.model || "")}
                title="Only models for providers with a saved key"
                onChange={(e) => selectModel(e.target.value)}
              >
                <option value="">{providerModels.length ? "default" : "no key — Settings"}</option>
                {Boolean(String(settings.model || "").trim()) &&
                  !providerModels.some((m) => m.id === String(settings.model)) && (
                    <option value={String(settings.model)}>
                      {String(settings.model)} (unavailable)
                    </option>
                  )}
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label || m.id}
                    {m.input_per_mtok != null
                      ? ` · $${m.input_per_mtok}/$${m.output_per_mtok} per 1M`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {modelSupportsEffort(String(settings.model || activeModelId || "")) && (
              <label>
                Effort
                <select
                  value={String(settings.reasoning_effort || "medium")}
                  onChange={(e) => selectEffort(e.target.value)}
                >
                  {EFFORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <span className="settings-hint">
                  Thinking depth for GPT-5.5/5.6 and o-series. Saved immediately.
                  With Wire API = Responses (or Auto on GPT-5.5/5.6), Effort applies
                  with tools.
                </span>
              </label>
            )}
            <label>
              Base URL (optional — OpenAI-compatible / Ollama / BAG)
              <input
                value={String(settings.base_url || "")}
                onChange={(e) => setSettings((s) => ({ ...s, base_url: e.target.value }))}
                placeholder={
                  selectedProvider === "bedrock"
                    ? String(settings.bedrock_mode || "iam") === "mantle"
                      ? "https://bedrock-mantle.us-east-1.api.aws/v1"
                      : String(settings.bedrock_mode || "iam") === "bag"
                        ? "http://localhost:8000/api/v1"
                        : "empty = native AWS IAM"
                    : selectedProvider === "openai"
                      ? "empty = api.openai.com · or http://localhost:11434/v1"
                      : selectedProvider === "gemini"
                        ? "(unused for native Gemini — use OpenAI provider for proxies)"
                        : "http://localhost:11434/v1"
                }
                disabled={selectedProvider === "gemini"}
              />
            </label>
            {(selectedProvider === "openai" ||
              selectedProvider === "auto" ||
              selectedProvider === "ollama" ||
              selectedProvider === "bedrock") && (
              <>
                <label>
                  Wire API
                  <select
                    value={String(settings.wire_api || "auto")}
                    onChange={(e) => selectWireApi(e.target.value)}
                  >
                    <option value="auto">Auto (model decides)</option>
                    <option value="responses">Responses (/v1/responses)</option>
                    <option value="chat_completions">
                      Chat Completions (/v1/chat/completions)
                    </option>
                  </select>
                  <span className="settings-hint">
                    {String(settings.bedrock_mode || "") === "mantle"
                      ? "Mantle: model pick sets this (chat / responses). Claude Haiku/Sonnet ignore Wire API and use Mantle Messages."
                      : "Use Responses for Codex / Responses-only gateways that 404 chat/completions. Auto picks Responses for GPT-5.5/5.6/Codex. Saved immediately."}
                  </span>
                </label>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={settings.ssl_verify !== false}
                    onChange={(e) => selectSslVerify(e.target.checked)}
                  />
                  Verify TLS certificates
                  <span className="settings-hint">
                    Uncheck for corporate proxies with a private CA (auto-off when
                    you Trust a custom HTTPS base URL). Saved immediately.
                  </span>
                </label>
              </>
            )}
            {selectedProvider === "bedrock" && (
              <div className="provider-setup">
                <h4 className="provider-setup-title">AWS Bedrock</h4>
                <div className="access-mode">
                  <span className="access-mode-label">Access mode</span>
                  <div
                    className="access-mode-seg"
                    role="radiogroup"
                    aria-label="Bedrock access mode"
                  >
                    {(
                      [
                        {
                          id: "iam",
                          title: "Native IAM",
                          sub: "Classic · AWS creds",
                        },
                        {
                          id: "mantle",
                          title: "Mantle",
                          sub: "OneHUB · API key",
                        },
                        {
                          id: "bag",
                          title: "Gateway",
                          sub: "BAG / LiteLLM",
                        },
                      ] as const
                    ).map((opt) => {
                      const active =
                        String(settings.bedrock_mode || "iam") === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={
                            active ? "access-mode-btn active" : "access-mode-btn"
                          }
                          onClick={() => applyBedrockMode(opt.id)}
                        >
                          <strong>{opt.title}</strong>
                          <span>{opt.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <p className="settings-hint">
                  {String(settings.bedrock_mode || "iam") === "mantle"
                    ? "Provider → AWS Bedrock Mantle. Routes by model: Claude → Messages, GPT-5.x → Responses, others → chat. Paste Mantle API key below."
                    : String(settings.bedrock_mode || "iam") === "bag"
                      ? "Provider → AWS Bedrock Gateway. Local/remote BAG / LiteLLM — Base URL + gateway key."
                      : "Provider → AWS Bedrock (IAM). Native Converse via ~/.aws credentials, env keys, or instance role."}
                </p>
                <label>
                  AWS region
                  <input
                    value={String(settings.aws_region || "")}
                    onChange={(e) => {
                      const region = e.target.value;
                      setSettings((s) => {
                        const mode = String(s.bedrock_mode || "iam");
                        const next: Record<string, unknown> = {
                          ...s,
                          aws_region: region,
                        };
                        if (mode === "mantle" && region.trim()) {
                          next.base_url = `https://bedrock-mantle.${region.trim()}.api.aws/v1`;
                        }
                        return next;
                      });
                    }}
                    placeholder="us-east-1"
                  />
                </label>
                {String(settings.bedrock_mode || "iam") === "iam" && (
                  <label>
                    AWS profile (optional)
                    <input
                      value={String(settings.aws_profile || "")}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, aws_profile: e.target.value }))
                      }
                      placeholder="default · or named profile from ~/.aws/credentials"
                    />
                  </label>
                )}
                <div className="provider-presets">
                  {String(settings.bedrock_mode || "iam") === "mantle" && (
                    <>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => {
                          const region = "us-east-1";
                          const model = MANTLE_DEFAULT_MODEL;
                          const next = {
                            ...settings,
                            provider: "bedrock",
                            bedrock_mode: "mantle",
                            aws_region: region,
                            base_url: `https://bedrock-mantle.${region}.api.aws/v1`,
                            wire_api: mantleWireApiForModel(model),
                            model,
                          };
                          setSettings(next);
                          setModel(next.model);
                          setProviderSetupMsg(
                            "Mantle us-east-1 (full catalog) — save Mantle API key.",
                          );
                        }}
                      >
                        Mantle us-east-1
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => {
                          const raw = String(settings.base_url || "").trim();
                          const region =
                            String(settings.aws_region || "").trim() || "us-east-1";
                          const normalized = normalizeMantleUrlClient(raw || region);
                          setSettings((s) => ({
                            ...s,
                            provider: "bedrock",
                            bedrock_mode: "mantle",
                            base_url: normalized,
                          }));
                          setProviderSetupMsg(`Mantle URL → ${normalized}`);
                        }}
                      >
                        Fix URL → Mantle /v1
                      </button>
                    </>
                  )}
                  {String(settings.bedrock_mode || "iam") === "bag" && (
                    <>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => {
                          const next = {
                            ...settings,
                            provider: "bedrock",
                            bedrock_mode: "bag",
                            base_url: "http://localhost:8000/api/v1",
                            model:
                              String(settings.model || "") ||
                              "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                          };
                          setSettings(next);
                          setModel(String(next.model));
                          setProviderSetupMsg("Local BAG URL applied — save key, then Test.");
                        }}
                      >
                        Local BAG (localhost:8000)
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => {
                          const raw = String(settings.base_url || "").trim();
                          if (!raw) {
                            setProviderSetupMsg(
                              "Paste CloudFormation APIBaseUrl into Base URL first.",
                            );
                            return;
                          }
                          const normalized = normalizeBagUrlClient(raw);
                          setSettings((s) => ({
                            ...s,
                            provider: "bedrock",
                            bedrock_mode: "bag",
                            base_url: normalized,
                          }));
                          setProviderSetupMsg(`Normalized to ${normalized}`);
                        }}
                      >
                        Fix URL → /api/v1
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      post({ type: "verify_key", provider: "bedrock" });
                      setProviderSetupMsg("Checking credentials…");
                    }}
                  >
                    Check credentials
                  </button>
                </div>
                <p className="settings-hint">
                  {String(settings.bedrock_mode || "iam") === "mantle"
                    ? "Mantle mode (IAM credentials not required)"
                    : String(settings.bedrock_mode || "iam") === "bag"
                      ? "BAG mode"
                      : `AWS IAM: ${hasAwsCreds ? "detected" : "not detected"}`}
                  {providerSetupMsg ? ` · ${providerSetupMsg}` : ""}
                </p>
                {String(settings.bedrock_mode || "iam") !== "iam" && (
                  <>
                    <label>
                      {String(settings.bedrock_mode) === "mantle"
                        ? "Mantle API key"
                        : "Gateway API key"}
                      <input
                        type="password"
                        autoComplete="off"
                        value={providerKeyDraft}
                        onChange={(e) => setProviderKeyDraft(e.target.value)}
                        placeholder={
                          hasBedrockKey
                            ? "••••••••  (saved — paste to replace)"
                            : String(settings.bedrock_mode) === "mantle"
                              ? "MANTLE_API_KEY / OneHUB key"
                              : "BAG / LiteLLM gateway key"
                        }
                      />
                    </label>
                    <div className="provider-actions">
                      <button
                        type="button"
                        className="primary tiny"
                        disabled={!providerKeyDraft.trim()}
                        onClick={() => {
                          setProviderSetupMsg(
                            String(settings.bedrock_mode) === "mantle"
                              ? "Saving Mantle key…"
                              : "Saving gateway key…",
                          );
                          post({
                            type: "set_provider_key",
                            provider: "bedrock",
                            apiKey: providerKeyDraft.trim(),
                          });
                          setProviderKeyDraft("");
                        }}
                      >
                        {String(settings.bedrock_mode) === "mantle"
                          ? "Save Mantle key"
                          : "Save gateway key"}
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => {
                          const base = String(settings.base_url || "").trim();
                          if (!base) {
                            setProviderSetupMsg("Set Base URL / Mantle mode first.");
                            return;
                          }
                          setProviderSetupMsg("Testing endpoint…");
                          post({
                            type: "test_compatible_endpoint",
                            baseUrl: base,
                            apiKey: providerKeyDraft.trim() || undefined,
                            style:
                              String(settings.bedrock_mode) === "mantle"
                                ? "openai"
                                : "bag",
                            provider: "bedrock",
                          });
                        }}
                      >
                        Test endpoint
                      </button>
                      <button
                        type="button"
                        className="ghost tiny"
                        disabled={!hasBedrockKey}
                        onClick={() => {
                          setProviderSetupMsg("Clearing key…");
                          post({ type: "clear_provider_key", provider: "bedrock" });
                        }}
                      >
                        Clear key
                      </button>
                    </div>
                    <p className="settings-hint">
                      {String(settings.bedrock_mode) === "mantle" ? "Mantle" : "Gateway"}{" "}
                      key: {hasBedrockKey ? "saved" : "not set"}
                    </p>
                  </>
                )}
              </div>
            )}
            {selectedProvider === "openai" && (
              <div className="provider-setup">
                <h4 className="provider-setup-title">OpenAI / compatible endpoint</h4>
                <p className="settings-hint">
                  Official OpenAI, or any OpenAI-compatible proxy: Ollama, vLLM, OpenRouter,
                  LiteLLM, or Bedrock Access Gateway.
                </p>
                <div className="provider-presets">
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      setSettings((s) => ({
                        ...s,
                        provider: "openai",
                        base_url: "",
                        model: String(s.model || "") || PREFERRED_OPENAI_MODEL,
                      }));
                      setProviderSetupMsg("Official OpenAI (api.openai.com) — save API key below.");
                    }}
                  >
                    Official OpenAI
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      setSettings((s) => ({
                        ...s,
                        provider: "openai",
                        base_url: "http://localhost:11434/v1",
                        model: "llama3.1",
                      }));
                      setModel("llama3.1");
                      setProviderSetupMsg("Ollama preset — key optional (use ollama).");
                    }}
                  >
                    Ollama
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    title="Point OpenAI provider at local Bedrock Access Gateway"
                    onClick={() => {
                      setSettings((s) => ({
                        ...s,
                        provider: "openai",
                        base_url: "http://localhost:8000/api/v1",
                        model:
                          String(s.model || "") ||
                          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                      }));
                      setProviderSetupMsg(
                        "BAG via OpenAI-compatible client — save the gateway API key as OpenAI key.",
                      );
                    }}
                  >
                    BAG (localhost:8000)
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      const raw = String(settings.base_url || "").trim();
                      if (!raw) {
                        setProviderSetupMsg("Paste a host or URL into Base URL first.");
                        return;
                      }
                      const normalized = normalizeOpenAIUrlClient(raw);
                      setSettings((s) => ({ ...s, provider: "openai", base_url: normalized }));
                      setProviderSetupMsg(`Normalized to ${normalized}`);
                    }}
                  >
                    Fix URL → /v1
                  </button>
                </div>
                <label>
                  API key (OpenAI or gateway token)
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerKeyDraft}
                    onChange={(e) => setProviderKeyDraft(e.target.value)}
                    placeholder={
                      hasOpenAIKey
                        ? "••••••••  (saved — paste to replace)"
                        : "sk-… / gateway token / ollama"
                    }
                  />
                </label>
                <div className="provider-actions">
                  <button
                    type="button"
                    className="primary tiny"
                    disabled={!providerKeyDraft.trim()}
                    onClick={() => {
                      setProviderSetupMsg("Saving OpenAI key…");
                      post({
                        type: "set_provider_key",
                        provider: "openai",
                        apiKey: providerKeyDraft.trim(),
                      });
                      setProviderKeyDraft("");
                    }}
                  >
                    Save API key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      const base = String(settings.base_url || "").trim();
                      if (!base) {
                        post({ type: "verify_key", provider: "openai" });
                        setProviderSetupMsg("Verifying official OpenAI key…");
                        return;
                      }
                      setProviderSetupMsg("Testing compatible endpoint…");
                      post({
                        type: "test_compatible_endpoint",
                        baseUrl: base,
                        apiKey: providerKeyDraft.trim() || undefined,
                        style: base.includes("/api/v1") ? "bag" : "openai",
                        provider: "openai",
                      });
                    }}
                  >
                    Test connection
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={!hasOpenAIKey}
                    onClick={() => {
                      setProviderSetupMsg("Clearing OpenAI key…");
                      post({ type: "clear_provider_key", provider: "openai" });
                    }}
                  >
                    Clear key
                  </button>
                </div>
                <p className="settings-hint">
                  Key: {hasOpenAIKey ? "saved" : "not set"}
                  {String(settings.base_url || "").trim()
                    ? ` · endpoint ${String(settings.base_url)}`
                    : " · official api.openai.com"}
                  {providerSetupMsg ? ` · ${providerSetupMsg}` : ""}
                </p>
              </div>
            )}
            {selectedProvider === "gemini" && (
              <div className="provider-setup">
                <h4 className="provider-setup-title">Google Gemini</h4>
                <p className="settings-hint">
                  Native Gemini API (Google AI Studio). For an OpenAI-compatible Gemini proxy,
                  switch Provider to OpenAI and set Base URL to the proxy.
                </p>
                <label>
                  Gemini API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerKeyDraft}
                    onChange={(e) => setProviderKeyDraft(e.target.value)}
                    placeholder={
                      hasGeminiKey
                        ? "••••••••  (saved — paste to replace)"
                        : "AIza… from Google AI Studio"
                    }
                  />
                </label>
                <div className="provider-actions">
                  <button
                    type="button"
                    className="primary tiny"
                    disabled={!providerKeyDraft.trim()}
                    onClick={() => {
                      setProviderSetupMsg("Saving Gemini key…");
                      post({
                        type: "set_provider_key",
                        provider: "gemini",
                        apiKey: providerKeyDraft.trim(),
                      });
                      setProviderKeyDraft("");
                    }}
                  >
                    Save API key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      setProviderSetupMsg("Verifying Gemini key…");
                      post({ type: "verify_key", provider: "gemini" });
                    }}
                  >
                    Verify key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={!hasGeminiKey}
                    onClick={() => {
                      setProviderSetupMsg("Clearing Gemini key…");
                      post({ type: "clear_provider_key", provider: "gemini" });
                    }}
                  >
                    Clear key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    title="Use OpenAI provider + BAG for Bedrock models instead"
                    onClick={() => {
                      setSettings((s) => ({
                        ...s,
                        provider: "openai",
                        base_url: "http://localhost:8000/api/v1",
                      }));
                      setProviderSetupMsg(
                        "Switched to OpenAI + BAG — Gemini is not served by Bedrock Access Gateway.",
                      );
                    }}
                  >
                    Use BAG via OpenAI…
                  </button>
                </div>
                <p className="settings-hint">
                  Key: {hasGeminiKey ? "saved" : "not set"}
                  {providerSetupMsg ? ` · ${providerSetupMsg}` : ""}
                </p>
              </div>
            )}
            {selectedProvider === "anthropic" && (
              <div className="provider-setup">
                <h4 className="provider-setup-title">Anthropic</h4>
                <p className="settings-hint">
                  Native Anthropic API. For Claude on Bedrock, switch Provider to AWS Bedrock
                  (IAM) or OpenAI + BAG.
                </p>
                <label>
                  Anthropic API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerKeyDraft}
                    onChange={(e) => setProviderKeyDraft(e.target.value)}
                    placeholder={
                      hasAnthropicKey
                        ? "••••••••  (saved — paste to replace)"
                        : "sk-ant-…"
                    }
                  />
                </label>
                <div className="provider-actions">
                  <button
                    type="button"
                    className="primary tiny"
                    disabled={!providerKeyDraft.trim()}
                    onClick={() => {
                      setProviderSetupMsg("Saving Anthropic key…");
                      post({
                        type: "set_provider_key",
                        provider: "anthropic",
                        apiKey: providerKeyDraft.trim(),
                      });
                      setProviderKeyDraft("");
                    }}
                  >
                    Save API key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => {
                      setProviderSetupMsg("Verifying Anthropic key…");
                      post({ type: "verify_key", provider: "anthropic" });
                    }}
                  >
                    Verify key
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    disabled={!hasAnthropicKey}
                    onClick={() => {
                      setProviderSetupMsg("Clearing Anthropic key…");
                      post({ type: "clear_provider_key", provider: "anthropic" });
                    }}
                  >
                    Clear key
                  </button>
                </div>
                <p className="settings-hint">
                  Key: {hasAnthropicKey ? "saved" : "not set"}
                  {providerSetupMsg ? ` · ${providerSetupMsg}` : ""}
                </p>
              </div>
            )}
            <label>
              Default mode
              <select
                value={String(settings.default_mode || "auto")}
                onChange={(e) => setSettings((s) => ({ ...s, default_mode: e.target.value }))}
              >
                <option value="ask">ask</option>
                <option value="read_only">read_only</option>
                <option value="auto">auto</option>
                <option value="full_access">full_access</option>
              </select>
            </label>
            <label>
              Agent persona mode
              <select
                value={String(settings.agent_mode || "")}
                onChange={(e) => setSettings((s) => ({ ...s, agent_mode: e.target.value }))}
              >
                <option value="">(none — permission mode only)</option>
                <option value="ask">ask</option>
                <option value="architect">architect</option>
                <option value="code">code</option>
                <option value="ci">ci</option>
              </select>
            </label>
            <label>
              Action mode
              <select
                value={String(settings.action_mode || "tools")}
                onChange={(e) => setSettings((s) => ({ ...s, action_mode: e.target.value }))}
              >
                <option value="tools">tools (ReAct)</option>
                <option value="code">code (CodeAct)</option>
              </select>
            </label>
            <label>
              Workspace system prompt
              <textarea
                rows={3}
                value={String(settings.workspace_system_prompt || "")}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, workspace_system_prompt: e.target.value }))
                }
              />
            </label>
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Skills</h3>
            <p className="settings-hint">
              Register folders that contain skills. A folder with{" "}
              <code>SKILL.md</code> registers as one skill; a parent folder registers each
              subfolder (or <code>.md</code> file) separately. Save to apply; detected list
              refreshes after save.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(settings.skill_auto_discover ?? true)}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, skill_auto_discover: e.target.checked }))
                }
              />
              Auto-discover workspace skills/ folders
            </label>

            <div className="skill-subheading">Folders</div>
            <div className="skill-dirs">
              {(skillsPreview?.folders?.length
                ? skillsPreview.folders
                : asStringList(settings.skill_dirs).map((path) => ({
                    path,
                    origin: "registered",
                  }))
              ).map((folder) => (
                <div key={`${folder.origin}:${folder.path}`} className="skill-folder-row">
                  <div className="skill-folder-meta">
                    <span className={`skill-origin origin-${folder.origin}`}>
                      {folder.origin}
                    </span>
                    <code className="skill-folder-path" title={folder.path}>
                      {folder.path}
                    </code>
                  </div>
                  <div className="skill-row-actions">
                    {folder.origin === "auto" && (
                      <button
                        type="button"
                        className="ghost tiny"
                        title="Pin this folder so it stays if auto-discover is off"
                        onClick={() => keepSkillFolder(folder.path)}
                      >
                        Keep
                      </button>
                    )}
                    {folder.origin !== "bundled" && (
                      <button
                        type="button"
                        className="ghost tiny"
                        title={
                          folder.origin === "auto"
                            ? "Ignore this auto-discovered folder"
                            : "Remove registered folder"
                        }
                        onClick={() => removeSkillFolder(folder.path, folder.origin)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!skillsPreview?.folders?.length && !asStringList(settings.skill_dirs).length && (
                <div className="muted tiny">No skill folders detected yet.</div>
              )}
              {asStringList(settings.skill_dirs)
                .filter((d) => d.trim() && !(skillsPreview?.folders || []).some((f) => f.path === d))
                .map((dir, idx) => (
                  <div key={`draft-${dir}-${idx}`} className="skill-dir-row">
                    <input
                      className="skill-dir-path"
                      value={dir}
                      onChange={(e) => {
                        const next = e.target.value;
                        setSettings((s) => {
                          const cur = [...asStringList(s.skill_dirs)];
                          const at = cur.indexOf(dir);
                          if (at >= 0) cur[at] = next;
                          return { ...s, skill_dirs: cur };
                        });
                      }}
                      placeholder="/path/to/skills"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="ghost skill-dir-remove"
                      title="Remove"
                      onClick={() =>
                        setSettings((s) => ({
                          ...s,
                          skill_dirs: asStringList(s.skill_dirs).filter((d) => d !== dir),
                        }))
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
              <div className="skill-dir-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      skill_dirs: [...asStringList(s.skill_dirs), ""],
                    }))
                  }
                >
                  Add path
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "pick_skill_dir" })}
                >
                  Browse…
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "load_skills" })}
                >
                  Refresh list
                </button>
              </div>
            </div>

            {asStringList(settings.skill_ignore_dirs).length > 0 && (
              <>
                <div className="skill-subheading">Ignored folders</div>
                <div className="skill-dirs">
                  {asStringList(settings.skill_ignore_dirs).map((dir) => (
                    <div key={`ignored-${dir}`} className="skill-folder-row">
                      <code className="skill-folder-path muted" title={dir}>
                        {dir}
                      </code>
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => restoreIgnoredFolder(dir)}
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="skill-subheading">
              Detected skills
              {skillsPreview ? ` (${skillsPreview.skills.length})` : ""}
            </div>
            <div className="skill-list">
              {!skillsPreview && (
                <div className="muted tiny">Open Settings or click Refresh list to scan.</div>
              )}
              {skillsPreview && skillsPreview.skills.length === 0 && (
                <div className="muted tiny">No skills found in the folders above.</div>
              )}
              {(skillsPreview?.skills || []).map((skill) => {
                const excluded =
                  skill.excluded || asStringList(settings.skill_exclude).includes(skill.name);
                return (
                  <div
                    key={skill.name}
                    className={`skill-item${excluded ? " skill-item-excluded" : ""}`}
                  >
                    <div className="skill-item-main">
                      <div className="skill-item-title">
                        <strong>{skill.name}</strong>
                        {excluded && <span className="muted tiny"> · removed</span>}
                      </div>
                      {skill.description ? (
                        <div className="skill-item-desc muted tiny">{skill.description}</div>
                      ) : null}
                      {skill.when_to_use ? (
                        <div className="skill-item-desc muted tiny">
                          Use when: {skill.when_to_use}
                        </div>
                      ) : null}
                      {skill.paths && skill.paths.length > 0 ? (
                        <div className="skill-item-desc muted tiny" title={skill.paths.join(", ")}>
                          Paths: {skill.paths.slice(0, 3).join(", ")}
                          {skill.paths.length > 3 ? ` (+${skill.paths.length - 3})` : ""}
                        </div>
                      ) : null}
                      {skill.source_dir ? (
                        <code className="skill-item-src muted tiny" title={skill.path}>
                          {skill.source_dir}
                        </code>
                      ) : null}
                    </div>
                    <div className="skill-row-actions">
                      {excluded ? (
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => keepSkill(skill.name, skill.source_dir)}
                        >
                          Keep
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() => excludeSkill(skill.name)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {Object.keys(skillsPreview?.unavailable || {}).length > 0 && (
              <>
                <div className="skill-subheading">
                  Unavailable (requirements not met)
                </div>
                <div className="skill-list">
                  {Object.entries(skillsPreview?.unavailable || {}).map(([name, reason]) => (
                    <div key={`unavail-${name}`} className="skill-item skill-item-excluded">
                      <div className="skill-item-main">
                        <div className="skill-item-title">
                          <strong>{name}</strong>
                        </div>
                        <div className="skill-item-desc muted tiny">{reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {Object.keys(skillsPreview?.quarantined || {}).length > 0 && (
              <>
                <div className="skill-subheading">
                  ⚠ Quarantined (failed security scan — not loaded)
                </div>
                <div className="skill-list">
                  {Object.entries(skillsPreview?.quarantined || {}).map(([name, reason]) => (
                    <div key={`quar-${name}`} className="skill-item skill-item-excluded">
                      <div className="skill-item-main">
                        <div className="skill-item-title">
                          <strong>{name}</strong>
                        </div>
                        <div className="skill-item-desc muted tiny">{reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(skillsPreview?.warnings || []).length > 0 && (
              <details className="skill-warnings">
                <summary className="muted tiny">
                  Loader warnings ({(skillsPreview?.warnings || []).length})
                </summary>
                {(skillsPreview?.warnings || []).slice(0, 20).map((w, i) => (
                  <div key={`skillwarn-${i}`} className="muted tiny">
                    {w}
                  </div>
                ))}
              </details>
            )}
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Tools</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(settings.mcp_enabled ?? false)}
                onChange={(e) => setSettings((s) => ({ ...s, mcp_enabled: e.target.checked }))}
              />
              Enable MCP (user ~/.clawagents/mcp.json)
            </label>
            <label
              className="check"
              title="Workspace .clawagents/mcp.json can run local commands from this repo. Off by default."
            >
              <input
                type="checkbox"
                checked={Boolean(settings.mcp_trust_workspace ?? false)}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, mcp_trust_workspace: e.target.checked }))
                }
              />
              Trust workspace MCP config
            </label>
            <label
              className="check"
              title="Required before mode=full_access is honored (otherwise demoted to auto). Also disables the OS seatbelt sandbox so gcloud/deploy can use ~/.config."
            >
              <input
                type="checkbox"
                checked={Boolean(settings.allow_full_access ?? false)}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, allow_full_access: e.target.checked }))
                }
              />
              Allow Full Access mode (also disables OS sandbox)
            </label>
            <label
              className="check"
              title="Automatically load ~/.codex/skills, ~/.claude/skills, and ~/.agents/skills so personal workflow skills (cohort, project startup, etc.) are available."
            >
              <input
                type="checkbox"
                checked={Boolean(settings.skill_user_homes ?? true)}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, skill_user_homes: e.target.checked }))
                }
              />
              Load personal skill homes (~/.codex/skills, …)
            </label>
            <label
              className="check"
              title="Load skill folders that resolve outside the workspace."
            >
              <input
                type="checkbox"
                checked={Boolean(settings.allow_external_skill_dirs ?? false)}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, allow_external_skill_dirs: e.target.checked }))
                }
              />
              Allow external skill folders
            </label>
            <label
              className="check"
              title="Sandboxed code execution + indexed search (ctx_* tools) for token-efficient bulk analysis. Requires: npm install -g context-mode"
            >
              <input
                type="checkbox"
                checked={Boolean(settings.context_mode ?? true)}
                onChange={(e) => setSettings((s) => ({ ...s, context_mode: e.target.checked }))}
              />
              Context Mode (token-efficient ctx_* tools)
            </label>
            <div className="graphify-panel" style={{ marginTop: 10, marginBottom: 8 }}>
              <div className="muted tiny" style={{ marginBottom: 6 }}>
                <strong>Graphify</strong> — local knowledge graph for architecture /
                dependency questions (query before bulk reads).
              </div>
              <label
                className="check"
                title="When on, the sidecar starts Graphify MCP against the active graph.json so the agent can call query_graph / shortest_path / god_nodes."
              >
                <input
                  type="checkbox"
                  checked={Boolean(settings.graphify ?? false)}
                  onChange={(e) => setSettings((s) => ({ ...s, graphify: e.target.checked }))}
                />
                Enable Graphify MCP (agent can query the graph)
              </label>
              <div className="muted tiny" style={{ marginTop: 6, marginBottom: 6 }}>
                {graphifyStatus
                  ? graphifyStatus.ready
                    ? `Ready — ${String(graphifyStatus.nodeCount ?? "?")} nodes` +
                      (graphifyStatus.linkCount != null
                        ? `, ${String(graphifyStatus.linkCount)} links`
                        : "") +
                      ` @ ${String(graphifyStatus.graphPath || graphifyStatus.graph_path || "")}`
                    : String(
                        graphifyStatus.hint ||
                          graphifyStatus.summary ||
                          "Not ready — build or adopt a graph.",
                      )
                  : "Status unknown — click Refresh."}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "status" })}
                >
                  Refresh status
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "ensure" })}
                  title="pip install graphifyy[mcp] into sidecar Python"
                >
                  Install package
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "extract_code" })}
                  title="AST extract — offline, writes .clawagents/graphify/graph.json"
                >
                  Build graph (code)
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "update" })}
                  title="Incremental AST update — augment after code changes"
                >
                  Augment graph
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "adopt_upstream" })}
                  title="Copy existing graphify-out/graph.json into .clawagents/graphify/"
                >
                  Use existing graphify-out
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "extract_full" })}
                  title="Includes docs; needs LLM API keys — prefer code-only if unsure"
                >
                  Full extract (LLM)
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => post({ type: "graphify_action", action: "open_folder" })}
                >
                  Reveal folder
                </button>
              </div>
              <label>
                Graph source
                <select
                  value={String(settings.graphify_corpus || "workspace")}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, graphify_corpus: e.target.value }))
                  }
                >
                  <option value="workspace">Workspace (.clawagents/graphify or graphify-out)</option>
                  <option value="path">Custom graph.json path</option>
                </select>
              </label>
              {String(settings.graphify_corpus || "workspace") === "path" && (
                <label>
                  Custom graph path
                  <input
                    type="text"
                    value={String(settings.graphify_graph_path || "")}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, graphify_graph_path: e.target.value }))
                    }
                    placeholder="~/.graphify/global-graph.json"
                  />
                </label>
              )}
            </div>
            <label
              className="check"
              title="Register Playwright browser_* tools (navigate, snapshot, click). Needs: pip install 'clawagents[browser]' && playwright install chromium. Auto-approve → Browser still decides whether each call asks first."
            >
              <input
                type="checkbox"
                checked={Boolean(settings.browser_tools)}
                onChange={(e) => setSettings((s) => ({ ...s, browser_tools: e.target.checked }))}
              />
              Enable browser tools (Playwright)
            </label>
            <div className="muted tiny" style={{ marginTop: 6 }}>
              Web search uses Tavily. Status:{" "}
              {hasTavilyKey ? (
                <strong>key configured</strong>
              ) : (
                <span>no key — save a Tavily key below</span>
              )}
              . Fetch/search auto-approve is under the composer Auto-approve → Web.
            </div>
            <label>
              Tavily API key (web_search)
              <input
                type="password"
                autoComplete="off"
                value={providerKeyDraft}
                onChange={(e) => setProviderKeyDraft(e.target.value)}
                placeholder={
                  hasTavilyKey
                    ? "••••••••  (saved — paste to replace)"
                    : "tvly-… from tavily.com"
                }
              />
            </label>
            <div className="provider-actions">
              <button
                type="button"
                className="primary tiny"
                disabled={!providerKeyDraft.trim()}
                onClick={() => {
                  setProviderSetupMsg("Saving Tavily key…");
                  post({
                    type: "set_provider_key",
                    provider: "tavily",
                    apiKey: providerKeyDraft.trim(),
                  });
                  setProviderKeyDraft("");
                }}
              >
                Save Tavily key
              </button>
              <button
                type="button"
                className="ghost tiny"
                disabled={!hasTavilyKey}
                onClick={() => {
                  setProviderSetupMsg("Clearing Tavily key…");
                  post({ type: "clear_provider_key", provider: "tavily" });
                }}
              >
                Clear key
              </button>
            </div>
            {providerSetupMsg && (
              <p className="settings-hint">{providerSetupMsg}</p>
            )}
          </section>

          <section className="settings-section">
            <h3 className="settings-heading">Advanced</h3>
            <p className="muted tiny" style={{ marginTop: 0 }}>
              Changes autosave after a short pause. API keys live under the Provider card
              above (and Tavily under Browser / web). Command Palette still has Set/Clear
              API key if you prefer dialogs.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(settings.telemetry)}
                onChange={(e) => setSettings((s) => ({ ...s, telemetry: e.target.checked }))}
              />
              Local telemetry (opt-in)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(settings.trajectory)}
                onChange={(e) => setSettings((s) => ({ ...s, trajectory: e.target.checked }))}
              />
              Trajectory logging
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(settings.learn)}
                onChange={(e) => setSettings((s) => ({ ...s, learn: e.target.checked }))}
              />
              Learn (PTRL lessons)
            </label>
          </section>

          <div className="panel-actions">
            <button
              type="button"
              className="primary"
              title="Flush settings now (also autosaves ~0.5s after changes)"
              onClick={() => {
                window.clearTimeout(settingsSaveTimer.current);
                const patch = normalizeSettingsForSave(settings);
                pendingSettingsPatch.current = patch;
                setVerifyMsg("Saving…");
                postSettingsSave(patch, settings);
              }}
            >
              Save settings
            </button>
          </div>
          {verifyMsg && <div className="muted">{verifyMsg}</div>}
        </div>
      )}

      {panel === "diagnostics" && (
        <div className="panel">
          <pre className="tool-body">{safeJson(diagnostics)}</pre>
          <h4>Local stats</h4>
          <pre className="tool-body">{safeJson(stats)}</pre>
          <button type="button" className="ghost" onClick={() => post({ type: "restart_sidecar" })}>
            Restart sidecar
          </button>
        </div>
      )}

      {panel === "chat" && (
        <>
          <main className="messages" ref={messagesRef}>
            {items.length === 0 && (
              <div className="empty">
                <p>Multi-turn agent with providers, checkpoints, MCP, and local telemetry.</p>
                <div className="quick">
                  {["Explain the active file", "Fix workspace errors", "Summarize git status"].map(
                    (q) => (
                      <button
                        key={q}
                        type="button"
                        className="chip"
                        disabled={busy || !hasApiKey}
                        onClick={() => {
                          setDraft(q);
                          // Include current auto-approve / interaction so a chip
                          // click before the persist debounce cannot use stale host state.
                          post({
                            type: "send",
                            text: q,
                            mode,
                            includeContext,
                            chatId,
                            autoApprove,
                            model: activeModelId || undefined,
                            interaction: effectiveInteraction,
                            caveman,
                            goal: goalMode,
                          });
                        }}
                      >
                        {q}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
            {(eventsHasMore || items.length > renderWindow) && (
              <div className="transcript-older">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    if (eventsHasMore) {
                      post({ type: "load_older_chat" });
                    }
                    setRenderWindow((w) => w + TRANSCRIPT_RENDER_CHUNK);
                  }}
                >
                  {eventsHasMore
                    ? "Load older messages…"
                    : `Show older (${items.length - renderWindow} hidden)`}
                </button>
              </div>
            )}
            {items.slice(Math.max(0, items.length - renderWindow)).map((item, i, arr) => {
              const absoluteIndex = items.length - arr.length + i;
              return (
                <TranscriptItem
                  key={absoluteIndex}
                  item={item}
                  setItems={setItems}
                  onAskDraftChange={handleAskDraftChange}
                  showStreamingCursor={
                    busy && streamingRef.current && absoluteIndex === items.length - 1
                  }
                />
              );
            })}
            <div ref={bottomRef} />
          </main>

          <footer className="composer">
            <div className="autoapprove">
              <button
                type="button"
                className="aa-summary"
                onClick={() => setAutoApproveOpen((o) => !o)}
                title="Actions the agent may take without asking each time"
              >
                <span className="aa-caret">{autoApproveOpen ? "▾" : "▸"}</span>
                Auto-approve:{" "}
                <strong>
                  {planAct === "plan"
                    ? "— (Plan: explore + write_plan → approve)"
                    : [
                        settings.allow_full_access && "Full access",
                        autoApprove.edit && "Edit",
                        autoApprove.execute && "Execute",
                        autoApprove.web && "Web",
                        autoApprove.browser && "Browser",
                      ]
                        .filter(Boolean)
                        .join(", ") || "nothing (asks each time)"}
                  {caveman ? " · Caveman" : ""}
                </strong>
              </button>
              {autoApproveOpen && (
                <div className="aa-options">
                  <label className="check" title="Reads and searches are never gated">
                    <input type="checkbox" checked readOnly disabled />
                    Read files &amp; search <span className="muted tiny">(always)</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={autoApprove.edit}
                      onChange={() => toggleApprove("edit")}
                    />
                    Edit files in workspace
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={autoApprove.execute}
                      onChange={() => toggleApprove("execute")}
                    />
                    Run commands &amp; ctx_execute
                  </label>
                  <label
                    className="check"
                    title="web_fetch and web_search (Tavily). Off = ask each time. Set Tavily key under Settings → Browser / web."
                  >
                    <input
                      type="checkbox"
                      checked={autoApprove.web}
                      onChange={() => toggleApprove("web")}
                    />
                    Web fetch &amp; search
                    {!hasTavilyKey && (
                      <span className="muted tiny"> (Tavily key missing for search)</span>
                    )}
                  </label>
                  <label
                    className="check"
                    title="browser_* tools. Requires Settings → Enable browser tools. Off = ask each time."
                  >
                    <input
                      type="checkbox"
                      checked={autoApprove.browser}
                      onChange={() => toggleApprove("browser")}
                      disabled={!settings.browser_tools}
                    />
                    Browser (Playwright)
                    {!settings.browser_tools && (
                      <span className="muted tiny"> (enable in Settings first)</span>
                    )}
                  </label>
                  <label
                    className="check"
                    title="Mode=full_access + disable OS seatbelt so gcloud/deploy can use ~/.config. Also turns on Edit + Execute auto-approve."
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(settings.allow_full_access)}
                      onChange={(e) => setAllowFullAccess(e.target.checked)}
                      disabled={planAct === "plan"}
                    />
                    Full access{" "}
                    <span className="muted tiny">(no OS sandbox · gcloud/deploy)</span>
                  </label>
                  <label
                    className="check"
                    title="Terse caveman-style replies — fewer tokens, same technical accuracy (juliusbrussee/caveman)"
                  >
                    <input
                      type="checkbox"
                      checked={caveman}
                      onChange={() => setCaveman((c) => !c)}
                    />
                    Caveman mode <span className="muted tiny">(terse replies)</span>
                  </label>
                  <div className="muted tiny">
                    In <strong>Goal</strong>, the agent runs planner→verify→strategist
                    (prefer <code>start_goal</code> / <code>update_goal</code>).
                    In <strong>Plan</strong>, the agent explores, drafts{" "}
                    <code>.clawagents/plan.md</code>, then asks you to Approve / Request
                    changes / Reject on exit — interaction is always Interactive.
                    In <strong>Act + Interactive</strong>, unchecked Edit/Execute/Web/Browser ask
                    first.
                    In <strong>Act + Auto</strong>, ask_user is skipped; Auto-approve toggles still
                    apply.
                    <strong> Full access</strong> disables the OS sandbox (needed for gcloud
                    credentials under <code>~/.config</code>).
                    <strong> Caveman</strong> makes the agent reply ultra-brief.
                    Enable browser tools under Settings; install{" "}
                    <code>clawagents[browser]</code> + Chromium for Playwright.
                  </div>
                </div>
              )}
            </div>
            <div className="toolbar">
              <div className="toolbar-modes">
                <div className="planact" role="tablist" aria-label="Goal, Plan, or Act">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workMode === "goal"}
                    className={workMode === "goal" ? "seg active" : "seg"}
                    onClick={() => setWorkMode("goal")}
                    disabled={busy}
                    title="Goal autopilot — planner → execute → majority verifier (Grok /goal)."
                  >
                    Goal
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workMode === "plan"}
                    className={workMode === "plan" ? "seg active" : "seg"}
                    onClick={() => setWorkMode("plan")}
                    disabled={busy}
                    title="Read & reason only — proposes changes without editing or running"
                  >
                    Plan
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workMode === "act"}
                    className={workMode === "act" ? "seg active" : "seg"}
                    onClick={() => setWorkMode("act")}
                    disabled={busy}
                    title="Execute — the auto-approve toggles decide what runs without a prompt"
                  >
                    Act
                  </button>
                </div>
                <div
                  className="planact interaction"
                  role="tablist"
                  aria-label="Ask or Auto"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveInteraction === "interactive"}
                    className={
                      effectiveInteraction === "interactive" ? "seg active" : "seg"
                    }
                    onClick={() => setInteractionStyle("interactive")}
                    disabled={busy || planAct === "plan"}
                    title="Interactive: ask you when unclear — Plan always uses this"
                  >
                    Ask
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveInteraction === "auto"}
                    className={effectiveInteraction === "auto" ? "seg active" : "seg"}
                    onClick={() => setInteractionStyle("auto")}
                    disabled={busy || planAct === "plan"}
                    title="Auto: decide without asking — Act only; also auto-approves Edit/Execute/Web for the turn"
                  >
                    Auto
                  </button>
                </div>
              </div>
              <label
                className="check"
                title="Attach active editor snippet to the model (not shown in chat history; .env and other secret files are omitted)"
              >
                <input
                  type="checkbox"
                  checked={includeContext}
                  onChange={(e) => setIncludeContext(e.target.checked)}
                />
                Context
              </label>
              {(
                [
                  ["file", "+File", "Insert active file path (@path) — agent reads it"],
                  ["selection", "+Sel", "Insert the current selection into the draft"],
                ] as const
              ).map(([kind, label, title]) => (
                <button
                  key={kind}
                  type="button"
                  className="ghost tiny"
                  title={title}
                  onClick={() => post({ type: "insert_context", kind })}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="ghost tiny"
                disabled={busy || attachmentUploads > 0}
                title="Attach images, PDF, or DOCX from this device"
                onClick={() => localAttachInputRef.current?.click()}
              >
                +Attach
              </button>
              <input
                ref={localAttachInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.docx"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  void attachLocalBrowserFiles(
                    files,
                    setItems,
                    beginAttachmentRequest,
                    finishAttachmentRequest,
                  );
                }}
              />
              <button
                type="button"
                className="ghost tiny"
                disabled={busy || attachmentUploads > 0}
                title="Attach files from the remote workspace"
                onClick={() => post({ type: "pick_attach_files" })}
              >
                +Remote
              </button>
              <button
                type="button"
                className="ghost tiny"
                disabled={busy || !items.length}
                title="Regenerate the last reply"
                onClick={() => post({ type: "regenerate" })}
              >
                Regen
              </button>
              <button
                type="button"
                className="ghost tiny"
                disabled={busy || !items.length}
                title="Fork current conversation into a new chat"
                onClick={() => post({ type: "fork_chat" })}
              >
                Fork
              </button>
              <button
                type="button"
                className="ghost tiny"
                disabled={busy}
                title="Start a new chat"
                onClick={() => post({ type: "new_chat" })}
              >
                New
              </button>
            </div>
            {(pendingImages.length > 0 || pendingFiles.length > 0) && (
              <div className="image-attachments">
                {pendingImages.map((img) => (
                  <span key={img.id} className="image-chip" title={img.name}>
                    <span className="image-chip-name">🖼 {img.name}</span>
                    <button
                      type="button"
                      className="image-chip-remove"
                      title="Remove image"
                      onClick={() => post({ type: "remove_image", id: img.id })}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {pendingFiles.map((f) => (
                  <span key={f.id} className="image-chip" title={f.name}>
                    <span className="image-chip-name">📄 {f.name}</span>
                    <button
                      type="button"
                      className="image-chip-remove"
                      title="Remove file"
                      onClick={() => post({ type: "remove_file", id: f.id })}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              className={`compose-row${dragOver ? " drag-over" : ""}`}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dragDepth.current += 1;
                setDragOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) {
                  setDragOver(false);
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dragDepth.current = 0;
                setDragOver(false);
                if (hasVsCodeUriPayload(e.dataTransfer)) {
                  const uris = collectDropUris(e.dataTransfer);
                  if (uris.length > 0) {
                    post({ type: "attach_uris", uris });
                    return;
                  }
                }
                const localFiles = collectTransferFiles(e.dataTransfer);
                if (localFiles.length > 0) {
                  void attachLocalBrowserFiles(
                    localFiles,
                    setItems,
                    beginAttachmentRequest,
                    finishAttachmentRequest,
                  );
                  return;
                }
                const uris = collectDropUris(e.dataTransfer);
                if (uris.length) {
                  post({ type: "attach_uris", uris });
                } else {
                  // VS Code disables webview pointer-events during drag unless
                  // Shift is held — empty drops usually mean that restriction.
                  setItems((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    const text =
                      "Hold Shift while dropping files here (VS Code), or use +Attach.";
                    if (last?.kind === "status") {
                      next[next.length - 1] = { kind: "status", text };
                      return next;
                    }
                    return [...next, { kind: "status", text }];
                  });
                }
              }}
            >
              <div className="compose-shell">
                <div
                  className="compose-resize-handle"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const ta = textareaRef.current;
                    if (!ta) return;
                    const startY = e.clientY;
                    const startH = ta.offsetHeight;
                    const onMove = (ev: PointerEvent) => {
                      // dragging up (negative delta) → taller
                      const delta = startY - ev.clientY;
                      const next = Math.min(Math.max(startH + delta, 52), 320);
                      ta.style.height = `${next}px`;
                    };
                    const onUp = () => {
                      document.removeEventListener("pointermove", onMove);
                      document.removeEventListener("pointerup", onUp);
                    };
                    document.addEventListener("pointermove", onMove);
                    document.addEventListener("pointerup", onUp);
                  }}
                />
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                  }}
                  onPaste={(e) => {
                    const files = collectTransferFiles(e.clipboardData);
                    if (files.length === 0) {
                      return;
                    }
                    e.preventDefault();
                    void attachLocalBrowserFiles(
                      files,
                      setItems,
                      beginAttachmentRequest,
                      finishAttachmentRequest,
                    );
                  }}
                  onDrop={(e) => {
                    // Prevent the browser's default path-insertion behavior inside textarea,
                    // but allow it to bubble up to .compose-row for custom attachment logic.
                    e.preventDefault();
                  }}
                  placeholder={`${workMode === "goal" ? "Goal" : workMode === "plan" ? "Plan" : "Act"} · ${effectiveInteraction === "auto" ? "Auto" : "Ask"} · mic / ⌃␣ / F8 dictate · paste / ⇧-drop / +Attach · ↵ send · ⇧↵ newline · Esc stop`}
                  rows={3}
                  onKeyDown={(e) => {
                    // Enter sends; Shift+Enter (or ⌘/Ctrl+Enter) inserts a newline.
                    // Ignore Enter while an IME composition is active.
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.metaKey &&
                      !e.ctrlKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      if (dictating) {
                        post({ type: "dictation_toggle", target: "composer" });
                      }
                      // send() owns API-key gating + slash-command exemptions
                      send();
                    } else if (e.key === "Escape" && dictating) {
                      e.preventDefault();
                      post({ type: "dictation_toggle", target: "composer" });
                    } else if (e.key === "Escape" && busy) {
                      e.preventDefault();
                      post({ type: "cancel" });
                    }
                  }}
                />
                <div className="compose-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Report a bug (type, speak, or screenshot → email)"
                    aria-label="Report a bug"
                    onClick={() => {
                      setBugReportOpen(true);
                      setBugReportStatus("");
                    }}
                  >
                    <IconComment />
                  </button>
                  <button
                    type="button"
                    className={`icon-btn mic-btn${dictating ? " active" : ""}`}
                    title={
                      dictating
                        ? "Stop dictation (Esc / Mic)"
                        : "Dictate (macOS Fn Fn · Windows Win+H). ⌃␣ / F8 · ⌥/Alt+Mic to change mic"
                    }
                    aria-label={dictating ? "Stop dictation" : "Start voice dictation"}
                    aria-pressed={dictating}
                    onClick={(e) => toggleDictation(e.altKey)}
                  >
                    {dictating ? <IconMicOff /> : <IconMic />}
                  </button>
                  {busy ? (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Redirect draft mid-turn (without stopping)"
                        aria-label="Redirect draft mid-turn"
                        disabled={!draft.trim()}
                        onClick={() => {
                          const value = draft.trim();
                          if (!value) return;
                          setDraft("");
                          post({ type: "interject", text: value });
                        }}
                      >
                        <IconRedirect />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Stop generation (Esc)"
                        aria-label="Stop generation"
                        onClick={() => post({ type: "cancel" })}
                      >
                        <IconStop />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn primary send"
                      title={
                        !hasApiKey
                          ? "Add a provider API key in Settings first"
                          : attachmentUploads > 0
                            ? "Attaching files…"
                            : "Send (Enter)"
                      }
                      aria-label={attachmentUploads > 0 ? "Attaching files" : "Send"}
                      onClick={send}
                      disabled={!draft.trim() || attachmentUploads > 0 || !hasApiKey}
                    >
                      {attachmentUploads > 0 ? <IconSpinner /> : <IconSend />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </footer>

          {bugReportOpen ? (
            <div
              className="bug-report-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Report a bug"
            >
              <div className="bug-report-panel">
                <div className="bug-report-head">
                  <strong>Report a bug</strong>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Close"
                    aria-label="Close bug report"
                    onClick={() => {
                      if (bugReportDictating) {
                        post({ type: "dictation_toggle", target: "bug_report" });
                      }
                      setBugReportDictating(false);
                      setBugReportOpen(false);
                    }}
                  >
                    ✕
                  </button>
                </div>
                <p className="tiny muted">
                  Type, speak, or attach a screenshot. Sends via configured SMTP, or copies/opens a
                  draft when email is unavailable.
                </p>
                <textarea
                  ref={bugReportTextareaRef}
                  className="bug-report-text"
                  rows={5}
                  value={bugReportText}
                  placeholder="What went wrong?"
                  disabled={bugReportBusy}
                  onChange={(e) => setBugReportText(e.target.value)}
                />
                {bugReportShots.length > 0 ? (
                  <div className="bug-report-shots">
                    {bugReportShots.map((s, i) => (
                      <span key={`${s.name}-${i}`} className="bug-shot-chip" title={s.name}>
                        <img
                          src={`data:${s.mediaType};base64,${s.data}`}
                          alt={s.name}
                        />
                        <button
                          type="button"
                          className="image-chip-remove"
                          title="Remove"
                          onClick={() =>
                            setBugReportShots((prev) => prev.filter((_, j) => j !== i))
                          }
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="bug-report-actions">
                  <button
                    type="button"
                    className={`icon-btn mic-btn${bugReportDictating ? " active" : ""}`}
                    title="Dictate (⌥/Alt+click to change mic)"
                    aria-label="Dictate bug description"
                    aria-pressed={bugReportDictating}
                    disabled={bugReportBusy}
                    onClick={(e) => {
                      const forcePick = e.altKey;
                      bugReportTextareaRef.current?.focus();
                      if (!bugReportDictating) {
                        setBugReportStatus(
                          forcePick ? "Choose a microphone…" : "Dictation…",
                        );
                      }
                      window.setTimeout(() => {
                        post({
                          type: "dictation_toggle",
                          target: "bug_report",
                          forcePick: forcePick || undefined,
                        });
                      }, 40);
                    }}
                  >
                    {bugReportDictating ? <IconMicOff /> : <IconMic />}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Capture screenshot (macOS: drag region)"
                    aria-label="Capture screenshot"
                    disabled={bugReportBusy || bugReportShots.length >= 6}
                    onClick={() => {
                      setBugReportBusy(true);
                      setBugReportStatus("Capture a region…");
                      post({ type: "bug_report_capture_screenshot" });
                    }}
                  >
                    <IconCamera />
                  </button>
                  <button
                    type="button"
                    className="primary bug-report-send"
                    disabled={bugReportBusy || !bugReportText.trim()}
                    onClick={() => {
                      if (bugReportDictating) {
                        post({ type: "dictation_toggle", target: "bug_report" });
                      }
                      setBugReportDictating(false);
                      setBugReportBusy(true);
                      setBugReportStatus("Sending…");
                      post({
                        type: "bug_report_submit",
                        text: bugReportText.trim(),
                        screenshots: bugReportShots,
                      });
                    }}
                  >
                    {bugReportBusy ? "…" : "Send report"}
                  </button>
                </div>
                {bugReportStatus ? (
                  <div className="tiny muted">{bugReportStatus}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function IconComment() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H6a2 2 0 0 1-2-2V6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M19 11a7 7 0 0 1-14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMicOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-4.9-1.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 9v2a3 3 0 0 0 4.2 2.7M19 11a7 7 0 0 1-9.9 6.3M5 11a7 7 0 0 0 3.1 5.8M12 18v3M4 4l16 16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M12 5l-6 6M12 5l6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconRedirect() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 7h7a5 5 0 0 1 0 10H7M7 7l3-3M7 7l3 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg
      className="icon-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <path
        d="M20 12a8 8 0 0 0-8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function normalizeMantleUrlClient(raw: string): string {
  const text = (raw || "").trim();
  const fallbackRegion = "us-east-1";
  if (!text || /^[a-z0-9-]+$/i.test(text)) {
    const region = text || fallbackRegion;
    return `https://bedrock-mantle.${region}.api.aws/v1`;
  }
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)
      ? text
      : `https://${text}`;
    const u = new URL(withScheme);
    const host = (u.hostname || "").toLowerCase();
    if (
      host === "bedrock-mantle.api.aws" ||
      /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/.test(host)
    ) {
      u.protocol = "https:";
      u.pathname = "/v1";
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/+$/, "");
    }
  } catch {
    /* fall through */
  }
  return `https://bedrock-mantle.${fallbackRegion}.api.aws/v1`;
}

/** Client-side mirror of extension `normalizeBagBaseUrl` for the Fix URL button. */
function normalizeBagUrlClient(raw: string): string {
  let text = (raw || "").trim().replace(/\/+$/, "");
  if (!text) {
    return "http://localhost:8000/api/v1";
  }
  text = text.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") {
      u.pathname = "/api/v1";
    } else if (path === "/v1" || path === "/api") {
      u.pathname = "/api/v1";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return text;
  }
}

/** Client-side mirror for OpenAI-compatible …/v1 endpoints. */
function normalizeOpenAIUrlClient(raw: string): string {
  let text = (raw || "").trim().replace(/\/+$/, "");
  if (!text) {
    return "http://localhost:11434/v1";
  }
  text = text.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/" || path === "") {
      u.pathname = "/v1";
    } else if (path === "/api") {
      u.pathname = "/v1";
    }
    // Keep /api/v1 (BAG) as-is when using OpenAI provider against BAG.
    return u.toString().replace(/\/+$/, "");
  } catch {
    return text;
  }
}

type LocalAttachmentPayload = { name: string; mediaType: string; data: string };
let localAttachmentRequestSequence = 0;

function nextLocalAttachmentRequestId(): string {
  localAttachmentRequestSequence += 1;
  return `local-${Date.now().toString(36)}-${localAttachmentRequestSequence.toString(36)}`;
}

function hasVsCodeUriPayload(data: DataTransfer): boolean {
  return Array.from(data.types ?? []).some((type) => {
    const normalized = type.toLowerCase();
    return normalized === "application/vnd.code.uri-list" || normalized === "resourceurls";
  });
}

function collectTransferFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) {
    return files;
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

async function attachLocalBrowserFiles(
  files: File[],
  setItems: Dispatch<SetStateAction<ChatItem[]>>,
  onRequestStarted: (requestId: string) => void,
  onRequestFinished: (requestId: string) => void,
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const limited = files.slice(0, MAX_LOCAL_ATTACHMENTS_PER_PICK);
  const errors: string[] = [];
  for (let index = 0; index < limited.length; index += 1) {
    const requestId = nextLocalAttachmentRequestId();
    onRequestStarted(requestId);
    const result = await readLocalAttachment(limited[index], index);
    if (typeof result === "string") {
      errors.push(result);
      onRequestFinished(requestId);
      continue;
    }
    try {
      // One file per message bounds Remote SSH / Codespaces IPC copies. The
      // host ACK keeps Send disabled until these bytes are actually staged.
      post({ type: "attach_local_files", requestId, files: [result] });
    } catch {
      errors.push(`${result.name} (could not be transferred)`);
      onRequestFinished(requestId);
    }
  }
  if (files.length > limited.length) {
    errors.push(`Only the first ${MAX_LOCAL_ATTACHMENTS_PER_PICK} files were considered`);
  }
  if (errors.length > 0) {
    setItems((previous) => [
      ...previous,
      { kind: "error", text: `Could not attach: ${errors.slice(0, 3).join(", ")}` },
    ]);
  }
}

async function readLocalAttachment(
  file: File,
  index: number,
): Promise<LocalAttachmentPayload | string> {
  const mediaType = localAttachmentMediaType(file);
  const fallbackName = `pasted-file-${index + 1}${extensionForMediaType(mediaType)}`;
  const name = (file.name || fallbackName).replace(/^.*[\\/]/, "").slice(0, 120);
  if (!mediaType) {
    return `${name || "file"} (use PNG, JPEG, GIF, WebP, PDF, or DOCX)`;
  }
  if (file.size === 0) {
    return `${name} (empty)`;
  }
  if (file.size > MAX_LOCAL_ATTACHMENT_BYTES) {
    return `${name} (${Math.ceil(file.size / 1024 / 1024)}MB > 10MB)`;
  }
  try {
    return { name, mediaType, data: await fileToBase64(file) };
  } catch {
    return `${name} (could not be read)`;
  }
}

function localAttachmentMediaType(file: File): string {
  const declared = (file.type || "").toLowerCase();
  if (LOCAL_IMAGE_TYPES.has(declared) || LOCAL_DOCUMENT_TYPES.has(declared)) {
    return declared;
  }
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".gif")) return "image/gif";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  if (lowerName.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "";
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/gif") return ".gif";
  if (mediaType === "image/webp") return ".webp";
  if (mediaType === "application/pdf") return ".pdf";
  if (mediaType.includes("wordprocessingml")) return ".docx";
  return ".png";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0 || !result.slice(comma + 1)) {
        reject(new Error("Invalid file data"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Collect file URIs from a VS Code explorer drag onto the composer. */
function collectDropUris(dt: DataTransfer): string[] {
  const found: string[] = [];
  const pushLine = (raw: string) => {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) {
        found.push(t);
      }
    }
  };
  const pushPayload = (type: string, data: string) => {
    if (!data) {
      return;
    }
    const lower = type.toLowerCase();
    // VS Code explorer uses JSON string arrays for ResourceURLs.
    if (lower === "resourceurls" || data.startsWith("[")) {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string" && item.trim()) {
              found.push(item.trim());
            }
          }
          return;
        }
      } catch {
        /* fall through to line split */
      }
    }
    pushLine(data);
  };
  const types = [
    "application/vnd.code.uri-list",
    "text/uri-list",
    "ResourceURLs",
    "resourceurls",
  ];
  for (const type of types) {
    if (!dt.types.includes(type)) continue;
    try {
      pushPayload(type, dt.getData(type));
    } catch {
      /* ignore */
    }
  }
  
  if (found.length === 0 && dt.types.includes("text/plain")) {
    try {
      pushPayload("text/plain", dt.getData("text/plain"));
    } catch {
      /* ignore */
    }
  }
  return [...new Set(found)];
}
