export const BUILTIN_PROVIDER_IDS = [
  "cursor",
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "deepseek-harness",
  "grok",
  "trae-cn",
] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

export function isBuiltinProviderId(value: string): value is BuiltinProviderId {
  return (BUILTIN_PROVIDER_IDS as readonly string[]).includes(value);
}

export type HealthState = "healthy" | "degraded" | "offline" | "standby";

export type SessionStatus = "idle" | "running" | "error";

export interface ProviderMeta {
  id: string;
  name: string;
  vendor: string;
  cli: string;
  defaultModel: string;
  models: string[];
  endpoint: string;
  envKeys: string[];
  docsUrl: string;
  accent: string;
  monogram: string;
}

export interface ProviderConfig {
  enabled: boolean;
  model: string;
  cliPath: string;
  endpoint: string;
}

export type ThemeMode = "light" | "dark";

export interface Settings {
  locale: "zh" | "en";
  theme: ThemeMode;
  demoMode: boolean;
  activeProviderId: string;
  workspacePath: string;
  providers: Record<string, ProviderConfig>;
}

export interface HealthReport {
  id: string;
  state: HealthState;
  latencyMs: number | null;
  version: string | null;
  messageKey: string;
  detail: string;
  checkedAt: string;
}

export type KeySource = "none" | "env" | "file";

export interface ProviderView {
  meta: ProviderMeta;
  config: ProviderConfig;
  health: HealthReport;
  keySource: KeySource;
  mcp: McpServer[];
}

export interface GitChange {
  path: string;
  status: "M" | "A" | "D";
}

export interface CommitRecord {
  id: string;
  message: string;
  createdAt: string;
}

export interface Project {
  id: string;
  providerId: string;
  workspaceId: string;
  name: string;
  path: string;
  branch: string;
  summary: string;
  language: string;
  updatedAt: string;
  changes: GitChange[];
  commits: CommitRecord[];
  stats: { files: number; loc: number };
}

export interface Session {
  id: string;
  providerId: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  updatedAt: string;
  preview: string;
  messageCount: number;
}

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; detail: string; status: "running" | "done" | "error" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  blocks: MessageBlock[];
  tokens?: { input: number; output: number };
}

export type StreamEvent =
  | { type: "status"; status: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; phase: "start" | "done"; name: string; detail: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done" }
  | { type: "error"; message: string };

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  language?: string;
}

export interface FileContent {
  path: string;
  language: string;
  content: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  demo: boolean;
}

export interface HostView {
  name: string;
  platform: string;
  port: number;
  urls: string[];
  workspacePath: string;
  demoMode: boolean;
  paired: boolean;
  loopback: boolean;
  pairingCode?: string;
}

export interface PairResult {
  token: string;
  host: HostView;
}

export interface QueueItem {
  id: string;
  providerId: string;
  sessionId: string;
  projectId: string;
  prompt: string;
  status: "waiting" | "running" | "done" | "failed";
  createdAt: string;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
}

export interface TerminalEvent {
  stream: "out" | "err" | "system";
  text: string;
}

/** Hardware/system back: leave the app only from home. Every other route returns home. */
export type BackAction = { type: "exit" } | { type: "home" };

export function backAction(pathname: string): BackAction {
  const path = pathname.split("?")[0]?.split("#")[0]?.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "") return { type: "exit" };
  return { type: "home" };
}

/** Parse one SSE buffer. Returns the incomplete tail. Ignores non-JSON keepalive frames. */
export function consumeSse(buffer: string, onEvent: (data: unknown) => void): string {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((item) => item.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* keepalive or a partial frame that was split incorrectly */
    }
  }
  return rest;
}

export interface Bootstrap {
  settings: Settings;
  providers: ProviderView[];
  projects: Project[];
  sessions: Session[];
  queue: QueueItem[];
}

export interface SessionCreated {
  session: Session;
  bootstrap: Bootstrap;
}
