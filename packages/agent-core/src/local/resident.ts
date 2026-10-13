import type { StreamEvent } from "@pocketpilot/protocol";
import { ClaudeStreamWorker, type ClaudeMapper, type StreamingQueryFn } from "./claude-stream";
import { CodexAppWorker } from "./codex-app";
import { CursorAcpWorker } from "./cursor-acp";
import { envFingerprint, poolConfig, ResidentStartError, WorkerPool, type PooledWorker, type WarmHint } from "./pool";

/** Process pools shared by every chat of this bridge, one per platform. */
interface Spec { cli: string; env: NodeJS.ProcessEnv }

const specs = new Map<string, Spec>();
const lastCwd = new Map<string, string>();

const cursorPool = new WorkerPool<CursorAcpWorker>({
  sharesSessions: true,
  create: (key, hint) => { const s = specs.get(key); if (!s) return Promise.reject(new Error("unknown pool key")); return CursorAcpWorker.start(s.cli, s.env, hint.cwd); },
});

const codexPool = new WorkerPool<CodexAppWorker>({
  sharesSessions: true,
  create: (key, hint) => { const s = specs.get(key); if (!s) return Promise.reject(new Error("unknown pool key")); return CodexAppWorker.start(s.cli, s.env, hint.cwd); },
});

const claudeOptions = new Map<string, { query: StreamingQueryFn; options: (hint: WarmHint) => Record<string, unknown> }>();
const claudePool = new WorkerPool<ClaudeStreamWorker>({
  sharesSessions: false,
  create: async (key, hint) => {
    const c = claudeOptions.get(key);
    if (!c) throw new Error("unknown pool key");
    return new ClaudeStreamWorker(c.query, c.options(hint));
  },
});

let exitHook = false;
function hookExit(): void {
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { cursorPool.disposeAll(); codexPool.disposeAll(); claudePool.disposeAll(); });
}

export const residentEnabled = (): boolean => poolConfig().enabled;

const keyFor = (platform: string, cli: string, env: NodeJS.ProcessEnv, secrets: readonly string[], extra = ""): string =>
  `${platform}|${cli}|${envFingerprint(env, secrets)}${extra ? `|${extra}` : ""}`;

/**
 * Run one turn on a pooled worker. Throws ResidentStartError when nothing was produced yet, so callers can fall back
 * to the one-shot CLI; after output has started, a failure is reported as an error event instead.
 */
async function* turnOn<W extends PooledWorker>(pool: WorkerPool<W>, key: string, hint: WarmHint, zh: boolean, run: (w: W) => AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
  hookExit();
  let lease;
  try {
    lease = await pool.acquire(key, hint);
  } catch (error) {
    throw new ResidentStartError(error instanceof Error ? error.message : String(error));
  }
  if (!lease.warm) yield { type: "status", status: zh ? "正在启动常驻进程（只在第一次需要）…" : "Starting the resident process (first time only)…" };
  let produced = false;
  let healthy = true;
  try {
    for await (const event of run(lease.worker)) {
      if (event.type === "session") lease.bind(event.id);
      else if (event.type !== "status") produced = true;
      yield event;
    }
  } catch (error) {
    healthy = lease.worker.alive;
    const message = error instanceof Error ? error.message : String(error);
    if (!produced) throw new ResidentStartError(message);
    yield { type: "error", message };
  } finally {
    lease.release(healthy && lease.worker.alive);
  }
}

export interface ResidentReq { sessionId?: string; cwd: string; prompt: string; model?: string }

export function cursorResident(cli: string, env: NodeJS.ProcessEnv, req: ResidentReq, zh: boolean, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const key = keyFor("cursor", cli, env, ["CURSOR_API_KEY"]);
  specs.set(key, { cli, env });
  lastCwd.set("cursor", req.cwd);
  return turnOn(cursorPool, key, { cwd: req.cwd, sessionId: req.sessionId }, zh, (w) => w.prompt(req, signal));
}

export function codexResident(cli: string, env: NodeJS.ProcessEnv, req: ResidentReq, zh: boolean, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const key = keyFor("codex", cli, env, ["OPENAI_API_KEY"]);
  specs.set(key, { cli, env });
  lastCwd.set("codex", req.cwd);
  return turnOn(codexPool, key, { cwd: req.cwd, sessionId: req.sessionId, model: req.model }, zh, (w) => w.prompt(req, signal));
}

/** `options(hint)` builds SDK options for a new process (cwd, resume, model). A process is one cwd + one session. */
export function claudeResident(query: StreamingQueryFn, env: NodeJS.ProcessEnv | undefined, options: (hint: WarmHint) => Record<string, unknown>, req: ResidentReq, map: () => ClaudeMapper, zh: boolean, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const key = keyFor("claude", "sdk", env ?? {}, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], req.cwd.toLowerCase());
  claudeOptions.set(key, { query, options });
  lastCwd.set("claude", req.cwd);
  return turnOn(claudePool, key, { cwd: req.cwd, sessionId: req.sessionId, model: req.model }, zh, (w) => w.prompt(req, map(), signal));
}

/** Start a logged-in process ahead of the first message (called after detection). */
export function warmCursor(cli: string, env: NodeJS.ProcessEnv): void {
  if (!residentEnabled()) return;
  hookExit();
  const key = keyFor("cursor", cli, env, ["CURSOR_API_KEY"]);
  specs.set(key, { cli, env });
  cursorPool.warm(key, { cwd: lastCwd.get("cursor") });
}

export function warmCodex(cli: string, env: NodeJS.ProcessEnv): void {
  if (!residentEnabled()) return;
  hookExit();
  const key = keyFor("codex", cli, env, ["OPENAI_API_KEY"]);
  specs.set(key, { cli, env });
  codexPool.warm(key, { cwd: lastCwd.get("codex") });
}

export function residentStats(): Record<string, ReturnType<WorkerPool<PooledWorker>["stats"]>> {
  return { cursor: cursorPool.stats(), codex: codexPool.stats(), claude: claudePool.stats() };
}

export function disposeResident(): void {
  cursorPool.disposeAll();
  codexPool.disposeAll();
  claudePool.disposeAll();
}

export { ResidentStartError };
