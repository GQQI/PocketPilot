import assert from "node:assert/strict";
import test from "node:test";
import { directoryParent } from "./browse";
import { claudeQueryOptions, mapClaudeSdkMessage, type SdkMapState } from "./local/claude";
import { isInternalCodexSession } from "./local/codex";
import { dedupeSessions } from "./local/dedupe";
import { classifyXaiFailure, groupTraeRecords, xaiDeltaEvents } from "./local/more";

test("drive roots parent to the drive list", () => {
  assert.equal(directoryParent("C:\\"), "");
  assert.equal(directoryParent("C:\\Windows"), "C:\\");
  assert.equal(directoryParent("D:\\Project"), "D:\\");
  assert.equal(directoryParent("/"), "");
  assert.equal(directoryParent("/home/user"), "/home");
  assert.equal(directoryParent(""), null);
});

test("identical history rows collapse to one session", () => {
  const rows = dedupeSessions([
    { id: "a", agentId: "cursor", title: "fix login", projectPath: "D:\\App", projectName: "App", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2, preview: "done", source: "cursor-ide" },
    { id: "a", agentId: "cursor", title: "fix login", projectPath: "D:\\App", projectName: "App", updatedAt: "2026-01-01T00:01:00.000Z", messageCount: 2, preview: "done", source: "pocketpilot" },
    { id: "b", agentId: "cursor", title: "fix login", projectPath: "D:\\App", projectName: "App", updatedAt: "2026-01-01T00:02:00.000Z", messageCount: 2, preview: "done", source: "pocketpilot" },
    { id: "c", agentId: "cursor", title: "other", projectPath: "D:\\App", projectName: "App", updatedAt: "2026-01-02T00:00:00.000Z", messageCount: 1, preview: "x", source: "cursor-ide" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, "a");
  assert.equal(rows[0]?.source, "cursor-ide");
  assert.equal(rows[1]?.id, "c");
});

test("codex chatcwd is filtered and real titles stay", () => {
  assert.equal(isInternalCodexSession("chatcwd", "hello", "D:\\App"), true);
  assert.equal(isInternalCodexSession("abc", "chatcwd", "D:\\App"), true);
  assert.equal(isInternalCodexSession("abc", "plan", "D:\\chatcwd"), true);
  assert.equal(isInternalCodexSession("abc", "look at chatcwd helper", "D:\\App"), false);
});

test("trae rollouts group into one conversation", () => {
  const grouped = groupTraeRecords([
    { id: "m1", threadId: "thread-1", cwd: "D:\\App", title: "first question", mtime: 1, preview: "" },
    { id: "m2", threadId: "thread-1", cwd: "D:\\App", title: "second question", mtime: 2, preview: "answer" },
    { id: "noise", threadId: "noise", cwd: "", title: "<system>", mtime: 3, preview: "" },
    { id: "empty", threadId: "empty", cwd: "", title: "", mtime: 4, preview: "" },
    { id: "other", threadId: "thread-2", cwd: "D:\\App", title: "another chat", mtime: 5, preview: "" },
  ]);
  assert.equal(grouped.length, 2);
  const first = grouped.find((row) => row.threadId === "thread-1");
  assert.equal(first?.title, "first question");
  assert.equal(first?.mtime, 2);
  assert.equal(first?.preview, "answer");
});

test("xAI failures name the cause and never echo a key", () => {
  const key = "xai-test-secret";
  assert.match(classifyXaiFailure({ key: "", locale: "zh" }), /XAI_API_KEY/);
  assert.match(classifyXaiFailure({ key, error: Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), locale: "zh" }), /api\.x\.ai/);
  assert.match(classifyXaiFailure({ key, status: 401, body: "invalid", locale: "zh" }), /无效/);
  assert.match(classifyXaiFailure({ key, error: Object.assign(new Error("slow"), { name: "TimeoutError" }), locale: "en" }), /Timed out/);
  assert.equal(JSON.stringify([
    classifyXaiFailure({ key, error: new Error("fetch failed"), locale: "zh" }),
    classifyXaiFailure({ key, status: 401, body: "nope", locale: "en" }),
  ]).includes(key), false);
});

test("xAI deltas expose reasoning and tool calls", () => {
  const open = new Map<number, string>();
  const events = xaiDeltaEvents({ reasoning_content: "think", content: "hi", tool_calls: [{ index: 0, function: { name: "shell", arguments: "ls" } }] }, open);
  assert.deepEqual(events.map((event) => event.type), ["thinking", "text", "tool"]);
  assert.equal(xaiDeltaEvents({ tool_calls: [{ index: 0, function: { arguments: "more" } }] }, open).length, 0);
});

test("Claude SDK query options stream partials and resume", () => {
  const env = { ANTHROPIC_API_KEY: "from-store" };
  const options = claudeQueryOptions({ cwd: "D:\\App", model: "sonnet", sessionId: "ses_1" }, env);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.resume, "ses_1");
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal((options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY, "from-store");
  const fresh = claudeQueryOptions({ cwd: "/tmp" }, {});
  assert.equal("resume" in fresh, false);
});

test("Claude SDK partial messages become text, thinking and tool events", () => {
  const state: SdkMapState = { sawPartial: false, sessionId: "", openTool: "" };
  const events = [
    ...mapClaudeSdkMessage({ type: "stream_event", session_id: "ses_9", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }, state),
    ...mapClaudeSdkMessage({ type: "stream_event", session_id: "ses_9", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read", input: { file_path: "a.ts" } } } }, state),
    ...mapClaudeSdkMessage({ type: "stream_event", session_id: "ses_9", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } }, state),
    ...mapClaudeSdkMessage({ type: "stream_event", session_id: "ses_9", event: { type: "content_block_stop" } }, state),
    ...mapClaudeSdkMessage({ type: "assistant", session_id: "ses_9", message: { content: [{ type: "text", text: "duplicate" }] } }, state),
    ...mapClaudeSdkMessage({ type: "result", session_id: "ses_9", usage: { input_tokens: 3, output_tokens: 4 } }, state),
  ];
  assert.equal(events.some((event) => event.type === "session" && event.id === "ses_9"), true);
  assert.equal(events.some((event) => event.type === "thinking" && event.delta === "hmm"), true);
  assert.equal(events.some((event) => event.type === "text" && event.delta === "ok"), true);
  assert.equal(events.some((event) => event.type === "text" && event.delta === "duplicate"), false);
  assert.equal(events.some((event) => event.type === "tool" && event.phase === "start" && event.name === "Read"), true);
  assert.equal(events.some((event) => event.type === "tool" && event.phase === "done"), true);
  assert.equal(events.some((event) => event.type === "usage" && event.input === 3), true);
});
