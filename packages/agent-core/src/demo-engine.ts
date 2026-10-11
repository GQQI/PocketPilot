import type {
  ChatMessage,
  FileContent,
  FileEntry,
  HealthReport,
  McpServer,
  Project,
  QueueItem,
  Session,
  TerminalEvent,
} from "@pocketpilot/protocol";
import type { CatalogEntry } from "./catalog";
import { HubError } from "./errors";
import {
  PROJECT_TEMPLATES,
  SEED_VERSION,
  WORKSPACES,
  buildSeed,
  countLines,
  workspaceById,
  type DemoSnapshot,
  type ProjectTemplate,
} from "./seed";
import { blocksFromEvents, buildPlan, delayFor } from "./text";

export interface EngineOptions {
  fast: boolean;
  onChange: () => void;
  initial?: DemoSnapshot | null;
}

function languageOf(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "ts";
  if (filePath.endsWith(".py")) return "py";
  if (filePath.endsWith(".md")) return "md";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".toml")) return "toml";
  return "text";
}

function listDir(files: { path: string; content: string }[], dir: string): FileEntry[] {
  const prefix = dir && dir !== "." ? dir.replace(/\/$/, "") + "/" : "";
  const dirs = new Map<string, FileEntry>();
  const out: FileEntry[] = [];
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const rest = prefix ? file.path.slice(prefix.length) : file.path;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      out.push({
        name: rest,
        path: file.path,
        kind: "file",
        size: file.content.length,
        language: languageOf(file.path),
      });
    } else {
      const name = rest.slice(0, slash);
      if (!dirs.has(name)) dirs.set(name, { name, path: `${prefix}${name}`, kind: "dir" });
    }
  }
  return [...dirs.values(), ...out].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export class DemoEngine {
  private state: DemoSnapshot;
  private readonly running = new Set<string>();

  constructor(private readonly options: EngineOptions) {
    const initial = options.initial;
    this.state = initial && initial.seedVersion === SEED_VERSION ? initial : buildSeed();
  }

  snapshot(): DemoSnapshot {
    return this.state;
  }

  reset(): void {
    this.state = buildSeed();
    this.options.onChange();
  }

  projects(): Project[] {
    return PROJECT_TEMPLATES.map((template) => this.toProject(template));
  }

  sessions(): Session[] {
    return [...this.state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  queue(): QueueItem[] {
    return [...this.state.queue];
  }

  mcp(providerId: string): McpServer[] {
    return this.state.mcp[providerId]?.map((item) => ({ ...item })) ?? [];
  }

  health(meta: CatalogEntry): HealthReport {
    return {
      id: meta.id,
      state: meta.demo.state,
      latencyMs: meta.demo.latencyMs,
      version: null,
      messageKey: meta.demo.state === "degraded" ? "health.demoSlow" : "health.demo",
      detail: "",
      checkedAt: new Date().toISOString(),
    };
  }

  messages(sessionId: string): ChatMessage[] {
    this.requireSession(sessionId);
    return this.state.messages[sessionId]?.map((message) => ({ ...message, blocks: message.blocks.map((block) => ({ ...block })) })) ?? [];
  }

  createSession(providerId: string, projectId: string, title?: string): Session {
    const template = this.requireTemplate(projectId);
    if (template.providerId !== providerId) throw new HubError("project is owned by another agent", 400, "project");
    const session: Session = {
      id: `ses_${providerId}_${Date.now().toString(36)}`,
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

  async *prompt(sessionId: string, prompt: string, signal: AbortSignal): AsyncGenerator<import("@pocketpilot/protocol").StreamEvent> {
    const text = prompt.trim();
    if (!text) throw new HubError("empty prompt", 400, "empty");
    const session = this.requireSession(sessionId);
    if (this.running.has(sessionId)) throw new HubError("session is busy", 409, "busy");
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
    session.updatedAt = user.createdAt;
    session.messageCount = this.state.messages[sessionId].length;
    this.options.onChange();
    const plan = buildPlan(session.providerId, text);
    const produced: typeof plan = [];
    try {
      for (const event of plan) {
        if (signal.aborted) {
          const aborted = { type: "error", message: "aborted" } as const;
          produced.push(aborted);
          yield aborted;
          break;
        }
        if (!this.options.fast && event.type !== "done") await wait(delayFor(event), signal);
        if (event.type === "done") this.finishTurn(session, produced.concat(event));
        produced.push(event);
        yield event;
      }
    } catch (error) {
      session.status = "error";
      const aborted = { type: "error", message: error instanceof Error ? error.message : "aborted" } as const;
      yield aborted;
    } finally {
      if (session.status === "running") session.status = "idle";
      this.running.delete(sessionId);
      this.options.onChange();
    }
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

  files(projectId: string, dir: string): FileEntry[] {
    const workspace = this.workspaceFor(projectId);
    return listDir(workspace.files, dir);
  }

  file(projectId: string, filePath: string): FileContent {
    const workspace = this.workspaceFor(projectId);
    const file = workspace.files.find((item) => item.path === filePath);
    if (!file) throw new HubError("file not found", 404, "file");
    return { path: file.path, language: languageOf(file.path), content: file.content };
  }

  commit(projectId: string, message: string): Project {
    const text = message.trim();
    if (!text) throw new HubError("commit message required", 400, "empty");
    const template = this.requireTemplate(projectId);
    const changes = this.state.changes[projectId] ?? [];
    if (!changes.length) throw new HubError("nothing to commit", 400, "clean");
    this.state.commits[projectId] ??= [];
    this.state.commits[projectId].unshift({
      id: `c_${Date.now().toString(36)}`,
      message: text,
      createdAt: new Date().toISOString(),
    });
    this.state.changes[projectId] = [];
    this.options.onChange();
    return this.toProject(template);
  }

  async *terminal(sessionId: string, command: string, signal: AbortSignal): AsyncGenerator<TerminalEvent> {
    const session = this.requireSession(sessionId);
    const template = this.requireTemplate(session.projectId);
    const workspace = workspaceById(template.workspaceId);
    const line = command.trim();
    yield { stream: "system", text: `$ ${line || "help"}` };
    const output = this.terminalScript(line, workspace?.path ?? "", template.id);
    for (const text of output) {
      if (signal.aborted) return;
      if (!this.options.fast) await wait(30, signal);
      yield { stream: "out", text };
    }
  }

  toggleMcp(providerId: string, mcpId: string, enabled: boolean): McpServer[] {
    const list = this.state.mcp[providerId];
    if (!list) throw new HubError("unknown provider", 404, "provider");
    const item = list.find((server) => server.id === mcpId);
    if (!item) throw new HubError("unknown mcp server", 404, "mcp");
    item.enabled = enabled;
    this.options.onChange();
    return this.mcp(providerId);
  }

  private finishTurn(session: Session, events: import("@pocketpilot/protocol").StreamEvent[]): void {
    const { blocks, tokens } = blocksFromEvents(events);
    const text = blocks.find((block) => block.type === "text");
    const message: ChatMessage = {
      id: `${session.id}_a_${Date.now().toString(36)}`,
      role: "assistant",
      createdAt: new Date().toISOString(),
      blocks,
      tokens,
    };
    this.state.messages[session.id].push(message);
    session.status = "idle";
    session.updatedAt = message.createdAt;
    session.messageCount = this.state.messages[session.id].length;
    if (text && text.type === "text") session.preview = text.text.replace(/\s+/g, " ").slice(0, 80);
  }

  private terminalScript(command: string, projectPath: string, projectId: string): string[] {
    if (!command || command === "help") {
      return ["演示终端。可以试 pwd、ls、git status。", "关闭演示模式后，命令会在设置里的项目目录执行。"];
    }
    if (command === "pwd") return [projectPath];
    if (command === "ls") {
      const workspace = this.workspaceFor(projectId);
      const top = listDir(workspace.files, "").map((entry) => entry.name);
      return top.length ? top : ["(empty)"];
    }
    if (command === "git status" || command === "git status -sb") {
      const changes = this.state.changes[projectId] ?? [];
      if (!changes.length) return ["## clean"];
      return ["## dirty", ...changes.map((change) => `${change.status} ${change.path}`)];
    }
    return [`演示模式没有执行「${command}」。关闭演示模式后才会在项目目录里运行。`];
  }

  private workspaceFor(projectId: string) {
    const template = this.requireTemplate(projectId);
    const workspace = workspaceById(template.workspaceId);
    if (!workspace) throw new HubError("workspace missing", 404, "project");
    return workspace;
  }

  private requireTemplate(projectId: string): ProjectTemplate {
    const template = PROJECT_TEMPLATES.find((item) => item.id === projectId);
    if (!template) throw new HubError("unknown project", 404, "project");
    return template;
  }

  private requireSession(sessionId: string): Session {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new HubError("unknown session", 404, "session");
    return session;
  }

  private toProject(template: ProjectTemplate): Project {
    const workspace = WORKSPACES.find((item) => item.id === template.workspaceId);
    const loc = workspace?.files.reduce((sum, file) => sum + countLines(file.content), 0) ?? 0;
    const related = this.state.sessions
      .filter((session) => session.projectId === template.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      id: template.id,
      providerId: template.providerId,
      workspaceId: template.workspaceId,
      name: workspace?.name ?? template.workspaceId,
      path: workspace?.path ?? "",
      branch: template.branch,
      summary: workspace?.summary ?? "",
      language: workspace?.language ?? "",
      updatedAt: related[0]?.updatedAt ?? new Date().toISOString(),
      changes: (this.state.changes[template.id] ?? []).map((change) => ({ ...change })),
      commits: (this.state.commits[template.id] ?? []).map((commit) => ({ ...commit })),
      stats: { files: workspace?.files.length ?? 0, loc },
    };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
