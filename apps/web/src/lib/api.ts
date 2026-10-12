import type { AgentChatRequest, AgentTestResult, AgentProject, AgentSession, AgentsOverview, AgentStatus, AgentUsage, Bootstrap, ChatMessage, DeviceView, FsListing, HostView, PairResult, StreamEvent } from "@pocketpilot/protocol";

import { Capacitor } from "@capacitor/core";
import { migrateLegacyStorage } from "./legacy";
import { consumeSse } from "./sse";
import { forgetRtc, rtcConfigured, rtcFetch, rtcLanOrigin } from "./rtc";

migrateLegacyStorage();

const BRIDGE_KEY = "pocketpilot.bridge";
const TOKEN_KEY = "pocketpilot.token";
const DEVICE_ID_KEY = "pocketpilot.device";

function readStore(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStore(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

function resolve(path: string): string {
  const origin = readStore(BRIDGE_KEY).replace(/\/$/, "");
  return origin ? `${origin}${path}` : path;
}

function authHeaders(): HeadersInit {
  const token = readStore(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Uses the encrypted WebRTC tunnel when this phone was paired by QR, otherwise plain HTTP to the LAN bridge. */
function transport(path: string, init?: RequestInit): Promise<Response> {
  if (rtcConfigured()) return rtcFetch(path, init);
  // The Capacitor app has no host of its own: until a PC is paired, there is nothing to call.
  if (Capacitor.isNativePlatform() && !readStore(BRIDGE_KEY)) {
    return Promise.resolve(new Response(JSON.stringify({ error: "pairing required", code: "pair" }), { status: 401, headers: { "content-type": "application/json" } }));
  }
  return fetch(resolve(path), init);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const extra = authHeaders();
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  const response = await transport(path, { ...init, headers });
  if (!response.ok) throw await toError(response);
  return response.json() as Promise<T>;
}

async function toError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({}));
  const record = body as { error?: string; code?: string };
  return new ApiError(record.error || "request failed", response.status, record.code);
}

export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  host: () => request<HostView>("/api/host"),
  devices: () => request<DeviceView[]>("/api/devices"),
  revokeDevice: (id: string) => request<DeviceView[]>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listFs: (dir: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(dir)}`),
  pair: async (code: string, origin?: string) => {
    const previous = readStore(BRIDGE_KEY);
    if (origin !== undefined) writeStore(BRIDGE_KEY, origin.trim().replace(/\/$/, ""));
    try {
      const result = await request<PairResult>("/api/pair", json({ code, name: deviceName(), deviceId: stableDeviceId() }));
      writeStore(TOKEN_KEY, result.token);
      return result;
    } catch (error) {
      writeStore(BRIDGE_KEY, previous);
      throw error;
    }
  },
  deviceName,
  stableDeviceId,
  adoptToken: (token: string) => writeStore(TOKEN_KEY, token),
  remoteSession: () => request<{ url: string; expiresAt: number; qrSvg: string }>("/api/remote/session", { method: "POST" }),
  forgetHost: () => {
    forgetRtc();
    writeStore(BRIDGE_KEY, "");
    writeStore(TOKEN_KEY, "");
    // Keep pocketpilot.device so the same phone is recognized the next time it pairs.
  },
  saveSettings: (patch: unknown) => request<Bootstrap>("/api/settings", json(patch)),
  agents: (refresh = false) => request<AgentsOverview>(`/api/agents${refresh ? "?refresh=1" : ""}`),
  agentProjects: (id: string) => request<AgentProject[]>(`/api/agents/${id}/projects`),
  agentSessions: (id: string, project: string | undefined, limit: number) =>
    request<AgentSession[]>(`/api/agents/${id}/sessions?limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  agentMessages: (id: string, sid: string, limit: number) => request<ChatMessage[]>(`/api/agents/${id}/sessions/${encodeURIComponent(sid)}/messages?limit=${limit}`),
  agentUsage: (id: string, refresh = false) => request<AgentUsage>(`/api/agents/${id}/usage${refresh ? "?refresh=1" : ""}`),
  agentConfig: (id: string, patch: { cliPath?: string; model?: string; apiKey?: string }) => request<AgentStatus>(`/api/agents/${id}/config`, json(patch)),
  agentTest: (id: string) => request<AgentTestResult>(`/api/agents/${id}/test`, { method: "POST" }),
  agentChat: (id: string, req: AgentChatRequest, onEvent: (event: StreamEvent) => void, signal: AbortSignal) =>
    stream(`/api/agents/${id}/chat`, req, onEvent, signal),
  privacy: () => request<{ dataDir: string; keepHistory: boolean }>("/api/privacy"),
  setPrivacy: (body: { keepHistory?: boolean; clearHistory?: boolean }) => request<{ dataDir: string; keepHistory: boolean }>("/api/privacy", json(body)),
  hostFs: (dir: string) => request<FsListing>(`/api/host/fs?path=${encodeURIComponent(dir)}`),
};

/** Random id created once on this phone and kept across re-pairs. Not a stand-in for any particular device. */
export function stableDeviceId(): string {
  const existing = readStore(DEVICE_ID_KEY);
  if (/^pp_[0-9a-f]{32}$/.test(existing)) return existing;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = `pp_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  writeStore(DEVICE_ID_KEY, id);
  return id;
}

export function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const kind = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Browser";
  return `${kind} · ${stableDeviceId().slice(-4)}`;
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function stream(path: string, body: unknown, onEvent: (event: never) => void, signal: AbortSignal) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const extra = authHeaders();
  for (const [key, value] of Object.entries(extra)) headers[key] = value;
  const payload = JSON.stringify(body);
  const emit = (data: unknown) => onEvent(data as never);
  // Android WebView buffers fetch() until the response ends. XHR onprogress paints each SSE frame.
  const lan = rtcConfigured() ? await rtcLanOrigin() : null;
  if (rtcConfigured() && !lan) {
    const response = await transport(path, { method: "POST", headers, body: payload, signal });
    if (!response.ok) throw await toError(response);
    await readSse(response, emit);
    return;
  }
  if (Capacitor.isNativePlatform() && !rtcConfigured() && !readStore(BRIDGE_KEY)) {
    throw new ApiError("pairing required", 401, "pair");
  }
  await xhrSse(lan ? `${lan}${path}` : resolve(path), payload, headers, emit, signal);
}

async function readSse(response: Response, onEvent: (data: unknown) => void) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSse(buffer, onEvent);
  }
  consumeSse(buffer, onEvent, true);
}

function xhrSse(url: string, body: string, headers: Record<string, string>, onEvent: (data: unknown) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let cursor = 0;
    let buffer = "";
    const pump = (flush: boolean) => {
      buffer += xhr.responseText.slice(cursor);
      cursor = xhr.responseText.length;
      buffer = consumeSse(buffer, onEvent, flush);
    };
    xhr.open("POST", url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.onprogress = () => pump(false);
    xhr.onerror = () => reject(new ApiError("network", 0));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      pump(true);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(parseApiError(xhr.status, xhr.responseText));
    };
    const onAbort = () => xhr.abort();
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

function parseApiError(status: number, text: string): ApiError {
  try {
    const record = JSON.parse(text) as { error?: string; code?: string };
    return new ApiError(record.error || "request failed", status, record.code);
  } catch {
    return new ApiError(text.slice(0, 200) || "request failed", status);
  }
}
