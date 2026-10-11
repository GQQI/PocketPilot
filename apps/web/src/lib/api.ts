import type { AgentChatRequest, AgentProject, AgentSession, AgentsOverview, AgentStatus, AgentUsage, Bootstrap, ChatMessage, DeviceView, FsListing, HostView, PairResult, StreamEvent } from "@pocketpilot/protocol";

import { Capacitor } from "@capacitor/core";
import { migrateLegacyStorage } from "./legacy";
import { forgetRtc, rtcConfigured, rtcFetch } from "./rtc";

migrateLegacyStorage();

const BRIDGE_KEY = "pocketpilot.bridge";
const TOKEN_KEY = "pocketpilot.token";

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
      const result = await request<PairResult>("/api/pair", json({ code, name: deviceName() }));
      writeStore(TOKEN_KEY, result.token);
      return result;
    } catch (error) {
      writeStore(BRIDGE_KEY, previous);
      throw error;
    }
  },
  deviceName,
  adoptToken: (token: string) => writeStore(TOKEN_KEY, token),
  remoteSession: () => request<{ url: string; expiresAt: number; qrSvg: string }>("/api/remote/session", { method: "POST" }),
  forgetHost: () => {
    forgetRtc();
    writeStore(BRIDGE_KEY, "");
    writeStore(TOKEN_KEY, "");
  },
  saveSettings: (patch: unknown) => request<Bootstrap>("/api/settings", json(patch)),
  agents: (refresh = false) => request<AgentsOverview>(`/api/agents${refresh ? "?refresh=1" : ""}`),
  agentProjects: (id: string) => request<AgentProject[]>(`/api/agents/${id}/projects`),
  agentSessions: (id: string, project: string | undefined, limit: number) =>
    request<AgentSession[]>(`/api/agents/${id}/sessions?limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  agentMessages: (id: string, sid: string, limit: number) => request<ChatMessage[]>(`/api/agents/${id}/sessions/${encodeURIComponent(sid)}/messages?limit=${limit}`),
  agentUsage: (id: string, refresh = false) => request<AgentUsage>(`/api/agents/${id}/usage${refresh ? "?refresh=1" : ""}`),
  agentConfig: (id: string, patch: { cliPath?: string; model?: string; apiKey?: string }) => request<AgentStatus>(`/api/agents/${id}/config`, json(patch)),
  agentChat: (id: string, req: AgentChatRequest, onEvent: (event: StreamEvent) => void, signal: AbortSignal) =>
    stream(`/api/agents/${id}/chat`, req, onEvent, signal),
  privacy: () => request<{ dataDir: string; keepHistory: boolean }>("/api/privacy"),
  setPrivacy: (body: { keepHistory?: boolean; clearHistory?: boolean }) => request<{ dataDir: string; keepHistory: boolean }>("/api/privacy", json(body)),
  hostFs: (dir: string) => request<FsListing>(`/api/host/fs?path=${encodeURIComponent(dir)}`),
};

export function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const kind = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Browser";
  return `${kind} ${new Date().toLocaleDateString()}`;
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function stream(path: string, body: unknown, onEvent: (event: never) => void, signal: AbortSignal) {
  const headers = new Headers(json(body).headers);
  const extra = authHeaders();
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  const response = await transport(path, { ...json(body), headers, signal });
  if (!response.ok) throw await toError(response);
  await readSse(response, (data) => onEvent(data as never));
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
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}
