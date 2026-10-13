import type { AgentTestResult } from "@pocketpilot/protocol";
import type { UsageDay, AgentAuth, AgentChatRequest, AgentProject, AgentSession, AgentUsage, ChatMessage, KeySource, StreamEvent, UsageBucket } from "@pocketpilot/protocol";

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
  /** models reported by the platform itself (e.g. `cursor-agent --list-models`) */
  models?: string[];
  /** Shown when the app is present but its chats cannot be read. */
  historyNote?: string;
  /** The product's data dir exists, even when chats are unreadable. */
  seen?: boolean;
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
  /** optional: start a logged-in resident process before the first message */
  warm?(ctx: AgentCtx, cli: string): void;
  /** optional lightweight "test connection" (login status / key check) */
  test?(ctx: AgentCtx, cli: string | null): Promise<AgentTestResult>;
}

export const emptyBucket = (): UsageBucket => ({ inputTokens: 0, outputTokens: 0, cacheTokens: 0, requests: 0, costUsd: null });

export function unsupportedUsage(source: string, reason: string): AgentUsage {
  return { supported: false, reason, source, hasTokens: false, today: null, week: null, month: null, costEstimated: false, models: [], note: "", computedAt: new Date().toISOString() };
}

export type { AgentProject };

const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Collects per-day totals; `list()` returns the last 7 local days, oldest first, zero-filled. */
export function dailyTotals() {
  const map = new Map<string, UsageDay>();
  return {
    add(ts: number, tokens: number, requests: number, cost: number | null) {
      const k = dayKey(ts);
      const cur = map.get(k) ?? { date: k, tokens: 0, requests: 0, costUsd: null };
      cur.tokens += tokens;
      cur.requests += requests;
      if (cost !== null) cur.costUsd = (cur.costUsd ?? 0) + cost;
      map.set(k, cur);
    },
    list(): UsageDay[] {
      const out: UsageDay[] = [];
      const now = Date.now();
      for (let i = 6; i >= 0; i--) {
        const k = dayKey(now - i * 86400000);
        out.push(map.get(k) ?? { date: k, tokens: 0, requests: 0, costUsd: null });
      }
      return out;
    },
  };
}
