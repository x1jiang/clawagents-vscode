export type ReadingContext = {
  chatId?: string;
  enabled: boolean;
  hasContent: boolean;
};

/** Converts deliberate transcript interactions into bounded, throttled signals.
 * No scroll listener: browser scroll events also fire for streamed auto-scroll. */
export function installThreadReading(
  root: HTMLElement,
  context: () => ReadingContext,
  report: (chatId: string, active: boolean, background?: boolean) => void,
  now = () => performance.now(),
) {
  const doc = root.ownerDocument;
  let lastPulse = -Infinity;
  let activeChat: string | undefined;
  const pause = () => {
    if (activeChat) report(activeChat, false);
    activeChat = undefined;
    lastPulse = -Infinity;
  };
  const editable = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.('input, textarea, [contenteditable="true"], [role="textbox"]');
  const pulse = (allowBackground = false) => {
    const { chatId, enabled, hasContent } = context();
    if (!enabled || !chatId || !hasContent || doc.hidden || (!doc.hasFocus() && !allowBackground)) return;
    const at = now();
    if (activeChat === chatId && at - lastPulse < 1000) return;
    if (activeChat && activeChat !== chatId) pause();
    activeChat = chatId;
    lastPulse = at;
    report(chatId, true, !doc.hasFocus());
  };
  const interact = (event: Event) => {
    if (!event.isTrusted || editable(event.target)) return;
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Enter"].includes(key)) return;
    }
    if (event.type === "pointermove" && !(event as PointerEvent).buttons) return;
    pulse(["wheel", "touchmove", "pointermove"].includes(event.type));
  };
  const leave = (event: Event) => {
    if (!root.contains(event.target as Node) || editable(event.target)) pause();
  };
  const visibility = () => { if (doc.hidden) pause(); };
  const events = ["wheel", "touchmove", "pointerdown", "pointerup", "pointermove", "click", "keydown"];
  for (const event of events) root.addEventListener(event, interact, { passive: true });
  doc.addEventListener("pointerdown", leave, true);
  doc.addEventListener("focusin", leave, true);
  doc.addEventListener("visibilitychange", visibility);
  doc.defaultView?.addEventListener("blur", pause);
  return {
    // Called only after explicit navigation and the matching transcript is ready.
    open: () => pulse(),
    pause,
    dispose() {
      pause();
      for (const event of events) root.removeEventListener(event, interact);
      doc.removeEventListener("pointerdown", leave, true);
      doc.removeEventListener("focusin", leave, true);
      doc.removeEventListener("visibilitychange", visibility);
      doc.defaultView?.removeEventListener("blur", pause);
    },
  };
}
