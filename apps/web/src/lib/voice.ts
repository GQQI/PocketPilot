/** Device speech recognition. No cloud key: the browser or WebView talks to the OS recognizer. */

interface SpeechResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface SpeechEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResult>;
}

interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechCtor = new () => SpeechRec;

function ctor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return ctor() !== null;
}

/** Ask for the microphone, then release it so recognition can open it. */
export async function ensureMic(): Promise<"ok" | "denied" | "missing"> {
  if (!navigator.mediaDevices?.getUserMedia) return voiceSupported() ? "ok" : "missing";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "ok";
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    return voiceSupported() ? "ok" : "missing";
  }
}

export function startVoice(options: { lang: string; onText: (text: string, final: boolean) => void; onError: (code: string) => void; onEnd: () => void }): { stop: () => void } | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = options.lang;
  rec.continuous = false;
  rec.interimResults = true;
  rec.onresult = (event) => {
    let text = "";
    let final = false;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      text += event.results[i]?.[0]?.transcript ?? "";
      if (event.results[i]?.isFinal) final = true;
    }
    if (text) options.onText(text, final);
  };
  rec.onerror = (event) => options.onError(event.error || "error");
  rec.onend = () => options.onEnd();
  rec.start();
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}
