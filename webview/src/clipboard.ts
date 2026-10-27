import { hasVsCodeHost, post } from "./vscodeApi";

let nextRequestId = 0;

/** Webviews may deny browser clipboard access even after a button click. */
export async function copyText(text: string): Promise<boolean> {
  if (!hasVsCodeHost()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const requestId = `copy-${++nextRequestId}`;
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(ok);
    };
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "clipboard_result" && msg.requestId === requestId) {
        finish(msg.ok === true);
      }
    };
    const timer = window.setTimeout(() => finish(false), 10_000);
    window.addEventListener("message", onMessage);
    try {
      post({ type: "copy_text", requestId, text });
    } catch {
      finish(false);
    }
  });
}
