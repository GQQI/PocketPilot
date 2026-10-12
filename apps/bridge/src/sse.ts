import { HubError } from "@pocketpilot/agent-core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

export const SSE_HEARTBEAT_MS = Number(process.env.POCKETPILOT_SSE_HEARTBEAT_MS ?? 15000);

/**
 * Android WebView keeps a chunked body until about 4KB is buffered, then appends that
 * slice to XMLHttpRequest.responseText. A short SSE frame never crosses the line, so
 * responseText stays empty until the socket closes and the phone paints the reply at once.
 * Every padded write is a multiple of that block, and the event's blank line sits inside
 * the released prefix — a frame that merely exceeds 4KB can still leave `\n\n` in the
 * unreleased tail. The header is opt-in: WebRTC messages are already delivered one by one.
 */
const SSE_BLOCK = 4096;

function alignBlock(text: string): string {
  const size = Buffer.byteLength(text);
  let extra = (SSE_BLOCK - (size % SSE_BLOCK)) % SSE_BLOCK;
  if (extra === 0) return text;
  if (extra < 2) extra += SSE_BLOCK;
  return `${text}:${" ".repeat(extra - 2)}\n`;
}

export function paddedSse(data: string): string {
  return alignBlock(`data: ${data}\n\n`);
}

export function paddedComment(): string {
  return alignBlock(":\n");
}

/** Bytes a 4KB WebView buffer would already have exposed. The remainder stays hidden until the socket closes. */
export function webViewReleased(received: string, ended: boolean): string {
  if (ended) return received;
  const visible = Math.floor(Buffer.byteLength(received) / SSE_BLOCK) * SSE_BLOCK;
  return received.slice(0, visible);
}

type NodeSocketEnv = { outgoing?: { socket?: { setNoDelay?: (noDelay: boolean) => void } } };

export async function sseFrom(c: Context, source: AsyncIterable<unknown>) {
  const iterator = source[Symbol.asyncIterator]();
  let first: IteratorResult<unknown>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (error instanceof HubError) return c.json({ error: error.message, code: error.code }, error.status as 400);
    throw error;
  }
  const pad = c.req.header("x-pocketpilot-pad") === "1";
  // Nagle would hold a small packet for an ACK. Chat frames are one packet each.
  try {
    (c.env as NodeSocketEnv | undefined)?.outgoing?.socket?.setNoDelay?.(true);
  } catch {
    /* WebRTC injects fetch() with no node socket */
  }
  const response = streamSSE(c, async (stream) => {
    const writeEvent = async (value: unknown) => {
      const data = JSON.stringify(value);
      if (pad) await stream.write(paddedSse(data));
      else await stream.writeSSE({ data });
    };
    // Comment-line heartbeat keeps proxies/NATs from closing idle streams; clients ignore it.
    if (pad) await stream.write(paddedComment());
    const beat = setInterval(() => { void stream.write(pad ? paddedComment() : ": ping\n\n").catch(() => undefined); }, SSE_HEARTBEAT_MS);
    try {
      if (!first.done) await writeEvent(first.value);
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        await writeEvent(next.value);
      }
    } finally {
      clearInterval(beat);
    }
  });
  // streamSSE stamps text/event-stream. WebView treats that MIME as a download and holds it.
  // The phone client parses the bytes itself, so plain text is enough, and it stops the buffer.
  response.headers.set("cache-control", "no-cache, no-store, no-transform");
  response.headers.set("x-accel-buffering", "no");
  response.headers.set("content-encoding", "identity");
  if (pad) response.headers.set("content-type", "text/plain; charset=utf-8");
  return response;
}
