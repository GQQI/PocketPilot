import type { StreamEvent } from "@pocketpilot/protocol";
import { EventQueue, RpcPeer } from "./jsonrpc";
import { ResidentStartError, type PooledWorker } from "./pool";
import { oneLine, spawnPersistent } from "./util";

/**
 * Codex through `codex app-server` (JSON-RPC over stdio; the protocol the Codex IDE extension uses).
 * One process holds many threads: `thread/start` or `thread/resume` once, then `turn/start` per message.
 * Same policy as the old `codex exec --sandbox workspace-write` path: workspace-write sandbox, no approval prompts.
 */
const START_TIMEOUT = 60_000;

export class CodexAppWorker implements PooledWorker {
  private threads = new Set<string>();
  private spare = new Map<string, Promise<string>>();
  private turn: { threadId: string; turnId: string; queue: EventQueue<StreamEvent>; sawDelta: boolean } | null = null;

  private constructor(private readonly peer: RpcPeer) {}

  get alive(): boolean {
    return this.peer.alive;
  }

  static async start(cli: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<CodexAppWorker> {
    let worker: CodexAppWorker | null = null;
    const peer = new RpcPeer(spawnPersistent(cli, ["app-server"], { cwd, env }), {
      onNotification: (method, params) => worker?.onNotification(method, params),
      // approvals are off for these threads; if one still arrives, answer like `exec` would and do not hang the turn
      onRequest: (method) => (/requestApproval$|Approval$/.test(method) ? { decision: "accept" } : Promise.reject(new Error(`unsupported request ${method}`))),
    });
    worker = new CodexAppWorker(peer);
    try {
      await peer.request("initialize", { clientInfo: { name: "pocketpilot", title: "PocketPilot", version: "0.2" }, capabilities: null }, START_TIMEOUT);
      peer.notify("initialized", {});
    } catch (error) {
      peer.dispose();
      throw new ResidentStartError(error instanceof Error ? error.message : String(error));
    }
    if (cwd) worker.prepare(cwd);
    return worker;
  }

  prepare(cwd: string, model?: string): void {
    if (this.spare.has(cwd) || !this.alive) return;
    const p = this.startThread(cwd, model);
    p.catch(() => this.spare.delete(cwd));
    this.spare.set(cwd, p);
  }

  dispose(): void {
    this.turn?.queue.close();
    this.peer.dispose();
  }

  async *prompt(req: { sessionId?: string; cwd: string; prompt: string; model?: string }, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const threadId = await this.openThread(req.sessionId, req.cwd, req.model);
    yield { type: "session", id: threadId };
    const queue = new EventQueue<StreamEvent>();
    this.turn = { threadId, turnId: "", queue, sawDelta: false };
    const onAbort = () => { if (this.turn?.turnId) void this.peer.request("turn/interrupt", { threadId, turnId: this.turn.turnId }).catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await this.peer.request<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: req.prompt, text_elements: [] }],
        cwd: req.cwd,
        ...(req.model ? { model: req.model } : {}),
      });
      if (this.turn && r.turn?.id) this.turn.turnId = r.turn.id;
      for await (const event of queue.drain()) yield event;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.turn = null;
      if (this.alive) this.prepare(req.cwd, req.model);
    }
  }

  private async openThread(sessionId: string | undefined, cwd: string, model?: string): Promise<string> {
    if (sessionId) {
      if (this.threads.has(sessionId)) return sessionId;
      const r = await this.peer.request<{ thread?: { id?: string } }>("thread/resume", { threadId: sessionId, cwd, approvalPolicy: "never", sandbox: "workspace-write", ...(model ? { model } : {}) }, START_TIMEOUT);
      const id = r.thread?.id ?? sessionId;
      this.threads.add(id);
      return id;
    }
    const spare = this.spare.get(cwd);
    this.spare.delete(cwd);
    if (spare) {
      try { return await spare; } catch { /* start a new one */ }
    }
    return this.startThread(cwd, model);
  }

  private async startThread(cwd: string, model?: string): Promise<string> {
    const r = await this.peer.request<{ thread: { id: string } }>("thread/start", { cwd, approvalPolicy: "never", sandbox: "workspace-write", ...(model ? { model } : {}) }, START_TIMEOUT);
    this.threads.add(r.thread.id);
    return r.thread.id;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn || (params.threadId !== undefined && params.threadId !== turn.threadId)) return;
    if (method === "turn/started") {
      const id = (params.turn as { id?: string } | undefined)?.id;
      if (id) turn.turnId = id;
    } else if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      turn.sawDelta = true;
      turn.queue.push({ type: "text", delta: params.delta });
    } else if ((method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") && typeof params.delta === "string") {
      turn.queue.push({ type: "thinking", delta: params.delta });
    } else if (method === "item/started" || method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      const kind = String(item.type ?? "");
      const phase = method === "item/completed" ? "done" as const : "start" as const;
      if (kind === "commandExecution") turn.queue.push({ type: "tool", phase, name: "shell", detail: oneLine(String(item.command ?? ""), 120) });
      else if (kind === "fileChange" || kind === "mcpToolCall" || kind === "webSearch") turn.queue.push({ type: "tool", phase, name: kind, detail: oneLine(JSON.stringify(item.changes ?? item.tool ?? item.query ?? ""), 120) });
      else if (kind === "agentMessage" && phase === "done" && !turn.sawDelta && typeof item.text === "string" && item.text) turn.queue.push({ type: "text", delta: item.text });
    } else if (method === "error") {
      if (params.willRetry === true) turn.queue.push({ type: "status", status: "Codex 正在重试…" });
    } else if (method === "turn/completed") {
      const t = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
      if (t.status === "failed") turn.queue.push({ type: "error", message: t.error?.message || "Codex 返回了错误" });
      turn.queue.close();
    }
  }
}
