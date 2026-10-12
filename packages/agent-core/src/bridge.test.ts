import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backAction, consumeSse } from "@mobileagent/protocol";
import { createHub } from "./hub";
import { directoryParent } from "./browse";
import { emptyClaudeState, eventsFromClaudeMessage, streamClaudeSdk } from "./claude-sdk";
import { classifyTransport, explainGrokFailure, streamGrok } from "./grok";
import { groupTraeRecords, isInternalCodexSession, presentHistory } from "./history";
import { createCliMapper, mapCliLine, textDelta } from "./stream-map";
import type { Session } from "@mobileagent/protocol";

function session(partial: Partial<Session> & Pick<Session, "id" | "title" | "preview">): Session {
  return {
    providerId: "cursor",
    projectId: "live__cursor",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 2,
    ...partial,
  };
}

test("android back leaves only from home", () => {
  assert.deepEqual(backAction("/"), { type: "exit" });
  assert.deepEqual(backAction("/chat/abc"), { type: "home" });
  assert.deepEqual(backAction("/settings"), { type: "home" });
  assert.deepEqual(backAction("/chat/abc?x=1"), { type: "home" });
});

test("drive root parent is the drive list", () => {
  assert.equal(directoryParent("C:\\"), "");
  assert.equal(directoryParent("C:/"), "");
  assert.equal(directoryParent("D:"), "");
  assert.equal(directoryParent("C:\\Windows"), "C:\\");
  assert.equal(directoryParent("D:\\Project\\MobileAgent"), "D:\\Project");
  assert.equal(directoryParent("/"), "");
  assert.equal(directoryParent(""), null);
});

test("session history drops duplicates and codex chatcwd", () => {
  const rows = presentHistory([
    session({ id: "a", title: "登录", preview: "同一段", updatedAt: "2026-01-01T00:00:00.000Z" }),
    session({ id: "b", title: "登录", preview: "同一段", updatedAt: "2026-01-02T00:00:00.000Z" }),
    session({ id: "c", providerId: "codex", title: "chatcwd", preview: "internal" }),
    session({ id: "chatcwd", providerId: "codex", title: "真实标题", preview: "保留" }),
    session({ id: "d", providerId: "codex", title: "迁移脚本", preview: "保留这条" }),
    session({ id: "e", title: "草稿", preview: "" }),
    session({ id: "f", title: "草稿", preview: "" }),
  ]);
  assert.equal(rows.some((item) => item.id === "a"), false);
  assert.equal(rows.some((item) => item.id === "b"), true);
  assert.equal(rows.some((item) => item.title === "chatcwd" || item.id === "chatcwd"), false);
  assert.equal(rows.some((item) => item.id === "d"), true);
  assert.equal(rows.filter((item) => item.title === "草稿").length, 2);
  assert.equal(isInternalCodexSession({ providerId: "codex", id: "C:\\chatcwd", title: "x" }), true);
  assert.equal(isInternalCodexSession({ providerId: "cursor", id: "chatcwd", title: "chatcwd" }), false);
});

test("trae history groups messages into conversations", () => {
  const sessions = groupTraeRecords([
    { conversationId: "c1", role: "user", text: "第一条", createdAt: "2026-01-01T00:00:00.000Z" },
    { conversationId: "c1", role: "assistant", text: "回复一", createdAt: "2026-01-01T00:01:00.000Z" },
    { conversationId: "c1", role: "user", text: "第二条", createdAt: "2026-01-01T00:02:00.000Z" },
    { conversationId: "c2", role: "user", text: "另一段对话", createdAt: "2026-01-02T00:00:00.000Z" },
    { file: "/tmp/conv/msg-1.json", role: "user", text: "文件里的一句" },
    { file: "/tmp/conv/msg-2.json", role: "assistant", text: "文件里的回复" },
  ]);
  assert.equal(sessions.length, 3);
  const first = sessions.find((item) => item.preview.includes("第二条"));
  assert.ok(first);
  assert.equal(first?.messageCount, 3);
  assert.equal(first?.title, "第一条");
  assert.equal(sessions.every((item) => item.providerId === "trae-cn"), true);
});

test("sse consumer keeps a partial frame", () => {
  const seen: unknown[] = [];
  let rest = consumeSse('data: {"type":"text","delta":"a"}\n\n', (event) => seen.push(event));
  rest = consumeSse(`${rest}data: {"type":"thinking","delta":"b"}`, (event) => seen.push(event));
  assert.equal(seen.length, 1);
  rest = consumeSse(`${rest}\n\n`, (event) => seen.push(event));
  assert.equal(seen.length, 2);
  assert.equal(rest, "");
});

test("cli stream lines become thinking, tools, and text", () => {
  const mapper = createCliMapper();
  const events = [
    ...mapper.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先看"}}}\n'),
    ...mapper.push('{"type":"tool_call","subtype":"started","name":"read_file"}\n'),
    ...mapper.push('{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}\n'),
    ...mapper.flush(),
  ];
  assert.equal(events.some((event) => event.type === "thinking"), true);
  assert.equal(events.some((event) => event.type === "tool"), true);
  assert.equal(events.some((event) => event.type === "text" && event.delta === "你好"), true);
  assert.equal(mapCliLine("plain text"), null);
  const cursor = { previous: "你好" };
  assert.equal(textDelta(cursor, "你好世界"), "世界");
});

test("claude sdk query sends a turn instead of reading history", async () => {
  let options: Record<string, unknown> | undefined;
  let resumed = "";
  const events = [];
  for await (const event of streamClaudeSdk({
    prompt: "hi",
    cwd: "/tmp/project",
    model: "sonnet",
    apiKey: "sk-test",
    env: {},
    resumeId: "sess_1",
    locale: "zh",
    signal: new AbortController().signal,
    onSession: (id) => {
      resumed = id;
    },
    queryImpl: (args) => {
      options = args.options;
      return (async function* () {
        yield { type: "system", session_id: "sess_1" };
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
        };
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "pong" } },
        };
      })();
    },
  })) events.push(event);
  assert.equal(options?.includePartialMessages, true);
  assert.equal(options?.resume, "sess_1");
  assert.equal(options?.cwd, "/tmp/project");
  assert.equal((options?.env as NodeJS.ProcessEnv | undefined)?.ANTHROPIC_API_KEY, "sk-test");
  assert.equal(events.some((event) => event.type === "thinking" && event.delta === "想"), true);
  assert.equal(events.some((event) => event.type === "text" && event.delta === "pong"), true);
  assert.equal(resumed, "sess_1");
});

test("claude sdk messages map partial text and tools", () => {
  const state = emptyClaudeState();
  const start = eventsFromClaudeMessage({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } },
  }, state);
  const text = eventsFromClaudeMessage({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  }, state);
  const done = eventsFromClaudeMessage({
    type: "stream_event",
    event: { type: "content_block_stop", index: 1 },
  }, state);
  const duplicate = eventsFromClaudeMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  }, state);
  assert.deepEqual(start[0], { type: "tool", phase: "start", name: "Read", detail: "" });
  assert.deepEqual(text[0], { type: "text", delta: "hi" });
  assert.equal(done[0]?.type, "tool");
  assert.equal(duplicate.length, 0);
});

test("grok errors distinguish network, timeout, and a bad key", () => {
  assert.equal(classifyTransport(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.x.ai"), { code: "ENOTFOUND" }) })), "network");
  assert.equal(classifyTransport(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })), "timeout");
  assert.equal(classifyTransport(new Error("nope"), 401, "invalid api key"), "auth");
  const network = explainGrokFailure({ error: new TypeError("fetch failed"), locale: "zh" });
  assert.match(network, /fetch failed/);
  assert.match(network, /不是密钥/);
  const auth = explainGrokFailure({ status: 401, locale: "zh" });
  assert.match(auth, /密钥/);
  const missing = explainGrokFailure({ missingKey: true, locale: "en" });
  assert.match(missing, /XAI_API_KEY/);
});

test("grok live turn keeps one history row and names a missing key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mobileagent-grok-"));
  try {
    const hub = createHub({ dataDir: dir, fast: true });
    hub.updateSettings({ demoMode: false, workspacePath: dir, activeProviderId: "grok" });
    const created = hub.createSession("grok", "live__grok", "登录说明");
    const events = [];
    for await (const event of hub.prompt(created.session.id, "你好", new AbortController().signal)) events.push(event);
    assert.equal(events.some((event) => event.type === "error" && event.message.includes("XAI_API_KEY")), true);
    const listed = hub.bootstrap().sessions.filter((item) => item.providerId === "grok");
    assert.equal(listed.length, 1);
    const transcript = hub.messages(created.session.id);
    assert.equal(transcript.at(-1)?.role, "assistant");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok stream maps reasoning and text deltas", async () => {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
      controller.close();
    },
  });
  const events = [];
  for await (const event of streamGrok({
    apiKey: "test-key",
    model: "grok-4",
    endpoint: "https://api.x.ai/v1",
    messages: [{ role: "user", content: "hi" }],
    locale: "zh",
    signal: new AbortController().signal,
    fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  })) events.push(event);
  assert.equal(events.some((event) => event.type === "thinking" && event.delta === "想"), true);
  assert.equal(events.some((event) => event.type === "text" && event.delta === "好"), true);
});
