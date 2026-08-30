export const THREAD_UNREAD_STATE_KEY = "unreadChatIds";

const MAX_PERSISTED_UNREAD_THREADS = 1_000;

/** Decode persisted webview state defensively; chat ids are opaque strings. */
export function readPersistedUnreadThreads(state: unknown): Set<string> {
  if (!state || typeof state !== "object") return new Set();
  const value = (state as Record<string, unknown>)[THREAD_UNREAD_STATE_KEY];
  if (!Array.isArray(value)) return new Set();
  const ids = value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .slice(0, MAX_PERSISTED_UNREAD_THREADS);
  return new Set(ids);
}

export function serializeUnreadThreads(ids: ReadonlySet<string>): string[] {
  return [...ids].slice(0, MAX_PERSISTED_UNREAD_THREADS);
}

export function markThreadUnread(previous: Set<string>, chatId: string): Set<string> {
  if (!chatId || previous.has(chatId)) return previous;
  const next = new Set(previous);
  next.add(chatId);
  return next;
}

export function acknowledgeThreadUnread(previous: Set<string>, chatId: string): Set<string> {
  if (!chatId || !previous.has(chatId)) return previous;
  const next = new Set(previous);
  next.delete(chatId);
  return next;
}

export function retainAvailableUnreadThreads(
  previous: Set<string>,
  availableChatIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set([...previous].filter((chatId) => availableChatIds.has(chatId)));
  return next.size === previous.size ? previous : next;
}

export type ThreadActivity = "attention" | "unread" | "running" | undefined;

/** Attention wins over unread; unread wins over the lower-priority running pulse. */
export function threadActivity(
  needsAttention: boolean,
  hasUnread: boolean,
  running: boolean,
): ThreadActivity {
  if (needsAttention) return "attention";
  if (hasUnread) return "unread";
  if (running) return "running";
  return undefined;
}

export function threadActivityLabel(activity: ThreadActivity): string | undefined {
  if (activity === "attention") return "Needs attention";
  if (activity === "unread") return "Unread output";
  if (activity === "running") return "Running";
  return undefined;
}
