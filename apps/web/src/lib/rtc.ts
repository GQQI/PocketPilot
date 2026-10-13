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

export function readLink(): Link | null {
  return read();
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
  via: "" | "lan" | "rtc" | "ble";
  stage: "" | "lan" | "signal" | "offer" | "ice" | "ble";
  error: string;
  code: string;
  at: number;
}

let state: LinkState = { phase: "idle", via: "", stage: "", error: "", code: "", at: 0 };
const listeners = new Set<() => void>();

export function patchLink(patch: Partial<LinkState>) {
  set(patch);
}

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
export function newClient(target: RemoteTarget): RemoteClient {
  return new RemoteClient(target, {
    RTC: RTCPeerConnection,
    createBus: () => new MqttBus(),
    log: (message) => console.debug("[rtc]", message),
    onStage: (stage) => set({ stage }),
  });
}

export async function probeLanUrl(url: string, ms: number): Promise<boolean> {
  return probeUrl(url, ms);
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
export function findLan(link: Link): Promise<string> {
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

export function rememberLan(url: string) {
  const link = read();
  if (link) write({ ...link, lanLast: url });
}

export async function learnLan(fetchHost: () => Promise<Response | undefined>) {
  try {
    const response = await fetchHost();
    if (!response?.ok) return;
    const info = (await response.json()) as { urls?: string[] };
    const urls = (info.urls ?? []).filter((url) => !/\/\/(127\.|localhost)/.test(url));
    const link = read();
    if (link && urls.length > 0) write({ ...link, lan: urls });
  } catch {
    /* best effort */
  }
}

let resumeHook: () => void = () => undefined;
let forgetHook: () => void = () => undefined;

export function setLinkHooks(hooks: { resume?: () => void; forget?: () => void }) {
  if (hooks.resume) resumeHook = hooks.resume;
  if (hooks.forget) forgetHook = hooks.forget;
}

export function bearer(): string {
  return token();
}

export function rtcConfigured(): boolean {
  return read() !== null;
}

export function rtcHost(): string {
  return read()?.host ?? "";
}

export function forgetRtc() {
  forgetHook();
  set({ phase: "idle", via: "", stage: "", error: "", code: "" });
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    /* private mode */
  }
}

function resume() {
  if (!read()) return;
  resumeHook();
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
