import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, StreamEvent, UsageBucket } from "@pocketpilot/protocol";
import { baseName, cap, exists, findExecutable, home, listDir, oneLine, readHead, runCapture, runStream, safeStat, startOfToday } from "./util";
import { childEnv, decideLogin } from "./login";
import { emptyBucket, unsupportedUsage, type AgentCtx, type Detection, type LocalAgent } from "./types";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function detectCli(ctx: AgentCtx, name: string, dirs: string[]): Promise<{ cliPath: string | null; version: string | null }> {
  const explicit = ctx.cliPath && ctx.cliPath !== name ? ctx.cliPath : undefined;
  const found = findExecutable([name], dirs, explicit);
  if (!found) return { cliPath: null, version: null };
  const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 10000 });
  const v = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  return { cliPath: found, version: v ? cap(v, 80) : null };
}

async function* plainChat(cli: string, args: string[], req: AgentChatRequest, ctx: AgentCtx, signal: AbortSignal, name: string, env: NodeJS.ProcessEnv = ctx.env): AsyncGenerator<StreamEvent> {
  let any = false;
  let exit: { code: number | null; stderr: string } | null = null;
  for await (const item of runStream(cli, args, { cwd: req.cwd, env, json: false, signal })) {
    if (item.kind === "exit") { exit = item; break; }
    if (item.kind === "text") { any = true; yield { type: "text", delta: item.text }; }
  }
  if (exit && exit.code !== 0) {
    yield { type: "error", message: cap(exit.stderr.trim() || `${name} 退出码 ${exit.code}`, 600) };
    return;
  }
  void any;
  yield { type: "done" };
}

/* ---------------- Gemini CLI: ~/.gemini/tmp/<hash>/chats/session-*.json ---------------- */
const geminiRoot = () => path.join(home(), ".gemini", "tmp");

interface GemSession { sessionId?: string; startTime?: string; lastUpdated?: string; messages?: { type?: string; content?: unknown; timestamp?: string; tokens?: { input?: number; output?: number; cached?: number } }[] }

function geminiFiles(): { file: string; project: string; mtime: number }[] {
  const out: { file: string; project: string; mtime: number }[] = [];
  for (const h of listDir(geminiRoot())) {
    const dir = path.join(geminiRoot(), h);
    const chats = path.join(dir, "chats");
    let project = "";
    try { project = readFileSync(path.join(dir, ".project_root"), "utf8").trim(); } catch { /* older versions have no project_root */ }
    for (const n of listDir(chats)) {
      if (!n.endsWith(".json")) continue;
      const st = safeStat(path.join(chats, n));
      if (st) out.push({ file: path.join(chats, n), project, mtime: st.mtimeMs });
    }
  }
  return out;
}

function gemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return "";
}

export const geminiAgent: LocalAgent = {
  id: "gemini",
  history: true,
  async detect(ctx): Promise<Detection> {
    const cli = await detectCli(ctx, "gemini", [path.join(process.env.APPDATA ?? "", "npm")]);
    const oauth = exists(path.join(home(), ".gemini", "oauth_creds.json"));
    const decision = decideLogin({
      present: Boolean(cli.cliPath),
      loggedIn: oauth,
      keySource: ctx.keySource,
      loginCommand: "gemini",
      keyName: "GEMINI_API_KEY",
      locale: ctx.locale,
      loginDetail: oauth ? "~/.gemini/oauth_creds.json" : undefined,
      absentNote: ctx.locale === "en" ? "gemini was not found and no backup key is saved." : "未找到 gemini，也没有备用密钥。",
      loggedOutNote: ctx.locale === "en" ? "Not signed in and no backup key. Run gemini on this PC and finish the Google sign-in." : "未登录，也没有备用密钥。请在电脑上运行 gemini，完成 Google 登录。",
    });
    return { ...cli, hasHistory: geminiFiles().length > 0, auth: decision.auth, dataPath: geminiRoot() };
  },
  async sessions(): Promise<AgentSession[]> {
    const out: AgentSession[] = [];
    for (const f of geminiFiles().sort((a, b) => b.mtime - a.mtime)) {
      const j = readJson<GemSession>(f.file);
      if (!j?.messages?.length) continue;
      const first = j.messages.find((m) => m.type === "user");
      out.push({ id: j.sessionId ?? path.basename(f.file, ".json"), agentId: "gemini", title: oneLine(gemText(first?.content) || "（空会话）", 80), projectPath: f.project, projectName: f.project ? baseName(f.project) : "", updatedAt: new Date(f.mtime).toISOString(), messageCount: j.messages.length, preview: oneLine(gemText(j.messages.at(-1)?.content), 100), source: "gemini-tmp" });
    }
    return out;
  },
  async extraProjects(): Promise<string[]> { return []; },
  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const f = geminiFiles().find((x) => (readJson<GemSession>(x.file)?.sessionId ?? path.basename(x.file, ".json")) === sessionId);
    const j = f ? readJson<GemSession>(f.file) : null;
    return (j?.messages ?? []).filter((m) => m.type === "user" || m.type === "gemini").map((m, i): ChatMessage => ({ id: `${sessionId}_${i}`, role: m.type === "user" ? "user" : "assistant", createdAt: m.timestamp ?? "", blocks: [{ type: "text", text: cap(gemText(m.content), 20000) }] })).slice(-limit);
  },
  chat(req, cli, ctx, signal) {
    const args = ["-p", req.prompt];
    if (req.model) args.unshift("-m", req.model);
    const loggedIn = exists(path.join(home(), ".gemini", "oauth_creds.json"));
    const env = childEnv(ctx.env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"], !loggedIn && ctx.keySource !== "none");
    return plainChat(cli, args, req, ctx, signal, "gemini", env);
  },
  async usage(): Promise<AgentUsage> {
    const t0 = startOfToday();
    const today = emptyBucket(), week = emptyBucket(), month = emptyBucket();
    for (const f of geminiFiles()) {
      if (f.mtime < t0 - 29 * 86400000) continue;
      for (const m of readJson<GemSession>(f.file)?.messages ?? []) {
        if (m.type !== "gemini" || !m.tokens) continue;
        const ts = Date.parse(m.timestamp ?? "") || f.mtime;
        for (const [b, from] of [[today, t0], [week, t0 - 6 * 86400000], [month, t0 - 29 * 86400000]] as [UsageBucket, number][]) {
          if (ts < from) continue;
          b.inputTokens += m.tokens.input ?? 0; b.outputTokens += m.tokens.output ?? 0; b.cacheTokens += m.tokens.cached ?? 0; b.requests += 1;
        }
      }
    }
    return { supported: true, reason: "", source: "~/.gemini/tmp/*/chats/session-*.json", hasTokens: true, today, week, month, costEstimated: false, models: [], note: "token 来自 Gemini CLI 本地会话记录，不估算费用。", computedAt: new Date().toISOString() };
  },
};

/* ---------------- OpenCode: ~/.local/share/opencode/storage ---------------- */
const ocRoot = () => path.join(home(), ".local", "share", "opencode", "storage");

interface OcSession { id: string; title?: string; directory?: string; time?: { created?: number; updated?: number } }

function ocSessions(): OcSession[] {
  const out: OcSession[] = [];
  const base = path.join(ocRoot(), "session");
  for (const proj of listDir(base)) for (const n of listDir(path.join(base, proj))) {
    const s = readJson<OcSession>(path.join(base, proj, n));
    if (s?.id) out.push(s);
  }
  return out;
}

export const opencodeAgent: LocalAgent = {
  id: "opencode",
  history: true,
  async detect(ctx): Promise<Detection> {
    const cli = await detectCli(ctx, "opencode", [path.join(process.env.APPDATA ?? "", "npm"), path.join(home(), ".opencode", "bin")]);
    const authed = exists(path.join(home(), ".local", "share", "opencode", "auth.json"));
    const decision = decideLogin({
      present: Boolean(cli.cliPath),
      loggedIn: authed,
      keySource: ctx.keySource,
      loginCommand: "opencode auth login",
      keyName: "OPENCODE_API_KEY",
      locale: ctx.locale,
      loginDetail: authed ? "auth.json" : undefined,
      absentNote: ctx.locale === "en" ? "opencode was not found and no backup key is saved." : "未找到 opencode，也没有备用密钥。",
      whenNeither: "unknown",
      loggedOutNote: ctx.locale === "en"
        ? "No opencode auth.json yet. Run `opencode auth login` on this PC. A saved key is not injected until login is confirmed absent."
        : "还没有 opencode 的 auth.json。请在电脑上运行 opencode auth login。未确认已登录时不会注入密钥。",
    });
    return { ...cli, hasHistory: ocSessions().length > 0, auth: decision.auth, dataPath: ocRoot() };
  },
  async sessions(): Promise<AgentSession[]> {
    return ocSessions().map((s): AgentSession => ({ id: s.id, agentId: "opencode", title: s.title || "（未命名）", projectPath: s.directory ?? "", projectName: s.directory ? baseName(s.directory) : "", updatedAt: new Date(s.time?.updated ?? s.time?.created ?? 0).toISOString(), messageCount: listDir(path.join(ocRoot(), "message", s.id)).length, preview: "", source: "opencode-storage" })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async extraProjects(): Promise<string[]> { return []; },
  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const dir = path.join(ocRoot(), "message", sessionId);
    const msgs = listDir(dir).sort().map((n) => readJson<{ id: string; role: string; time?: { created?: number } }>(path.join(dir, n))).filter(Boolean) as { id: string; role: string; time?: { created?: number } }[];
    const out: ChatMessage[] = [];
    for (const m of msgs) {
      const pdir = path.join(ocRoot(), "part", m.id);
      const text = listDir(pdir).sort().map((n) => readJson<{ type?: string; text?: string }>(path.join(pdir, n))).filter((p) => p?.type === "text" && p.text).map((p) => p!.text).join("\n");
      if (text && (m.role === "user" || m.role === "assistant")) out.push({ id: m.id, role: m.role, createdAt: new Date(m.time?.created ?? 0).toISOString(), blocks: [{ type: "text", text: cap(text, 20000) }] });
    }
    return out.slice(-limit);
  },
  chat(req, cli, ctx, signal) {
    const args = ["run"];
    if (req.sessionId) args.push("--session", req.sessionId);
    if (req.model) args.push("--model", req.model);
    args.push(req.prompt);
    const loggedIn = exists(path.join(home(), ".local", "share", "opencode", "auth.json"));
    const env = childEnv(ctx.env, ["OPENCODE_API_KEY"], !loggedIn && ctx.keySource !== "none");
    return plainChat(cli, args, req, ctx, signal, "opencode", env);
  },
  async usage(): Promise<AgentUsage> {
    return unsupportedUsage("opencode", "OpenCode 的用量记录在其 storage 里按模型供应商不同而不同，PocketPilot 暂未实现读取。");
  },
};

/* ---------------- DeepSeek Harness: command line only ---------------- */
export const deepseekAgent: LocalAgent = {
  id: "deepseek-harness",
  history: false,
  async detect(ctx): Promise<Detection> {
    const cli = await detectCli(ctx, "dsh", [path.join(process.env.APPDATA ?? "", "npm"), path.join(home(), ".local", "bin")]);
    const zh = ctx.locale !== "en";
    const reason = zh
      ? "DeepSeek Harness（dsh）没有本机登录命令，只能用 DEEPSEEK_API_KEY。这不是可选备用。"
      : "DeepSeek Harness (dsh) has no local login command. DEEPSEEK_API_KEY is required, not an optional backup.";
    const decision = decideLogin({
      present: Boolean(cli.cliPath),
      loggedIn: false,
      keySource: ctx.keySource,
      loginCommand: "",
      keyName: "DEEPSEEK_API_KEY",
      locale: ctx.locale,
      keyOnlyReason: reason,
      absentNote: reason,
      loggedOutNote: reason,
    });
    return { ...cli, hasHistory: false, auth: decision.auth, dataPath: "" };
  },
  async sessions(): Promise<AgentSession[]> { return []; },
  async extraProjects(): Promise<string[]> { return []; },
  async messages(): Promise<ChatMessage[]> { return []; },
  chat(req, cli, ctx, signal) {
    return plainChat(cli, ["--profile", "headless", req.prompt], req, ctx, signal, "dsh");
  },
  async usage(): Promise<AgentUsage> {
    return unsupportedUsage("deepseek-harness", "DeepSeek Harness 没有本地会话/用量记录；用量只能在 platform.deepseek.com 控制台查看。");
  },
};

export const cliOnlyAgents: LocalAgent[] = [geminiAgent, opencodeAgent, deepseekAgent];
void readHead;
