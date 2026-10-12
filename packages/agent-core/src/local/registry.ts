import type { AgentTestResult } from "@pocketpilot/protocol";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentProject, AgentsOverview, AgentStatus, AgentUsage, ChatMessage, StreamEvent, AgentChatRequest, AgentSession } from "@pocketpilot/protocol";
import { CATALOG as BUILTIN, LOCAL_ONLY } from "../catalog";
import type { ProviderMeta } from "@pocketpilot/protocol";
import { HubError } from "../errors";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { cursorAgent } from "./cursor";
import { cliOnlyAgents } from "./others";
import { grokAgent, traeAgent } from "./more";
import type { AgentCtx, LocalAgent } from "./types";
import { dedupeSessions } from "./dedupe";
import { baseName, normPath, isDir } from "./util";

const CATALOG: ProviderMeta[] = [...BUILTIN, ...LOCAL_ONLY];
const AGENTS: LocalAgent[] = [cursorAgent, claudeAgent, codexAgent, ...cliOnlyAgents, traeAgent, grokAgent];

const INSTALL: Record<string, { win: string; unix: string }> = {
  cursor: { win: "irm 'https://cursor.com/install?win32=true' | iex", unix: "curl https://cursor.com/install -fsS | bash" },
  "claude-code": { win: "npm install -g @anthropic-ai/claude-code", unix: "npm install -g @anthropic-ai/claude-code" },
  codex: { win: "npm install -g @openai/codex", unix: "npm install -g @openai/codex" },
  gemini: { win: "npm install -g @google/gemini-cli", unix: "npm install -g @google/gemini-cli" },
  opencode: { win: "npm install -g opencode-ai", unix: "npm install -g opencode-ai" },
  grok: { win: "irm https://x.ai/cli/install.ps1 | iex", unix: "curl -fsSL https://x.ai/cli/install.sh | bash" },
};

export type CtxFactory = (id: string) => AgentCtx;

/** Facade over every platform adapter: real detection, history, projects, chat and usage. Nothing here is demo data. */
export class LocalAgents {
  private detectCache = new Map<string, { at: number; value: AgentStatus }>();
  private sessionCache = new Map<string, { at: number; value: AgentSession[] }>();
  private usageCache = new Map<string, { at: number; value: AgentUsage }>();

  constructor(private readonly ctxFor: CtxFactory) {}

  private agent(id: string): LocalAgent {
    const found = AGENTS.find((a) => a.id === id);
    if (!found) throw new HubError("unknown platform", 404, "agent");
    return found;
  }

  async overview(force = false): Promise<AgentsOverview> {
    const all = await Promise.all(CATALOG.map((meta) => this.status(meta.id, force)));
    // every adapted platform is listed, installed or not, so the phone can show its status and how to set it up
    return { agents: all, detected: all.filter((a) => a.detected).length, available: all.filter((a) => a.available).length, total: CATALOG.length };
  }

  async status(id: string, force = false): Promise<AgentStatus> {
    const hit = this.detectCache.get(id);
    if (!force && hit && Date.now() - hit.at < 30_000) return hit.value;
    const meta = CATALOG.find((m) => m.id === id);
    if (!meta) throw new HubError("unknown platform", 404, "agent");
    const agent = this.agent(id);
    const ctx = this.ctxFor(id);
    const detection = await agent.detect(ctx);
    let sessionCount = 0;
    let projectCount = 0;
    if (agent.history && detection.hasHistory) {
      const sessions = await this.allSessions(id, force);
      sessionCount = sessions.length;
      projectCount = (await this.projects(id)).length;
    }
    const installed = detection.cliPath !== null;
    const value: AgentStatus = {
      id,
      name: meta.name,
      vendor: meta.vendor,
      monogram: meta.monogram,
      accent: meta.accent,
      cli: meta.cli,
      installed,
      cliPath: detection.cliPath,
      version: detection.version,
      hasHistory: detection.hasHistory,
      detected: installed || detection.hasHistory || detection.seen === true,
      available: installed,
      auth: detection.auth,
      defaultModel: ctx.model || detection.defaultModel || meta.defaultModel,
      models: detection.models && detection.models.length ? detection.models : [...meta.models],
      sessionCount,
      projectCount,
      canListSessions: agent.history,
      keySource: ctx.keySource,
      envKeys: [...meta.envKeys],
      docsUrl: meta.docsUrl,
      dataPath: detection.dataPath,
      configuredCliPath: ctx.cliPath,
      keyLast4: ctx.keySource !== "none" ? (meta.envKeys.map((k) => ctx.env[k]).find(Boolean) ?? "").slice(-4) : "",
      installCmd: INSTALL[id]?.[process.platform === "win32" ? "win" : "unix"] ?? "",
      checkedAt: new Date().toISOString(),
      ...(detection.historyNote ? { historyNote: detection.historyNote } : {}),
    };
    this.detectCache.set(id, { at: Date.now(), value });
    return value;
  }

  /** "Test connection": the platform's own check when it has one, otherwise its detected auth state. */
  async test(id: string): Promise<AgentTestResult> {
    const agent = this.agent(id);
    const ctx = this.ctxFor(id);
    this.invalidate(id);
    const status = await this.status(id, true);
    try {
      if (agent.test) return await agent.test(ctx, status.cliPath);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const zh = ctx.locale !== "en";
    if (!status.available) return { ok: false, message: zh ? "没有找到可运行的命令行/接口，请先安装或配置。" : "Nothing runnable was found. Install or configure it first." };
    return { ok: status.auth.state === "ok", message: status.auth.note || (status.auth.state === "ok" ? (zh ? "已就绪" : "Ready") : (zh ? "尚未登录或未配置密钥" : "Not signed in / no key")) };
  }

  invalidate(id?: string): void {
    if (id) {
      this.detectCache.delete(id);
      this.sessionCache.delete(id);
    } else {
      this.detectCache.clear();
      this.sessionCache.clear();
    }
  }

  private async allSessions(id: string, force = false): Promise<AgentSession[]> {
    const hit = this.sessionCache.get(id);
    if (!force && hit && Date.now() - hit.at < 8000) return hit.value;
    const value = dedupeSessions(await this.agent(id).sessions(this.ctxFor(id)));
    value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.sessionCache.set(id, { at: Date.now(), value });
    return value;
  }

  async sessions(id: string, project: string | undefined, limit: number): Promise<AgentSession[]> {
    const all = await this.allSessions(id);
    const filtered = project ? all.filter((s) => normPath(s.projectPath) === normPath(project)) : all;
    return filtered.slice(0, limit);
  }

  async projects(id: string): Promise<AgentProject[]> {
    const agent = this.agent(id);
    const sessions = await this.allSessions(id);
    const map = new Map<string, AgentProject>();
    for (const s of sessions) {
      if (!s.projectPath) continue;
      const key = normPath(s.projectPath);
      const cur = map.get(key);
      if (cur) {
        cur.sessions += 1;
        if (s.updatedAt > cur.updatedAt) cur.updatedAt = s.updatedAt;
      } else {
        map.set(key, { path: s.projectPath, name: baseName(s.projectPath), sessions: 1, updatedAt: s.updatedAt, exists: isDir(s.projectPath) });
      }
    }
    for (const p of await agent.extraProjects(this.ctxFor(id))) {
      const key = normPath(p);
      if (!map.has(key)) map.set(key, { path: p, name: baseName(p), sessions: 0, updatedAt: "", exists: isDir(p) });
    }
    return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  }

  messages(id: string, sessionId: string, limit: number): Promise<ChatMessage[]> {
    return this.agent(id).messages(sessionId, limit, this.ctxFor(id));
  }

  async usage(id: string, force = false): Promise<AgentUsage> {
    const hit = this.usageCache.get(id);
    if (!force && hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await this.agent(id).usage(this.ctxFor(id));
    this.usageCache.set(id, { at: Date.now(), value });
    return value;
  }

  async *chat(id: string, req: AgentChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const agent = this.agent(id);
    const ctx = this.ctxFor(id);
    const prompt = (req.prompt ?? "").trim();
    if (!prompt) throw new HubError("empty prompt", 400, "empty");
    const cwd = req.cwd?.trim();
    if (!cwd || !path.isAbsolute(cwd) || !existsSync(cwd) || !isDir(cwd)) {
      yield { type: "error", message: ctx.locale === "en" ? `Project folder not found on this PC: ${cwd || "(empty)"}` : `电脑上找不到这个项目目录：${cwd || "（未选择）"}` };
      return;
    }
    // Open the SSE response before detection. A cold `cursor-agent status` / `--list-models` used to run first, so the phone sat on a blank turn.
    yield { type: "status", status: ctx.locale === "en" ? "Running on your PC…" : "正在电脑上运行…" };
    let status = await this.status(id);
    if (!status.cliPath) status = await this.status(id, true);
    if (!status.cliPath) {
      const meta = CATALOG.find((m) => m.id === id);
      yield {
        type: "error",
        message: ctx.locale === "en"
          ? `${meta?.name ?? id}: command "${meta?.cli}" was not found on this PC. Install it (${meta?.docsUrl}) or set its path in Settings.`
          : `${meta?.name ?? id}：电脑上没有找到命令行 "${meta?.cli}"，无法发送。请先安装（${meta?.docsUrl}），或在设置里填写它的路径。`,
      };
      return;
    }
    try {
      yield* agent.chat({ ...req, prompt, cwd, model: req.model || ctx.model || undefined }, status.cliPath, ctx, signal);
    } finally {
      this.sessionCache.delete(id);
    }
  }
}

export { normPath };
