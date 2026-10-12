export const BUILTIN_PROVIDER_IDS = [
  "cursor",
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "deepseek-harness",
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
  | { type: "session"; id: string }
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
  remote?: boolean;
  pairingCode?: string;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  current: boolean;
}

export interface PairResult {
  token: string;
  device?: DeviceView;
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

/* ---- real local agent platforms (detected on the host PC) ---- */

export interface AgentAuth {
  state: "ok" | "missing" | "unknown";
  /** where the credential comes from: env | file | login | settings | cli | none (never the secret itself) */
  source: string;
  note: string;
}

export interface AgentStatus {
  id: string;
  name: string;
  vendor: string;
  monogram: string;
  accent: string;
  cli: string;
  /** CLI executable found on this PC */
  installed: boolean;
  cliPath: string | null;
  version: string | null;
  /** local session history found on this PC */
  hasHistory: boolean;
  /** installed or has history */
  detected: boolean;
  /** can actually run a prompt (CLI found) */
  available: boolean;
  auth: AgentAuth;
  defaultModel: string;
  models: string[];
  sessionCount: number;
  projectCount: number;
  canListSessions: boolean;
  keySource: KeySource;
  envKeys: string[];
  docsUrl: string;
  /** where this platform's local data was read from */
  dataPath: string;
  configuredCliPath: string;
  /** one-line install command for this platform on the host OS ("" = see docs) */
  /** last 4 chars of the API key in use ("" = none); the key itself never leaves the PC */
  keyLast4: string;
  installCmd: string;
  checkedAt: string;
}

export interface AgentsOverview {
  agents: AgentStatus[];
  detected: number;
  available: number;
  total: number;
}

export interface AgentProject {
  path: string;
  name: string;
  sessions: number;
  updatedAt: string;
  exists: boolean;
}

export interface AgentSession {
  id: string;
  agentId: string;
  title: string;
  projectPath: string;
  projectName: string;
  updatedAt: string;
  /** -1 = not counted for this entry */
  messageCount: number;
  preview: string;
  source: string;
}

export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  requests: number;
  costUsd: number | null;
}

export interface UsageDay {
  /** YYYY-MM-DD in the PC's local time */
  date: string;
  tokens: number;
  requests: number;
  costUsd: number | null;
}

export interface AgentUsage {
  supported: boolean;
  /** why not supported / what is missing */
  reason: string;
  source: string;
  /** token counts exist (false = only request counts) */
  hasTokens: boolean;
  today: UsageBucket | null;
  week: UsageBucket | null;
  month: UsageBucket | null;
  costEstimated: boolean;
  /** last 7 days, oldest first (local dates) */
  daily?: UsageDay[];
  models: string[];
  note: string;
  computedAt: string;
}

export interface AgentChatRequest {
  sessionId?: string;
  cwd: string;
  prompt: string;
  model?: string;
}

/** Result of a "test connection" (login status / key check) for one platform. */
export interface AgentTestResult {
  ok: boolean;
  message: string;
}
