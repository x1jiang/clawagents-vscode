import { copyText } from "./clipboard";
import { post } from "./vscodeApi";

const TRANSCRIPTS = ".messages, .side-chat-messages";
const EDITORS = "input, textarea, [contenteditable='true']";

/** Restrict the override to rendered transcript text, leaving editors native. */
export function selectedTranscriptText(doc: Document): string {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const elementFor = (node: Node | null) => node?.nodeType === 1
    ? node as Element : node?.parentElement;
  const start = elementFor(selection.anchorNode);
  const end = elementFor(selection.focusNode);
  if (!start || !end || start.closest(EDITORS) || end.closest(EDITORS)) return "";
  const root = start.closest(TRANSCRIPTS);
  if (!root || end.closest(TRANSCRIPTS) !== root) return "";
  const text = selection.toString();
  return text.length <= 1_000_000 ? text : "";
}

/** Copy snapshots instead of relying on VS Code's native iframe focus routing. */
export function installTranscriptSelection(doc: Document): () => void {
  let last = "";
  const publish = (text: string) => {
    if (text === last) return;
    last = text;
    post({ type: "transcript_selection", text });
  };
  const onSelection = () => {
    // Opening a native context menu may blur the iframe without clearing its
    // visible selection. Keep the snapshot until focus returns or it is changed.
    if (doc.hasFocus()) publish(selectedTranscriptText(doc));
  };
  const onFocus = (event: FocusEvent) => {
    if ((event.target as Element | null)?.closest?.(EDITORS)) publish("");
    else onSelection();
  };
  const onContextMenu = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const root = target?.closest?.(TRANSCRIPTS);
    if (!root) return;
    const text = selectedTranscriptText(doc);
    publish(text);
    root.setAttribute("data-vscode-context", JSON.stringify(text ? {
      webviewSection: "transcript-selection",
      preventDefaultContextMenuItems: true,
      clawagentsSelectionText: text,
    } : { webviewSection: "transcript" }));
  };
  const onKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey
      || event.key.toLowerCase() !== "c" || event.defaultPrevented) return;
    const text = selectedTranscriptText(doc);
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    void copyText(text);
  };
  const onCopy = (event: ClipboardEvent) => {
    const text = selectedTranscriptText(doc);
    if (!text || event.defaultPrevented) return;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    void copyText(text);
  };
  doc.addEventListener("selectionchange", onSelection);
  doc.addEventListener("focusin", onFocus);
  doc.addEventListener("contextmenu", onContextMenu, true);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("copy", onCopy, true);
  return () => {
    doc.removeEventListener("selectionchange", onSelection);
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("contextmenu", onContextMenu, true);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("copy", onCopy, true);
    publish("");
  };
}
