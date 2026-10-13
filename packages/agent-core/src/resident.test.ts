import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { StreamEvent } from "@pocketpilot/protocol";
import { ClaudeStreamWorker } from "./local/claude-stream";
import { CodexAppWorker } from "./local/codex-app";
import { CursorAcpWorker, resolveAcpModel } from "./local/cursor-acp";
import { envFingerprint, poolConfig, WorkerPool, type PooledWorker } from "./local/pool";

class FakeWorker implements PooledWorker {
  alive = true;
  disposed = false;
  constructor(readonly n: number) {}
  dispose(): void { this.disposed = true; this.alive = false; }
}

function fakePool(over: Partial<ReturnType<typeof poolConfig>> = {}, sharesSessions = true) {
  let n = 0;
  let clock = 1_000;
  const made: FakeWorker[] = [];
  const pool = new WorkerPool<FakeWorker>({
    sharesSessions,
    create: async () => { const w = new FakeWorker(++n); made.push(w); return w; },
    config: () => ({ enabled: true, idleMs: 10_000, maxWorkers: 4, spare: 1, ...over }),
    now: () => clock,
  });
  return { pool, made, tick: (ms: number) => { clock += ms; } };
}

test("pool reuses the worker that holds a session and keeps one warm spare", async () => {
  const { pool, made } = fakePool({}, false);
  const a = await pool.acquire("k", { cwd: "/p" });
  assert.equal(a.warm, false);
  a.bind("s1");
  a.release();
  await new Promise((r) => setImmediate(r));
  assert.equal(made.length, 2, "a spare was started after the turn");
  const again = await pool.acquire("k", { sessionId: "s1" });
  assert.equal(again.worker.n, 1, "same process for the same session");
  again.release();
  const fresh = await pool.acquire("k", {});
  assert.equal(fresh.worker.n, 2, "a new chat takes the warm spare");
  assert.equal(fresh.warm, true);
  fresh.release();
});

test("pool disposes idle workers after the timeout and replaces dead ones", async () => {
  const { pool, made, tick } = fakePool({ spare: 0 });
  const a = await pool.acquire("k");
  a.release();
  tick(20_000);
  pool.sweep();
  assert.equal(made[0].disposed, true);
  const b = await pool.acquire("k");
  assert.equal(b.worker.n, 2);
  b.worker.alive = false; // crashed
  b.release();
  const c = await pool.acquire("k");
  assert.equal(c.worker.n, 3, "a crashed worker is not handed out again");
  c.release();
});

test("pool stays within maxWorkers and can be switched off", async () => {
  const { pool, made } = fakePool({ maxWorkers: 1, spare: 0 });
  const a = await pool.acquire("a");
  const b = await pool.acquire("b");
  a.release();
  b.release();
  assert.equal(made.filter((w) => !w.disposed).length, 1);
  assert.equal(poolConfig({ POCKETPILOT_RESIDENT: "0" }).enabled, false);
  assert.equal(poolConfig({ POCKETPILOT_POOL_IDLE_MS: "5000" }).idleMs, 5000);
  assert.notEqual(envFingerprint({ K: "a" }, ["K"]), envFingerprint({ K: "b" }, ["K"]));
  assert.ok(!envFingerprint({ K: "secret-value" }, ["K"]).includes("secret"));
});

const ACP_MODELS = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "gpt-5.5[context=272k,reasoning=medium,fast=false]", name: "gpt-5.5" },
  { modelId: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]", name: "claude-opus-5" },
  { modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]", name: "claude-opus-5-5" },
  { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
];

test("CLI model ids map onto ACP model parameters", () => {
  assert.equal(resolveAcpModel("auto", ACP_MODELS), "default[]");
  assert.equal(resolveAcpModel("gpt-5.5-high-fast", ACP_MODELS), "gpt-5.5[context=272k,reasoning=high,fast=true]");
  assert.equal(resolveAcpModel("gpt-5.5-extra-high", ACP_MODELS), "gpt-5.5[context=272k,reasoning=xhigh,fast=false]");
  assert.equal(resolveAcpModel("claude-opus-5-5-low", ACP_MODELS), "claude-opus-5-5[context=300k,effort=low,fast=false]", "longest base name wins");
  assert.equal(resolveAcpModel("claude-opus-5-thinking-max-fast", ACP_MODELS), "claude-opus-5[thinking=true,context=300k,effort=max,fast=true]");
  assert.equal(resolveAcpModel("composer-2.5", ACP_MODELS), "composer-2.5[fast=true]");
  assert.equal(resolveAcpModel("unknown-model", ACP_MODELS), null);
});

/** A tiny stand-in CLI: `<cli> acp` or `<cli> app-server` speaking newline-delimited JSON-RPC. */
function fakeCli(script: string): { cli: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-fake-"));
  const js = path.join(dir, "fake.mjs");
  const log = path.join(dir, "starts.log");
  writeFileSync(js, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "start\\n");\n${script}`);
  if (process.platform === "win32") {
    const cli = path.join(dir, "fake.cmd");
    writeFileSync(cli, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    return { cli, log };
  }
  const cli = path.join(dir, "fake");
  writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(cli, 0o755);
  return { cli, log };
}

const RPC_PRELUDE = `
import readline from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let nextId = 1000; const waiting = new Map();
const ask = (method, params) => new Promise((r) => { const id = nextId++; waiting.set(id, r); out({ id, method, params }); });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  await handle(m);
});
`;

const FAKE_ACP = RPC_PRELUDE + `
let n = 0; const models = ${JSON.stringify(ACP_MODELS)};
async function handle(m) {
  if (m.method === "initialize") return out({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] } });
  if (m.method === "authenticate") return out({ id: m.id, result: {} });
  if (m.method === "session/new") return out({ id: m.id, result: { sessionId: "s" + (++n), models: { currentModelId: "default[]", availableModels: models } } });
  if (m.method === "session/load") return out({ id: m.id, error: { code: -32602, message: "Invalid params", data: { message: "unknown session" } } });
  if (m.method === "session/set_model") { process.stderr.write("model " + m.params.modelId + "\\n"); return out({ id: m.id, result: {} }); }
  if (m.method === "session/prompt") {
    const sessionId = m.params.sessionId;
    const up = (u) => out({ method: "session/update", params: { sessionId, update: u } });
    up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    const perm = await ask("session/request_permission", { sessionId, options: [{ optionId: "reject-once", kind: "reject_once" }, { optionId: "allow-always", kind: "allow_always" }] });
    up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "pending" });
    up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" + m.params.prompt[0].text + ":" + perm.outcome.optionId } });
    return out({ id: m.id, result: { stopReason: "end_turn" } });
  }
}
`;

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const textOf = (events: StreamEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
const starts = async (log: string) => (await import("node:fs")).readFileSync(log, "utf8").trim().split("\n").length;

test("Cursor ACP worker: one process, two messages, permissions answered, model switched", async () => {
  const { cli, log } = fakeCli(FAKE_ACP);
  const w = await CursorAcpWorker.start(cli, process.env, tmpdir());
  try {
    const signal = new AbortController().signal;
    const first = await collect(w.prompt({ cwd: tmpdir(), prompt: "one" }, signal));
    assert.equal(textOf(first), "echo:one:allow-always");
    const sid = (first.find((e) => e.type === "session") as { id: string }).id;
    assert.ok(first.some((e) => e.type === "thinking"));
    assert.ok(first.some((e) => e.type === "tool" && e.phase === "start" && e.name === "execute"));
    assert.ok(first.some((e) => e.type === "tool" && e.phase === "done"));
    const second = await collect(w.prompt({ sessionId: sid, cwd: tmpdir(), prompt: "two", model: "gpt-5.5-high" }, signal));
    assert.equal(textOf(second), "echo:two:allow-always");
    assert.equal((second.find((e) => e.type === "session") as { id: string }).id, sid, "same session continues");
    // an unknown session (e.g. from the IDE) falls back to a new one instead of failing
    const third = await collect(w.prompt({ sessionId: "ide-chat", cwd: tmpdir(), prompt: "three" }, signal));
    assert.equal(textOf(third), "echo:three:allow-always");
    assert.equal(await starts(log), 1, "the CLI started once for all messages");
  } finally {
    w.dispose();
  }
});

const FAKE_CODEX = RPC_PRELUDE + `
let n = 0;
async function handle(m) {
  if (m.method === "initialize") return out({ id: m.id, result: { userAgent: "fake" } });
  if (m.method === "initialized") return;
  if (m.method === "thread/start") return out({ id: m.id, result: { thread: { id: "th" + (++n) }, model: m.params.model ?? "x" } });
  if (m.method === "thread/resume") return out({ id: m.id, result: { thread: { id: m.params.threadId } } });
  if (m.method === "turn/start") {
    const threadId = m.params.threadId;
    out({ id: m.id, result: { turn: { id: "tu1", status: "inProgress" } } });
    const text = m.params.input[0].text;
    if (text === "fail") { out({ method: "error", params: { threadId, error: { message: "usage limit" }, willRetry: false } }); return out({ method: "turn/completed", params: { threadId, turn: { id: "tu1", status: "failed", error: { message: "You've hit your usage limit" } } } }); }
    await ask("item/commandExecution/requestApproval", { threadId });
    out({ method: "item/started", params: { threadId, item: { type: "commandExecution", command: "ls" } } });
    out({ method: "item/completed", params: { threadId, item: { type: "commandExecution", command: "ls" } } });
    out({ method: "item/agentMessage/delta", params: { threadId, delta: "re:" } });
    out({ method: "item/agentMessage/delta", params: { threadId, delta: text } });
    out({ method: "item/agentMessage/delta", params: { threadId: "other", delta: "LEAK" } });
    return out({ method: "turn/completed", params: { threadId, turn: { id: "tu1", status: "completed", error: null } } });
  }
}
`;

test("Codex app-server worker: threads reused, deltas streamed, failures reported", async () => {
  const { cli, log } = fakeCli(FAKE_CODEX);
  const w = await CodexAppWorker.start(cli, process.env, tmpdir());
  try {
    const signal = new AbortController().signal;
    const a = await collect(w.prompt({ cwd: tmpdir(), prompt: "hi" }, signal));
    assert.equal(textOf(a), "re:hi");
    assert.ok(a.some((e) => e.type === "tool" && e.name === "shell"));
    const tid = (a.find((e) => e.type === "session") as { id: string }).id;
    const b = await collect(w.prompt({ sessionId: tid, cwd: tmpdir(), prompt: "again" }, signal));
    assert.equal(textOf(b), "re:again");
    const c = await collect(w.prompt({ sessionId: tid, cwd: tmpdir(), prompt: "fail" }, signal));
    assert.match((c.find((e) => e.type === "error") as { message: string }).message, /usage limit/);
    assert.equal(await starts(log), 1);
  } finally {
    w.dispose();
  }
});

test("Claude streaming worker: one query() for several messages, model switched in place", async () => {
  let calls = 0;
  const models: (string | undefined)[] = [];
  const query = ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    calls++;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: "cs1" };
      for await (const msg of prompt) {
        const text = String((msg.message as { content: string }).content);
        yield { type: "assistant", session_id: "cs1", message: { content: [{ type: "text", text: `ok:${text}` }] } };
        yield { type: "result", session_id: "cs1", subtype: "success", result: `ok:${text}` };
      }
    })();
    return Object.assign(gen, { setModel: async (m?: string) => { models.push(m); }, interrupt: async () => undefined });
  };
  const w = new ClaudeStreamWorker(query, { cwd: tmpdir() });
  const map = (m: Record<string, unknown>): StreamEvent[] => (m.type === "assistant" ? [{ type: "text", delta: String(((m.message as { content: { text: string }[] }).content[0]).text) }] : []);
  const signal = new AbortController().signal;
  assert.equal(textOf(await collect(w.prompt({ prompt: "a" }, map, signal))), "ok:a");
  assert.equal(textOf(await collect(w.prompt({ prompt: "b", model: "opus" }, map, signal))), "ok:b");
  assert.equal(calls, 1);
  assert.deepEqual(models, ["opus"]);
  assert.equal(w.sessionId, "cs1");
  w.dispose();
  assert.equal(w.alive, false);
});
