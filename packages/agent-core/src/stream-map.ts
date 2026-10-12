import type { StreamEvent } from "@mobileagent/protocol";

export interface TextCursor {
  previous: string;
}

/** Accept either a full snapshot or a delta without repeating text already shown. */
export function textDelta(cursor: TextCursor, incoming: string): string {
  if (!incoming) return "";
  if (cursor.previous && incoming.startsWith(cursor.previous)) {
    const delta = incoming.slice(cursor.previous.length);
    cursor.previous = incoming;
    return delta;
  }
  if (cursor.previous && cursor.previous.startsWith(incoming)) return "";
  cursor.previous += incoming;
  return incoming;
}

export function eventsFromXaiPayload(payload: unknown): StreamEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as {
    error?: string | { message?: string };
    choices?: Array<{ delta?: XaiDelta; message?: XaiDelta }>;
  };
  if (record.error) {
    const message = typeof record.error === "string" ? record.error : record.error.message || "xAI error";
    return [{ type: "error", message }];
  }
  const choice = record.choices?.[0];
  const delta = choice?.delta ?? choice?.message;
  if (!delta) return [];
  return eventsFromXaiDelta(delta);
}

interface XaiDelta {
  reasoning_content?: string;
  content?: string | null;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string }; name?: string }>;
}

function eventsFromXaiDelta(delta: XaiDelta): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (delta.reasoning_content) events.push({ type: "thinking", delta: delta.reasoning_content });
  if (typeof delta.content === "string" && delta.content) events.push({ type: "text", delta: delta.content });
  for (const tool of delta.tool_calls ?? []) {
    const name = tool.function?.name || tool.name || "tool";
    const detail = (tool.function?.arguments ?? "").slice(0, 180);
    events.push({ type: "tool", phase: "start", name, detail });
  }
  return events;
}

/**
 * Map one CLI stdout line.
 * `null` means the line is ordinary text. An empty array means the line was a
 * protocol frame with nothing to show (pings, system envelopes).
 */
export function mapCliLine(line: string): StreamEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("data:")) return null;
  const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText || jsonText === "[DONE]") return [];
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "stream_event" || record.type === "assistant" || record.type === "content_block_delta") {
    return eventsFromClaudeShape(record);
  }
  if (record.type === "system" || record.type === "result" || record.type === "ping") return [];
  if (record.type === "tool_call") {
    const tool = (record.tool_call ?? {}) as Record<string, unknown>;
    const name = stringOf(tool.name) || stringOf(record.name) || nestedToolName(tool) || "tool";
    const phase = record.subtype === "completed" || record.subtype === "done" ? "done" : "start";
    return [{ type: "tool", phase, name, detail: stringOf(tool.path) || stringOf(tool.detail) || "" }];
  }
  if (record.type === "item.started" || record.type === "item.completed") {
    return eventsFromCodexItem(record);
  }
  if ("choices" in record || "reasoning_content" in record) return eventsFromXaiPayload(record);
  if (record.type === "thinking" && (typeof record.delta === "string" || typeof record.text === "string")) {
    return [{ type: "thinking", delta: stringOf(record.delta) || stringOf(record.text) }];
  }
  if (record.type === "text" && (typeof record.delta === "string" || typeof record.text === "string")) {
    return [{ type: "text", delta: stringOf(record.delta) || stringOf(record.text) }];
  }
  return null;
}

function eventsFromCodexItem(record: Record<string, unknown>): StreamEvent[] {
  const item = (record.item ?? {}) as Record<string, unknown>;
  const kind = stringOf(item.type);
  const done = record.type === "item.completed";
  if (kind === "agent_message" && done) {
    const text = stringOf(item.text) || stringOf(item.content);
    return text ? [{ type: "text", delta: text }] : [];
  }
  if (kind === "reasoning" || kind === "thinking") {
    const text = stringOf(item.text) || stringOf(item.content);
    return text ? [{ type: "thinking", delta: text }] : [];
  }
  if (kind === "command_execution" || kind === "tool_call" || kind === "function_call") {
    const name = stringOf(item.command) || stringOf(item.name) || kind;
    return [{ type: "tool", phase: done ? "done" : "start", name, detail: stringOf(item.aggregated_output) || "" }];
  }
  return [];
}

function eventsFromClaudeShape(record: Record<string, unknown>): StreamEvent[] {
  if (record.type === "content_block_delta") return deltaEvents(record.delta);
  if (record.type === "stream_event") {
    const event = record.event as Record<string, unknown> | undefined;
    if (!event) return [];
    if (event.type === "content_block_delta") return deltaEvents(event.delta);
    if (event.type === "content_block_start") return toolStart(event.content_block);
    if (event.type === "content_block_stop") return [];
    return [];
  }
  if (record.type === "assistant") {
    const message = record.message as { content?: unknown } | undefined;
    return contentBlocks(message?.content);
  }
  return [];
}

function deltaEvents(delta: unknown): StreamEvent[] {
  if (!delta || typeof delta !== "object") return [];
  const record = delta as Record<string, unknown>;
  if (record.type === "text_delta" && typeof record.text === "string" && record.text) {
    return [{ type: "text", delta: record.text }];
  }
  if (record.type === "thinking_delta") {
    const text = stringOf(record.thinking) || stringOf(record.text);
    return text ? [{ type: "thinking", delta: text }] : [];
  }
  return [];
}

function toolStart(block: unknown): StreamEvent[] {
  if (!block || typeof block !== "object") return [];
  const record = block as Record<string, unknown>;
  if (record.type !== "tool_use") return [];
  return [{ type: "tool", phase: "start", name: stringOf(record.name) || "tool", detail: "" }];
}

function contentBlocks(content: unknown): StreamEvent[] {
  if (!Array.isArray(content)) return [];
  const events: StreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string" && record.text) {
      events.push({ type: "text", delta: record.text });
    } else if (record.type === "thinking") {
      const text = stringOf(record.thinking) || stringOf(record.text);
      if (text) events.push({ type: "thinking", delta: text });
    } else if (record.type === "tool_use") {
      events.push({ type: "tool", phase: "done", name: stringOf(record.name) || "tool", detail: "" });
    }
  }
  return events;
}

function nestedToolName(tool: Record<string, unknown>): string {
  for (const value of Object.values(tool)) {
    if (value && typeof value === "object" && "args" in value) return "tool";
  }
  return "";
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createCliMapper(): { push: (chunk: string) => StreamEvent[]; flush: () => StreamEvent[] } {
  let buffer = "";
  const cursor: TextCursor = { previous: "" };
  const emit = (line: string): StreamEvent[] => {
    const mapped = mapCliLine(line);
    if (mapped === null) return line.trim() ? [{ type: "text", delta: line.endsWith("\n") ? line : `${line}\n` }] : [];
    const events: StreamEvent[] = [];
    for (const event of mapped) {
      if (event.type === "text") {
        const delta = textDelta(cursor, event.delta);
        if (delta) events.push({ type: "text", delta });
      } else if (event.type === "thinking") {
        events.push(event);
      } else {
        events.push(event);
      }
    }
    return events;
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      const events: StreamEvent[] = [];
      for (const line of lines) events.push(...emit(line));
      return events;
    },
    flush() {
      if (!buffer) return [];
      const line = buffer;
      buffer = "";
      return emit(line);
    },
  };
}
