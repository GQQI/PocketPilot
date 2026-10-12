import { consumeSse, type Bootstrap, type ChatMessage, type FileContent, type FileEntry, type FsListing, type HostView, type PairResult, type SessionCreated, type StreamEvent, type TerminalEvent } from "@mobileagent/protocol";

const BRIDGE_KEY = "mobileagent.bridge";
const TOKEN_KEY = "mobileagent.token";

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
  const response = await fetch(resolve(path), { ...init, headers });
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
  listFs: (dir: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(dir)}`),
  pair: async (code: string, origin?: string) => {
    const previous = readStore(BRIDGE_KEY);
    if (origin !== undefined) writeStore(BRIDGE_KEY, origin.trim().replace(/\/$/, ""));
    try {
      const result = await request<PairResult>("/api/pair", json({ code }));
      writeStore(TOKEN_KEY, result.token);
      return result;
    } catch (error) {
      writeStore(BRIDGE_KEY, previous);
      throw error;
    }
  },
  forgetHost: () => {
    writeStore(BRIDGE_KEY, "");
    writeStore(TOKEN_KEY, "");
  },
  saveSettings: (patch: unknown) => request<Bootstrap>("/api/settings", json(patch)),
  setSecret: (id: string, apiKey: string) => request<Bootstrap>(`/api/providers/${id}/secret`, json({ apiKey })),
  clearSecret: (id: string) => request<Bootstrap>(`/api/providers/${id}/secret`, { method: "DELETE" }),
  probeAll: () => request<Bootstrap>("/api/probe", { method: "POST" }),
  resetDemo: () => request<Bootstrap>("/api/demo/reset", { method: "POST" }),
  createSession: (providerId: string, projectId: string, title?: string) =>
    request<SessionCreated>("/api/sessions", json({ providerId, projectId, title })),
  messages: (sessionId: string) => request<ChatMessage[]>(`/api/sessions/${sessionId}/messages`),
  files: (projectId: string, dir: string) => request<FileEntry[]>(`/api/projects/${projectId}/files?path=${encodeURIComponent(dir)}`),
  file: (projectId: string, filePath: string) => request<FileContent>(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`),
  commit: (projectId: string, message: string) => request<Bootstrap>(`/api/projects/${projectId}/commit`, json({ message })),
  enqueue: (sessionId: string, prompt: string) => request<Bootstrap>("/api/queue", json({ sessionId, prompt })),
  removeQueue: (id: string) => request<Bootstrap>(`/api/queue/${id}`, { method: "DELETE" }),
  reorderQueue: (ids: string[]) => request<Bootstrap>("/api/queue/reorder", json({ ids })),
  toggleMcp: (providerId: string, mcpId: string, enabled: boolean) =>
    request<Bootstrap>(`/api/providers/${providerId}/mcp/${mcpId}`, json({ enabled })),
  prompt: (sessionId: string, prompt: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) =>
    stream(`/api/sessions/${sessionId}/prompt`, { prompt }, onEvent, signal),
  terminal: (sessionId: string, command: string, onEvent: (event: TerminalEvent) => void, signal: AbortSignal) =>
    stream(`/api/sessions/${sessionId}/terminal`, { command }, onEvent, signal),
  runQueue: (id: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) =>
    stream(`/api/queue/${id}/run`, {}, onEvent, signal),
};

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function stream(path: string, body: unknown, onEvent: (event: never) => void, signal: AbortSignal) {
  await readSseXhr(resolve(path), body, (data) => onEvent(data as never), signal);
}

/**
 * XMLHttpRequest onprogress delivers SSE chunks on Android WebView.
 * fetch() there often buffers the body until the response ends, so the phone
 * only saw the final message.
 */
function readSseXhr(url: string, body: unknown, onEvent: (data: unknown) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/json");
    const extra = authHeaders();
    for (const [key, value] of Object.entries(extra)) xhr.setRequestHeader(key, value);
    let seen = 0;
    let rest = "";
    let settled = false;
    const pump = () => {
      const chunk = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      if (!chunk) return;
      rest = consumeSse(rest + chunk, onEvent);
    };
    xhr.onprogress = pump;
    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.LOADING || xhr.readyState === XMLHttpRequest.DONE) pump();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      pump();
      rest = consumeSse(`${rest}\n\n`, onEvent);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolvePromise();
        return;
      }
      let record: { error?: string; code?: string } = {};
      try {
        record = JSON.parse(xhr.responseText) as { error?: string; code?: string };
      } catch {
        record = {};
      }
      reject(new ApiError(record.error || "request failed", xhr.status || 0, record.code));
    };
    xhr.onload = finish;
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new ApiError("request failed", xhr.status || 0));
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(JSON.stringify(body));
  });
}
