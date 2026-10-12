import { useSyncExternalStore } from "react";
import { MqttBus, RemoteClient, RemoteError, type RemoteTarget } from "@pocketpilot/remote";
import { migrateLegacyStorage } from "./legacy";

migrateLegacyStorage();

const LINK_KEY = "pocketpilot.rtc";
const TOKEN_KEY = "pocketpilot.token";

interface Link {
  secret: string;
  host: string;
  /** LAN base URLs of the PC (http://ip:port), learned at pairing and refreshed after every successful connect */
  lan?: string[];
  lanLast?: string;
}

function read(): Link | null {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    return raw ? (JSON.parse(raw) as Link) : null;
  } catch {
    return null;
  }
}

function write(link: Link) {
  try {
    localStorage.setItem(LINK_KEY, JSON.stringify(link));
  } catch {
    /* private mode */
  }
}

function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

// ---------- observable link state (banner / skeleton in the UI) ----------
export type LinkPhase = "idle" | "connecting" | "connected" | "failed";
export interface LinkState {
  phase: LinkPhase;
  via: "" | "lan" | "rtc";
  stage: "" | "lan" | "signal" | "offer" | "ice";
  error: string;
  code: string;
  at: number;
}

let state: LinkState = { phase: "idle", via: "", stage: "", error: "", code: "", at: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<LinkState>) {
  state = { ...state, ...patch, at: Date.now() };
  for (const listener of listeners) listener();
  if (patch.phase === "connected" && typeof window !== "undefined") window.dispatchEvent(new Event("pocketpilot:link"));
}

export function linkState(): LinkState {
  return state;
}

export function useLinkState(): LinkState {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, () => state);
}

// ---------- connection ----------
let client: RemoteClient | null = null;
let lanBase = "";
let inflight: Promise<void> | null = null;

function newClient(target: RemoteTarget): RemoteClient {
  const created = new RemoteClient(target, {
    RTC: RTCPeerConnection,
    createBus: () => new MqttBus(),
    log: (message) => console.debug("[rtc]", message),
    onStage: (stage) => set({ stage }),
  });
  created.onClose = () => {
    if (client === created) {
      client = null;
      set({ phase: "idle", via: "", stage: "" });
    }
  };
  return created;
}

async function probeUrl(url: string, ms: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(`${url}/api/devices`, { headers: { authorization: `Bearer ${token()}` }, signal: controller.signal, cache: "no-store" });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Same Wi-Fi: try the saved LAN addresses in parallel; the first one that accepts our device token wins. */
function findLan(link: Link): Promise<string> {
  const urls = [...new Set([link.lanLast, ...(link.lan ?? [])].filter(Boolean) as string[])];
  if (urls.length === 0) return Promise.resolve("");
  return new Promise((resolve) => {
    let left = urls.length;
    for (const url of urls) {
      void probeUrl(url, 1500).then((ok) => {
        if (ok) resolve(url);
        else if (--left === 0) resolve("");
      });
    }
  });
}

async function learnLan() {
  try {
    const response = await client?.fetch("/api/host", { headers: { authorization: `Bearer ${token()}` } });
    if (!response?.ok) return;
    const info = (await response.json()) as { urls?: string[] };
    const urls = (info.urls ?? []).filter((url) => !/\/\/(127\.|localhost)/.test(url));
    const link = read();
    if (link && urls.length > 0) write({ ...link, lan: urls });
  } catch {
    /* best effort */
  }
}

function failure(error: unknown): { code: string; message: string } {
  return { code: error instanceof RemoteError ? error.code : "closed", message: error instanceof Error ? error.message : String(error) };
}

function markDead() {
  client?.close();
  client = null;
  lanBase = "";
  if (state.phase !== "connecting") set({ phase: "idle", via: "", stage: "" });
}

/** LAN first (no MQTT/WebRTC needed), then the encrypted WebRTC tunnel. Single-flight. */
export function connectLink(): Promise<void> {
  if (inflight) return inflight;
  const link = read();
  if (!link) return Promise.reject(new RemoteError("closed", "未配对"));
  set({ phase: "connecting", via: "", stage: "lan", error: "", code: "" });
  inflight = (async () => {
    const lan = await findLan(link);
    if (lan) {
      client?.close();
      client = null;
      lanBase = lan;
      write({ ...link, lanLast: lan });
      set({ phase: "connected", via: "lan", stage: "" });
      return;
    }
    lanBase = "";
    if (!client || !client.connected) {
      client?.close();
      client = newClient({ kind: "link", secret: link.secret });
    }
    try {
      await client.connect();
    } catch (error) {
      const f = failure(error);
      client?.close();
      client = null;
      set({ phase: "failed", via: "", stage: "", error: f.message, code: f.code });
      throw error;
    }
    set({ phase: "connected", via: "rtc", stage: "" });
    void learnLan();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** User pressed "retry": drop whatever is left of the old link and connect from scratch. */
export function retryLink(): Promise<void> {
  if (!inflight) markDead();
  return connectLink();
}

export function rtcConfigured(): boolean {
  return read() !== null;
}

/** LAN origin when the phone can reach the PC over HTTP. Null means the encrypted tunnel must carry the request. */
export async function rtcLanOrigin(): Promise<string | null> {
  if (!rtcConfigured()) return null;
  if (state.phase !== "connected") await connectLink();
  return state.via === "lan" && lanBase ? lanBase : null;
}

export function rtcHost(): string {
  return read()?.host ?? "";
}

export function forgetRtc() {
  client?.close();
  client = null;
  lanBase = "";
  set({ phase: "idle", via: "", stage: "", error: "", code: "" });
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    /* private mode */
  }
}

/** fetch() replacement: LAN HTTP when the PC is on the same network, otherwise the encrypted WebRTC channel. */
export async function rtcFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!read()) throw new RemoteError("closed", "未配对");
  if (state.phase !== "connected") {
    // parallel requests right after a failure share its error instead of each waiting out another attempt
    if (state.phase === "failed" && Date.now() - state.at < 1500) throw new RemoteError(state.code as RemoteError["code"], state.error);
    await connectLink();
  }
  const run = () => (state.via === "lan" && lanBase ? fetch(`${lanBase}${path}`, init) : (client as RemoteClient).fetch(path, init));
  try {
    return await run();
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    markDead();
    // only idempotent reads are replayed on a fresh link
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw error;
    await connectLink();
    return run();
  }
}

// ---------- app resume / network change: never reuse a dead PeerConnection ----------
async function resume() {
  if (!read()) return;
  if (state.phase === "connected") {
    const alive = state.via === "lan" ? await probeUrl(lanBase, 2500) : await (client?.probe(3000) ?? Promise.resolve(false));
    if (alive) return;
    markDead();
  }
  if (state.phase !== "connecting") void connectLink().catch(() => undefined);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void resume();
  });
  window.addEventListener("online", () => void resume());
}

/** Accepts a full pairing URL, a `#pair=...` fragment, or `sid.secret`. */
export function parsePairPayload(text: string): string | null {
  const match = /(?:#|^)pair=([\w-]+\.[\w-]+)/.exec(text.trim()) ?? /^([\w-]+\.[\w-]{40,})$/.exec(text.trim());
  return match ? match[1] : null;
}

export async function pairFromPayload(payload: string, deviceName: string, deviceId?: string): Promise<string> {
  const [sid, secret] = payload.split(".");
  if (!sid || !secret) throw new RemoteError("expired", "二维码无效");
  const pairing = newClient({ kind: "pair", sid, secret });
  try {
    const welcome = await pairing.pair(deviceName, deviceId);
    forgetRtc();
    write({ secret: welcome.linkSecret, host: welcome.host, lan: welcome.urls ?? [] });
    return welcome.token;
  } finally {
    pairing.close();
  }
}
