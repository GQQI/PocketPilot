import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, MessageBlock, StreamEvent, UsageBucket } from "@pocketpilot/protocol";
import { baseName, cap, exists, prettyError, FileCache, findExecutable, globDirs, home, listDir, oneLine, readHead, readLines, runCapture, runStream, safeStat, startOfToday, tryJson } from "./util";
import { dailyTotals, emptyBucket, type AgentCtx, type Detection, type LocalAgent } from "./types";

/**
 * Codex.
 * History: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (first line = session_meta with id and cwd) and ~/.codex/session_index.jsonl (thread titles).
 * Usage: event_msg/token_count lines (cumulative total_token_usage) inside those rollouts.
 * Running: `codex exec --json [resume <id>] -` with the prompt on stdin, `-C <project>`.
 */
const codexHome = () => path.join(home(), ".codex");
const sessionsRoot = () => path.join(codexHome(), "sessions");

interface Entry { id: string; file: string; mtime: number }
interface Head { id: string; cwd: string }
const headCache = new FileCache<Head | null>();
const countCache = new FileCache<number>();

function rollouts(): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of listDir(dir)) {
      const full = path.join(dir, name);
      if (depth < 3) { walk(full, depth + 1); continue; }
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const st = safeStat(full);
      if (!st || st.size === 0) continue;
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(name);
      out.push({ id: m ? m[1] : name, file: full, mtime: st.mtimeMs });
    }
  };
  walk(sessionsRoot(), 0);
  return out;
}

async function head(e: Entry): Promise<Head | null> {
  return headCache.get(e.file, () => {
    const first = readHead(e.file, 400_000).split("\n")[0];
    const j = tryJson(first ?? "");
    const p = j?.payload as { id?: string; cwd?: string } | undefined;
    if (!p) return null;
    return { id: p.id ?? e.id, cwd: typeof p.cwd === "string" ? p.cwd.replace(/^\\\\\?\\/, "") : "" };
  });
}

function titles(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(path.join(codexHome(), "session_index.jsonl"), "utf8").split("\n")) {
      const j = tryJson(line.trim());
      if (j && typeof j.id === "string" && typeof j.thread_name === "string") map.set(j.id, j.thread_name);
    }
  } catch {
    /* no index */
  }
  return map;
}

/** Codex writes an internal scratch session named `chatcwd`. Hide that row, not a real chat that merely mentions the word. */
export function isInternalCodexSession(id: string, title: string, cwd = ""): boolean {
  const leaf = (value: string) => value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return leaf(id) === "chatcwd" || title.trim().toLowerCase() === "chatcwd" || leaf(cwd) === "chatcwd";
}

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<environment_context") || t.startsWith("<user_instructions") || t.startsWith("# AGENTS.md") || t.startsWith("<turn_aborted") || t.startsWith("<codex_") || t.startsWith("<permissions") || t.startsWith("<INSTRUCTIONS") || t.startsWith("<external_");
}

function contentText(content: unknown): string {
  return (Array.isArray(content) ? (content as Record<string, unknown>[]) : [])
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

async function firstUser(file: string): Promise<{ title: string; preview: string }> {
  let title = "";
  let preview = "";
  let n = 0;
  for await (const line of readLines(file)) {
    if (!line.includes('"message"') && !line.includes("UserMessage") && !line.includes("AgentMessage")) { if (++n > 300) break; continue; }
    const j = tryJson(line);
    const p = j?.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    if (p.type === "message" && p.role === "user") {
      const t = contentText(p.content);
      if (!title && t && !isInjected(t)) title = oneLine(t, 80);
    } else if (p.type === "message" && p.role === "assistant") {
      const t = contentText(p.content);
      if (!preview && t) preview = oneLine(t, 100);
    } else if (p.type === "item_completed") {
      const item = p.item as { type?: string; content?: unknown; text?: string } | undefined;
      if (item?.type === "UserMessage" && !title) { const t = contentText(item.content); if (t && !isInjected(t)) title = oneLine(t, 80); }
      if (item?.type === "AgentMessage" && !preview && item.text) preview = oneLine(item.text, 100);
    }
    if (title && preview) break;
    if (++n > 400) break;
  }
  return { title, preview };
}

function candidates(): { names: string[]; dirs: string[] } {
  const dirs: string[] = [];
  for (const ext of [".vscode", ".cursor", ".vscode-insiders"]) {
    for (const d of globDirs(path.join(home(), ext, "extensions"), "openai.chatgpt-")) dirs.push(path.join(d, "bin", "windows-x86_64"), path.join(d, "bin"));
  }
  const appdata = process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
  dirs.push(path.join(appdata, "npm"), path.join(home(), ".local", "bin"), path.join(codexHome(), ".sandbox-bin"));
  return { names: ["codex"], dirs };
}

function configModel(): string {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(codexHome(), "config.toml"), "utf8"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function configProjects(): string[] {
  try {
    const out: string[] = [];
    const re = /^\[projects\.'([^']+)'\]/gm;
    const text = readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  } catch {
    return [];
  }
}

export const codexAgent: LocalAgent = {
  id: "codex",
  history: true,

  async detect(ctx): Promise<Detection> {
    const c = candidates();
    const explicit = ctx.cliPath && ctx.cliPath !== "codex" ? ctx.cliPath : undefined;
    const found = findExecutable(c.names, c.dirs, explicit);
    let version: string | null = null;
    if (found) {
      const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 10000 });
      version = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
    }
    const authFile = path.join(codexHome(), "auth.json");
    const auth = ctx.keySource !== "none"
      ? { state: "ok" as const, source: ctx.keySource, note: "OPENAI_API_KEY" }
      : exists(authFile)
        ? { state: "ok" as const, source: "login", note: "已用 Codex / ChatGPT 账号登录（~/.codex/auth.json）" }
        : found
          ? { state: "missing" as const, source: "none", note: "未登录：运行 codex login，或在设置里填写 OPENAI_API_KEY" }
          : { state: "missing" as const, source: "none", note: "未找到 codex" };
    return { cliPath: found, version: version ? cap(version, 80) : null, hasHistory: rollouts().length > 0, auth, dataPath: sessionsRoot(), defaultModel: configModel() };
  },

  async sessions(): Promise<AgentSession[]> {
    const index = titles();
    const out: AgentSession[] = [];
    const groups = new Map<string, { entries: Entry[]; cwd: string }>();
    for (const e of rollouts().sort((x, y) => y.mtime - x.mtime)) {
      const h = await head(e);
      if (!h) continue;
      const g = groups.get(h.id);
      if (g) g.entries.push(e);
      else groups.set(h.id, { entries: [e], cwd: h.cwd });
    }
    let counted = 0;
    for (const [id, g] of groups) {
      const oldest = g.entries[g.entries.length - 1];
      const f = await firstUser(oldest.file);
      const title = index.get(id) || f.title;
      if (!title || isInternalCodexSession(id, title, g.cwd)) continue;
      let messageCount = -1;
      if (counted++ < 40) {
        messageCount = 0;
        for (const e of g.entries) messageCount += await countMessages(e.file);
      }
      out.push({ id, agentId: "codex", title, projectPath: g.cwd, projectName: g.cwd ? baseName(g.cwd) : "", updatedAt: new Date(g.entries[0].mtime).toISOString(), messageCount, preview: f.preview, source: "codex-sessions" });
    }
    return out;
  },

  async extraProjects(): Promise<string[]> {
    return configProjects();
  },

  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const entries: Entry[] = [];
    for (const e of rollouts()) {
      const h = await head(e);
      if (h?.id === sessionId) entries.push(e);
    }
    entries.sort((x, y) => x.mtime - y.mtime);
    if (!entries.length) return [];
    const seen = new Set<string>();
    const out: ChatMessage[] = [];
    let current: ChatMessage | null = null;
    const tools = new Map<string, MessageBlock & { type: "tool" }>();
    let n = 0;
    const push = (role: "user" | "assistant", at: string, block: MessageBlock) => {
      const last = out.at(-1);
      if (role === "user") {
        if (last?.role === "user" && last.blocks[0]?.type === "text" && block.type === "text" && last.blocks[0].text === block.text) return;
        current = null;
        out.push({ id: `${sessionId}_${n++}`, role, createdAt: at, blocks: [block] });
        return;
      }
      if (!current || out.at(-1) !== current) { current = { id: `${sessionId}_${n++}`, role, createdAt: at, blocks: [] }; out.push(current); }
      const prev = current.blocks.at(-1);
      if (block.type === "text" && prev?.type === "text" && prev.text === block.text) return;
      current.blocks.push(block);
    };
    for (const entry of entries) for await (const line of readLines(entry.file)) {
      if (!line.includes('"message"') && !line.includes("function_call") && !line.includes("UserMessage") && !line.includes("AgentMessage")) continue;
      const j = tryJson(line);
      const p = j?.payload as Record<string, unknown> | undefined;
      if (!j || !p) continue;
      const at = typeof j.timestamp === "string" ? j.timestamp : new Date(entry.mtime).toISOString();
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const t = contentText(p.content);
        if (!t.trim() || (p.role === "user" && isInjected(t))) continue;
        const key = `${at}|${p.role}|${t.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        push(p.role, at, { type: "text", text: cap(t, 20000) });
      } else if (p.type === "item_completed") {
        const item = p.item as { type?: string; content?: unknown; text?: string } | undefined;
        if (item?.type === "UserMessage") { const t = contentText(item.content); if (t.trim() && !isInjected(t)) push("user", at, { type: "text", text: cap(t, 20000) }); }
        else if (item?.type === "AgentMessage" && item.text?.trim()) push("assistant", at, { type: "text", text: cap(item.text, 20000) });
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const args = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.action ?? {});
        const block: MessageBlock & { type: "tool" } = { type: "tool", name: String(p.name ?? "shell"), detail: oneLine(args, 140), status: "done" };
        tools.set(String(p.call_id ?? ""), block);
        push("assistant", at, block);
      }
    }
    return out.filter((m) => m.blocks.length).slice(-limit);
  },

  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", req.cwd];
    if (req.model) args.push("-m", req.model);
    if (req.sessionId) args.push("resume", req.sessionId);
    args.push("-");
    let any = false;
    let failed = "";
    let exit: { code: number | null; stderr: string } | null = null;
    for await (const item of runStream(cli, args, { cwd: req.cwd, env: ctx.env, stdin: req.prompt, json: true, signal })) {
      if (item.kind === "exit") { exit = item; break; }
      if (item.kind === "text") continue;
      const v = item.value;
      const type = String(v.type ?? "");
      if (type === "thread.started" && typeof v.thread_id === "string") yield { type: "session", id: v.thread_id };
      else if (type === "item.completed" || type === "item.started") {
        const it = (v.item ?? {}) as Record<string, unknown>;
        const kind = String(it.type ?? "");
        if (kind === "agent_message" && typeof it.text === "string" && type === "item.completed") { any = true; yield { type: "text", delta: it.text + "\n" }; }
        else if (kind === "reasoning" && typeof it.text === "string" && type === "item.completed") yield { type: "thinking", delta: it.text };
        else if (kind === "command_execution") yield { type: "tool", phase: type === "item.completed" ? "done" : "start", name: "shell", detail: oneLine(String(it.command ?? ""), 120) };
        else if (kind === "file_change" || kind === "mcp_tool_call" || kind === "web_search") yield { type: "tool", phase: type === "item.completed" ? "done" : "start", name: kind, detail: oneLine(JSON.stringify(it.changes ?? it.tool ?? it.query ?? ""), 120) };
      } else if (type === "turn.completed") {
        const u = v.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (u) yield { type: "usage", input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
      } else if (type === "turn.failed" || type === "error") {
        failed = String((v.error as { message?: string } | undefined)?.message ?? v.message ?? "Codex 返回了错误");
      }
    }
    if (failed || (exit && exit.code !== 0 && !any)) {
      yield { type: "error", message: explain(failed || exit?.stderr.trim() || `codex 退出码 ${exit?.code}`, ctx) };
      return;
    }
    yield { type: "done" };
  },

  async usage(): Promise<AgentUsage> {
    const t0 = startOfToday();
    const today = emptyBucket(), week = emptyBucket(), month = emptyBucket();
    const models = new Set<string>();
    const seen = new Set<string>();
    const daily = dailyTotals();
    for (const e of rollouts()) {
      if (e.mtime < t0 - 29 * 86400000) continue;
      for await (const line of readLines(e.file)) {
        if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
        const j = tryJson(line);
        const p = j?.payload as Record<string, unknown> | undefined;
        if (!j || !p) continue;
        if (j.type === "turn_context" && typeof p.model === "string") { models.add(p.model); continue; }
        if (p.type !== "token_count") continue;
        const info = p.info as { last_token_usage?: Record<string, number>; total_token_usage?: Record<string, number> } | null | undefined;
        const last = info?.last_token_usage;
        if (!last) continue;
        // forked/resumed rollouts replay earlier events: count each (timestamp, running total) once
        const key = `${String(j.timestamp)}|${info?.total_token_usage?.total_tokens ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const input = last.input_tokens ?? 0, cached = last.cached_input_tokens ?? 0, output = last.output_tokens ?? 0;
        if (!input && !output) continue;
        const ts = Date.parse(String(j.timestamp ?? "")) || e.mtime;
        daily.add(ts, Math.max(0, input - cached) + output, 1, null);
        for (const [b, from] of [[today, t0], [week, t0 - 6 * 86400000], [month, t0 - 29 * 86400000]] as [UsageBucket, number][]) {
          if (ts < from) continue;
          b.inputTokens += Math.max(0, input - cached); b.cacheTokens += cached; b.outputTokens += output; b.requests += 1;
        }
      }
    }
    return {
      supported: true,
      reason: "",
      source: "~/.codex/sessions/**/rollout-*.jsonl（token_count.last_token_usage）",
      hasTokens: true,
      today, week, month,
      costEstimated: false,
      daily: daily.list(),
      models: [...models],
      note: "token 来自 Codex 本地会话记录（输入 = 未命中缓存的输入）；费用不估算（ChatGPT 账号登录按套餐额度计费，没有逐次单价）。“请求数”是模型调用次数。",
      computedAt: new Date().toISOString(),
    };
  },
};

async function countMessages(file: string): Promise<number> {
  return countCache.get(file, async () => {
    let n = 0;
    for await (const line of readLines(file)) {
      if (!line.includes('"type":"message"')) continue;
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
      const j = tryJson(line);
      const p = j?.payload as Record<string, unknown> | undefined;
      const t = contentText(p?.content);
      if (!t.trim() || (p?.role === "user" && isInjected(t))) continue;
      n++;
    }
    return n;
  });
}

function explain(raw: string, ctx: AgentCtx): string {
  const message = prettyError(raw);
  if (/not supported when using Codex with a ChatGPT account/i.test(message)) {
    return ctx.locale === "en" ? `${message} Pick another model for this chat or change "model" in ~/.codex/config.toml.` : `${message}。请在这次对话里换一个模型，或修改 ~/.codex/config.toml 里的 model。`;
  }
  if (/login|sign in|unauthor|api key|401|auth/i.test(message)) {
    return ctx.locale === "en" ? `Codex is not signed in: run "codex login" on the PC. (${cap(message, 200)})` : `Codex 未登录：请在电脑上运行 codex login，或在设置里填写 OPENAI_API_KEY。（${cap(message, 200)}）`;
  }
  return cap(message, 600);
}
