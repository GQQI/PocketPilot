import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paddedSse, sseFrom, webViewReleased } from "../../../bridge/src/sse.ts";
import { applyChatEvent, assistantText, type ChatTurn } from "./chat-stream.ts";
import { consumeSse } from "./sse.ts";

function blank(): ChatTurn {
  return {
    rows: [{ id: "a", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z", blocks: [] }],
    status: "",
    sessionId: "",
    text: "",
    error: "",
  };
}

test("SSE frames flush as they arrive, including a trailing frame", () => {
  const seen: unknown[] = [];
  let rest = consumeSse('data: {"type":"text","delta":"a"}\n\n: ping\n\ndata: {"type":"thinking","delta":"b"}', (event) => seen.push(event));
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { delta: string }).delta, "a");
  rest = consumeSse(`${rest}\n\n`, (event) => seen.push(event), true);
  assert.equal(rest, "");
  assert.equal((seen[1] as { type: string }).type, "thinking");
});

test("a 4KB WebView buffer hides small frames until the socket closes", () => {
  const small = `data: ${JSON.stringify({ type: "text", delta: "He" })}\n\ndata: ${JSON.stringify({ type: "text", delta: "llo" })}\n\n`;
  assert.equal(webViewReleased(small, false), "");
  assert.equal(webViewReleased(small, true), small);
  const padded = paddedSse(JSON.stringify({ type: "text", delta: "He" }));
  assert.equal(Buffer.byteLength(padded) % 4096, 0);
  assert.equal(webViewReleased(padded, false).includes('"He"'), true);
});

test("padded SSE comments do not hide text, and each frame updates chat state", () => {
  const pad = `:${" ".repeat(64)}\n`;
  const frame = (delta: string) => `data: ${JSON.stringify({ type: "text", delta })}\n${pad}\n`;
  let state = blank();
  let rest = "";
  const first = `${frame("He")}`;
  rest = consumeSse(first, (event) => { state = applyChatEvent(state, event as never); });
  assert.equal(assistantText(state), "He");
  assert.equal(rest, "");
  consumeSse(frame("llo"), (event) => { state = applyChatEvent(state, event as never); }, true);
  assert.equal(assistantText(state), "Hello");
});

test("LAN HTTP path updates chat state before the reply finishes, even through a 4KB WebView buffer", async () => {
  const sentAt: number[] = [];
  const app = new Hono();
  app.post("/api/chat", (c) => sseFrom(c, (async function* () {
    sentAt.push(Date.now());
    yield { type: "text", delta: "He" };
    await new Promise((resolve) => setTimeout(resolve, 200));
    sentAt.push(Date.now());
    yield { type: "text", delta: "llo" };
  })()));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const port = await new Promise<number>((resolve) => {
    const read = () => resolve((server.address() as AddressInfo).port);
    if (server.listening) read();
    else server.once("listening", read);
  });
  try {
    const observed = await new Promise<{ firstTextAt: number; text: string; contentType: string; contentLength: string | undefined }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/chat",
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "x-pocketpilot-pad": "1", "content-length": "2", connection: "close" },
      }, (res) => {
        let raw = "";
        let state = blank();
        let firstTextAt = 0;
        const take = (ended: boolean) => {
          const visible = webViewReleased(raw, ended);
          let next = blank();
          consumeSse(visible, (event) => { next = applyChatEvent(next, event as never); }, ended);
          state = next;
          if (!firstTextAt && assistantText(state).includes("He")) firstTextAt = Date.now();
          if (firstTextAt && sentAt.length < 2) {
            resolve({
              firstTextAt,
              text: assistantText(state),
              contentType: String(res.headers["content-type"] ?? ""),
              contentLength: res.headers["content-length"],
            });
          }
        };
        res.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); take(false); });
        res.on("end", () => {
          take(true);
          if (!firstTextAt) reject(new Error(`first text never became visible, bytes=${raw.length}`));
          else resolve({
            firstTextAt,
            text: assistantText(state),
            contentType: String(res.headers["content-type"] ?? ""),
            contentLength: res.headers["content-length"],
          });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(observed.contentLength, undefined);
    assert.match(observed.contentType, /text\/plain/);
    assert.equal(observed.text.startsWith("He"), true);
    assert.ok(sentAt.length < 2 || observed.firstTextAt <= sentAt[1], "text reached UI state only after the response finished");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
