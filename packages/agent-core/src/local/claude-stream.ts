import type { StreamEvent } from "@pocketpilot/protocol";
import { EventQueue } from "./jsonrpc";
import { ResidentStartError, type PooledWorker } from "./pool";

/**
 * Claude Code through the Agent SDK's streaming input mode: `query({ prompt: AsyncIterable<SDKUserMessage> })`
 * keeps one Claude Code process alive and takes each new user message on the same stream
 * (https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode). A process is one session,
 * so the pool keeps it bound to that session and starts a spare one for the next new chat.
 */
export interface StreamingQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt?(): Promise<unknown>;
  setModel?(model?: string): Promise<void>;
}

export type StreamingQueryFn = (args: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => StreamingQuery;

export type ClaudeMapper = (message: Record<string, unknown>) => StreamEvent[];

export class ClaudeStreamWorker implements PooledWorker {
  private input = new EventQueue<Record<string, unknown>>();
  private turn: EventQueue<Record<string, unknown>> | null = null;
  private ended = false;
  private failure = "";
  private model: string | undefined;
  private readonly q: StreamingQuery;
  sessionId = "";

  constructor(query: StreamingQueryFn, options: Record<string, unknown>) {
    this.model = typeof options.model === "string" ? options.model : undefined;
    if (typeof options.resume === "string") this.sessionId = options.resume;
    try {
      this.q = query({ prompt: this.input.drain(), options });
    } catch (error) {
      throw new ResidentStartError(error instanceof Error ? error.message : String(error));
    }
    void this.pump();
  }

  get alive(): boolean {
    return !this.ended;
  }

  dispose(): void {
    this.input.close();
    this.turn?.close();
    this.ended = true;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        if (typeof message.session_id === "string" && message.session_id) this.sessionId = message.session_id;
        const turn = this.turn;
        if (!turn) continue; // start-up messages before the first prompt
        turn.push(message);
        if (message.type === "result") turn.close();
      }
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.ended = true;
      if (this.turn) {
        if (this.failure) this.turn.push({ type: "result", is_error: true, result: this.failure });
        this.turn.close();
      }
    }
  }

  async *prompt(req: { prompt: string; model?: string }, map: ClaudeMapper, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (this.ended) throw new ResidentStartError(this.failure || "Claude process has exited");
    if (req.model && req.model !== this.model && this.q.setModel) {
      await this.q.setModel(req.model);
      this.model = req.model;
    }
    const turn = new EventQueue<Record<string, unknown>>();
    this.turn = turn;
    const onAbort = () => { void this.q.interrupt?.().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    this.input.push({ type: "user", message: { role: "user", content: req.prompt }, parent_tool_use_id: null, session_id: this.sessionId });
    try {
      for await (const message of turn.drain()) for (const event of map(message)) yield event;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.turn = null;
    }
  }
}
