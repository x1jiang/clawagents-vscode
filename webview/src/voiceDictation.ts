/** Browser Web Speech API dictation → composer draft. */

export type DictationCallbacks = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: Event & { error?: string }) => void) | null;
  onresult: ((ev: Event & { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechRecognitionAvailable(): boolean {
  return getSpeechRecognitionCtor() != null;
}

export class VoiceDictation {
  private rec: SpeechRecognitionLike | null = null;
  private running = false;
  private lang: string;

  constructor(lang = "en-US") {
    this.lang = lang;
  }

  get active(): boolean {
    return this.running;
  }

  setLanguage(lang: string) {
    this.lang = lang || "en-US";
  }

  start(cb: DictationCallbacks): boolean {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      cb.onError?.("Speech recognition is not available in this webview.");
      return false;
    }
    this.stop();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onstart = () => {
      this.running = true;
      cb.onStart?.();
    };
    rec.onend = () => {
      this.running = false;
      this.rec = null;
      cb.onEnd?.();
    };
    rec.onerror = (ev) => {
      const code = String(ev.error || "error");
      if (code === "aborted" || code === "no-speech") {
        return;
      }
      cb.onError?.(
        code === "not-allowed"
          ? "Microphone permission denied — allow mic access for VS Code / Cursor."
          : `Dictation error: ${code}`,
      );
    };
    rec.onresult = (ev) => {
      let interim = "";
      let finals = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const row = ev.results[i];
        const piece = row?.[0]?.transcript || "";
        if (row.isFinal) {
          finals += piece;
        } else {
          interim += piece;
        }
      }
      if (interim) cb.onInterim?.(interim);
      if (finals) cb.onFinal?.(finals);
    };
    this.rec = rec;
    try {
      rec.start();
      return true;
    } catch (err) {
      cb.onError?.(err instanceof Error ? err.message : String(err));
      this.running = false;
      this.rec = null;
      return false;
    }
  }

  stop() {
    if (!this.rec) {
      this.running = false;
      return;
    }
    try {
      this.rec.onresult = null;
      this.rec.onerror = null;
      this.rec.stop();
    } catch {
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
    }
    this.rec = null;
    this.running = false;
  }

  toggle(cb: DictationCallbacks): boolean {
    if (this.running) {
      this.stop();
      cb.onEnd?.();
      return false;
    }
    return this.start(cb);
  }
}
