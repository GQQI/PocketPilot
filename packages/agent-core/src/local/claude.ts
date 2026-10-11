import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentChatRequest, AgentSession, AgentUsage, ChatMessage, MessageBlock, StreamEvent, UsageBucket } from "@pocketpilot/protocol";
import { baseName, cap, exists, prettyError, FileCache, findExecutable, globDirs, home, listDir, oneLine, readLines, runCapture, runStream, safeStat, startOfToday, tryJson } from "./util";
import { emptyBucket, type AgentCtx, type Detection, type LocalAgent } from "./types";

/**
 * Claude Code.
 * History + usage: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl (every line carries cwd, timestamp; assistant lines carry message.usage).
 * Running: `claude -p --output-format stream-json --verbose [--resume <id>]`, prompt on stdin, cwd = project folder.
 * Credentials are never read into PocketPilot; only the *presence* of a key/login is reported.
 */
const projectsRoot = () => path.join(home(), ".claude", "projects");

interface Meta { id: string; file: string; cwd: string; title: string; preview: string }
const metaCache = new FileCache<Meta | null>();

function files(): { id: string; file: string; mtime: number }[] {
  const out: { id: string; file: string; mtime: number }[] = [];
  for (const slug of listDir(projectsRoot())) {
    const dir = path.join(projectsRoot(), slug);
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const st = safeStat(file);
      if (st) out.push({ id: name.slice(0, -6), file, mtime: st.mtimeMs });
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
}

function isNoise(text: string): boolean {
  const t = text.trim();
  return !t || t.startsWith("<command-") || t.startsWith("<local-command") || t.startsWith("Caveat:") || t.startsWith("<system-reminder>");
}

async function meta(f: { id: string; file: string }): Promise<Meta | null> {
  return metaCache.get(f.file, async () => {
    let cwd = "";
    let title = "";
    let aiTitle = "";
    let preview = "";
    let n = 0;
    for await (const line of readLines(f.file)) {
      const j = tryJson(line);
      if (!j) continue;
      if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
      if (j.type === "ai-title" && typeof j.aiTitle === "string") aiTitle = j.aiTitle;
      if (j.type === "user" && !title && !j.isMeta) {
        const t = textOf((j.message as { content?: unknown })?.content);
        if (!isNoise(t)) title = oneLine(t, 80);
      }
      if (j.type === "assistant" && !preview) {
        const t = textOf((j.message as { content?: unknown })?.content);
        if (t.trim()) preview = oneLine(t, 100);
      }
      if (++n > 600) break;
    }
    return { id: f.id, file: f.file, cwd, title: aiTitle || title, preview };
  });
}

function settingsEnv(): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(path.join(home(), ".claude", "settings.json"), "utf8")) as { env?: Record<string, unknown>; model?: string };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.env ?? {})) if (typeof v === "string") out[k] = v;
    if (typeof j.model === "string") out.__model = j.model;
    return out;
  } catch {
    return {};
  }
}

function candidates(): { names: string[]; dirs: string[] } {
  const appdata = process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
  const dirs = [path.join(home(), ".local", "bin"), path.join(appdata, "npm"), path.join(home(), ".claude", "local")];
  for (const ext of [".vscode", ".cursor", ".vscode-insiders"]) {
    for (const d of globDirs(path.join(home(), ext, "extensions"), "anthropic.claude-code-")) dirs.push(path.join(d, "resources", "native-binary"));
  }
  return { names: ["claude"], dirs };
}

export const claudeAgent: LocalAgent = {
  id: "claude-code",
  history: true,

  async detect(ctx): Promise<Detection> {
    const c = candidates();
    const explicit = ctx.cliPath && ctx.cliPath !== "claude" ? ctx.cliPath : undefined;
    const found = findExecutable(c.names, c.dirs, explicit);
    let version: string | null = null;
    if (found) {
      const r = await runCapture(found, ["--version"], { env: ctx.env, timeoutMs: 10000 });
      version = (r.stdout || r.stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
    }
    const s = settingsEnv();
    const credsFile = path.join(home(), ".claude", ".credentials.json");
    const auth = ctx.keySource !== "none"
      ? { state: "ok" as const, source: ctx.keySource, note: "ANTHROPIC_API_KEY" }
      : s.ANTHROPIC_AUTH_TOKEN || s.ANTHROPIC_API_KEY
        ? { state: "ok" as const, source: "settings", note: s.ANTHROPIC_BASE_URL ? `~/.claude/settings.json（自定义网关 ${hostOf(s.ANTHROPIC_BASE_URL)}）` : "~/.claude/settings.json" }
        : process.env.ANTHROPIC_AUTH_TOKEN
          ? { state: "ok" as const, source: "env", note: "ANTHROPIC_AUTH_TOKEN" }
          : exists(credsFile)
            ? { state: "ok" as const, source: "login", note: "Claude 账号登录" }
            : found
              ? { state: "unknown" as const, source: "cli", note: "未发现密钥；如已用 claude login 登录，发送时会直接可用" }
              : { state: "missing" as const, source: "none", note: "未找到 claude，也没有配置密钥" };
    return { cliPath: found, version: version ? cap(version, 80) : null, hasHistory: files().length > 0, auth, dataPath: projectsRoot(), defaultModel: s.ANTHROPIC_MODEL || s.__model };
  },

  async sessions(): Promise<AgentSession[]> {
    const out: AgentSession[] = [];
    for (const f of files().sort((a, b) => b.mtime - a.mtime)) {
      const m = await meta(f);
      if (!m || !m.title) continue;
      out.push({ id: f.id, agentId: "claude-code", title: m.title, projectPath: m.cwd, projectName: m.cwd ? baseName(m.cwd) : "", updatedAt: new Date(f.mtime).toISOString(), messageCount: -1, preview: m.preview, source: "claude-projects" });
    }
    return out;
  },

  async extraProjects(): Promise<string[]> {
    return [];
  },

  async messages(sessionId, limit): Promise<ChatMessage[]> {
    const f = files().find((x) => x.id === sessionId);
    if (!f) return [];
    const out: ChatMessage[] = [];
    const tools = new Map<string, MessageBlock & { type: "tool" }>();
    let current: ChatMessage | null = null;
    for await (const line of readLines(f.file)) {
      const j = tryJson(line);
      if (!j || j.isSidechain === true) continue;
      const at = typeof j.timestamp === "string" ? j.timestamp : new Date(f.mtime).toISOString();
      const content = (j.message as { content?: unknown } | undefined)?.content;
      if (j.type === "user" && !j.isMeta) {
        if (Array.isArray(content)) {
          for (const b of content as Record<string, unknown>[]) {
            if (b.type === "tool_result") {
              const t = tools.get(String(b.tool_use_id));
              if (t) t.status = b.is_error === true ? "error" : "done";
            }
          }
        }
        const text = textOf(content);
        if (isNoise(text)) continue;
        current = null;
        out.push({ id: String(j.uuid ?? `${sessionId}_${out.length}`), role: "user", createdAt: at, blocks: [{ type: "text", text: cap(text, 20000) }] });
      } else if (j.type === "assistant") {
        if (!current) {
          current = { id: String(j.uuid ?? `${sessionId}_${out.length}`), role: "assistant", createdAt: at, blocks: [] };
          out.push(current);
        }
        for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) current.blocks.push({ type: "text", text: cap(b.text, 20000) });
          else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) current.blocks.push({ type: "thinking", text: cap(b.thinking, 4000) });
          else if (b.type === "tool_use") {
            const input = (b.input ?? {}) as Record<string, unknown>;
            const detail = String(input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.description ?? JSON.stringify(input));
            const block: MessageBlock & { type: "tool" } = { type: "tool", name: String(b.name ?? "tool"), detail: oneLine(detail, 140), status: "running" };
            tools.set(String(b.id), block);
            current.blocks.push(block);
          }
        }
      }
    }
    for (const b of tools.values()) if (b.status === "running") b.status = "done";
    return out.filter((m) => m.blocks.length).slice(-limit);
  },

  async *chat(req: AgentChatRequest, cli: string, ctx: AgentCtx, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);
    let sawText = false;
    let sessionId = req.sessionId ?? "";
    let failed = "";
    let exit: { code: number | null; stderr: string } | null = null;
    for await (const item of runStream(cli, args, { cwd: req.cwd, env: ctx.env, stdin: req.prompt, json: true, signal })) {
      if (item.kind === "exit") { exit = item; break; }
      if (item.kind === "text") continue;
      const v = item.value;
      if (typeof v.session_id === "string" && v.session_id && v.session_id !== sessionId) {
        sessionId = v.session_id;
        yield { type: "session", id: sessionId };
      }
      if (v.type === "system" && v.subtype === "api_retry") {
        yield { type: "status", status: `API 连接失败，正在重试（第 ${String(v.attempt ?? "?")} 次）…` };
      } else if (v.type === "assistant" && (v.message as { model?: string })?.model === "<synthetic>") {
        // Claude Code's own error line (e.g. "API Error: Unable to connect to API"), not a model answer
        failed = textOf((v.message as { content?: unknown }).content) || "Claude Code 返回了错误";
      } else if (v.type === "assistant") {
        const content = (v.message as { content?: unknown })?.content;
        for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
          if (b.type === "text" && typeof b.text === "string") { sawText = true; yield { type: "text", delta: b.text }; }
          else if (b.type === "thinking" && typeof b.thinking === "string") yield { type: "thinking", delta: b.thinking };
          else if (b.type === "tool_use") {
            const input = (b.input ?? {}) as Record<string, unknown>;
            yield { type: "tool", phase: "start", name: String(b.name ?? "tool"), detail: oneLine(String(input.file_path ?? input.command ?? input.pattern ?? input.description ?? ""), 120) };
          }
        }
      } else if (v.type === "result") {
        const usage = v.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) yield { type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
        if (v.is_error === true) failed = failed || (typeof v.result === "string" ? v.result : "Claude Code 返回了错误");
        else if (!sawText && typeof v.result === "string" && v.result) yield { type: "text", delta: v.result };
      }
    }
    if (failed || (exit && exit.code !== 0 && !sawText)) {
      yield { type: "error", message: explain(failed || exit?.stderr.trim() || `claude 退出码 ${exit?.code}`, ctx) };
      return;
    }
    yield { type: "done" };
  },

  async usage(): Promise<AgentUsage> {
    const t0 = startOfToday();
    const today = emptyBucket(), week = emptyBucket(), month = emptyBucket();
    const models = new Set<string>();
    let unpriced = false;
    let priced = false;
    const seen = new Set<string>();
    for (const f of files()) {
      if (f.mtime < t0 - 29 * 86400000) continue;
      for await (const line of readLines(f.file)) {
        if (!line.includes('"usage"')) continue;
        const j = tryJson(line);
        if (!j || j.type !== "assistant") continue;
        const msg = j.message as { id?: string; model?: string; usage?: Record<string, number> } | undefined;
        if (!msg?.usage || !msg.model || msg.model === "<synthetic>") continue;
        const key = `${msg.id ?? ""}:${j.requestId ?? j.uuid ?? ""}`;
        if (msg.id && seen.has(key)) continue;
        seen.add(key);
        const ts = Date.parse(String(j.timestamp ?? "")) || f.mtime;
        const u = msg.usage;
        const inTok = (u.input_tokens ?? 0);
        const outTok = (u.output_tokens ?? 0);
        const cache = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        models.add(msg.model);
        const price = priceFor(msg.model);
        const cost = price ? (inTok * price.in + outTok * price.out + (u.cache_read_input_tokens ?? 0) * price.in * 0.1 + (u.cache_creation_input_tokens ?? 0) * price.in * 1.25) / 1e6 : null;
        if (cost === null) unpriced = true; else priced = true;
        for (const [b, from] of [[today, t0], [week, t0 - 6 * 86400000], [month, t0 - 29 * 86400000]] as [UsageBucket, number][]) {
          if (ts < from) continue;
          b.inputTokens += inTok; b.outputTokens += outTok; b.cacheTokens += cache; b.requests += 1;
          if (cost !== null) b.costUsd = (b.costUsd ?? 0) + cost;
        }
      }
    }
    return {
      supported: true,
      reason: "",
      source: "~/.claude/projects/**/*.jsonl（message.usage）",
      hasTokens: true,
      today, week, month,
      costEstimated: priced,
      models: [...models],
      note: priced
        ? `费用按公开单价估算${unpriced ? "，未知模型（如自定义网关的模型）没有计价" : ""}，不等于账单。`
        : "没有这些模型的公开单价（例如经自定义网关的模型），所以只显示 token 数，不估算费用。",
      computedAt: new Date().toISOString(),
    };
  },
};

function priceFor(model: string): { in: number; out: number } | null {
  const m = model.toLowerCase();
  if (!m.startsWith("claude")) return null;
  if (m.includes("opus")) return { in: 15, out: 75 };
  if (m.includes("sonnet")) return { in: 3, out: 15 };
  if (m.includes("haiku")) return { in: 1, out: 5 };
  return null;
}

function explain(raw: string, ctx: AgentCtx): string {
  const message = prettyError(raw);
  if (/ConnectionRefused|Unable to connect/i.test(message)) {
    return ctx.locale === "en" ? `Claude Code could not reach its API (${cap(message, 120)}). Check the gateway/proxy in ~/.claude/settings.json is running.` : `Claude Code 连不上它的 API（${cap(message, 120)}）。请检查电脑上 ~/.claude/settings.json 里配置的网关/代理是否在运行。`;
  }
  if (/api key|login|unauthor|authentication|401/i.test(message)) {
    return ctx.locale === "en" ? `Claude Code is not signed in or has no key: ${cap(message, 200)}` : `Claude Code 未登录或没有密钥：${cap(message, 200)}`;
  }
  return cap(message, 600);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
