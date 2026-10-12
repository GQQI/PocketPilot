import type { AgentTestResult } from "@pocketpilot/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, MessageBlock, StreamEvent } from "@pocketpilot/protocol";
import { baseName, cap, exists, FileCache, prettyError, fileUriToPath, findExecutable, home, isDir, listDir, normPath, oneLine, readLines, resolveSlug, runCapture, runStream, safeStat, slugify, startOfToday, tryJson } from "./util";
import { childEnv, decideLogin } from "./login";
import { dailyTotals, emptyBucket, type AgentCtx, type Detection, type LocalAgent } from "./types";

/**
 * Cursor.
 * History: Cursor's agent writes one JSONL transcript per chat to ~/.cursor/projects/<folder-slug>/agent-transcripts/<chat-id>/<chat-id>.jsonl.
 * Workspaces: %APPDATA%/Cursor/User/workspaceStorage/<hash>/workspace.json lists every folder opened in the editor.
 * Running: the Cursor Agent CLI (`cursor-agent` / `agent`), headless with `-p --output-format stream-json`.
 */
const root = () => path.join(home(), ".cursor", "projects");
const appData = () => process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
const wsRoot = () => path.join(appData(), "Cursor", "User", "workspaceStorage");
const OUR = "cursor-chats.json";

const metaCache = new FileCache<{ title: string; preview: string }>();
const countCache = new FileCache<number>();
let slugMap: { at: number; map: Map<string, string> } | null = null;

/** slug -> real folder path, from the editor's workspace list first, then by walking the disk. */
function pathForSlug(slug: string): string {
  if (!slugMap || Date.now() - slugMap.at > 60_000) {
    const map = new Map<string, string>();
    for (const folder of workspaceFolders()) map.set(slugify(folder).toLowerCase(), folder);
    slugMap = { at: Date.now(), map };
  }
  const known = slugMap.map.get(slug.toLowerCase());
  if (known) return known;
  const walked = resolveSlug(slug);
  if (walked) {
    slugMap.map.set(slug.toLowerCase(), walked);
    return walked;
  }
  return "";
}

function workspaceFolders(): string[] {
  const out: string[] = [];
  for (const dir of listDir(wsRoot())) {
    try {
      const j = JSON.parse(readFileSync(path.join(wsRoot(), dir, "workspace.json"), "utf8")) as { folder?: string };
      const p = j.folder ? fileUriToPath(j.folder) : null;
      if (p && !out.some((x) => normPath(x) === normPath(p))) out.push(p);
    } catch {
      /* no workspace.json (empty window) */
    }
  }
  return out;
}

function listTranscripts(): { id: string; file: string; slug: string }[] {
  const out: { id: string; file: string; slug: string }[] = [];
  for (const slug of listDir(root())) {
    const base = path.join(root(), slug, "agent-transcripts");
    for (const id of listDir(base)) {
      const file = path.join(base, id, `${id}.jsonl`);
      if (safeStat(file)) out.push({ id, file, slug });
    }
  }
  return out;
}

function userText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  return (m ? m[1] : text).trim();
}

async function readMeta(file: string): Promise<{ title: string; preview: string }> {
  return metaCache.get(file, async () => {
    let title = "";
    let preview = "";
    let n = 0;
    for await (const line of readLines(file)) {
      if (!line.startsWith('{"role"')) { if (++n > 400) break; continue; }
      const j = tryJson(line);
      const msg = j?.message as { content?: unknown } | undefined;
      if (j?.role === "user" && !title) title = oneLine(userText(msg?.content), 80);
      if (j?.role === "assistant" && !preview) {
        const t = (Array.isArray(msg?.content) ? msg.content : []).find((b: { type?: string }) => b?.type === "text") as { text?: string } | undefined;
        if (t?.text) preview = oneLine(t.text, 100);
      }
      if (title && preview) break;
      if (++n > 400) break;
    }
    return { title, preview };
  });
}

async function countMessages(file: string): Promise<number> {
  return countCache.get(file, async () => {
    let users = 0;
    let groups = 0;
    let afterUser = false;
    for await (const line of readLines(file)) {
      if (line.startsWith('{"role":"user"')) { users++; afterUser = true; }
      else if (line.startsWith('{"role":"assistant"') && afterUser) { groups++; afterUser = false; }
    }
    return users + groups;
  });
}

function readOur(dataDir: string): { id: string; cwd: string; title: string; updatedAt: string; messages: { role: "user" | "assistant"; text: string; at: string }[] }[] {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, OUR), "utf8")) as ReturnType<typeof readOur>;
  } catch {
    return [];
  }
}

function writeOur(dataDir: string, list: ReturnType<typeof readOur>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, OUR), JSON.stringify(list.slice(0, 200)));
}

function cliCandidates(): { names: string[]; dirs: string[] } {
  const local = process.env.LOCALAPPDATA ?? path.join(home(), "AppData", "Local");
  return {
    names: ["cursor-agent", "agent"],
    dirs: [path.join(local, "cursor-agent"), path.join(local, "cursor-agent", "bin"), path.join(local, "Programs", "cursor-agent"), path.join(home(), ".local", "bin"), path.join(home(), ".cursor", "bin"), "/usr/local/bin", "/opt/homebrew/bin"],
  };
}

async function locateCli(ctx: AgentCtx): Promise<{ cliPath: string | null; version: string | null }> {
  const c = cliCandidates();
  const explicit = ctx.cliPath && ctx.cliPath !== "agent" && ctx.cliPath !== "cursor-agent" ? ctx.cliPath : undefined;
  const found = findExecutable(explicit ? [] : c.names, c.dirs, explicit) ?? (explicit ? null : null);
  if (!found) return { cliPath: null, version: null };
  const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 8000 });
  const out = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  // a bare "agent" on PATH that is not the Cursor CLI would not answer with a version
  if (r.code !== 0 && !explicit && path.basename(found).toLowerCase().startsWith("agent")) return { cliPath: null, version: null };
  return { cliPath: found, version: out ? cap(out, 80) : null };
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
let loginCache: { key: string; at: number; value: { ok: boolean; email: string; text: string } } | null = null;

/** `cursor-agent status` decides login from local tokens: "Logged in as x@y" / "Logged in" / "Not logged in". */
async function loginStatus(cli: string, ctx: AgentCtx): Promise<{ ok: boolean; email: string; text: string }> {
  if (loginCache && loginCache.key === cli && Date.now() - loginCache.at < 60_000) return loginCache.value;
  // Probe login without a saved key, or the key can hide "Logged in".
  const r = await runCapture(cli, ["status"], { env: childEnv(ctx.env, ["CURSOR_API_KEY"], false), timeoutMs: 20_000 });
  const out = stripAnsi(`${r.stdout}\n${r.stderr}`);
  const email = /Logged in as\s+([^\s@]+@[^\s]+)/i.exec(out)?.[1] ?? "";
  const ok = r.code === 0 && /Logged in/i.test(out) && !/not logged in/i.test(out);
  const value = { ok, email, text: oneLine(out, 120) };
  loginCache = { key: cli, at: Date.now(), value };
  return value;
}

let modelCache: { key: string; at: number; value: string[] } | null = null;

/** `cursor-agent --list-models` prints "<id> - <Name>" per line. */
async function listModels(cli: string, ctx: AgentCtx): Promise<string[]> {
  if (modelCache && modelCache.key === cli && Date.now() - modelCache.at < 600_000) return modelCache.value;
  const r = await runCapture(cli, ["--list-models"], { env: ctx.env, timeoutMs: 20_000 });
  const ids: string[] = [];
  for (const raw of stripAnsi(r.stdout).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._:-]*)\s+-\s+/.exec(raw);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  modelCache = { key: cli, at: Date.now(), value: ids };
  return ids;
}

export const cursorAgent: LocalAgent = {
  id: "cursor",
  history: true,

  async detect(ctx): Promise<Detection> {
    const cli = await locateCli(ctx);
    const hasHistory = listTranscripts().length > 0 || readOur(ctx.dataDir).length > 0;
    const login = cli.cliPath ? await loginStatus(cli.cliPath, ctx).catch(() => null) : null;
    const decision = decideLogin({
      present: Boolean(cli.cliPath),
      loggedIn: Boolean(login?.ok),
      keySource: ctx.keySource,
      loginCommand: "cursor-agent login",
      keyName: "CURSOR_API_KEY",
      locale: ctx.locale,
      loginDetail: login?.email || (login?.ok ? "cursor-agent status" : undefined),
      absentNote: ctx.locale === "en" ? "cursor-agent was not found and no backup key is saved." : "未找到 cursor-agent，也没有备用密钥。",
    });
    const models = cli.cliPath && decision.auth.state === "ok"
      ? await listModels(cli.cliPath, { ...ctx, env: childEnv(ctx.env, ["CURSOR_API_KEY"], decision.useKey) }).catch(() => [])
      : [];
    return { ...cli, hasHistory, dataPath: root(), auth: decision.auth, models };
  },

  async test(ctx, cli): Promise<AgentTestResult> {
    const zh = ctx.locale !== "en";
    if (!cli) return { ok: false, message: zh ? "没有找到 cursor-agent，请先安装（设置 → 连接与登录里有安装指引）。" : "cursor-agent was not found. Install it first." };
    loginCache = null;
    modelCache = null;
    const login = await loginStatus(cli, ctx).catch(() => null);
    if (login?.ok) return { ok: true, message: zh ? `cursor-agent 已登录${login.email ? `：${login.email}` : ""}。已保存的密钥不会覆盖这次登录。` : `cursor-agent is signed in${login.email ? `: ${login.email}` : ""}. A saved key is not applied over this login.` };
    if (ctx.keySource !== "none") {
      const models = await listModels(cli, ctx).catch(() => [] as string[]);
      if (models.length > 0) return { ok: true, message: zh ? `CURSOR_API_KEY 可用，能获取 ${models.length} 个模型。` : `CURSOR_API_KEY works: ${models.length} models.` };
      return { ok: false, message: zh ? "密钥已保存，但 cursor-agent 用它取不到模型：请确认密钥有效（Cursor Dashboard → API Keys）。" : "A key is saved but cursor-agent could not list models with it. Check it in Cursor Dashboard → API Keys." };
    }
    return { ok: false, message: zh ? "cursor-agent 未登录，也没有备用密钥。请在电脑上运行 cursor-agent login。" : "Not signed in and no backup key. Run cursor-agent login on this PC." };
  },

  async sessions(ctx): Promise<AgentSession[]> {
    const out: AgentSession[] = [];
    const items = listTranscripts().map((t) => ({ ...t, mtime: safeStat(t.file)?.mtimeMs ?? 0 })).sort((a, b) => b.mtime - a.mtime);
    let counted = 0;
    for (const t of items) {
      const meta = await readMeta(t.file);
      const projectPath = t.slug === "empty-window" ? "" : pathForSlug(t.slug);
      const messageCount = counted++ < 40 ? await countMessages(t.file) : -1;
      out.push({
        id: t.id,
        agentId: "cursor",
        title: meta.title || "（空会话）",
        projectPath,
        projectName: projectPath ? baseName(projectPath) : t.slug === "empty-window" ? "（未打开文件夹）" : t.slug,
        updatedAt: new Date(t.mtime).toISOString(),
        messageCount,
        preview: meta.preview,
        source: "cursor-ide",
      });
    }
    for (const c of readOur(ctx.dataDir)) {
      out.push({ id: c.id, agentId: "cursor", title: c.title, projectPath: c.cwd, projectName: baseName(c.cwd), updatedAt: c.updatedAt, messageCount: c.messages.length, preview: oneLine(c.messages.at(-1)?.text ?? "", 100), source: "pocketpilot" });
    }
    return out;
  },

  async extraProjects(): Promise<string[]> {
    return workspaceFolders();
  },

  async messages(sessionId, limit, ctx): Promise<ChatMessage[]> {
    const t = listTranscripts().find((x) => x.id === sessionId);
    if (t) {
      const at = new Date(safeStat(t.file)?.mtimeMs ?? Date.now()).toISOString();
      const lines: string[] = [];
      for await (const line of readLines(t.file)) lines.push(line);
      return cursorHistoryFromLines(sessionId, lines, at).slice(-limit);
    }
    const ours = readOur(ctx.dataDir).find((c) => c.id === sessionId);
    if (!ours) return [];
    return ours.messages.slice(-limit).map((m, i) => ({ id: `${sessionId}_${i}`, role: m.role, createdAt: m.at, blocks: [{ type: "text" as const, text: m.text }] }));
  },

  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    // `cursor-agent -p` is a one-shot process: it prints the turn and exits. `--resume` reuses the
    // remote chat, but the CLI still starts again. There is no verified headless daemon to keep
    // warm, so this path does not spawn `status` or `--list-models` before the print process.
    const args = cursorPrintArgs(req);
    // Inject the saved key only after a probe said "not logged in". A missing probe must not
    // overwrite a CLI login: `cursor-agent` prefers CURSOR_API_KEY over the local login.
    const confirmedOut = loginCache?.value.ok === false;
    const env = childEnv(ctx.env, ["CURSOR_API_KEY"], confirmedOut && ctx.keySource !== "none");
    let text = "";
    let sessionId = req.sessionId ?? "";
    let failed = "";
    let exit: { code: number | null; stderr: string } | null = null;
    const parsed: CursorStreamState = { sessionId, sawPartial: false, sawText: false };
    for await (const item of runStream(cli, args, { cwd: req.cwd, env, json: true, signal })) {
      if (item.kind === "exit") { exit = item; break; }
      if (item.kind === "text") { text += item.text; yield { type: "text", delta: item.text }; continue; }
      for (const event of mapCursorStreamLine(item.value, parsed)) {
        if (event.type === "session") sessionId = event.id;
        if (event.type === "text") text += event.delta;
        if (event.type === "error") { failed = event.message; continue; }
        yield event;
      }
    }
    if (failed || (exit && exit.code !== 0 && !text)) {
      const stderr = exit?.stderr.trim() ?? "";
      const message = failed || stderr || `cursor-agent 退出码 ${exit?.code}`;
      yield { type: "error", message: explain(message, ctx) };
      return;
    }
    if (sessionId) recordOur(ctx.dataDir, sessionId, req, text);
    yield { type: "done" };
  },

  async usage(ctx): Promise<AgentUsage> {
    // Cursor does not store token counts locally and its account usage lives behind the signed-in session (cursor.com API),
    // which PocketPilot does not read. What exists locally is the number of chats/prompts, bucketed by transcript mtime.
    const today = emptyBucket(), week = emptyBucket(), month = emptyBucket();
    const t0 = startOfToday();
    const daily = dailyTotals();
    for (const t of listTranscripts()) {
      const m = safeStat(t.file)?.mtimeMs ?? 0;
      if (m < t0 - 29 * 86400000) continue;
      let users = 0;
      for await (const line of readLines(t.file)) if (line.startsWith('{"role":"user"')) users++;
      daily.add(m, 0, users, null);
      for (const [b, from] of [[today, t0], [week, t0 - 6 * 86400000], [month, t0 - 29 * 86400000]] as const) if (m >= from) b.requests += users;
    }
    void ctx;
    return {
      supported: true,
      reason: "",
      source: "~/.cursor/projects/*/agent-transcripts",
      hasTokens: false,
      today, week, month,
      costEstimated: false,
      daily: daily.list(),
      models: [],
      note: "Cursor 不在本地记录 token 和费用；账户额度只能在 cursor.com 登录后查看。这里的“请求数”是本地对话里的提问数，按对话文件最后修改日期归档，仅供参考。",
      computedAt: new Date().toISOString(),
    };
  },
};

/** Headless cursor-agent args. `--stream-partial-output` emits text deltas instead of one blob per turn. */
export function cursorPrintArgs(req: { sessionId?: string; model?: string; prompt: string }): string[] {
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--force", "--trust"];
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.model && req.model !== "auto") args.push("--model", req.model);
  args.push(req.prompt);
  return args;
}

export interface CursorStreamState {
  sessionId: string;
  sawPartial: boolean;
  sawText: boolean;
}

/**
 * cursor-agent `--stream-partial-output` emits three assistant shapes.
 * Only `timestamp_ms` without `model_call_id` is new text; the other two repeat it.
 * An assistant event with neither field is the older one-shot message.
 */
export function mapCursorStreamLine(value: Record<string, unknown>, state: CursorStreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const sid = typeof value.session_id === "string" ? value.session_id : "";
  if (sid && sid !== state.sessionId) {
    state.sessionId = sid;
    events.push({ type: "session", id: sid });
  }
  if (value.type === "assistant") {
    const hasTs = typeof value.timestamp_ms === "number";
    const hasCall = value.model_call_id != null && String(value.model_call_id) !== "";
    if (hasTs && !hasCall) {
      state.sawPartial = true;
      const added = contentEvents(value);
      if (added.some((event) => event.type === "text")) state.sawText = true;
      return [...events, ...added];
    }
    if (state.sawPartial || hasCall) return events;
    const added = contentEvents(value);
    if (added.some((event) => event.type === "text")) state.sawText = true;
    return [...events, ...added];
  }
  if (value.type === "tool_call") {
    const tool = cursorToolCall(value.tool_call);
    const phase = value.subtype === "completed" ? "done" as const : "start" as const;
    events.push({
      type: "tool",
      phase,
      name: tool.name,
      detail: tool.detail,
      ...(tool.input ? { input: tool.input } : {}),
      ...(phase === "done" && tool.output ? { output: tool.output } : {}),
    });
    return events;
  }
  if (value.type === "result") {
    if (value.is_error === true || value.subtype === "error") {
      events.push({ type: "error", message: cap(typeof value.result === "string" ? value.result : "Cursor error", 600) });
      return events;
    }
    if (!state.sawText && typeof value.result === "string" && value.result) {
      state.sawText = true;
      events.push({ type: "text", delta: value.result });
    }
  }
  return events;
}

export function cursorToolCall(raw: unknown): { name: string; input: string; output: string; detail: string } {
  const tc = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const key = Object.keys(tc)[0] ?? "tool";
  const body = (tc[key] ?? {}) as { args?: unknown; result?: unknown };
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
  const input = jsonPreview(body.args);
  const output = jsonPreview(body.result);
  const summary = args.path ?? args.file_path ?? args.target_file ?? args.command ?? args.pattern ?? args.query ?? args.glob_pattern ?? "";
  return { name: key.replace(/ToolCall$/, "") || "tool", input, output, detail: oneLine(String(summary || input), 160) };
}

/** IDE transcripts (`agent-transcripts/*.jsonl`) into the same blocks the live stream shows. */
export function cursorHistoryFromLines(sessionId: string, lines: string[], at: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, MessageBlock & { type: "tool" }>();
  let current: ChatMessage | null = null;
  let n = 0;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    const j = tryJson(line);
    if (!j) continue;
    const content = (j.message as { content?: unknown } | undefined)?.content ?? j.content;
    const role = j.role === "user" || j.role === "assistant" ? j.role : "";
    if (!role) continue;
    if (role === "user") {
      const results = toolResults(content);
      if (results.length) {
        for (const result of results) {
          const tool = result.id ? tools.get(result.id) : [...tools.values()].find((item) => item.status === "running");
          if (!tool) continue;
          tool.status = result.error ? "error" : "done";
          if (result.output) tool.output = result.output;
        }
      }
      const text = userText(content);
      if (!text) continue;
      current = null;
      out.push({ id: `${sessionId}_${n++}`, role: "user", createdAt: at, blocks: [{ type: "text", text: cap(text, 20000) }] });
      continue;
    }
    if (!current) {
      current = { id: `${sessionId}_${n++}`, role: "assistant", createdAt: at, blocks: [] };
      out.push(current);
    }
    for (const block of contentBlocks(content, tools)) current.blocks.push(block);
  }
  for (const tool of tools.values()) if (tool.status === "running") tool.status = "done";
  return out.filter((message) => message.blocks.length);
}

function contentEvents(value: Record<string, unknown>): StreamEvent[] {
  const content = (value.message as { content?: unknown } | undefined)?.content;
  const events: StreamEvent[] = [];
  for (const block of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
    if (block.type === "text" && typeof block.text === "string" && block.text) events.push({ type: "text", delta: block.text });
    else if ((block.type === "thinking" || block.type === "reasoning") && typeof (block.thinking ?? block.text) === "string") {
      const text = String(block.thinking ?? block.text);
      if (text) events.push({ type: "thinking", delta: text });
    } else if (block.type === "tool_use") {
      const tool = cursorToolCall({ [`${String(block.name ?? "tool")}ToolCall`]: { args: block.input } });
      events.push({ type: "tool", phase: "start", name: String(block.name ?? tool.name), detail: tool.detail, ...(tool.input ? { input: tool.input } : {}) });
    }
  }
  return events;
}

function contentBlocks(content: unknown, tools: Map<string, MessageBlock & { type: "tool" }>): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const block of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) blocks.push({ type: "text", text: cap(block.text, 20000) });
    else if ((block.type === "thinking" || block.type === "reasoning") && String(block.thinking ?? block.text ?? "").trim()) {
      blocks.push({ type: "thinking", text: cap(String(block.thinking ?? block.text), 20000) });
    } else if (block.type === "tool_use") {
      const tool = toolBlock(block);
      if (typeof block.id === "string" && block.id) tools.set(block.id, tool);
      blocks.push(tool);
    }
  }
  return blocks;
}

function toolResults(content: unknown): { id: string; output: string; error: boolean }[] {
  const out: { id: string; output: string; error: boolean }[] = [];
  for (const block of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
    if (block.type !== "tool_result") continue;
    out.push({ id: String(block.tool_use_id ?? ""), output: cap(textOf(block.content ?? block.output ?? block.text), 20000), error: block.is_error === true });
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? String((part as { text: string }).text) : "")).join("\n");
}

function jsonPreview(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return cap(value, 20000);
  try { return cap(JSON.stringify(value, null, 2), 20000); } catch { return ""; }
}

function toolBlock(b: Record<string, unknown>): MessageBlock & { type: "tool" } {
  const input = (b.input ?? {}) as Record<string, unknown>;
  const detail = String(input.path ?? input.target_file ?? input.command ?? input.pattern ?? input.query ?? input.glob_pattern ?? input.description ?? "");
  const preview = jsonPreview(b.input);
  return { type: "tool", name: String(b.name ?? "tool"), detail: oneLine(detail || preview, 160), status: "running", ...(preview ? { input: preview } : {}) };
}

function recordOur(dataDir: string, id: string, req: AgentChatRequest, answer: string): void {
  if (exists(path.join(dataDir, "no-history"))) return;
  try {
    const list = readOur(dataDir);
    const now = new Date().toISOString();
    let c = list.find((x) => x.id === id);
    if (!c) {
      c = { id, cwd: req.cwd, title: oneLine(req.prompt, 60), updatedAt: now, messages: [] };
      list.unshift(c);
    }
    c.messages.push({ role: "user", text: req.prompt, at: now }, { role: "assistant", text: answer || "(no output)", at: now });
    c.updatedAt = now;
    writeOur(dataDir, list);
  } catch {
    /* history record is best effort */
  }
}

function explain(message: string, ctx: AgentCtx): string {
  const m = prettyError(message);
  if (/login|log in|auth|unauthor|api key|not logged/i.test(m)) {
    return ctx.locale === "en" ? `Cursor is not signed in: run "cursor-agent login" on the PC. A saved key is only a backup. (${cap(m, 160)})` : `Cursor 未登录：请在电脑上运行 cursor-agent login。密钥只是备用。（${cap(m, 160)}）`;
  }
  return cap(m, 600);
}

export { isDir };
