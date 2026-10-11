import type { AgentAuth, AgentChatRequest, AgentProject, AgentSession, AgentUsage, ChatMessage, KeySource, StreamEvent, UsageBucket } from "@pocketpilot/protocol";

export interface AgentCtx {
  /** cliPath from PocketPilot settings (defaults to the bare command name) */
  cliPath: string;
  model: string;
  /** environment for child processes: process.env plus a stored API key */
  env: NodeJS.ProcessEnv;
  keySource: KeySource;
  /** PocketPilot data dir (for its own records) */
  dataDir: string;
  locale: "zh" | "en";
}

export interface Detection {
  cliPath: string | null;
  version: string | null;
  hasHistory: boolean;
  auth: AgentAuth;
  dataPath: string;
  defaultModel?: string;
}

export interface LocalAgent {
  id: string;
  /** can list/read historical sessions */
  history: boolean;
  detect(ctx: AgentCtx): Promise<Detection>;
  sessions(ctx: AgentCtx): Promise<AgentSession[]>;
  /** extra projects known to the platform even without sessions (e.g. Cursor workspaces) */
  extraProjects(ctx: AgentCtx): Promise<string[]>;
  messages(sessionId: string, limit: number, ctx: AgentCtx): Promise<ChatMessage[]>;
  chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent>;
  usage(ctx: AgentCtx): Promise<AgentUsage>;
}

export const emptyBucket = (): UsageBucket => ({ inputTokens: 0, outputTokens: 0, cacheTokens: 0, requests: 0, costUsd: null });

export function unsupportedUsage(source: string, reason: string): AgentUsage {
  return { supported: false, reason, source, hasTokens: false, today: null, week: null, month: null, costEstimated: false, models: [], note: "", computedAt: new Date().toISOString() };
}

export type { AgentProject };
