import { createHash } from "node:crypto";

/**
 * Resident agent processes.
 *
 * Each platform that has a long-lived protocol (Cursor `agent acp`, Codex `app-server`,
 * Claude Agent SDK streaming input) keeps its process here instead of starting one per message:
 * - a worker that already holds a session is reused for that session;
 * - after a turn, one spare worker per key is started and initialised (login, handshake) so the next
 *   chat only has to write the prompt;
 * - idle workers are disposed after `idleMs`; a worker that died is dropped and replaced on demand.
 * Everything is tunable from the environment; nothing here knows about a specific platform.
 */
export interface PooledWorker {
  readonly alive: boolean;
  dispose(): void;
}

export interface PoolConfig {
  enabled: boolean;
  /** dispose an idle worker after this long */
  idleMs: number;
  /** upper bound on idle workers kept per pool (busy workers are never killed) */
  maxWorkers: number;
  /** warm workers kept ready per key */
  spare: number;
}

const num = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.max(min, n) : fallback;
};

/** POCKETPILOT_RESIDENT=0 turns resident processes off (every message spawns a one-shot CLI again). */
export function poolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    enabled: env.POCKETPILOT_RESIDENT !== "0",
    idleMs: num(env.POCKETPILOT_POOL_IDLE_MS, 15 * 60_000, 1_000),
    maxWorkers: num(env.POCKETPILOT_POOL_MAX, 4, 1),
    spare: num(env.POCKETPILOT_POOL_SPARE, 1, 0),
  };
}

/** Pool key part for an environment: which secrets are present (hashed, never stored), not their values. */
export function envFingerprint(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  const h = createHash("sha256");
  for (const n of names) h.update(`${n}=${env[n] ?? ""}\n`);
  return h.digest("hex").slice(0, 12);
}

export interface WarmHint {
  cwd?: string;
  sessionId?: string;
  model?: string;
}

interface Entry<W> {
  id: number;
  key: string;
  ready: Promise<W>;
  worker: W | null;
  busy: boolean;
  sessions: Set<string>;
  lastUsed: number;
  hint: WarmHint;
}

export interface Lease<W> {
  worker: W;
  /** true when this worker had been started before the request (warm) */
  warm: boolean;
  /** remember that this worker now holds `sessionId` */
  bind(sessionId: string): void;
  /** return the worker; `healthy=false` disposes it */
  release(healthy?: boolean): void;
}

export interface PoolOptions<W> {
  create(key: string, hint: WarmHint): Promise<W>;
  /** one process can serve several sessions (ACP, app-server). False: a process is one session (Claude SDK). */
  sharesSessions: boolean;
  config?: () => PoolConfig;
  now?: () => number;
}

export class WorkerPool<W extends PooledWorker> {
  private entries: Entry<W>[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly cfg: () => PoolConfig;
  private readonly now: () => number;

  constructor(private readonly opts: PoolOptions<W>) {
    this.cfg = opts.config ?? (() => poolConfig());
    this.now = opts.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.cfg().enabled;
  }

  async acquire(key: string, hint: WarmHint = {}): Promise<Lease<W>> {
    this.sweep();
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.pick(key, hint.sessionId) ?? this.spawn(key, hint);
      const warm = entry.worker !== null;
      entry.busy = true;
      let worker: W;
      try {
        worker = await entry.ready;
      } catch (error) {
        this.drop(entry);
        throw error;
      }
      if (!worker.alive) {
        this.drop(entry);
        if (attempt === 0) continue;
        throw new Error("resident worker exited during start-up");
      }
      return this.lease(entry, worker, warm);
    }
    throw new Error("unreachable");
  }

  /** Start a spare worker for `key` when none is idle. Errors are swallowed: warming is best effort. */
  warm(key: string, hint: WarmHint = {}): void {
    const c = this.cfg();
    if (!c.enabled || c.spare <= 0) return;
    this.sweep();
    const spares = this.entries.filter((e) => e.key === key && !e.busy && (this.opts.sharesSessions || e.sessions.size === 0));
    if (spares.length >= c.spare) return;
    if (this.entries.filter((e) => !e.busy).length >= c.maxWorkers) this.evictOldestIdle();
    const entry = this.spawn(key, { cwd: hint.cwd, model: hint.model });
    entry.ready.catch(() => this.drop(entry));
  }

  /** Dispose idle workers past the timeout and drop dead ones. */
  sweep(): void {
    const { idleMs } = this.cfg();
    const t = this.now();
    for (const e of [...this.entries]) {
      if (e.busy) continue;
      if (e.worker && !e.worker.alive) this.drop(e);
      else if (e.worker && t - e.lastUsed > idleMs) this.drop(e);
    }
    if (!this.entries.length && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  disposeAll(): void {
    for (const e of [...this.entries]) this.drop(e);
  }

  stats(): { key: string; busy: boolean; sessions: number; ready: boolean; idleMs: number }[] {
    const t = this.now();
    return this.entries.map((e) => ({ key: e.key, busy: e.busy, sessions: e.sessions.size, ready: e.worker !== null, idleMs: t - e.lastUsed }));
  }

  private pick(key: string, sessionId?: string): Entry<W> | undefined {
    const idle = this.entries.filter((e) => e.key === key && !e.busy && (!e.worker || e.worker.alive));
    if (sessionId) {
      const bound = idle.find((e) => e.sessions.has(sessionId));
      if (bound) return bound;
    }
    // prefer a ready worker over one still starting, then the most recently used
    const free = idle.filter((e) => this.opts.sharesSessions || e.sessions.size === 0);
    free.sort((a, b) => Number(b.worker !== null) - Number(a.worker !== null) || b.lastUsed - a.lastUsed);
    return free[0];
  }

  private spawn(key: string, hint: WarmHint): Entry<W> {
    const entry: Entry<W> = { id: ++this.seq, key, ready: Promise.resolve(null as unknown as W), worker: null, busy: false, sessions: new Set(), lastUsed: this.now(), hint };
    entry.ready = this.opts.create(key, hint).then((w) => {
      entry.worker = w;
      if (!this.entries.includes(entry)) w.dispose();
      return w;
    });
    if (hint.sessionId) entry.sessions.add(hint.sessionId);
    this.entries.push(entry);
    this.ensureTimer();
    return entry;
  }

  private lease(entry: Entry<W>, worker: W, warm: boolean): Lease<W> {
    let done = false;
    return {
      worker,
      warm,
      bind: (sessionId) => { if (sessionId) entry.sessions.add(sessionId); },
      release: (healthy = true) => {
        if (done) return;
        done = true;
        entry.busy = false;
        entry.lastUsed = this.now();
        if (!healthy || !worker.alive) this.drop(entry);
        if (this.entries.filter((e) => !e.busy).length > this.cfg().maxWorkers) this.evictOldestIdle();
        this.warm(entry.key, entry.hint);
      },
    };
  }

  private evictOldestIdle(): void {
    const idle = this.entries.filter((e) => !e.busy && e.worker).sort((a, b) => a.lastUsed - b.lastUsed);
    if (idle[0]) this.drop(idle[0]);
  }

  private drop(entry: Entry<W>): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    try { entry.worker?.dispose(); } catch { /* already gone */ }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const every = Math.min(60_000, Math.max(1_000, Math.floor(this.cfg().idleMs / 2)));
    this.timer = setInterval(() => this.sweep(), every);
    this.timer.unref?.();
  }
}

/** Thrown by a resident path before it produced any output, so the caller can fall back to the one-shot CLI. */
export class ResidentStartError extends Error {}
