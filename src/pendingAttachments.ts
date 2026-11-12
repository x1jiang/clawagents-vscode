/**
 * Attachments staged in a composer, keyed by the conversation that composer
 * belongs to.
 *
 * Staged attachments used to live in two provider-wide arrays that any
 * starting run claimed. A queued follow-up in conversation A would therefore
 * send (and remove) a screenshot the user had just staged in conversation B.
 * Keying by conversation makes ownership explicit: a run only ever claims
 * what was staged in its own composer.
 */

export type StagedAttachment = {
  id: string;
  name: string;
  /** Base64 payload. Stays host-side; the webview only sees id + name. */
  data: string;
  mediaType: string;
};

export type ClaimedAttachments = {
  images: StagedAttachment[];
  files: StagedAttachment[];
};

/** Key for the composer of a conversation that has no id yet. */
export const UNASSIGNED_CHAT = "";

export function attachmentKey(chatId: string | undefined | null): string {
  return chatId || UNASSIGNED_CHAT;
}

export class PendingAttachments {
  private readonly imagesByChat = new Map<string, StagedAttachment[]>();
  private readonly filesByChat = new Map<string, StagedAttachment[]>();

  /** Live list for one conversation; safe to `push` onto. */
  images(chatId: string | undefined): StagedAttachment[] {
    return liveList(this.imagesByChat, attachmentKey(chatId));
  }

  files(chatId: string | undefined): StagedAttachment[] {
    return liveList(this.filesByChat, attachmentKey(chatId));
  }

  setImages(chatId: string | undefined, next: StagedAttachment[]): void {
    replace(this.imagesByChat, attachmentKey(chatId), next);
  }

  setFiles(chatId: string | undefined, next: StagedAttachment[]): void {
    replace(this.filesByChat, attachmentKey(chatId), next);
  }

  /** Remove and return everything staged for one conversation. */
  claim(chatId: string | undefined): ClaimedAttachments {
    const key = attachmentKey(chatId);
    const claimed = {
      images: this.imagesByChat.get(key) ?? [],
      files: this.filesByChat.get(key) ?? [],
    };
    this.imagesByChat.delete(key);
    this.filesByChat.delete(key);
    return claimed;
  }

  /**
   * Move one composer's staged attachments to another conversation — used
   * when the unsaved composer is given its real id, or a run renames a chat.
   * Anything already staged on the target is kept, ahead of the moved items.
   */
  adopt(fromChatId: string | undefined, toChatId: string | undefined): void {
    const from = attachmentKey(fromChatId);
    const to = attachmentKey(toChatId);
    if (from === to) {
      return;
    }
    move(this.imagesByChat, from, to);
    move(this.filesByChat, from, to);
  }

  /** Drop a conversation's staged attachments (e.g. the chat was deleted). */
  discard(chatId: string | undefined): void {
    const key = attachmentKey(chatId);
    this.imagesByChat.delete(key);
    this.filesByChat.delete(key);
  }

  isEmpty(chatId: string | undefined): boolean {
    const key = attachmentKey(chatId);
    return !this.imagesByChat.get(key)?.length && !this.filesByChat.get(key)?.length;
  }
}

function liveList(
  map: Map<string, StagedAttachment[]>,
  key: string,
): StagedAttachment[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

function replace(
  map: Map<string, StagedAttachment[]>,
  key: string,
  next: StagedAttachment[],
): void {
  if (next.length === 0) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
}

function move(map: Map<string, StagedAttachment[]>, from: string, to: string): void {
  const moving = map.get(from);
  if (!moving?.length) {
    map.delete(from);
    return;
  }
  map.delete(from);
  map.set(to, [...(map.get(to) ?? []), ...moving]);
}
