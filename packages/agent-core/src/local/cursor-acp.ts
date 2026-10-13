import type { StreamEvent } from "@pocketpilot/protocol";
import { EventQueue, RpcError, RpcPeer } from "./jsonrpc";
import { ResidentStartError, type PooledWorker } from "./pool";
import { cap, oneLine, spawnPersistent } from "./util";

/**
 * Cursor through `cursor-agent acp` (Agent Client Protocol, https://cursor.com/docs/cli/acp).
 * One process serves many chats: initialize + authenticate once (the slow part, ~20 s on a cold start),
 * then `session/new` / `session/load` and `session/prompt` per message.
 */
export interface AcpModel {
  modelId: string;
  name: string;
}

interface SessionState {
  cwd: string;
  modelId: string;
}

const START_TIMEOUT = 90_000;
const EFFORT = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "extra-high"]);

/**
 * Map a model id from `--list-models` (e.g. `gpt-5.5-high-fast`, `claude-opus-5-thinking-high`) to an ACP model value.
 * ACP lists base models with their parameters (`gpt-5.5[context=272k,reasoning=medium,fast=false]`), so the CLI suffix
 * words are applied to whichever parameters that model actually has. Nothing about specific models is hard-coded.
 */
export function resolveAcpModel(requested: string | undefined, available: AcpModel[]): string | null {
  if (!available.length) return null;
  const want = (requested ?? "").trim();
  if (!want || want === "auto" || want === "default") return available.find((m) => /^default\b/.test(m.modelId) || /^auto$/i.test(m.name))?.modelId ?? null;
  const exact = available.find((m) => m.modelId === want || m.name === want);
  if (exact) return exact.modelId;
  const base = available
    .filter((m) => want.startsWith(`${m.name}-`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!base) return null;
  const words = want.slice(base.name.length + 1).split("-").filter(Boolean);
  const m = /^([^[]+)\[(.*)\]$/.exec(base.modelId);
  if (!m) return base.modelId;
  const params = m[2].split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)] as [string, string]; });
  const has = (k: string) => params.some(([key]) => key === k);
  const set = (k: string, v: string) => { const p = params.find(([key]) => key === k); if (p) p[1] = v; };
  let effort = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i] === "extra" && words[i + 1] === "high" ? (i++, "xhigh") : words[i];
    if (EFFORT.has(w)) effort = w;
  }
  if (has("fast")) set("fast", words.includes("fast") ? "true" : "false");
  if (has("thinking")) set("thinking", words.includes("thinking") ? "true" : "false");
  if (effort) for (const k of ["effort", "reasoning", "reasoning_effort"]) if (has(k)) set(k, effort);
  return `${m[1]}[${params.map(([k, v]) => `${k}=${v}`).join(",")}]`;
}

function permissionChoice(params: Record<string, unknown>): Record<string, unknown> {
  // Same policy as the old `-p --force` path: allow tool calls. Prefer the option Cursor marks as "always".
  const options = Array.isArray(params.options) ? params.options as { optionId?: string; kind?: string }[] : [];
  const pick = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once") ?? options.find((o) => /allow/i.test(String(o.optionId)));
  return { outcome: { outcome: "selected", optionId: pick?.optionId ?? "allow-once" } };
}

export class CursorAcpWorker implements PooledWorker {
  private sessions = new Map<string, SessionState>();
  private spare = new Map<string, Promise<string>>();
  private models: AcpModel[] = [];
  private turn: { sessionId: string; queue: EventQueue<StreamEvent>; tools: Map<string, string> } | null = null;
  private loading = new Set<string>();

  private constructor(private readonly peer: RpcPeer) {}

  get alive(): boolean {
    return this.peer.alive;
  }

  static async start(cli: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<CursorAcpWorker> {
    const child = spawnPersistent(cli, ["acp"], { cwd, env });
    let worker: CursorAcpWorker | null = null;
    const peer = new RpcPeer(child, {
      onNotification: (method, params) => worker?.onNotification(method, params),
      onRequest: (method, params) => {
        if (method === "session/request_permission") return permissionChoice(params);
        if (method === "cursor/ask_question") return { outcome: { outcome: "skipped", reason: "PocketPilot cannot ask on the phone yet" } };
        if (method === "cursor/create_plan") return { outcome: { outcome: "accepted" } };
        throw new Error(`unsupported request ${method}`);
      },
    });
    worker = new CursorAcpWorker(peer);
    try {
      await peer.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "pocketpilot", version: "0.2" } }, START_TIMEOUT);
      await peer.request("authenticate", { methodId: "cursor_login" }, START_TIMEOUT);
    } catch (error) {
      peer.dispose();
      throw new ResidentStartError(error instanceof Error ? error.message : String(error));
    }
    if (cwd) worker.prepare(cwd);
    return worker;
  }

  /** Create the next session for `cwd` ahead of time (session/new costs a few seconds). */
  prepare(cwd: string): void {
    if (this.spare.has(cwd) || !this.alive) return;
    const p = this.newSession(cwd);
    p.catch(() => this.spare.delete(cwd));
    this.spare.set(cwd, p);
  }

  dispose(): void {
    this.turn?.queue.close();
    this.peer.dispose();
  }

  async *prompt(req: { sessionId?: string; cwd: string; prompt: string; model?: string }, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const sessionId = await this.openSession(req.sessionId, req.cwd);
    yield { type: "session", id: sessionId };
    await this.applyModel(sessionId, req.model);
    const queue = new EventQueue<StreamEvent>();
    this.turn = { sessionId, queue, tools: new Map() };
    const onAbort = () => this.peer.notify("session/cancel", { sessionId });
    signal.addEventListener("abort", onAbort, { once: true });
    const done = this.peer.request<{ stopReason?: string }>("session/prompt", { sessionId, prompt: [{ type: "text", text: req.prompt }] })
      .then((r) => { if (r.stopReason === "refusal") queue.push({ type: "error", message: "Cursor refused this request" }); queue.close(); })
      .catch((error) => { queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) }); queue.close(); });
    try {
      for await (const event of queue.drain()) yield event;
      await done;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.turn = null;
      if (this.alive) this.prepare(req.cwd);
    }
  }

  private async openSession(sessionId: string | undefined, cwd: string): Promise<string> {
    if (sessionId) {
      if (this.sessions.has(sessionId)) return sessionId;
      this.loading.add(sessionId);
      try {
        const r = await this.peer.request<{ models?: { currentModelId?: string; availableModels?: AcpModel[] } }>("session/load", { sessionId, cwd, mcpServers: [] }, START_TIMEOUT);
        this.remember(sessionId, cwd, r.models);
        return sessionId;
      } catch (error) {
        if (!this.alive) throw error;
        // not loadable (e.g. an IDE chat): continue in a fresh session rather than failing the message
      } finally {
        this.loading.delete(sessionId);
      }
    }
    const spare = this.spare.get(cwd);
    this.spare.delete(cwd);
    if (spare) {
      try { return await spare; } catch { /* fall through to a new one */ }
    }
    return this.newSession(cwd);
  }

  private async newSession(cwd: string): Promise<string> {
    const r = await this.peer.request<{ sessionId: string; models?: { currentModelId?: string; availableModels?: AcpModel[] } }>("session/new", { cwd, mcpServers: [] }, START_TIMEOUT);
    this.remember(r.sessionId, cwd, r.models);
    return r.sessionId;
  }

  private remember(id: string, cwd: string, models?: { currentModelId?: string; availableModels?: AcpModel[] }): void {
    if (models?.availableModels?.length) this.models = models.availableModels;
    this.sessions.set(id, { cwd, modelId: models?.currentModelId ?? "" });
  }

  private async applyModel(sessionId: string, model?: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const wanted = resolveAcpModel(model, this.models);
    if (!state || !wanted || state.modelId === wanted) return;
    try {
      await this.peer.request("session/set_model", { sessionId, modelId: wanted }, 20_000);
      state.modelId = wanted;
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      // a parameter combination the account does not offer: fall back to the base model
      const base = this.models.find((m) => m.modelId.split("[")[0] === wanted.split("[")[0])?.modelId;
      if (base && base !== wanted) {
        await this.peer.request("session/set_model", { sessionId, modelId: base }, 20_000).catch(() => undefined);
        state.modelId = base;
      }
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const sid = String(params.sessionId ?? "");
    if (this.loading.has(sid)) return; // history replay from session/load
    const turn = this.turn;
    if (!turn || turn.sessionId !== sid) return;
    const u = (params.update ?? {}) as Record<string, unknown>;
    const kind = String(u.sessionUpdate ?? "");
    const text = (u.content as { text?: unknown } | undefined)?.text;
    if (kind === "agent_message_chunk" && typeof text === "string" && text) turn.queue.push({ type: "text", delta: text });
    else if (kind === "agent_thought_chunk" && typeof text === "string" && text) turn.queue.push({ type: "thinking", delta: text });
    else if (kind === "tool_call") {
      const id = String(u.toolCallId ?? "");
      const name = String(u.kind ?? "tool");
      const title = String(u.title ?? "");
      turn.tools.set(id, name);
      const input = u.rawInput === undefined ? "" : cap(typeof u.rawInput === "string" ? u.rawInput : JSON.stringify(u.rawInput), 20000);
      turn.queue.push({ type: "tool", phase: "start", name, detail: oneLine(title || input, 160), ...(input ? { input } : {}) });
    } else if (kind === "tool_call_update" && (u.status === "completed" || u.status === "failed")) {
      const id = String(u.toolCallId ?? "");
      const output = u.rawOutput === undefined ? "" : cap(typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput), 20000);
      turn.queue.push({ type: "tool", phase: "done", name: turn.tools.get(id) ?? "tool", detail: oneLine(String(u.title ?? ""), 160), ...(output ? { output } : {}) });
    }
  }
}
