import { useSyncExternalStore } from "react";
import {
  b64uDecode,
  BleTransport,
  connectByPolicy,
  LanTransport,
  normalizePolicy,
  RemoteError,
  RtcTransport,
  type Transport,
  type TransportPolicy,
} from "@pocketpilot/remote";
import { bleAvailable, openBlePipe } from "./ble-phone";
import {
  bearer,
  findLan,
  learnLan,
  linkState,
  newClient,
  patchLink,
  probeLanUrl,
  readLink,
  rememberLan,
  rtcConfigured,
  setLinkHooks,
} from "./rtc";

function remoteCode(code: string): RemoteError["code"] {
  if (code === "signal" || code === "no-host" || code === "ice" || code === "expired" || code === "denied") return code;
  return "closed";
}

const PREF_KEY = "pocketpilot.transport";
let policy: TransportPolicy = normalizePolicy(null);
const prefListeners = new Set<() => void>();

function loadPolicy() {
  try {
    policy = normalizePolicy(JSON.parse(localStorage.getItem(PREF_KEY) || "null"));
  } catch {
    policy = normalizePolicy(null);
  }
}
loadPolicy();

export function readPolicy(): TransportPolicy {
  return policy;
}

export function writePolicy(next: TransportPolicy) {
  policy = normalizePolicy(next);
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(policy));
  } catch {
    /* private mode */
  }
  for (const listener of prefListeners) listener();
  if (rtcConfigured()) void retryLink().catch(() => undefined);
}

export function useTransportPolicy(): TransportPolicy {
  return useSyncExternalStore((cb) => {
    prefListeners.add(cb);
    return () => prefListeners.delete(cb);
  }, readPolicy);
}

let active: Transport | null = null;
let ble: BleTransport | null = null;
let inflight: Promise<void> | null = null;
let lastError = { code: "closed", message: "无法连接这台电脑" };

const lan = new LanTransport(
  async () => {
    const link = readLink();
    return link ? findLan(link) : "";
  },
  probeLanUrl,
  rememberLan,
);
const rtc = new RtcTransport(() => {
  const link = readLink();
  if (!link) throw new RemoteError("closed", "未配对");
  return newClient({ kind: "link", secret: link.secret });
});

function shutdown(keep?: Transport) {
  for (const transport of [lan, rtc, ble]) {
    if (!transport || transport === keep) continue;
    transport.onClose = null;
    transport.close();
  }
  if (ble && ble !== keep) ble = null;
  if (active && active !== keep) active = null;
}

function watch(transport: Transport) {
  transport.onClose = () => {
    if (active !== transport) return;
    active = null;
    if (linkState().phase === "connected") patchLink({ phase: "idle", via: "", stage: "" });
  };
}

function deviceId(): string {
  try {
    return localStorage.getItem("pocketpilot.device") || "phone";
  } catch {
    return "phone";
  }
}

export function connectLink(): Promise<void> {
  if (inflight) return inflight;
  if (!readLink()) return Promise.reject(new RemoteError("closed", "未配对"));
  patchLink({ phase: "connecting", via: "", stage: "", error: "", code: "" });
  inflight = (async () => {
    const chosen = readPolicy();
    const kind = await connectByPolicy(chosen, async (candidate) => {
      patchLink({ stage: candidate === "rtc" ? "signal" : candidate });
      shutdown();
      try {
        if (candidate === "lan") {
          await lan.connect();
          active = lan;
        } else if (candidate === "rtc") {
          await rtc.connect();
          active = rtc;
        } else if (!bleAvailable()) {
          if (chosen.mode === "ble") lastError = { code: "closed", message: "蓝牙连接仅在 Android 客户端可用" };
          return false;
        } else {
          const link = readLink();
          if (!link) return false;
          ble = new BleTransport({
            secret: b64uDecode(link.secret),
            deviceId: deviceId(),
            name: "Android",
            pipe: openBlePipe(),
          });
          await ble.connect();
          active = ble;
        }
        if (!active) return false;
        watch(active);
        return true;
      } catch (error) {
        lastError = {
          code: error instanceof RemoteError ? error.code : "closed",
          message: error instanceof Error ? error.message : String(error),
        };
        ble?.close();
        ble = null;
        active = null;
        return false;
      }
    });
    if (!kind || !active) {
      patchLink({ phase: "failed", via: "", stage: "", error: lastError.message, code: lastError.code });
      throw new RemoteError(remoteCode(lastError.code), lastError.message);
    }
    patchLink({ phase: "connected", via: kind, stage: "", error: "", code: "" });
    if (kind !== "lan") {
      const current = active;
      void learnLan(async () => {
        try {
          return await current.request("/api/host", { headers: { authorization: `Bearer ${bearer()}` } });
        } catch {
          return undefined;
        }
      });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function retryLink(): Promise<void> {
  if (!inflight) {
    shutdown();
    if (linkState().phase !== "connecting") patchLink({ phase: "idle", via: "", stage: "" });
  }
  return connectLink();
}

/** LAN origin when that transport is the one in use. Streaming prefers it over the encrypted tunnels. */
export async function linkedLanOrigin(): Promise<string | null> {
  if (!rtcConfigured()) return null;
  if (linkState().phase !== "connected") await connectLink();
  return linkState().via === "lan" && lan.origin ? lan.origin : null;
}

export async function activeFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!readLink()) throw new RemoteError("closed", "未配对");
  if (linkState().phase !== "connected" || !active) {
    const now = linkState();
    if (now.phase === "failed" && Date.now() - now.at < 1500) throw new RemoteError(remoteCode(now.code), now.error);
    await connectLink();
  }
  const run = () => {
    if (!active) throw new RemoteError("closed", "未连接");
    return active.request(path, init);
  };
  try {
    return await run();
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    shutdown();
    patchLink({ phase: "idle", via: "", stage: "" });
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw error;
    await connectLink();
    return run();
  }
}

async function resume() {
  if (!readLink()) return;
  if (linkState().phase === "connected" && active) {
    const alive = await active.probe(2500);
    if (alive) return;
    shutdown();
    patchLink({ phase: "idle", via: "", stage: "" });
  }
  if (linkState().phase !== "connecting") void connectLink().catch(() => undefined);
}

setLinkHooks({
  forget: () => shutdown(),
  resume: () => {
    void resume();
  },
});
