import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  ChatMessage,
  FileContent,
  FileEntry,
  HealthReport,
  MessageBlock,
  McpServer,
  Project,
  QueueItem,
  Session,
  StreamEvent,
  TerminalEvent,
} from "@mobileagent/protocol";
import { launchArgs, type CatalogEntry } from "./catalog";
import { streamClaudeSdk } from "./claude-sdk";
import { HubError } from "./errors";
import { explainGrokFailure, streamGrok, type GrokTurn } from "./grok";
import { resolveInside } from "./paths";
import { createCliMapper } from "./stream-map";
import { blocksFromEvents } from "./text";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".mobileagent"]);
const SKIP_FILES = new Set([".env", ".env.local", "secrets.json"]);

export interface LiveSnapshot {
  sessions: Session[];
  messages: Record<string, ChatMessage[]>;
  queue: QueueItem[];
  /** Provider session ids (Claude Agent SDK) keyed by our session id. */
  externalIds?: Record<string, string>;
}

export interface LiveContext {
  workspacePath: string;
  cliPath: string;
  model: string;
  endpoint: string;
  env: NodeJS.ProcessEnv;
  locale: "zh" | "en";
}

interface LiveOptions {
  fast: boolean;
  onChange: () => void;
  initial?: LiveSnapshot | null;
  context: (providerId: string) => LiveContext;
}

export class LiveEngine {
  private state: LiveSnapshot;
  private readonly running = new Set<string>();

  constructor(
    private readonly metas: CatalogEntry[],
    private readonly options: LiveOptions,
  ) {
    this.state = options.initial ?? { sessions: [], messages: {}, queue: [] };
  }

  snapshot(): LiveSnapshot {
    return this.state;
  }

  projects(): Project[] {
    return this.metas.map((meta) => this.toProject(meta.id));
  }

  sessions(): Session[] {
    return [...this.state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  queue(): QueueItem[] {
    return [...this.state.queue];
  }

  mcp(): McpServer[] {
    return [];
  }

  async health(meta: CatalogEntry, ctx: LiveContext): Promise<HealthReport> {
    if (meta.id === "grok") return grokHealth(meta, ctx);
    const started = Date.now();
    const result = await collect(ctx.cliPath || meta.cli, ["--version"], ctx.env, ctx.workspacePath || process.cwd(), 4000);
    const missing = result.error?.includes("ENOENT") || result.error?.toLowerCase().includes("not found");
    if (missing || result.code === null && !result.stdout) {
      return {
        id: meta.id,
        state: "offline",
        latencyMs: null,
        version: null,
        messageKey: "health.missing",
        detail: ctx.cliPath || meta.cli,
        checkedAt: new Date().toISOString(),
      };
    }
    const version = (result.stdout || result.stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
    const latencyMs = Date.now() - started;
    return {
      id: meta.id,
      state: result.code === 0 ? (latencyMs > 1500 ? "degraded" : "healthy") : "degraded",
      latencyMs,
      version: version?.slice(0, 120) ?? null,
      messageKey: result.code === 0 ? "health.liveOk" : "health.liveBad",
      detail: version?.slice(0, 160) ?? "",
      checkedAt: new Date().toISOString(),
    };
  }

  messages(sessionId: string): ChatMessage[] {
    this.requireSession(sessionId);
    return this.state.messages[sessionId] ?? [];
  }

  createSession(providerId: string, projectId: string, title?: string): Session {
    if (projectId !== liveProjectId(providerId)) throw new HubError("unknown project", 404, "project");
    const session: Session = {
      id: `live_${providerId}_${Date.now().toString(36)}`,
      providerId,
      projectId,
      title: title?.trim() || "新会话",
      status: "idle",
      updatedAt: new Date().toISOString(),
      preview: "",
      messageCount: 0,
    };
    this.state.sessions.unshift(session);
    this.state.messages[session.id] = [];
    this.options.onChange();
    return session;
  }

  async *prompt(sessionId: string, prompt: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const text = prompt.trim();
    if (!text) throw new HubError("empty prompt", 400, "empty");
    const session = this.requireSession(sessionId);
    if (this.running.has(sessionId)) throw new HubError("session is busy", 409, "busy");
    const ctx = this.options.context(session.providerId);
    if (!ctx.workspacePath && session.providerId !== "grok") throw new HubError("workspace path is empty", 400, "workspace");
    this.running.add(sessionId);
    session.status = "running";
    const user: ChatMessage = {
      id: `${sessionId}_u_${Date.now().toString(36)}`,
      role: "user",
      createdAt: new Date().toISOString(),
      blocks: [{ type: "text", text }],
    };
    this.state.messages[sessionId] ??= [];
    this.state.messages[sessionId].push(user);
    session.preview = text.slice(0, 80);
    session.messageCount = this.state.messages[sessionId].length;
    this.options.onChange();
    const produced: StreamEvent[] = [];
    try {
      yield { type: "status", status: "running" };
      produced.push({ type: "status", status: "running" });
      for await (const event of this.turnEvents(session, text, ctx, signal)) {
        produced.push(event);
        yield event;
        if (event.type === "error") session.status = "error";
      }
      this.finishTurn(session, produced);
      if (session.status !== "error") {
        session.status = "idle";
        yield { type: "done" };
      }
    } catch (error) {
      session.status = "error";
      const message = explainCliError(error, ctx);
      produced.push({ type: "error", message });
      this.finishTurn(session, produced);
      yield { type: "error", message };
    } finally {
      if (session.status === "running") session.status = "idle";
      this.running.delete(sessionId);
      this.options.onChange();
    }
  }

  private async *turnEvents(session: Session, text: string, ctx: LiveContext, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (session.providerId === "grok") {
      yield* streamGrok({
        apiKey: ctx.env.XAI_API_KEY ?? "",
        model: ctx.model || "grok-4",
        endpoint: ctx.endpoint || "https://api.x.ai/v1",
        messages: grokTurns(this.state.messages[session.id] ?? []),
        locale: ctx.locale,
        signal,
      });
      return;
    }
    if (session.providerId === "claude-code") {
      let sdkMissing = false;
      for await (const event of streamClaudeSdk({
        prompt: text,
        cwd: ctx.workspacePath,
        model: ctx.model,
        apiKey: ctx.env.ANTHROPIC_API_KEY,
        env: ctx.env,
        resumeId: this.state.externalIds?.[session.id],
        locale: ctx.locale,
        signal,
        onSession: (id) => {
          this.state.externalIds ??= {};
          this.state.externalIds[session.id] = id;
        },
      })) {
        if (event.type === "status" && event.status === "sdk-missing") {
          sdkMissing = true;
          break;
        }
        yield event;
      }
      if (!sdkMissing) return;
    }
    const args = launchArgs(session.providerId, ctx.model, text);
    const mapper = createCliMapper();
    for await (const piece of streamProcess(ctx.cliPath, args, ctx.env, ctx.workspacePath, signal, 180_000)) {
      for (const event of mapper.push(piece)) yield event;
    }
    for (const event of mapper.flush()) yield event;
  }

  private finishTurn(session: Session, events: StreamEvent[]): void {
    const blocks = blocksForTurn(events);
    const message: ChatMessage = {
      id: `${session.id}_a_${Date.now().toString(36)}`,
      role: "assistant",
      createdAt: new Date().toISOString(),
      blocks,
    };
    this.state.messages[session.id].push(message);
    session.updatedAt = message.createdAt;
    session.messageCount = this.state.messages[session.id].length;
    const text = [...blocks].reverse().find((block) => block.type === "text");
    const preview = text && text.type === "text" ? text.text : blocks.map(blockPreview).join(" ");
    session.preview = preview.replace(/\s+/g, " ").slice(0, 80);
  }

  enqueue(sessionId: string, prompt: string): QueueItem {
    const text = prompt.trim();
    if (!text) throw new HubError("empty prompt", 400, "empty");
    const session = this.requireSession(sessionId);
    const item: QueueItem = {
      id: `q_${Date.now().toString(36)}`,
      providerId: session.providerId,
      sessionId,
      projectId: session.projectId,
      prompt: text,
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    this.state.queue.unshift(item);
    this.options.onChange();
    return item;
  }

  removeQueue(id: string): void {
    this.state.queue = this.state.queue.filter((item) => item.id !== id);
    this.options.onChange();
  }

  setQueueStatus(id: string, status: QueueItem["status"]): void {
    const item = this.state.queue.find((entry) => entry.id === id);
    if (!item) throw new HubError("unknown queue item", 404, "queue");
    item.status = status;
    this.options.onChange();
  }

  reorderQueue(ids: string[]): QueueItem[] {
    const map = new Map(this.state.queue.map((item) => [item.id, item]));
    const next: QueueItem[] = [];
    for (const id of ids) {
      const item = map.get(id);
      if (!item) continue;
      next.push(item);
      map.delete(id);
    }
    next.push(...map.values());
    this.state.queue = next;
    this.options.onChange();
    return this.queue();
  }

  files(providerId: string, dir: string): FileEntry[] {
    const root = this.requireRoot(providerId);
    const target = resolveInside(root, dir);
    const entries = readdirSync(target, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
      const full = path.join(target, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) out.push({ name: entry.name, path: rel, kind: "dir" });
      else if (entry.isFile()) {
        const size = statSync(full).size;
        out.push({ name: entry.name, path: rel, kind: "file", size, language: path.extname(entry.name).slice(1) || "text" });
      }
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  }

  file(providerId: string, filePath: string): FileContent {
    const base = path.basename(filePath);
    if (SKIP_FILES.has(base)) throw new HubError("refusing to read secrets", 403, "secret");
    const root = this.requireRoot(providerId);
    const target = resolveInside(root, filePath);
    const stat = statSync(target);
    if (!stat.isFile()) throw new HubError("not a file", 400, "file");
    if (stat.size > 200_000) throw new HubError("file is too large", 400, "file");
    const buffer = readFileSync(target);
    if (buffer.includes(0)) return { path: filePath, language: "binary", content: "(binary file)" };
    return { path: filePath, language: path.extname(filePath).slice(1) || "text", content: buffer.toString("utf8") };
  }

  commit(): never {
    throw new HubError("live commits are left to the agent CLI", 400, "live");
  }

  async *terminal(sessionId: string, command: string, signal: AbortSignal): AsyncGenerator<TerminalEvent> {
    const session = this.requireSession(sessionId);
    const ctx = this.options.context(session.providerId);
    if (!ctx.workspacePath) throw new HubError("workspace path is empty", 400, "workspace");
    const line = command.trim();
    if (!line) throw new HubError("empty command", 400, "empty");
    if (line.length > 2000 || line.includes("\0") || line.includes("\n")) {
      throw new HubError("command rejected", 400, "command");
    }
    yield { stream: "system", text: `$ ${line}` };
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", line] : ["-lc", line];
    try {
      for await (const piece of streamProcess(shell, args, ctx.env, ctx.workspacePath, signal, 20_000)) {
        yield { stream: "out", text: piece };
      }
    } catch (error) {
      yield { stream: "err", text: error instanceof Error ? error.message : "command failed" };
    }
  }

  private requireRoot(providerId: string): string {
    const ctx = this.options.context(providerId);
    if (!ctx.workspacePath) throw new HubError("workspace path is empty", 400, "workspace");
    return ctx.workspacePath;
  }

  private requireSession(sessionId: string): Session {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new HubError("unknown session", 404, "session");
    return session;
  }

  private toProject(providerId: string): Project {
    const ctx = this.options.context(providerId);
    const root = ctx.workspacePath;
    let files = 0;
    if (root) {
      try {
        files = this.files(providerId, "").length;
      } catch {
        files = 0;
      }
    }
    return {
      id: liveProjectId(providerId),
      providerId,
      workspaceId: "live",
      name: root ? path.basename(root) : "workspace",
      path: root,
      branch: "",
      summary: root ? "这台电脑上的目录" : "还没有选择电脑上的目录",
      language: "",
      updatedAt: new Date().toISOString(),
      changes: [],
      commits: [],
      stats: { files, loc: 0 },
    };
  }
}

export function liveProjectId(providerId: string): string {
  return `live__${providerId}`;
}

function blocksForTurn(events: StreamEvent[]): MessageBlock[] {
  const { blocks } = blocksFromEvents(events);
  const error = [...events].reverse().find((event) => event.type === "error");
  if (error && error.type === "error" && !blocks.some((block) => block.type === "text" && block.text.includes(error.message))) {
    blocks.push({ type: "text", text: error.message });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "(no output)" });
  return blocks;
}

function blockPreview(block: MessageBlock): string {
  if (block.type === "text" || block.type === "thinking") return block.text;
  return block.name;
}

function grokTurns(messages: ChatMessage[]): GrokTurn[] {
  const turns: GrokTurn[] = [];
  for (const message of messages) {
    const text = message.blocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n").trim();
    if (!text) continue;
    turns.push({ role: message.role, content: text });
  }
  return turns;
}

async function grokHealth(meta: CatalogEntry, ctx: LiveContext): Promise<HealthReport> {
  const key = ctx.env.XAI_API_KEY ?? "";
  if (!key) {
    return {
      id: meta.id,
      state: "offline",
      latencyMs: null,
      version: null,
      messageKey: "health.missing",
      detail: "XAI_API_KEY",
      checkedAt: new Date().toISOString(),
    };
  }
  const started = Date.now();
  const endpoint = (ctx.endpoint || "https://api.x.ai/v1").replace(/\/$/, "");
  try {
    const response = await fetch(`${endpoint}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        id: meta.id,
        state: "offline",
        latencyMs: Date.now() - started,
        version: null,
        messageKey: "health.liveBad",
        detail: explainGrokFailure({ status: response.status, locale: ctx.locale }),
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      id: meta.id,
      state: response.ok ? "healthy" : "degraded",
      latencyMs: Date.now() - started,
      version: null,
      messageKey: response.ok ? "health.liveOk" : "health.liveBad",
      detail: response.ok ? "api.x.ai" : `HTTP ${response.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      id: meta.id,
      state: "offline",
      latencyMs: null,
      version: null,
      messageKey: "health.liveBad",
      detail: explainGrokFailure({ error, locale: ctx.locale }),
      checkedAt: new Date().toISOString(),
    };
  }
}

function explainCliError(error: unknown, ctx: LiveContext): string {
  const raw = error instanceof Error ? error.message : "cli failed";
  const missing = raw.includes("ENOENT") || raw.toLowerCase().includes("not found");
  if (!missing) return raw;
  const cmd = ctx.cliPath;
  return ctx.locale === "en"
    ? `Cannot find ${cmd} on this PC. Install that CLI on the computer. The phone only forwards the prompt.`
    : `这台电脑上找不到 ${cmd}。请把这个 CLI 装在电脑上，手机只负责把指令转发过去。`;
}

function collect(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function* streamProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, timeoutMs: number): AsyncGenerator<string> {
  const child = spawn(cmd, args, { cwd, env, windowsHide: true });
  const queue: string[] = [];
  let done = false;
  let failure: Error | null = null;
  let notify: (() => void) | null = null;
  const wake = () => {
    notify?.();
    notify = null;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    queue.push(chunk);
    wake();
  });
  child.stderr?.on("data", (chunk: string) => {
    queue.push(chunk);
    wake();
  });
  child.on("error", (error) => {
    failure = error;
    done = true;
    wake();
  });
  child.on("close", (code) => {
    if (code && code !== 0) failure = new Error(`${cmd} exited ${code}`);
    done = true;
    wake();
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const onAbort = () => child.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!done || queue.length) {
      if (!queue.length) await new Promise<void>((resolve) => {
        notify = resolve;
      });
      while (queue.length) yield queue.shift() ?? "";
    }
    if (failure) throw failure;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
