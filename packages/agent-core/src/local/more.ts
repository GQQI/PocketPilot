import type { AgentTestResult } from "@pocketpilot/protocol";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, StreamEvent } from "@pocketpilot/protocol";
import { baseName, cap, exists, fileUriToPath, findExecutable, home, isDir, listDir, normPath, oneLine, readLines, runCapture, runStream, safeStat, startOfToday, tryJson } from "./util";
import { childEnv, interpretCliLogin } from "./login";
import { dailyTotals, emptyBucket, unsupportedUsage, type AgentCtx, type Detection, type LocalAgent } from "./types";

/* =====================================================================================
 * Trae CN (ByteDance, China build of the Trae IDE)
 *  - IDE: VS Code fork. Folders opened in it are listed in %APPDATA%/Trae CN/User/workspaceStorage/<hash>/workspace.json (readable).
 *    Its AI chat history lives in ModularData/ai-agent/database.db, which is SQLCipher-encrypted -> NOT readable, so no IDE sessions.
 *  - CLI (separate product "TRAE CLI", binary traex / traecli): Codex-like rollouts under ~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *    Headless: `traecli exec --json`, resume with `resume <id>`. (Not installed on this PC when this was written: CLI parts are unverified.)
 * =================================================================================== */
const traeDirs = () => {
  const roaming = process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
  return ["Trae CN", "Trae"].map((n) => path.join(roaming, n)).filter((d) => exists(d));
};
const traeCliRoot = () => path.join(process.env.TRAE_HOME || path.join(home(), ".trae"), "cli", "sessions");

/** Plaintext session roots. The IDE database is not one of them. */
export function traeSessionRoots(env: NodeJS.ProcessEnv = process.env, homeDir = home()): string[] {
  const local = env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
  const roots = [
    path.join(env.TRAE_HOME || path.join(homeDir, ".trae"), "cli", "sessions"),
    env.TRAECLI_HOME ? path.join(env.TRAECLI_HOME, "sessions") : "",
    path.join(homeDir, ".trae-cn", "cli", "sessions"),
    path.join(homeDir, ".cache", "coco", "sessions"),
    path.join(local, "coco", "sessions"),
  ];
  return [...new Set(roots.filter(Boolean))];
}

export function traeHistoryNote(input: { readableSessions: number; encryptedDb: boolean; locale: "zh" | "en" }): string {
  if (input.readableSessions > 0 || !input.encryptedDb) return "";
  return input.locale === "en"
    ? "Trae CN keeps IDE chats in an encrypted database (ModularData/ai-agent/database.db, SQLCipher). PocketPilot cannot decrypt it, so those chats are not listed and none are invented. TRAE CLI sessions are plain JSONL under ~/.trae/cli/sessions (or TRAE_HOME / TRAECLI_HOME) and show up here."
    : "Trae CN 编辑器里的会话在加密库 ModularData/ai-agent/database.db（SQLCipher）中。PocketPilot 不能解密，所以不会列出这些会话，也不会编造记录。TRAE CLI 的明文会话在 ~/.trae/cli/sessions（或 TRAE_HOME、TRAECLI_HOME），能读到就会出现在这里。";
}

function traeWorkspaces(): string[] {
  const out: string[] = [];
  for (const base of traeDirs()) {
    const ws = path.join(base, "User", "workspaceStorage");
    for (const h of listDir(ws)) {
      try {
        const j = JSON.parse(readFileSync(path.join(ws, h, "workspace.json"), "utf8")) as { folder?: string };
        const p = j.folder ? fileUriToPath(j.folder) : null;
        if (p && !out.some((x) => normPath(x) === normPath(p))) out.push(p);
      } catch { /* empty window */ }
    }
  }
  return out;
}

const TRAE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function traeRollouts(): { file: string; id: string; threadHint: string; mtime: number }[] {
  const out: { file: string; id: string; threadHint: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const n of listDir(dir)) {
      const full = path.join(dir, n);
      if (isDir(full)) {
        if (depth < 6) walk(full, depth + 1);
        continue;
      }
      if (!n.endsWith(".jsonl") || depth < 1) continue;
      const st = safeStat(full);
      if (!st) continue;
      const fileUuid = TRAE_UUID.exec(n)?.[0] ?? "";
      const parent = path.basename(dir);
      const parentUuid = TRAE_UUID.test(parent) ? parent : "";
      const id = fileUuid || parentUuid || n.replace(/\.jsonl$/, "");
      out.push({ file: full, id, threadHint: parentUuid || fileUuid || id, mtime: st.mtimeMs });
    }
  };
  for (const root of traeSessionRoots()) if (exists(root)) walk(root, 0);
  return out;
}

function traeEncryptedDb(): boolean {
  return traeDirs().some((base) => exists(path.join(base, "ModularData", "ai-agent", "database.db")));
}

export interface TraeRecord {
  id: string;
  threadId: string;
  cwd: string;
  title: string;
  mtime: number;
  preview: string;
}

/** Collapse per-message / per-rollout rows into one conversation. Untitled and injected system rows are dropped. */
export function groupTraeRecords(records: TraeRecord[]): TraeRecord[] {
  const groups = new Map<string, TraeRecord>();
  for (const raw of records) {
    const title = raw.title.trim();
    if (!title || title.startsWith("<")) continue;
    const key = raw.threadId || raw.id;
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, { ...raw, threadId: key, title });
      continue;
    }
    const newer = raw.mtime >= prev.mtime;
    groups.set(key, {
      ...prev,
      threadId: key,
      mtime: Math.max(prev.mtime, raw.mtime),
      cwd: raw.cwd || prev.cwd,
      title: prev.title || title,
      preview: newer && raw.preview ? raw.preview : prev.preview || raw.preview,
    });
  }
  return [...groups.values()];
}

function msgText(content: unknown): string {
  return (Array.isArray(content) ? content : []).map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
}

async function traeMeta(file: string): Promise<{ cwd: string; title: string; threadId: string; preview: string }> {
  let cwd = "", title = "", threadId = "", preview = "", n = 0;
  for await (const line of readLines(file)) {
    const j = tryJson(line);
    const p = j?.payload as Record<string, unknown> | undefined;
    if (j?.type === "session_meta" && p) {
      if (typeof p.cwd === "string") cwd = p.cwd;
      const id = p.id ?? p.session_id ?? p.thread_id ?? p.conversation_id;
      if (typeof id === "string" && id) threadId = id;
    }
    if (j?.type === "response_item" && p?.type === "message" && p.role === "user" && !title) {
      const t = msgText(p.content).trim();
      if (t && !t.startsWith("<")) title = oneLine(t, 80);
    }
    if (j?.type === "response_item" && p?.type === "message" && p.role === "assistant" && !preview) {
      const t = msgText(p.content).trim();
      if (t) preview = oneLine(t, 100);
    }
    if (title && preview && threadId) break;
    if (++n > 200) break;
  }
  return { cwd, title, threadId, preview };
}

export const traeAgent: LocalAgent = {
  id: "trae-cn",
  history: true,
  async detect(ctx): Promise<Detection> {
    const explicit = ctx.cliPath && ctx.cliPath !== "traex" ? ctx.cliPath : undefined;
    const found = findExecutable(["traex", "traecli", "trae-cli"], [path.join(home(), ".local", "bin"), path.join(home(), ".trae", "bin"), path.join(process.env.APPDATA ?? "", "npm")], explicit);
    let version: string | null = null;
    if (found) {
      const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 10000 });
      version = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
    }
    const ide = traeDirs().length > 0;
    const readable = traeRollouts().length;
    const encrypted = traeEncryptedDb();
    const jwt = exists(path.join(home(), ".trae-cn", "trae-jwt-token")) || exists(path.join(home(), ".trae", "trae-jwt-token"));
    const zh = ctx.locale !== "en";
    const locked = traeHistoryNote({ readableSessions: readable, encryptedDb: encrypted, locale: ctx.locale });
    const bin = found ? path.basename(found, path.extname(found)) : "traecli";
    const loginCommand = `${bin} login`;
    const auth = found
      ? { state: "unknown" as const, source: "cli", loginCommand, note: zh ? `登录由 ${bin} 自己保存。未登录时请在电脑上运行 ${loginCommand}。PocketPilot 不注入密钥。` : `Login is stored by ${bin}. If you are not signed in, run ${loginCommand} on this PC.` }
      : ide
        ? { state: jwt ? ("ok" as const) : ("unknown" as const), source: "ide", note: locked || (zh ? `Trae CN 编辑器${jwt ? "已登录（只检查令牌文件是否存在，不读取内容）" : "（未发现登录令牌）"}。编辑器没有命令行或接口可从手机调用` : "Trae CN IDE found; it exposes no CLI/API to drive from the phone") }
        : { state: "missing" as const, source: "none", note: zh ? "未发现 Trae CN 或 TRAE CLI" : "Neither Trae CN nor TRAE CLI found" };
    return { cliPath: found, version: version ? cap(version, 80) : null, hasHistory: readable > 0, seen: ide || readable > 0, historyNote: locked, auth, dataPath: traeDirs()[0] ?? traeCliRoot() };
  },
  async sessions(): Promise<AgentSession[]> {
    const records: TraeRecord[] = [];
    for (const r of traeRollouts()) {
      const m = await traeMeta(r.file);
      records.push({ id: r.id, threadId: m.threadId || r.threadHint, cwd: m.cwd, title: m.title, mtime: r.mtime, preview: m.preview });
    }
    return groupTraeRecords(records)
      .sort((a, b) => b.mtime - a.mtime)
      .map((r) => ({ id: r.threadId, agentId: "trae-cn", title: r.title, projectPath: r.cwd, projectName: r.cwd ? baseName(r.cwd) : "", updatedAt: new Date(r.mtime).toISOString(), messageCount: -1, preview: r.preview, source: "trae-cli" }));
  },
  async extraProjects(): Promise<string[]> {
    return traeWorkspaces();
  },
  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const files: { file: string; mtime: number }[] = [];
    for (const r of traeRollouts()) {
      const m = await traeMeta(r.file);
      const thread = m.threadId || r.threadHint;
      if (thread === sessionId || r.id === sessionId) files.push({ file: r.file, mtime: r.mtime });
    }
    files.sort((a, b) => a.mtime - b.mtime);
    if (!files.length) return [];
    const out: ChatMessage[] = [];
    let n = 0;
    for (const r of files) for await (const line of readLines(r.file)) {
      const j = tryJson(line);
      const p = j?.payload as Record<string, unknown> | undefined;
      if (j?.type !== "response_item" || !p) continue;
      const createdAt = String(j.timestamp ?? "");
      if (p.type === "reasoning" || p.type === "thinking") {
        const thought = msgText(p.content).trim() || (typeof p.text === "string" ? p.text.trim() : "");
        if (thought) out.push({ id: `${sessionId}_${n++}`, role: "assistant", createdAt, blocks: [{ type: "thinking", text: cap(thought, 20000) }] });
        continue;
      }
      if (p.type === "function_call" || p.type === "tool_call" || p.type === "tool_use") {
        const name = String(p.name ?? "tool");
        const input = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : "";
        const output = typeof p.output === "string" ? p.output : "";
        out.push({ id: `${sessionId}_${n++}`, role: "assistant", createdAt, blocks: [{ type: "tool", name, detail: oneLine(input || name, 160), status: "done", ...(input ? { input: cap(input, 20000) } : {}), ...(output ? { output: cap(output, 20000) } : {}) }] });
        continue;
      }
      if (p.type !== "message") continue;
      const role = p.role === "user" ? "user" as const : p.role === "assistant" ? "assistant" as const : null;
      const text = msgText(p.content).trim();
      if (!role || !text || (role === "user" && text.startsWith("<"))) continue;
      out.push({ id: `${sessionId}_${n++}`, role, createdAt, blocks: [{ type: "text", text: cap(text, 20000) }] });
    }
    return out.slice(-limit);
  },
  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (req.model) args.push("-m", req.model);
    if (req.sessionId) args.push("resume", req.sessionId);
    args.push(req.prompt);
    let exit: { code: number | null; stderr: string } | null = null;
    let any = false;
    for await (const item of runStream(cli, args, { cwd: req.cwd, env: ctx.env, json: true, signal })) {
      if (item.kind === "exit") { exit = item; break; }
      if (item.kind === "text") { any = true; yield { type: "text", delta: item.text }; continue; }
      const v = item.value;
      if (v.type === "thread.started" && typeof v.thread_id === "string") yield { type: "session", id: v.thread_id };
      const it = v.item as { type?: string; text?: string } | undefined;
      if (v.type === "item.completed" && it?.type === "agent_message" && it.text) { any = true; yield { type: "text", delta: it.text }; }
      if (v.type === "error" || v.type === "turn.failed") {
        const m = (v.message ?? (v.error as { message?: string } | undefined)?.message) as string | undefined;
        if (m) { yield { type: "error", message: cap(m, 500) }; return; }
      }
    }
    if (exit && exit.code !== 0 && !any) { yield { type: "error", message: cap(exit.stderr.trim() || `traecli exit ${exit.code}`, 500) }; return; }
    yield { type: "done" };
  },
  async usage(): Promise<AgentUsage> {
    return unsupportedUsage("Trae CN", "Trae CN 的对话记录在加密数据库（SQLCipher）里，TRAE CLI 也没有公开的本地用量统计，PocketPilot 读不到 token 和费用。请在 Trae 账号页查看。");
  },
};

/* =====================================================================================
 * Grok (xAI)
 *  - API: POST https://api.x.ai/v1/chat/completions (OpenAI-compatible, streaming, returns usage). Plain chat, no file tools.
 *  - CLI "Grok Build" (`grok`, install: irm https://x.ai/cli/install.ps1 | iex): headless `grok -p <prompt> --cwd <dir>`; resume with -r.
 *  When XAI_API_KEY is set the API is used (real token usage); otherwise the CLI if present.
 * =================================================================================== */
const XAI = "https://api.x.ai/v1";
const GROK_STORE = "grok-chats.json";
const GROK_USAGE = "grok-usage.jsonl";
interface GrokChat { id: string; cwd: string; title: string; updatedAt: string; messages: { role: "user" | "assistant"; text: string; at: string; thinking?: string }[] }

function grokRead(dir: string): GrokChat[] {
  try { return JSON.parse(readFileSync(path.join(dir, GROK_STORE), "utf8")) as GrokChat[]; } catch { return []; }
}
function grokWrite(dir: string, list: GrokChat[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, GROK_STORE), JSON.stringify(list.slice(0, 200)));
}

/** Persist the turn even when the API fails, so the session still shows up in history. */
function grokRemember(dir: string, id: string, cwd: string, prompt: string, assistant: string | null, thinking = ""): void {
  if (exists(path.join(dir, "no-history"))) return;
  try {
    const list = grokRead(dir);
    const now = new Date().toISOString();
    let chat = list.find((c) => c.id === id);
    if (!chat) {
      chat = { id, cwd, title: oneLine(prompt, 60), updatedAt: now, messages: [{ role: "user", text: prompt, at: now }] };
      list.unshift(chat);
    } else if (assistant === null) {
      const last = chat.messages.at(-1);
      if (!(last?.role === "user" && last.text === prompt)) chat.messages.push({ role: "user", text: prompt, at: now });
    }
    if (assistant !== null) {
      const last = chat.messages.at(-1);
      if (last?.role === "assistant") { last.text = assistant; if (thinking) last.thinking = thinking; }
      else chat.messages.push({ role: "assistant", text: assistant, at: now, ...(thinking ? { thinking } : {}) });
    }
    chat.updatedAt = now;
    grokWrite(dir, list);
  } catch {
    /* history is best effort */
  }
}

const XAI_TIMEOUT_MS = 600_000;

/** Turn a raw xAI failure into a specific cause. Never includes the key. */
export function classifyXaiFailure(input: { key: string; error?: unknown; status?: number; body?: string; locale: "zh" | "en" }): string {
  const zh = input.locale !== "en";
  if (!input.key) return zh ? "没有 XAI_API_KEY。请在设置里保存密钥，或在电脑上配置环境变量。" : "No XAI_API_KEY. Save one in Settings, or set it in the PC environment.";
  const err = input.error instanceof Error ? input.error : null;
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const blob = `${err?.name ?? ""} ${err?.message ?? ""} ${cause?.code ?? ""} ${input.body ?? ""}`;
  if (input.status === 401 || input.status === 403 || /invalid.?api.?key|incorrect api key/i.test(blob)) {
    return zh ? "XAI_API_KEY 无效或已被吊销（401/403）。请在设置里更换密钥。" : "XAI_API_KEY is invalid or revoked (401/403). Replace it in Settings.";
  }
  if (err?.name === "TimeoutError" || input.status === 408 || input.status === 504 || /timeout|timed out|ETIMEDOUT/i.test(blob)) {
    return zh ? "连接 api.x.ai 超时。推理模型可能较慢；若反复超时，请检查这台电脑的网络。" : "Timed out reaching api.x.ai. Reasoning models can be slow; if this keeps happening, check this PC's network.";
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|UND_ERR|network|getaddrinfo/i.test(blob)) {
    return zh
      ? "连不上 api.x.ai（网络错误，不是密钥写错）。这台电脑必须能访问 api.x.ai；国内网络经常访问不到。"
      : "Cannot reach api.x.ai (network error, not a bad key). This PC must be able to reach api.x.ai.";
  }
  const detail = cap((input.body || err?.message || "request failed").replace(/\s+/g, " "), 180);
  return input.status ? `xAI API ${input.status}: ${detail}` : `xAI API: ${detail}`;
}

/** Map one OpenAI-compatible stream delta (content, reasoning_content, tool_calls) to PocketPilot events. */
export function xaiDeltaEvents(delta: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] } | undefined, open: Map<number, string>): StreamEvent[] {
  if (!delta) return [];
  const events: StreamEvent[] = [];
  if (delta.reasoning_content) events.push({ type: "thinking", delta: delta.reasoning_content });
  if (delta.content) events.push({ type: "text", delta: delta.content });
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0;
    const name = call.function?.name || open.get(index) || "tool";
    if (!open.has(index)) {
      open.set(index, name);
      events.push({ type: "tool", phase: "start", name, detail: oneLine(call.function?.arguments ?? "", 120) });
    }
  }
  return events;
}
export interface XaiProbe { ok: boolean; models: string[]; status?: number; error?: unknown }

/**
 * A saved key counts as ready only after api.x.ai accepts it.
 * No key: the local grok CLI can still run. A failed probe is not "ready".
 */
export function grokRuntime(input: { cliFound: boolean; cliLoggedIn?: boolean; hasKey: boolean; probe: XaiProbe | null; locale: "zh" | "en" }): { runnable: boolean; models: string[]; useKey: boolean; auth: { state: "ok" | "missing" | "unknown"; source: string; note: string; loginCommand?: string } } {
  const zh = input.locale !== "en";
  const loginCommand = input.cliFound ? "grok login" : "";
  if (input.cliFound && input.cliLoggedIn) {
    return {
      runnable: true,
      models: [],
      useKey: false,
      auth: {
        state: "ok",
        source: "login",
        loginCommand,
        note: zh ? "已使用本机 grok 登录。保存的 XAI_API_KEY 不会传给进程，也不会改走 api.x.ai。" : "Using the local grok login. A saved XAI_API_KEY is not passed in and api.x.ai is not used.",
      },
    };
  }
  if (input.hasKey) {
    if (input.probe?.ok) {
      const n = input.probe.models.length;
      const why = input.cliFound
        ? (zh ? "本机 grok 未登录，所以使用备用密钥。" : "The local grok CLI is not signed in, so the backup key is used.")
        : (zh ? "这台电脑没有可登录的 grok 命令行。xAI 接口使用 XAI_API_KEY；安装官方 grok 并登录后会优先用登录态，并不再注入密钥。" : "This PC has no grok CLI to sign in to, so xAI uses XAI_API_KEY. If you install the official grok CLI and sign in, that login is used and the key is not injected.");
      return { runnable: true, models: input.probe.models, useKey: true, auth: { state: "ok", source: "env", loginCommand, note: zh ? `已连通 api.x.ai，密钥有效${n ? `，${n} 个模型` : ""}。${why}` : `Reached api.x.ai with a valid key${n ? `, ${n} models` : ""}. ${why}` } };
    }
    const note = classifyXaiFailure({ key: "configured", error: input.probe?.error, status: input.probe?.status, locale: input.locale });
    const authFail = input.probe?.status === 401 || input.probe?.status === 403;
    const extra = input.cliFound ? (zh ? ` 也可在电脑上运行 ${loginCommand}。` : ` Or run ${loginCommand} on this PC.`) : "";
    return { runnable: false, models: [], useKey: false, auth: { state: authFail ? "missing" : "unknown", source: "none", loginCommand, note: zh ? `${note} 因此不会标成可对话。${extra}` : `${note} Not marked ready.${extra}` } };
  }
  if (input.cliFound) {
    return { runnable: false, models: [], useKey: false, auth: { state: "missing", source: "cli", loginCommand, note: zh ? `grok 未登录，也没有备用密钥。请在电脑上运行 ${loginCommand}。` : `grok is not signed in and no backup key is saved. Run ${loginCommand} on this PC.` } };
  }
  return { runnable: false, models: [], useKey: false, auth: { state: "missing", source: "none", loginCommand: "", note: zh ? "没有可登录的 grok 命令行，也没有 XAI_API_KEY。xAI 只能用密钥，或先安装官方 grok 再登录。" : "No grok CLI to sign in to, and no XAI_API_KEY. xAI needs a key, or install the official grok CLI and sign in." } };
}

let grokLoginMemo: { at: number; key: string; ok: boolean } | null = null;

async function grokCliLoggedIn(cli: string, ctx: AgentCtx): Promise<boolean> {
  if (grokLoginMemo && grokLoginMemo.key === cli && Date.now() - grokLoginMemo.at < 60_000) return grokLoginMemo.ok;
  const env = childEnv(ctx.env, ["XAI_API_KEY"], false);
  const r = await runCapture(cli, ["auth", "status"], { env, timeoutMs: 8000 }).catch(() => null);
  const kind = r ? interpretCliLogin(`${r.stdout}\n${r.stderr}`, r.code ?? 1) : "unknown";
  const ok = kind === "in";
  grokLoginMemo = { at: Date.now(), key: cli, ok };
  return ok;
}

let xaiProbeCache: { at: number; key: string; probe: XaiProbe } | null = null;

async function probeXai(key: string): Promise<XaiProbe> {
  const now = Date.now();
  if (xaiProbeCache && xaiProbeCache.key === key && now - xaiProbeCache.at < (xaiProbeCache.probe.ok ? 60_000 : 15_000)) return xaiProbeCache.probe;
  let probe: XaiProbe;
  try {
    const res = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      probe = { ok: false, models: [], status: res.status, error: new Error(body.includes(key) ? `HTTP ${res.status}` : body.slice(0, 180)) };
    } else {
      const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      probe = { ok: true, models: (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean) };
    }
  } catch (error) {
    probe = { ok: false, models: [], error };
  }
  xaiProbeCache = { at: now, key, probe };
  return probe;
}

export const grokAgent: LocalAgent = {
  id: "grok",
  history: true,
  async detect(ctx): Promise<Detection> {
    const explicit = ctx.cliPath && ctx.cliPath !== "grok" ? ctx.cliPath : undefined;
    const found = findExecutable(["grok"], [path.join(home(), ".grok", "bin"), path.join(home(), ".local", "bin")], explicit);
    let version: string | null = null;
    if (found) {
      const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 10000 });
      version = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
    }
    const cliLoggedIn = found ? await grokCliLoggedIn(found, ctx) : false;
    const key = cliLoggedIn ? "" : (ctx.env.XAI_API_KEY ?? "");
    const probe = key ? await probeXai(key) : null;
    const runtime = grokRuntime({ cliFound: Boolean(found), cliLoggedIn, hasKey: Boolean(key), probe, locale: ctx.locale });
    return {
      cliPath: runtime.runnable ? (runtime.useKey ? found ?? "xai-api" : found) : (runtime.auth.state === "missing" ? found : null),
      version: runtime.runnable && key && !found ? "xAI API" : version ? cap(version, 80) : null,
      hasHistory: grokRead(ctx.dataDir).length > 0,
      auth: runtime.auth,
      dataPath: path.join(ctx.dataDir, GROK_STORE),
      models: runtime.models,
    };
  },
  async test(ctx, _cli): Promise<AgentTestResult> {
    const zh = ctx.locale !== "en";
    if (grokLoginMemo?.ok) return { ok: true, message: zh ? "grok 命令行已登录。保存的密钥不会覆盖这次登录。" : "The grok CLI is signed in. A saved key is not applied over that login." };
    const key = ctx.env.XAI_API_KEY ?? "";
    if (!key) return { ok: false, message: zh ? "grok 未登录，也没有备用密钥。请运行 grok login，或保存 XAI_API_KEY。" : "grok is not signed in and no backup key is saved. Run grok login, or save an XAI_API_KEY." };
    try {
      const res = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { data?: unknown[] };
        xaiProbeCache = null;
        const n = j.data?.length ?? 0;
        return { ok: true, message: zh ? `连接成功，密钥有效，可用模型 ${n} 个。` : `Connected. The key is valid, ${n} models available.` };
      }
      const hint = res.status === 400 || res.status === 401 || res.status === 403 ? (zh ? "密钥无效或已被吊销。" : "The key is invalid or revoked.") : `HTTP ${res.status}`;
      return { ok: false, message: zh ? `xAI 拒绝了请求：${hint}` : `xAI rejected the request: ${hint}` };
    } catch (error) {
      return { ok: false, message: classifyXaiFailure({ key, error, locale: ctx.locale }) };
    }
  },

  async sessions(ctx): Promise<AgentSession[]> {
    return grokRead(ctx.dataDir).map((c) => ({ id: c.id, agentId: "grok", title: c.title, projectPath: c.cwd, projectName: baseName(c.cwd), updatedAt: c.updatedAt, messageCount: c.messages.length, preview: oneLine(c.messages.at(-1)?.text ?? "", 100), source: "pocketpilot" }));
  },
  async extraProjects(): Promise<string[]> { return []; },
  async messages(sessionId, limit, ctx): Promise<ChatMessage[]> {
    const c = grokRead(ctx.dataDir).find((x) => x.id === sessionId);
    return (c?.messages ?? []).slice(-limit).map((m, i) => ({
      id: `${sessionId}_${i}`,
      role: m.role,
      createdAt: m.at,
      blocks: [
        ...(m.thinking ? [{ type: "thinking" as const, text: m.thinking }] : []),
        ...(m.text.trim() ? [{ type: "text" as const, text: m.text }] : []),
      ],
    })).filter((m) => m.blocks.length);
  },
  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const cliLoggedIn = grokLoginMemo?.ok === true && cli !== "xai-api";
    const env = childEnv(ctx.env, ["XAI_API_KEY"], !cliLoggedIn && ctx.keySource !== "none");
    const key = cliLoggedIn ? "" : (env.XAI_API_KEY ?? "");
    const id = req.sessionId ?? `grok_${Date.now().toString(36)}`;
    if (!req.sessionId) yield { type: "session", id };
    if (cli === "xai-api" && !key) {
      yield { type: "error", message: ctx.locale === "en" ? "No grok CLI login and no XAI_API_KEY." : "没有 grok 登录，也没有 XAI_API_KEY。" };
      return;
    }
    if (!key) {
      grokRemember(ctx.dataDir, id, req.cwd, req.prompt, null);
      const args = ["--no-auto-update", "-p", req.prompt, "--cwd", req.cwd, "--output-format", "plain", "--always-approve"];
      if (req.model) args.push("-m", req.model);
      if (req.sessionId) args.push("-r", req.sessionId);
      let exit: { code: number | null; stderr: string } | null = null;
      let answer = "";
      for await (const item of runStream(cli, args, { cwd: req.cwd, env, json: false, signal })) {
        if (item.kind === "exit") { exit = item; break; }
        if (item.kind === "text") { answer += item.text; yield { type: "text", delta: item.text }; }
      }
      if (signal.aborted) return;
      if (exit && exit.code !== 0 && !answer) {
        const message = cap(exit.stderr.trim() || `grok exit ${exit.code}`, 500);
        grokRemember(ctx.dataDir, id, req.cwd, req.prompt, message);
        yield { type: "error", message };
        return;
      }
      grokRemember(ctx.dataDir, id, req.cwd, req.prompt, answer || "(no output)");
      yield { type: "done" };
      return;
    }
    const history = grokRead(ctx.dataDir).find((c) => c.id === id)?.messages.slice(-30).map((m) => ({ role: m.role, content: m.text })) ?? [];
    grokRemember(ctx.dataDir, id, req.cwd, req.prompt, null);
    const model = req.model || "grok-4";
    const timeout = AbortSignal.timeout(XAI_TIMEOUT_MS);
    const linked = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await fetch(`${XAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: `You are Grok replying inside PocketPilot on a phone. The user's project folder is ${req.cwd}, but you cannot read or edit files; answer in text.` }, ...history, { role: "user", content: req.prompt }] }),
        signal: linked,
      });
    } catch (e) {
      if (signal.aborted) return;
      const message = classifyXaiFailure({ key, error: timeout.aborted ? Object.assign(new Error("timeout"), { name: "TimeoutError" }) : e, locale: ctx.locale });
      grokRemember(ctx.dataDir, id, req.cwd, req.prompt, message);
      yield { type: "error", message };
      return;
    }
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      let msg = raw;
      try { const j = JSON.parse(raw) as { error?: string | { message?: string } }; msg = typeof j.error === "string" ? j.error : j.error?.message ?? raw; } catch { /* raw */ }
      const message = classifyXaiFailure({ key, status: res.status, body: msg, locale: ctx.locale });
      grokRemember(ctx.dataDir, id, req.cwd, req.prompt, message);
      yield { type: "error", message };
      return;
    }
    let answer = "";
    let thinking = "";
    interface XUsage { prompt_tokens?: number; completion_tokens?: number; cost_in_usd_ticks?: number }
    let usage = null as XUsage | null;
    const open = new Map<number, string>();
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const j = tryJson(data);
        const choice = (j?.choices as { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] | undefined)?.[0];
        for (const event of xaiDeltaEvents(choice?.delta, open)) {
          if (event.type === "text") answer += event.delta;
          if (event.type === "thinking") thinking += event.delta;
          yield event;
        }
        if (choice?.finish_reason && open.size) {
          for (const name of open.values()) yield { type: "tool", phase: "done", name, detail: "" };
          open.clear();
        }
        if (j?.usage) usage = j.usage as XUsage;
      }
    }
    const stored = answer || (thinking ? "" : "(no output)");
    grokRemember(ctx.dataDir, id, req.cwd, req.prompt, stored, thinking);
    try {
      if (usage) appendFileSync(path.join(ctx.dataDir, GROK_USAGE), JSON.stringify({ t: Date.now(), model, i: usage.prompt_tokens ?? 0, o: usage.completion_tokens ?? 0, c: typeof usage.cost_in_usd_ticks === "number" ? usage.cost_in_usd_ticks / 1e10 : null }) + "\n");
    } catch { /* best effort */ }
    yield { type: "done" };
  },
  async usage(ctx): Promise<AgentUsage> {
    const file = path.join(ctx.dataDir, GROK_USAGE);
    const t0 = startOfToday();
    const today = emptyBucket(), week = emptyBucket(), month = emptyBucket();
    const daily = dailyTotals();
    const models = new Set<string>();
    if (exists(file)) {
      for await (const line of readLines(file)) {
        const j = tryJson(line) as { t?: number; model?: string; i?: number; o?: number; c?: number | null } | null;
        if (!j?.t) continue;
        if (j.model) models.add(j.model);
        const cost = typeof j.c === "number" ? j.c : null;
        daily.add(j.t, (j.i ?? 0) + (j.o ?? 0), 1, cost);
        for (const [b, from] of [[today, t0], [week, t0 - 6 * 86400000], [month, t0 - 29 * 86400000]] as const) {
          if (j.t < from) continue;
          b.inputTokens += j.i ?? 0; b.outputTokens += j.o ?? 0; b.requests += 1;
          if (cost !== null) b.costUsd = (b.costUsd ?? 0) + cost;
        }
      }
    }
    return {
      supported: true, reason: "", source: "xAI API usage returned for each PocketPilot request", hasTokens: true,
      today, week, month, costEstimated: false, daily: daily.list(), models: [...models],
      note: "只统计经 PocketPilot 走 xAI API 发出的对话（API 每次返回的 usage）；用 grok 命令行或网页的用量不在其中。费用来自 API 返回的账单字段，没有返回则不显示。",
      computedAt: new Date().toISOString(),
    };
  },
};
