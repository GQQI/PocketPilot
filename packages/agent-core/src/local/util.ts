import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export function home(): string {
  return process.env.USERPROFILE || homedir();
}

export function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export function safeStat(p: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Reads at most `bytes` from the start of a file (used to peek at the first lines of large transcripts). */
export function readHead(file: string, bytes: number): string {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const n = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export async function* readLines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line) yield line;
  } finally {
    rl.close();
  }
}

export function tryJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function oneLine(text: string, max = 90): string {
  return cap(text.replace(/\s+/g, " ").trim(), max);
}

export function baseName(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

/** Cache keyed by file path, invalidated when mtime or size change. */
export class FileCache<T> {
  private readonly map = new Map<string, { sig: string; value: T }>();
  async get(file: string, load: () => Promise<T> | T): Promise<T> {
    const st = safeStat(file);
    const sig = st ? `${st.mtimeMs}:${st.size}` : "none";
    const hit = this.map.get(file);
    if (hit && hit.sig === sig) return hit.value;
    const value = await load();
    this.map.set(file, { sig, value });
    return value;
  }
}

export function slugify(p: string): string {
  return p.replace(/^([a-zA-Z]):/, "$1").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Cursor stores projects under a slug of the folder path (separators and punctuation become "-"). Rebuild the real path by walking the disk. */
export function resolveSlug(slug: string): string | null {
  const m = /^([A-Za-z])-(.*)$/.exec(slug);
  if (!m) return null;
  const root = `${m[1].toUpperCase()}:\\`;
  if (!isDir(root)) return null;
  const walk = (dir: string, rest: string): string | null => {
    if (!rest) return dir;
    for (const entry of listDir(dir)) {
      const es = entry.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!es) continue;
      if (rest === es || rest.startsWith(`${es}-`)) {
        const full = path.join(dir, entry);
        if (!isDir(full)) continue;
        const found = walk(full, rest === es ? "" : rest.slice(es.length + 1));
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, m[2]);
}

export function fileUriToPath(uri: string): string | null {
  const m = /^file:\/\/\/?(.*)$/.exec(uri);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    return /^[a-zA-Z]:/.test(decoded) ? decoded.replace(/\//g, "\\") : `/${decoded}`;
  } catch {
    return null;
  }
}

export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
}

function pathDirs(): string[] {
  return (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
}

/** Finds an executable: explicit absolute path, then PATH, then extra directories. */
export function findExecutable(names: string[], extraDirs: string[], explicit?: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  if (explicit && (path.isAbsolute(explicit) || /[\\/]/.test(explicit))) {
    const found = firstExisting(explicit, exts, true);
    if (found) return found;
  }
  const wanted = explicit && !/[\\/]/.test(explicit) ? [explicit, ...names] : names;
  for (const dir of [...pathDirs(), ...extraDirs]) {
    for (const name of wanted) {
      const found = firstExisting(path.join(dir, name), exts, false);
      if (found) return found;
    }
  }
  return null;
}

function firstExisting(base: string, exts: string[], allowBare: boolean): string | null {
  for (const ext of exts) {
    const full = base.toLowerCase().endsWith(ext) && ext ? base : base + ext;
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      /* next */
    }
  }
  return allowBare ? null : null;
}

/** Directories matching `prefix*` under `parent`, newest name first (used for versioned extension folders). */
export function globDirs(parent: string, prefix: string): string[] {
  return listDir(parent).filter((n) => n.startsWith(prefix)).sort().reverse().map((n) => path.join(parent, n));
}

function cmdEscape(arg: string, double: boolean): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  out = out.replace(/[()%!^"<>&|;, ]/g, "^$&");
  if (double) out = out.replace(/[()%!^"<>&|;, ]/g, "^$&");
  return out;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

/** spawn() that also works for .cmd/.bat shims on Windows (arguments are escaped for cmd.exe). */
export function spawnCli(cmd: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
  let child: ChildProcess;
  if (needsShell) {
    const line = [cmd, ...args].map((a, i) => (i === 0 ? cmdEscape(a, false) : cmdEscape(a.replace(/\r?\n/g, " "), true))).join(" ");
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd: options.cwd, env: options.env, windowsHide: true, windowsVerbatimArguments: true });
  } else {
    child = spawn(cmd, args, { cwd: options.cwd, env: options.env, windowsHide: true });
  }
  if (options.stdin !== undefined) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin);
  } else {
    child.stdin?.end();
  }
  return child;
}

export async function runCapture(cmd: string, args: string[], options: SpawnOptions & { timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    try {
      child = spawnCli(cmd, args, options);
    } catch (error) {
      resolve({ code: null, stdout, stderr, error: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 8000);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export type RunItem = { kind: "json"; value: Record<string, unknown> } | { kind: "text"; text: string } | { kind: "exit"; code: number | null; stderr: string };

/** Runs a CLI and yields its stdout as parsed JSON lines (or raw text when `json` is false), ending with an exit record. */
export async function* runStream(cmd: string, args: string[], options: SpawnOptions & { json: boolean; signal: AbortSignal; timeoutMs?: number }): AsyncGenerator<RunItem> {
  const child = spawnCli(cmd, args, options);
  const queue: RunItem[] = [];
  let stderr = "";
  let ended = false;
  let wake: (() => void) | null = null;
  const push = (item: RunItem) => { queue.push(item); wake?.(); wake = null; };
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (!options.json) { push({ kind: "text", text: chunk }); return; }
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const value = tryJson(line);
      push(value ? { kind: "json", value } : { kind: "text", text: line + "\n" });
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.on("error", (error) => { stderr += error.message; push({ kind: "exit", code: null, stderr }); ended = true; });
  child.on("close", (code) => {
    if (options.json && buffer.trim()) {
      const value = tryJson(buffer.trim());
      push(value ? { kind: "json", value } : { kind: "text", text: buffer });
    }
    if (!ended) push({ kind: "exit", code, stderr });
    ended = true;
  });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30 * 60_000);
  const onAbort = () => child.kill();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; });
      const item = queue.shift();
      if (!item) continue;
      yield item;
      if (item.kind === "exit") return;
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill();
  }
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** CLIs often report errors as a JSON blob; show only the human message. */
export function prettyError(raw: string): string {
  const text = raw.trim();
  if (text.startsWith("{")) {
    const j = tryJson(text);
    const e = j?.error as { message?: string } | string | undefined;
    const m = typeof e === "string" ? e : e?.message ?? (typeof j?.message === "string" ? j.message : "");
    if (m) return m;
  }
  return text;
}
