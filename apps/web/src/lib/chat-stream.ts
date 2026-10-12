import type { ChatMessage, MessageBlock, StreamEvent } from "@pocketpilot/protocol";

export type ChatRow = ChatMessage & { error?: boolean };

/** Phone chat state. The same function is applied to SSE events from LAN HTTP and from the encrypted channel. */
export interface ChatTurn {
  rows: ChatRow[];
  status: string;
  sessionId: string;
  text: string;
  error: string;
}

function patchAssistant(rows: ChatRow[], fn: (blocks: MessageBlock[]) => MessageBlock[]): ChatRow[] {
  const last = rows[rows.length - 1];
  if (!last || last.role !== "assistant") return rows;
  return [...rows.slice(0, -1), { ...last, blocks: fn(last.blocks) }];
}

/** Fold one stream event into the bubbles the phone renders. Each call returns a new state. */
export function applyChatEvent(state: ChatTurn, event: StreamEvent): ChatTurn {
  if (event.type === "status") return { ...state, status: event.status };
  if (event.type === "session") return { ...state, sessionId: event.id };
  if (event.type === "text") {
    return {
      ...state,
      status: "",
      text: state.text + event.delta,
      rows: patchAssistant(state.rows, (blocks) => {
        const last = blocks[blocks.length - 1];
        if (last?.type === "text") return [...blocks.slice(0, -1), { type: "text", text: last.text + event.delta }];
        return [...blocks, { type: "text", text: event.delta }];
      }),
    };
  }
  if (event.type === "thinking") {
    return {
      ...state,
      rows: patchAssistant(state.rows, (blocks) => {
        const last = blocks[blocks.length - 1];
        if (last?.type === "thinking") return [...blocks.slice(0, -1), { type: "thinking", text: last.text + event.delta }];
        return [...blocks, { type: "thinking", text: event.delta }];
      }),
    };
  }
  if (event.type === "tool") {
    return {
      ...state,
      rows: patchAssistant(state.rows, (blocks) => {
        if (event.phase === "done") {
          const at = blocks.findLastIndex((block) => block.type === "tool" && block.name === event.name && block.status === "running");
          if (at >= 0) {
            return blocks.map((block, index) => (index === at && block.type === "tool"
              ? { ...block, status: "done" as const, detail: event.detail || block.detail, input: block.input || event.input, output: event.output || block.output }
              : block));
          }
        }
        return [...blocks, {
          type: "tool",
          name: event.name,
          detail: event.detail,
          status: event.phase === "done" ? "done" : "running",
          ...(event.input ? { input: event.input } : {}),
          ...(event.output ? { output: event.output } : {}),
        }];
      }),
    };
  }
  if (event.type === "error") {
    const last = state.rows[state.rows.length - 1];
    const rest = last && last.role === "assistant" && last.blocks.length === 0 ? state.rows.slice(0, -1) : state.rows;
    return {
      ...state,
      error: event.message,
      rows: [...rest, { id: `err_${state.rows.length}`, role: "assistant", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: event.message }], error: true }],
    };
  }
  return state;
}

export function assistantText(state: ChatTurn): string {
  const last = [...state.rows].reverse().find((row) => row.role === "assistant" && !row.error);
  if (!last) return "";
  return last.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
