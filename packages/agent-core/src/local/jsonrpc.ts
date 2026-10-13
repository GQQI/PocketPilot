import type { ChildProcess } from "node:child_process";
import { killTree } from "./util";

/** JSON-RPC 2.0 over newline-delimited JSON on a child's stdio (ACP and Codex app-server both use this framing). */
export interface RpcHandlers {
  onNotification?(method: string, params: Record<string, unknown>): void;
  /** answer a request the server sends to us; throw to reply with an error */
  onRequest?(method: string, params: Record<string, unknown>): unknown;
}

export class RpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
  }
}

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private buffer = "";
  private exited = false;
  private stderrTail = "";
  private exitListeners: ((code: number | null) => void)[] = [];

  constructor(readonly child: ChildProcess, private readonly handlers: RpcHandlers = {}) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    child.stdin?.on("error", () => undefined);
    const onGone = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      const why = new Error(`process exited (${code ?? "signal"})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-300)}` : ""}`);
      for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(why); }
      this.pending.clear();
      for (const l of this.exitListeners) l(code);
    };
    child.on("exit", onGone);
    child.on("error", () => onGone(null));
  }

  get alive(): boolean {
    return !this.exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  request<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.exited) return Promise.reject(new Error("process is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) entry.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    this.exited = true;
    try { this.child.stdin?.end(); } catch { /* closed */ }
    killTree(this.child);
  }

  private write(msg: unknown): void {
    try { this.child.stdin?.write(JSON.stringify(msg) + "\n"); } catch { /* exit handler reports it */ }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined && msg.id !== null) { void this.answer(msg.id, msg.method, msg.params ?? {}); return; }
    if (msg.method) { this.handlers.onNotification?.(msg.method, msg.params ?? {}); return; }
    if (msg.id === undefined || msg.id === null) return;
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) {
      const data = msg.error.data as { message?: string } | undefined;
      p.reject(new RpcError(data?.message || msg.error.message || "request failed", msg.error.code ?? -32000, msg.error.data));
    } else p.resolve(msg.result ?? {});
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.handlers.onRequest) { this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not handled: ${method}` } }); return; }
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

/** A push/pull queue of events for one turn: protocol handlers push, the chat generator pulls. */
export class EventQueue<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) { yield this.items.shift() as T; continue; }
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }
}
