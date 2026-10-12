import type { StreamEvent } from "@mobileagent/protocol";
import { collectErrorText, classifyTransport } from "./grok";

export interface ClaudeQuery {
  (args: { prompt: string; options: Record<string, unknown> }): AsyncIterable<unknown> & { close?: () => void };
}

export interface ClaudeMapState {
  sawText: boolean;
  sawThinking: boolean;
  tools: Map<number, string>;
  args: Map<number, string>;
  started: Set<number>;
}

export function emptyClaudeState(): ClaudeMapState {
  return { sawText: false, sawThinking: false, tools: new Map(), args: new Map(), started: new Set() };
}

export function claudeSessionId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const id = (message as { session_id?: unknown }).session_id;
  return typeof id === "string" && id ? id : undefined;
}

export function eventsFromClaudeMessage(message: unknown, state: ClaudeMapState): StreamEvent[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  if (record.type === "stream_event") return eventsFromStream(record.event, state);
  if (record.type === "assistant") return eventsFromAssistant(record, state);
  if (record.type === "result") {
    const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (!usage) return [];
    return [{ type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }];
  }
  return [];
}

function eventsFromStream(event: unknown, state: ClaudeMapState): StreamEvent[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const index = typeof record.index === "number" ? record.index : 0;
  if (record.type === "content_block_start") {
    const block = record.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      const name = typeof block.name === "string" && block.name ? block.name : "tool";
      state.tools.set(index, name);
      state.started.add(index);
      return [{ type: "tool", phase: "start", name, detail: "" }];
    }
    return [];
  }
  if (record.type === "content_block_delta") {
    const delta = record.delta as Record<string, unknown> | undefined;
    if (!delta) return [];
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      state.sawText = true;
      return [{ type: "text", delta: delta.text }];
    }
    if (delta.type === "thinking_delta") {
      const text = typeof delta.thinking === "string" ? delta.thinking : typeof delta.text === "string" ? delta.text : "";
      if (!text) return [];
      state.sawThinking = true;
      return [{ type: "thinking", delta: text }];
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      state.args.set(index, `${state.args.get(index) ?? ""}${delta.partial_json}`);
      return [];
    }
  }
  if (record.type === "content_block_stop") {
    const name = state.tools.get(index);
    if (!name) return [];
    return [{ type: "tool", phase: "done", name, detail: (state.args.get(index) ?? "").slice(0, 180) }];
  }
  return [];
}

function eventsFromAssistant(record: Record<string, unknown>, state: ClaudeMapState): StreamEvent[] {
  const message = record.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return [];
  const events: StreamEvent[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string" && item.text && !state.sawText) {
      events.push({ type: "text", delta: item.text });
    } else if (item.type === "thinking" && !state.sawThinking) {
      const text = typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
      if (text) events.push({ type: "thinking", delta: text });
    } else if (item.type === "tool_use" && !state.started.size) {
      const name = typeof item.name === "string" && item.name ? item.name : "tool";
      const detail = item.input ? JSON.stringify(item.input).slice(0, 180) : "";
      events.push({ type: "tool", phase: "done", name, detail });
    }
  }
  return events;
}

export function explainClaudeFailure(error: unknown, locale: "zh" | "en"): string {
  const text = collectErrorText(error);
  const kind = classifyTransport(error, undefined, text);
  if (kind === "auth" || /invalid api key|authentication|unauthorized/i.test(text)) {
    return locale === "en"
      ? "Claude Code rejected the key. Check ANTHROPIC_API_KEY on this PC. The key stays on the computer."
      : "Claude Code 拒绝了密钥。请在这台电脑上检查 ANTHROPIC_API_KEY。密钥只留在电脑上。";
  }
  if (kind === "timeout") {
    return locale === "en"
      ? "Claude Code timed out while streaming. The turn was not history-only; the PC has to reach Anthropic."
      : "Claude Code 流式输出超时。这一轮不是只读历史；这台电脑需要能连上 Anthropic。";
  }
  if (kind === "network") {
    return locale === "en"
      ? "Claude Code network error. This PC could not reach the API. It is not a read-only history view."
      : "Claude Code 网络失败。这台电脑连不上接口。这不是只读历史。";
  }
  const detail = text.replace(/\s+/g, " ").slice(0, 240) || "claude failed";
  return locale === "en" ? `Claude Code: ${detail}` : `Claude Code：${detail}`;
}

export interface ClaudeStreamOptions {
  prompt: string;
  cwd: string;
  model: string;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
  resumeId?: string;
  locale: "zh" | "en";
  signal: AbortSignal;
  queryImpl?: ClaudeQuery;
  onSession?: (sessionId: string) => void;
}

export async function loadClaudeQuery(): Promise<ClaudeQuery | null> {
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk") as { query?: ClaudeQuery };
    return typeof mod.query === "function" ? mod.query : null;
  } catch {
    return null;
  }
}

/** Real Claude Agent SDK turn. Yields text, thinking, and tool events. Does not import history-only. */
export async function* streamClaudeSdk(options: ClaudeStreamOptions): AsyncGenerator<StreamEvent> {
  const query = options.queryImpl ?? await loadClaudeQuery();
  if (!query) {
    yield { type: "status", status: "sdk-missing" };
    return;
  }
  const env: NodeJS.ProcessEnv = { ...options.env };
  if (options.apiKey && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = options.apiKey;
  const handle = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      model: options.model || undefined,
      includePartialMessages: true,
      resume: options.resumeId,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env,
      persistSession: true,
    },
  });
  const onAbort = () => handle.close?.();
  options.signal.addEventListener("abort", onAbort, { once: true });
  const state = emptyClaudeState();
  try {
    for await (const message of handle) {
      const sessionId = claudeSessionId(message);
      if (sessionId) options.onSession?.(sessionId);
      for (const event of eventsFromClaudeMessage(message, state)) yield event;
      if (options.signal.aborted) break;
    }
  } catch (error) {
    if (options.signal.aborted) {
      yield { type: "error", message: options.locale === "en" ? "aborted" : "已中止" };
      return;
    }
    yield { type: "error", message: explainClaudeFailure(error, options.locale) };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}
