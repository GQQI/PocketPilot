import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

/**
 * Voice input through the native Android recognizer (@capacitor-community/speech-recognition).
 * Web Speech is unreliable inside the Android WebView, so the browser API is not used.
 * Recognized text is only handed back to the caller; nothing is sent.
 */
type Plugin = typeof import("@capacitor-community/speech-recognition").SpeechRecognition;

let plugin: Promise<Plugin | null> | null = null;
function load(): Promise<Plugin | null> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  plugin ??= import("@capacitor-community/speech-recognition").then((m) => m.SpeechRecognition).catch(() => null);
  return plugin;
}

export async function voiceSupported(): Promise<boolean> {
  const p = await load();
  if (!p) return false;
  try { return (await p.available()).available; } catch { return false; }
}

export interface VoiceSession {
  stop(): Promise<void>;
}

/** Starts listening. `onText` gets the running transcript; `onEnd` fires once when listening stops. */
export async function startVoice(locale: "zh" | "en", onText: (text: string) => void, onEnd: (error?: string) => void): Promise<VoiceSession> {
  const p = await load();
  if (!p) throw new Error("unsupported");
  let perm = await p.checkPermissions();
  if (perm.speechRecognition !== "granted") perm = await p.requestPermissions();
  if (perm.speechRecognition !== "granted") throw new Error("permission");
  const handles: PluginListenerHandle[] = [];
  let ended = false;
  const finish = (error?: string) => {
    if (ended) return;
    ended = true;
    for (const h of handles) void h.remove();
    onEnd(error);
  };
  handles.push(await p.addListener("partialResults", (data: { matches?: string[] }) => { const t = data.matches?.[0]; if (t) onText(t); }));
  handles.push(await p.addListener("listeningState", (data: { status: "started" | "stopped" }) => { if (data.status === "stopped") finish(); }));
  p.start({ language: locale === "zh" ? "zh-CN" : "en-US", maxResults: 1, partialResults: true, popup: false })
    .then((r) => { const t = (r as { matches?: string[] } | undefined)?.matches?.[0]; if (t) onText(t); })
    .catch((e: unknown) => finish(e instanceof Error ? e.message : String(e)));
  return { stop: async () => { try { await p.stop(); } finally { finish(); } } };
}

/** Joins dictated text onto what was already typed (no space between CJK characters). */
export function joinDictation(before: string, spoken: string): string {
  if (!before) return spoken;
  if (!spoken) return before;
  const cjk = /[\u3000-\u9fff\uff00-\uffef]$/.test(before) || /^[\u3000-\u9fff\uff00-\uffef]/.test(spoken);
  return before + (cjk || /\s$/.test(before) ? "" : " ") + spoken;
}
