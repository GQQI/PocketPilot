import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, MessageBlock, StreamEvent } from "@pocketpilot/protocol";
import { baseName, cap, FileCache, prettyError, fileUriToPath, findExecutable, home, isDir, listDir, normPath, oneLine, readLines, resolveSlug, runCapture, runStream, safeStat, slugify, startOfToday, tryJson } from "./util";
import { emptyBucket, type AgentCtx, type Detection, type LocalAgent } from "./types";

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
    dirs: [path.join(local, "cursor-agent"), path.join(local, "Programs", "cursor-agent"), path.join(home(), ".local", "bin"), path.join(home(), ".cursor", "bin")],
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

export const cursorAgent: LocalAgent = {
  id: "cursor",
  history: true,

  async detect(ctx): Promise<Detection> {
    const cli = await locateCli(ctx);
    const hasHistory = listTranscripts().length > 0 || readOur(ctx.dataDir).length > 0;
    const hasKey = ctx.keySource !== "none";
    return {
      ...cli,
      hasHistory,
      dataPath: root(),
      auth: hasKey
        ? { state: "ok", source: ctx.keySource, note: "CURSOR_API_KEY" }
        : cli.cliPath
          ? { state: "unknown", source: "cli", note: "登录状态由 cursor-agent 自己保存；未登录时发送会返回登录提示" }
          : { state: "missing", source: "none", note: "未找到 cursor-agent，也没有配置 CURSOR_API_KEY" },
    };
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
    const ours = readOur(ctx.dataDir).find((c) => c.id === sessionId);
    if (ours) {
      return ours.messages.slice(-limit).map((m, i) => ({ id: `${sessionId}_${i}`, role: m.role, createdAt: m.at, blocks: [{ type: "text", text: m.text }] }));
    }
    const t = listTranscripts().find((x) => x.id === sessionId);
    if (!t) return [];
    const at = new Date(safeStat(t.file)?.mtimeMs ?? Date.now()).toISOString();
    const out: ChatMessage[] = [];
    let current: ChatMessage | null = null;
    let n = 0;
    for await (const line of readLines(t.file)) {
      if (!line.startsWith('{"role"')) continue;
      const j = tryJson(line);
      const content = (j?.message as { content?: unknown } | undefined)?.content;
      if (j?.role === "user") {
        current = null;
        const text = userText(content);
        if (text) out.push({ id: `${sessionId}_${n++}`, role: "user", createdAt: at, blocks: [{ type: "text", text: cap(text, 20000) }] });
      } else if (j?.role === "assistant") {
        if (!current) {
          current = { id: `${sessionId}_${n++}`, role: "assistant", createdAt: at, blocks: [] };
          out.push(current);
        }
        for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) current.blocks.push({ type: "text", text: cap(b.text, 20000) });
          else if (b.type === "tool_use") current.blocks.push(toolBlock(b));
        }
      }
    }
    return out.filter((m) => m.blocks.length).slice(-limit);
  },

  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const args = ["-p", "--output-format", "stream-json", "--force"];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model && req.model !== "auto") args.push("--model", req.model);
    args.push(req.prompt);
    const env = { ...ctx.env };
    let text = "";
    let sessionId = req.sessionId ?? "";
    let failed = "";
    let exit: { code: number | null; stderr: string } | null = null;
    for await (const item of runStream(cli, args, { cwd: req.cwd, env, json: true, signal })) {
      if (item.kind === "exit") { exit = item; break; }
      if (item.kind === "text") { text += item.text; yield { type: "text", delta: item.text }; continue; }
      const v = item.value;
      if (typeof v.session_id === "string" && v.session_id && v.session_id !== sessionId) {
        sessionId = v.session_id;
        yield { type: "session", id: sessionId };
      }
      if (v.type === "assistant") {
        const content = (v.message as { content?: unknown })?.content;
        for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
          if (b.type === "text" && typeof b.text === "string") { text += b.text; yield { type: "text", delta: b.text }; }
        }
      } else if (v.type === "tool_call") {
        const tc = v.tool_call as Record<string, unknown> | undefined;
        const name = tc ? Object.keys(tc)[0]?.replace(/ToolCall$/, "") ?? "tool" : "tool";
        const detail = tc ? oneLine(JSON.stringify((tc[Object.keys(tc)[0]] as { args?: unknown })?.args ?? {}), 120) : "";
        yield { type: "tool", phase: v.subtype === "completed" ? "done" : "start", name, detail };
      } else if (v.type === "result") {
        if (v.is_error === true || v.subtype === "error") failed = typeof v.result === "string" ? v.result : "Cursor 返回了错误";
        else if (!text && typeof v.result === "string") { text = v.result; yield { type: "text", delta: v.result }; }
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
    for (const t of listTranscripts()) {
      const m = safeStat(t.file)?.mtimeMs ?? 0;
      if (m < t0 - 29 * 86400000) continue;
      let users = 0;
      for await (const line of readLines(t.file)) if (line.startsWith('{"role":"user"')) users++;
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
      models: [],
      note: "Cursor 不在本地记录 token 和费用；账户额度只能在 cursor.com 登录后查看。这里的“请求数”是本地对话里的提问数，按对话文件最后修改日期归档，仅供参考。",
      computedAt: new Date().toISOString(),
    };
  },
};

function toolBlock(b: Record<string, unknown>): MessageBlock {
  const input = (b.input ?? {}) as Record<string, unknown>;
  const detail = String(input.path ?? input.target_file ?? input.command ?? input.pattern ?? input.query ?? input.glob_pattern ?? input.description ?? "");
  return { type: "tool", name: String(b.name ?? "tool"), detail: oneLine(detail || JSON.stringify(input), 140), status: "done" };
}

function recordOur(dataDir: string, id: string, req: AgentChatRequest, answer: string): void {
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
    return ctx.locale === "en" ? `Cursor is not signed in: run "cursor-agent login" on the PC or set CURSOR_API_KEY. (${cap(m, 160)})` : `Cursor 未登录：请在电脑上运行 cursor-agent login，或在设置里填写 CURSOR_API_KEY。（${cap(m, 160)}）`;
  }
  return cap(m, 600);
}

export { isDir };
