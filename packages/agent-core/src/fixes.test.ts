import assert from "node:assert/strict";
import test from "node:test";
import { directoryParent } from "./browse";
import { claudeAgent, claudeQueryOptions, claudeRuntime, mapClaudeSdkMessage, setClaudeQueryForTests, type SdkMapState } from "./local/claude";
import { cursorHistoryFromLines, cursorPrintArgs, mapCursorStreamLine, type CursorStreamState } from "./local/cursor";
import { grokRuntime, traeHistoryNote, traeSessionRoots } from "./local/more";
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
  const fresh = claudeQueryOptions({ cwd: "/tmp" });
  assert.equal("resume" in fresh, false);
  assert.equal("env" in fresh, false);
});

test("Claude is runnable from a local login and treats the API key as optional", () => {
  const missing = claudeRuntime({ cliFound: false, sdkPresent: false, keySource: "none", loggedIn: false, locale: "zh" });
  assert.equal(missing.runnable, false);
  assert.equal(missing.auth.state, "missing");
  assert.match(missing.auth.note, /不需要 API Key/);
  assert.equal(/必须/.test(missing.auth.note), false);

  const local = claudeRuntime({ cliFound: false, sdkPresent: true, keySource: "none", loggedIn: true, locale: "zh", loginDetail: "Claude account" });
  assert.equal(local.runnable, true);
  assert.equal(local.auth.state, "ok");
  assert.equal(local.auth.source, "login");
  assert.match(local.auth.note, /不需要 API Key/);

  const unsigned = claudeRuntime({ cliFound: true, sdkPresent: false, keySource: "none", loggedIn: false, locale: "en" });
  assert.equal(unsigned.runnable, true);
  assert.equal(unsigned.auth.state, "unknown");
  assert.match(unsigned.auth.note, /optional/i);

  const saved = claudeRuntime({ cliFound: true, sdkPresent: true, keySource: "file", loggedIn: false, locale: "en" });
  assert.equal(saved.auth.state, "ok");
  assert.equal(saved.auth.source, "file");
  assert.match(saved.auth.note, /optional/i);
});

test("Claude query receives a key only when the user configured one", async () => {
  let seen: Record<string, unknown> | undefined;
  setClaudeQueryForTests(async function* (args) {
    seen = args.options;
    yield { type: "result", session_id: "s", result: "ok" };
  });
  const ctx = { cliPath: "claude", model: "", dataDir: "/tmp", locale: "zh" as const };
  try {
    const withoutKey = [];
    for await (const event of claudeAgent.chat(
      { prompt: "hi", cwd: "/tmp" },
      "claude-sdk",
      { ...ctx, env: { ANTHROPIC_API_KEY: "should-not-pass" }, keySource: "none" },
      new AbortController().signal,
    )) withoutKey.push(event);
    assert.equal("env" in (seen ?? {}), false);
    assert.equal(withoutKey.some((event) => event.type === "done"), true);

    for await (const event of claudeAgent.chat(
      { prompt: "hi", cwd: "/tmp" },
      "claude",
      { ...ctx, env: { ANTHROPIC_API_KEY: "from-store" }, keySource: "file" },
      new AbortController().signal,
    )) void event;
    assert.equal((seen?.env as NodeJS.ProcessEnv | undefined)?.ANTHROPIC_API_KEY, "from-store");
  } finally {
    setClaudeQueryForTests(null);
  }
});

test("cursor-agent streams partial deltas and keeps tool input and output", () => {
  const args = cursorPrintArgs({ prompt: "hi", model: "composer-2", sessionId: "chat-1" });
  assert.equal(args.includes("--stream-partial-output"), true);
  assert.equal(args.includes("--output-format"), true);
  assert.equal(args.at(-1), "hi");
  assert.equal(args.includes("composer-2"), true);
  const state: CursorStreamState = { sessionId: "", sawPartial: false, sawText: false };
  const first = mapCursorStreamLine({ type: "assistant", session_id: "s1", timestamp_ms: 1, message: { content: [{ type: "text", text: "He" }] } }, state);
  const second = mapCursorStreamLine({ type: "assistant", session_id: "s1", timestamp_ms: 2, message: { content: [{ type: "text", text: "llo" }] } }, state);
  const duplicate = mapCursorStreamLine({ type: "assistant", session_id: "s1", timestamp_ms: 3, model_call_id: "mc", message: { content: [{ type: "text", text: "Hello" }] } }, state);
  const flush = mapCursorStreamLine({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "Hello" }] } }, state);
  const tool = mapCursorStreamLine({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "a.ts" }, result: { success: { content: "body" } } } } }, state);
  const again = mapCursorStreamLine({ type: "result", result: "Hello" }, state);
  assert.equal(first.some((event) => event.type === "text" && event.delta === "He"), true);
  assert.equal(second.some((event) => event.type === "text" && event.delta === "llo"), true);
  assert.equal(duplicate.some((event) => event.type === "text"), false);
  assert.equal(flush.some((event) => event.type === "text"), false);
  assert.equal(tool.some((event) => event.type === "tool" && event.input?.includes("a.ts") && event.output?.includes("body")), true);
  assert.equal(again.some((event) => event.type === "text"), false);
});

test("cursor transcripts keep thinking, tool input and tool output", () => {
  const lines = [
    JSON.stringify({ role: "assistant", message: { content: [{ type: "thinking", thinking: "plan the edit" }, { type: "text", text: "done" }, { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }] } }),
    JSON.stringify({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export const n = 1;" }] } }),
  ];
  const messages = cursorHistoryFromLines("s", lines, "2026-01-01T00:00:00.000Z");
  const blocks = messages.flatMap((message) => message.blocks);
  assert.equal(blocks.some((block) => block.type === "thinking" && block.text.includes("plan")), true);
  assert.equal(blocks.some((block) => block.type === "text" && block.text === "done"), true);
  const tool = blocks.find((block) => block.type === "tool");
  assert.equal(tool?.type === "tool" && tool.input?.includes("a.ts"), true);
  assert.equal(tool?.type === "tool" && tool.output?.includes("export const n"), true);
});

test("grok is ready only when api.x.ai accepts the key", () => {
  const down = grokRuntime({ cliFound: true, hasKey: true, probe: { ok: false, models: [], error: Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }) }, locale: "zh" });
  assert.equal(down.runnable, false);
  assert.match(down.auth.note, /api\.x\.ai/);
  assert.equal(down.auth.note.includes("xai-secret"), false);
  const bad = grokRuntime({ cliFound: false, hasKey: true, probe: { ok: false, models: [], status: 401 }, locale: "en" });
  assert.equal(bad.runnable, false);
  assert.equal(bad.auth.state, "missing");
  const up = grokRuntime({ cliFound: false, hasKey: true, probe: { ok: true, models: ["grok-4"] }, locale: "en" });
  assert.equal(up.runnable, true);
  assert.deepEqual(up.models, ["grok-4"]);
  const cli = grokRuntime({ cliFound: true, hasKey: false, probe: null, locale: "zh" });
  assert.equal(cli.runnable, true);
});

test("trae encrypted database is explained and plaintext roots stay separate", () => {
  assert.match(traeHistoryNote({ readableSessions: 0, encryptedDb: true, locale: "zh" }), /SQLCipher/);
  assert.equal(traeHistoryNote({ readableSessions: 1, encryptedDb: true, locale: "zh" }), "");
  assert.equal(traeHistoryNote({ readableSessions: 0, encryptedDb: false, locale: "en" }), "");
  const roots = traeSessionRoots({ TRAE_HOME: "/tmp/trae", TRAECLI_HOME: "/tmp/cli", LOCALAPPDATA: "/tmp/local" }, "/tmp/home");
  assert.equal(roots.some((root) => root.endsWith("/tmp/cli/sessions")), true);
  assert.equal(roots.some((root) => root.includes("database.db")), false);
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
