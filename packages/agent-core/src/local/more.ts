import type { AgentTestResult } from "@pocketpilot/protocol";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, StreamEvent } from "@pocketpilot/protocol";
import { baseName, cap, exists, fileUriToPath, findExecutable, home, listDir, normPath, oneLine, readLines, runCapture, runStream, safeStat, startOfToday, tryJson } from "./util";
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

function traeRollouts(): { file: string; id: string; mtime: number }[] {
  const out: { file: string; id: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const n of listDir(dir)) {
      const full = path.join(dir, n);
      if (depth < 3) { walk(full, depth + 1); continue; }
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      const st = safeStat(full);
      const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(n)?.[1] ?? n.replace(/\.jsonl$/, "");
      if (st) out.push({ file: full, id, mtime: st.mtimeMs });
    }
  };
  walk(traeCliRoot(), 0);
  return out;
}

function msgText(content: unknown): string {
  return (Array.isArray(content) ? content : []).map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
}

async function traeMeta(file: string): Promise<{ cwd: string; title: string }> {
  let cwd = "", title = "", n = 0;
  for await (const line of readLines(file)) {
    const j = tryJson(line);
    const p = j?.payload as Record<string, unknown> | undefined;
    if (j?.type === "session_meta" && typeof p?.cwd === "string") cwd = p.cwd;
    if (j?.type === "response_item" && p?.type === "message" && p.role === "user") {
      const t = msgText(p.content).trim();
      if (t && !t.startsWith("<")) { title = oneLine(t, 80); break; }
    }
    if (++n > 200) break;
  }
  return { cwd, title };
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
    const jwt = exists(path.join(home(), ".trae-cn", "trae-jwt-token")) || exists(path.join(home(), ".trae", "trae-jwt-token"));
    const zh = ctx.locale !== "en";
    const auth = found
      ? { state: "unknown" as const, source: "cli", note: zh ? "登录状态由 traecli 自己保存；未登录时发送会提示运行 traecli login" : "Login is stored by traecli; run `traecli login` if sending fails" }
      : ide
        ? { state: jwt ? ("ok" as const) : ("unknown" as const), source: "ide", note: zh ? `Trae CN 编辑器${jwt ? "已登录（只检查令牌文件是否存在，不读取内容）" : "（未发现登录令牌）"}。编辑器没有命令行或接口可从手机调用，只能读取已打开的项目` : "Trae CN IDE found; it exposes no CLI/API to drive from the phone" }
        : { state: "missing" as const, source: "none", note: zh ? "未发现 Trae CN 或 TRAE CLI" : "Neither Trae CN nor TRAE CLI found" };
    return { cliPath: found, version: version ? cap(version, 80) : null, hasHistory: ide || traeRollouts().length > 0, auth, dataPath: traeDirs()[0] ?? traeCliRoot() };
  },
  async sessions(): Promise<AgentSession[]> {
    const out: AgentSession[] = [];
    for (const r of traeRollouts().sort((a, b) => b.mtime - a.mtime)) {
      const m = await traeMeta(r.file);
      out.push({ id: r.id, agentId: "trae-cn", title: m.title || "TRAE CLI", projectPath: m.cwd, projectName: m.cwd ? baseName(m.cwd) : "", updatedAt: new Date(r.mtime).toISOString(), messageCount: -1, preview: "", source: "trae-cli" });
    }
    return out;
  },
  async extraProjects(): Promise<string[]> {
    return traeWorkspaces();
  },
  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const r = traeRollouts().find((x) => x.id === sessionId);
    if (!r) return [];
    const out: ChatMessage[] = [];
    let n = 0;
    for await (const line of readLines(r.file)) {
      const j = tryJson(line);
      const p = j?.payload as Record<string, unknown> | undefined;
      if (j?.type !== "response_item" || p?.type !== "message") continue;
      const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : null;
      const text = msgText(p.content).trim();
      if (!role || !text || (role === "user" && text.startsWith("<"))) continue;
      out.push({ id: `${sessionId}_${n++}`, role, createdAt: String(j?.timestamp ?? ""), blocks: [{ type: "text", text: cap(text, 20000) }] });
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
interface GrokChat { id: string; cwd: string; title: string; updatedAt: string; messages: { role: "user" | "assistant"; text: string; at: string }[] }

function grokRead(dir: string): GrokChat[] {
  try { return JSON.parse(readFileSync(path.join(dir, GROK_STORE), "utf8")) as GrokChat[]; } catch { return []; }
}
function grokWrite(dir: string, list: GrokChat[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, GROK_STORE), JSON.stringify(list.slice(0, 200)));
}
let grokModels: { at: number; key: string; list: string[] } | null = null;

async function xaiModels(key: string): Promise<string[]> {
  if (grokModels && grokModels.key === key && Date.now() - grokModels.at < 600_000) return grokModels.list;
  try {
    const res = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id?: string }[] };
    const list = (j.data ?? []).map((m) => String(m.id)).filter(Boolean);
    grokModels = { at: Date.now(), key, list };
    return list;
  } catch { return []; }
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
    const key = ctx.env.XAI_API_KEY ?? "";
    const zh = ctx.locale !== "en";
    const models = key ? await xaiModels(key) : [];
    const auth = key
      ? { state: "ok" as const, source: ctx.keySource, note: zh ? "XAI_API_KEY（xAI API 对话；只有文字对话，不能读写项目文件）" : "XAI_API_KEY (xAI API chat; no file tools)" }
      : found
        ? { state: "unknown" as const, source: "cli", note: zh ? "登录由 grok 自己保存（grok login）；或在下方保存 XAI_API_KEY 走 API" : "Sign in with `grok login`, or save XAI_API_KEY below" }
        : { state: "missing" as const, source: "none", note: zh ? "没有 XAI_API_KEY，也没找到 grok 命令行" : "No XAI_API_KEY and no grok CLI" };
    return {
      cliPath: key && !found ? "xai-api" : found,
      version: key && !found ? "xAI API" : version ? cap(version, 80) : null,
      hasHistory: grokRead(ctx.dataDir).length > 0,
      auth,
      dataPath: path.join(ctx.dataDir, GROK_STORE),
      models,
    };
  },
  async test(ctx, _cli): Promise<AgentTestResult> {
    const zh = ctx.locale !== "en";
    const key = ctx.env.XAI_API_KEY ?? "";
    if (!key) return { ok: false, message: zh ? "未配置 XAI_API_KEY：请先填写并保存密钥。" : "No XAI_API_KEY saved yet." };
    try {
      const res = await fetch(`${XAI}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { data?: unknown[] };
        grokModels = null;
        const n = j.data?.length ?? 0;
        return { ok: true, message: zh ? `连接成功，密钥有效，可用模型 ${n} 个。` : `Connected. The key is valid, ${n} models available.` };
      }
      const hint = res.status === 400 || res.status === 401 || res.status === 403 ? (zh ? "密钥无效或已被吊销。" : "The key is invalid or revoked.") : `HTTP ${res.status}`;
      return { ok: false, message: zh ? `xAI 拒绝了请求：${hint}` : `xAI rejected the request: ${hint}` };
    } catch (error) {
      return { ok: false, message: (zh ? "无法访问 api.x.ai：" : "Cannot reach api.x.ai: ") + (error instanceof Error ? error.message : String(error)).slice(0, 160) };
    }
  },

  async sessions(ctx): Promise<AgentSession[]> {
    return grokRead(ctx.dataDir).map((c) => ({ id: c.id, agentId: "grok", title: c.title, projectPath: c.cwd, projectName: baseName(c.cwd), updatedAt: c.updatedAt, messageCount: c.messages.length, preview: oneLine(c.messages.at(-1)?.text ?? "", 100), source: "pocketpilot" }));
  },
  async extraProjects(): Promise<string[]> { return []; },
  async messages(sessionId, limit, ctx): Promise<ChatMessage[]> {
    const c = grokRead(ctx.dataDir).find((x) => x.id === sessionId);
    return (c?.messages ?? []).slice(-limit).map((m, i) => ({ id: `${sessionId}_${i}`, role: m.role, createdAt: m.at, blocks: [{ type: "text" as const, text: m.text }] }));
  },
  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const key = ctx.env.XAI_API_KEY ?? "";
    if (!key) {
      // Grok Build CLI, plain output
      const args = ["--no-auto-update", "-p", req.prompt, "--cwd", req.cwd, "--output-format", "plain", "--always-approve"];
      if (req.model) args.push("-m", req.model);
      if (req.sessionId) args.push("-r", req.sessionId);
      let exit: { code: number | null; stderr: string } | null = null;
      for await (const item of runStream(cli, args, { cwd: req.cwd, env: ctx.env, json: false, signal })) {
        if (item.kind === "exit") { exit = item; break; }
        if (item.kind === "text") yield { type: "text", delta: item.text };
      }
      if (exit && exit.code !== 0) { yield { type: "error", message: cap(exit.stderr.trim() || `grok exit ${exit.code}`, 500) }; return; }
      yield { type: "done" };
      return;
    }
    const list = grokRead(ctx.dataDir);
    const id = req.sessionId ?? `grok_${Date.now().toString(36)}`;
    const existing = list.find((c) => c.id === id);
    if (!req.sessionId) yield { type: "session", id };
    const history = (existing?.messages ?? []).slice(-30).map((m) => ({ role: m.role, content: m.text }));
    const model = req.model || "grok-4";
    let res: Response;
    try {
      res = await fetch(`${XAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: `You are Grok replying inside PocketPilot on a phone. The user's project folder is ${req.cwd}, but you cannot read or edit files; answer in text.` }, ...history, { role: "user", content: req.prompt }] }),
        signal,
      });
    } catch (e) {
      yield { type: "error", message: cap(`xAI API: ${e instanceof Error ? e.message : String(e)}`, 400) };
      return;
    }
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      let msg = raw;
      try { const j = JSON.parse(raw) as { error?: string | { message?: string }; code?: string }; msg = typeof j.error === "string" ? j.error : j.error?.message ?? raw; } catch { /* raw */ }
      const hint = res.status === 400 || res.status === 401 || res.status === 403 ? (ctx.locale === "en" ? " (check XAI_API_KEY)" : "（请检查 XAI_API_KEY）") : "";
      yield { type: "error", message: cap(`xAI API ${res.status}: ${msg}${hint}`, 500) };
      return;
    }
    let answer = "";
    interface XUsage { prompt_tokens?: number; completion_tokens?: number; cost_in_usd_ticks?: number }
    let usage = null as XUsage | null;
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
        const delta = (j?.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content;
        if (delta) { answer += delta; yield { type: "text", delta }; }
        if (j?.usage) usage = j.usage as XUsage;
      }
    }
    const now = new Date().toISOString();
    const chat = existing ?? { id, cwd: req.cwd, title: oneLine(req.prompt, 60), updatedAt: now, messages: [] };
    chat.messages.push({ role: "user", text: req.prompt, at: now }, { role: "assistant", text: answer || "(no output)", at: now });
    chat.updatedAt = now;
    if (!existing) list.unshift(chat);
    try {
      if (!exists(path.join(ctx.dataDir, "no-history"))) grokWrite(ctx.dataDir, list);
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
