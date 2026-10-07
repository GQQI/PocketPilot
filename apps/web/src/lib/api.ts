import type { Bootstrap, ChatMessage, FileContent, FileEntry, SessionCreated, StreamEvent, TerminalEvent } from "@mobileagent/protocol";

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
  const response = await fetch(path, init);
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
  const response = await fetch(path, { ...json(body), signal });
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
