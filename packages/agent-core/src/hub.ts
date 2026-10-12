import { spawnSync as __spawnSync } from "node:child_process";
import { mergeUserEnv } from "./local/util";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type {
  Bootstrap,
  ChatMessage,
  FileContent,
  FileEntry,
  FsListing,
  DeviceView,
  HealthReport,
  HostView,
  KeySource,
  McpServer,
  Project,
  ProviderConfig,
  ProviderMeta,
  ProviderView,
  Session,
  Settings,
  StreamEvent,
  TerminalEvent,
} from "@pocketpilot/protocol";
import { listDemoDirectory, listHostDirectory } from "./browse";
import { CATALOG, LOCAL_ONLY, type CatalogEntry } from "./catalog";
import { DemoEngine } from "./demo-engine";
import { HubError } from "./errors";
import { applyLegacyEnv, resolveDefaultDataDir } from "./compat";
import { LiveEngine, type LiveSnapshot } from "./live-engine";
import { LocalAgents, type AgentCtx } from "./local";
import type { DemoSnapshot } from "./seed";

export interface AgentAdapter {
  meta: ProviderMeta;
  probe(): Promise<HealthReport>;
  listProjects(): Project[];
  listSessions(): Session[];
  getMessages(sessionId: string): ChatMessage[];
  createSession(projectId: string, title?: string): Session;
  streamPrompt(sessionId: string, prompt: string, signal: AbortSignal): AsyncIterable<StreamEvent>;
  listFiles(projectId: string, dir: string): FileEntry[];
  readFile(projectId: string, filePath: string): FileContent;
  commit(projectId: string, message: string): Project;
  runTerminal(sessionId: string, command: string, signal: AbortSignal): AsyncIterable<TerminalEvent>;
  listMcp(): McpServer[];
  setMcp(mcpId: string, enabled: boolean): McpServer[];
}

export interface HubOptions {
  dataDir?: string;
  fast?: boolean;
  /** Remote mode: no loopback trust, pairing code never exposed over HTTP, code rotates after each pairing. Defaults to POCKETPILOT_REMOTE=1. */
  remote?: boolean;
  /** Device token lifetime in days. Defaults to POCKETPILOT_TOKEN_TTL_DAYS or 90. */
  tokenTtlDays?: number;
  onPairingCodeChange?: (code: string) => void;
  /** Called after devices are added or revoked (remote transport re-subscribes / drops connections). */
  onDevicesChange?: () => void;
}

const extras: AgentAdapter[] = [];

export function registerAdapter(adapter: AgentAdapter): void {
  extras.push(adapter);
}

export function clearRegisteredAdapters(): void {
  extras.length = 0;
}

export function registeredAdapters(): readonly AgentAdapter[] {
  return extras;
}

interface SavedSettings extends Partial<Omit<Settings, "providers">> {
  providers?: Record<string, Partial<ProviderConfig>>;
}

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  /** Secret for the persisted WebRTC link of this device (remote pairing). Never leaves host.json / the paired phone. */
  linkSecret?: string;
}

interface HostSecrets {
  code: string;
  devices: DeviceRecord[];
}

export interface PairContext {
  /** Client key for rate limiting (usually the remote IP). */
  ip?: string;
  /** Human readable device name supplied by the phone. */
  name?: string;
}

const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 20;
const LOCK_MS = 15 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_TOKEN_TTL_DAYS = 90;

interface FailState {
  count: number;
  first: number;
  lockedUntil: number;
}

export interface HostInfoInput {
  loopback: boolean;
  authorized: boolean;
  port: number;
  urls: string[];
}

export class Hub {
  readonly dataDir: string;
  private settings: Settings;
  private secrets: Record<string, string>;
  private hostSecrets: HostSecrets;
  private healthCache = new Map<string, HealthReport>();
  private readonly demo: DemoEngine;
  private readonly live: LiveEngine;
  private readonly fast: boolean;
  readonly remote: boolean;
  private readonly tokenTtlMs: number;
  private readonly onCode?: (code: string) => void;
  private onDevices?: () => void;
  private fails = new Map<string, FailState>();
  private lastSeenSaved = 0;
  /** Real platform detection / history / chat / usage on this PC (no demo data). */
  readonly agents = new LocalAgents((id) => this.agentCtx(id));

  constructor(options: HubOptions = {}) {
    applyLegacyEnv();
    this.dataDir = options.dataDir ?? process.env.POCKETPILOT_HOME ?? resolveDefaultDataDir();
    this.fast = options.fast ?? false;
    this.remote = options.remote ?? process.env.POCKETPILOT_REMOTE === "1";
    const ttlDays = options.tokenTtlDays ?? Number(process.env.POCKETPILOT_TOKEN_TTL_DAYS ?? DEFAULT_TOKEN_TTL_DAYS);
    this.tokenTtlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TOKEN_TTL_DAYS) * 86_400_000;
    this.onCode = options.onPairingCodeChange;
    this.onDevices = options.onDevicesChange;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.settings = this.loadSettings();
    this.secrets = this.loadSecrets();
    this.hostSecrets = this.loadHostSecrets();
    this.demo = new DemoEngine({
      fast: this.fast,
      onChange: () => this.persistDemo(),
      initial: readJson<DemoSnapshot | null>(path.join(this.dataDir, "demo-state.json"), null),
    });
    this.live = new LiveEngine(CATALOG, {
      fast: this.fast,
      onChange: () => this.persistLive(),
      initial: readJson<LiveSnapshot | null>(path.join(this.dataDir, "live-state.json"), null),
      context: (providerId) => this.liveContext(providerId),
    });
    for (const meta of this.metas()) {
      if (this.settings.demoMode && this.isBuiltin(meta.id)) this.healthCache.set(meta.id, this.demo.health(meta as CatalogEntry));
    }
  }

  bootstrap(): Bootstrap {
    const projects = this.settings.demoMode ? this.demo.projects() : this.live.projects();
    const sessions = this.settings.demoMode ? this.demo.sessions() : this.live.sessions();
    const queue = this.settings.demoMode ? this.demo.queue() : this.live.queue();
    return {
      settings: this.settings,
      providers: this.providerViews(),
      projects: [...projects, ...extras.flatMap((adapter) => adapter.listProjects())],
      sessions: [...sessions, ...extras.flatMap((adapter) => adapter.listSessions())],
      queue,
    };
  }

  updateSettings(patch: Partial<Settings> & { providers?: Record<string, Partial<ProviderConfig>> }): Bootstrap {
    if (patch.locale === "en" || patch.locale === "zh") this.settings.locale = patch.locale;
    if (patch.theme === "light" || patch.theme === "dark") this.settings.theme = patch.theme;
    if (typeof patch.demoMode === "boolean" && patch.demoMode !== this.settings.demoMode) {
      this.settings.demoMode = patch.demoMode;
      this.healthCache.clear();
      if (patch.demoMode) {
        for (const meta of CATALOG) this.healthCache.set(meta.id, this.demo.health(meta));
      }
    }
    if (typeof patch.workspacePath === "string") this.settings.workspacePath = patch.workspacePath.trim();
    if (typeof patch.activeProviderId === "string" && this.metas().some((meta) => meta.id === patch.activeProviderId)) {
      this.settings.activeProviderId = patch.activeProviderId;
    }
    if (patch.providers) {
      for (const [id, config] of Object.entries(patch.providers)) {
        const current = this.settings.providers[id];
        if (!current || !config) continue;
        if (typeof config.enabled === "boolean") current.enabled = config.enabled;
        if (typeof config.model === "string") current.model = config.model;
        if (typeof config.cliPath === "string" && !config.cliPath.includes("\0")) current.cliPath = config.cliPath.trim();
        if (typeof config.endpoint === "string") current.endpoint = config.endpoint.trim();
      }
    }
    this.persistSettings();
    return this.bootstrap();
  }

  setSecret(id: string, apiKey: string): Bootstrap {
    this.requireMeta(id);
    const value = apiKey.trim();
    if (!value) delete this.secrets[id];
    else this.secrets[id] = value;
    this.persistSecrets();
    return this.bootstrap();
  }

  clearSecret(id: string): Bootstrap {
    this.requireMeta(id);
    delete this.secrets[id];
    this.persistSecrets();
    return this.bootstrap();
  }

  async probe(id: string): Promise<HealthReport> {
    const meta = this.requireMeta(id);
    const report = this.settings.demoMode && this.isBuiltin(meta.id)
      ? this.demo.health(meta as CatalogEntry)
      : await this.live.health(meta as CatalogEntry, this.liveContext(meta.id));
    this.healthCache.set(id, report);
    return report;
  }

  async probeAll(): Promise<Bootstrap> {
    await Promise.all(this.metas().map(async (meta) => this.healthCache.set(meta.id, await this.probe(meta.id))));
    return this.bootstrap();
  }

  createSession(providerId: string, projectId: string, title?: string): { session: Session; bootstrap: Bootstrap } {
    this.assertEnabled(providerId);
    const extra = this.extra(providerId);
    const session = extra
      ? extra.createSession(projectId, title)
      : this.settings.demoMode
        ? this.demo.createSession(providerId, projectId, title)
        : this.live.createSession(providerId, projectId, title);
    return { session, bootstrap: this.bootstrap() };
  }

  messages(sessionId: string): ChatMessage[] {
    const session = this.requireSession(sessionId);
    const extra = this.extra(session.providerId);
    if (extra) return extra.getMessages(sessionId);
    return this.settings.demoMode ? this.demo.messages(sessionId) : this.live.messages(sessionId);
  }

  prompt(sessionId: string, text: string, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const session = this.requireSession(sessionId);
    this.assertEnabled(session.providerId);
    const extra = this.extra(session.providerId);
    if (extra) return extra.streamPrompt(sessionId, text, signal);
    return this.settings.demoMode ? this.demo.prompt(sessionId, text, signal) : this.live.prompt(sessionId, text, signal);
  }

  enqueue(sessionId: string, text: string): Bootstrap {
    this.requireSession(sessionId);
    if (this.settings.demoMode) this.demo.enqueue(sessionId, text);
    else this.live.enqueue(sessionId, text);
    return this.bootstrap();
  }

  removeQueue(id: string): Bootstrap {
    if (this.settings.demoMode) this.demo.removeQueue(id);
    else this.live.removeQueue(id);
    return this.bootstrap();
  }

  reorderQueue(ids: string[]): Bootstrap {
    if (this.settings.demoMode) this.demo.reorderQueue(ids);
    else this.live.reorderQueue(ids);
    return this.bootstrap();
  }

  async *runQueue(id: string, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const queue = this.settings.demoMode ? this.demo.queue() : this.live.queue();
    const item = queue.find((entry) => entry.id === id);
    if (!item || item.status !== "waiting") throw new HubError("queue item is not waiting", 400, "queue");
    this.assertEnabled(item.providerId);
    const engine = this.settings.demoMode ? this.demo : this.live;
    engine.setQueueStatus(id, "running");
    let failed = false;
    try {
      for await (const event of this.prompt(item.sessionId, item.prompt, signal)) {
        if (event.type === "error") failed = true;
        yield event;
      }
      engine.setQueueStatus(id, failed ? "failed" : "done");
    } catch (error) {
      const busy = error instanceof HubError && error.code === "busy";
      engine.setQueueStatus(id, busy ? "waiting" : "failed");
      throw error;
    }
  }

  files(projectId: string, dir: string): FileEntry[] {
    if (this.settings.demoMode) return this.demo.files(projectId, dir);
    const project = this.live.projects().find((item) => item.id === projectId);
    if (!project) throw new HubError("unknown project", 404, "project");
    return this.live.files(project.providerId, dir);
  }

  file(projectId: string, filePath: string): FileContent {
    if (this.settings.demoMode) return this.demo.file(projectId, filePath);
    const project = this.live.projects().find((item) => item.id === projectId);
    if (!project) throw new HubError("unknown project", 404, "project");
    return this.live.file(project.providerId, filePath);
  }

  commit(projectId: string, message: string): Bootstrap {
    if (this.settings.demoMode) this.demo.commit(projectId, message);
    else this.live.commit();
    return this.bootstrap();
  }

  terminal(sessionId: string, command: string, signal: AbortSignal): AsyncIterable<TerminalEvent> {
    if (this.settings.demoMode) return this.demo.terminal(sessionId, command, signal);
    return this.live.terminal(sessionId, command, signal);
  }

  toggleMcp(providerId: string, mcpId: string, enabled: boolean): Bootstrap {
    if (!this.settings.demoMode) throw new HubError("mcp edits in live mode stay in each CLI config", 400, "live");
    this.demo.toggleMcp(providerId, mcpId, enabled);
    return this.bootstrap();
  }

  resetDemo(): Bootstrap {
    this.demo.reset();
    return this.bootstrap();
  }

  listDirs(dir: string): FsListing {
    return this.settings.demoMode ? listDemoDirectory(dir) : listHostDirectory(dir);
  }

  pairingCode(): string {
    return this.hostSecrets.code;
  }

  /** Exchange the pairing code for a per-device token. Rate limited and lockable. */
  pair(code: string, context: PairContext = {}): { token: string; device: DeviceView } {
    const now = Date.now();
    const key = context.ip || "local";
    this.assertNotLocked(key, now);
    this.assertNotLocked("*", now);
    const given = code.trim().toUpperCase().replace(/\s+/g, "");
    if (!safeEqual(given, this.hostSecrets.code)) {
      this.recordFail(key, MAX_FAILS_PER_IP, now);
      this.recordFail("*", MAX_FAILS_GLOBAL, now);
      throw new HubError("pairing code rejected", 401, "pair");
    }
    this.fails.delete(key);
    const token = "mat_" + randomBytes(32).toString("hex");
    const device: DeviceRecord = {
      id: "dev_" + randomBytes(6).toString("hex"),
      name: (context.name ?? "").toString().trim().slice(0, 60) || "Phone",
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.tokenTtlMs,
    };
    this.hostSecrets.devices.push(device);
    if (this.remote) this.rotatePairingCode();
    this.saveHostSecrets();
    return { token, device: this.deviceView(device, device.id) };
  }

  /** Issue a device token without a pairing code: only for the QR/WebRTC flow that has already proven possession of a one-time secret. */
  grantDevice(name: string, linkSecret: string): { token: string; device: DeviceRecord } {
    const now = Date.now();
    const token = "mat_" + randomBytes(32).toString("hex");
    const device: DeviceRecord = {
      id: "dev_" + randomBytes(6).toString("hex"),
      name: name.trim().slice(0, 60) || "Phone",
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.tokenTtlMs,
      linkSecret,
    };
    this.hostSecrets.devices.push(device);
    this.saveHostSecrets();
    this.onDevices?.();
    return { token, device };
  }

  /** Live (unexpired) devices that have a WebRTC link. */
  deviceLinks(): Array<{ id: string; linkSecret: string }> {
    const now = Date.now();
    return this.hostSecrets.devices.filter((d) => d.linkSecret && d.expiresAt > now).map((d) => ({ id: d.id, linkSecret: d.linkSecret as string }));
  }

  setDevicesListener(listener: () => void): void {
    this.onDevices = listener;
  }

  /** Regenerate the pairing code (remote mode does this after every pairing and every lockout). */
  rotatePairingCode(): string {
    this.hostSecrets.code = makePairingCode();
    this.saveHostSecrets();
    this.onCode?.(this.hostSecrets.code);
    return this.hostSecrets.code;
  }

  authenticate(header: string | undefined): DeviceRecord | null {
    if (!header) return null;
    const value = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
    if (!value) return null;
    const hash = hashToken(value);
    const now = Date.now();
    let found: DeviceRecord | null = null;
    for (const device of this.hostSecrets.devices) {
      if (safeEqual(hash, device.tokenHash)) found = device;
    }
    if (!found || found.expiresAt <= now) return null;
    found.lastSeen = now;
    if (now - this.lastSeenSaved > 60_000) {
      this.lastSeenSaved = now;
      this.saveHostSecrets();
    }
    return found;
  }

  tokenMatches(header: string | undefined): boolean {
    return this.authenticate(header) !== null;
  }

  listDevices(currentId?: string): DeviceView[] {
    const now = Date.now();
    return this.hostSecrets.devices.filter((device) => device.expiresAt > now).map((device) => this.deviceView(device, currentId));
  }

  revokeDevice(id: string): DeviceView[] {
    const before = this.hostSecrets.devices.length;
    this.hostSecrets.devices = this.hostSecrets.devices.filter((device) => device.id !== id);
    if (this.hostSecrets.devices.length === before) throw new HubError("unknown device", 404, "device");
    this.saveHostSecrets();
    this.onDevices?.();
    return this.listDevices();
  }

  hostInfo(input: HostInfoInput): HostView {
    const loopback = input.loopback && !this.remote;
    const paired = loopback || input.authorized;
    return {
      name: hostname(),
      platform: process.platform,
      port: input.port,
      urls: input.urls,
      workspacePath: this.settings.workspacePath,
      demoMode: this.settings.demoMode,
      paired,
      loopback,
      remote: this.remote,
      ...(loopback ? { pairingCode: this.hostSecrets.code } : {}),
    };
  }

  private deviceView(device: DeviceRecord, currentId?: string): DeviceView {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeen: device.lastSeen,
      expiresAt: device.expiresAt,
      current: device.id === currentId,
    };
  }

  private assertNotLocked(key: string, now: number): void {
    const state = this.fails.get(key);
    if (state && state.lockedUntil > now) {
      const seconds = Math.ceil((state.lockedUntil - now) / 1000);
      throw new HubError(`too many attempts, retry in ${seconds}s`, 429, "locked");
    }
  }

  private recordFail(key: string, limit: number, now: number): void {
    let state = this.fails.get(key);
    if (!state || now - state.first > FAIL_WINDOW_MS) state = { count: 0, first: now, lockedUntil: 0 };
    state.count += 1;
    if (state.count >= limit) {
      state.lockedUntil = now + LOCK_MS;
      state.count = 0;
      state.first = now;
      if (this.remote) this.rotatePairingCode();
    }
    this.fails.set(key, state);
  }

  private saveHostSecrets(): void {
    const file = path.join(this.dataDir, "host.json");
    writeJson(file, this.hostSecrets);
    try { chmodSync(file, 0o600); } catch { /* windows */ }
  }

  private extra(providerId: string): AgentAdapter | undefined {
    return extras.find((adapter) => adapter.meta.id === providerId);
  }

  private requireSession(sessionId: string): Session {
    const session = this.bootstrap().sessions.find((item) => item.id === sessionId);
    if (!session) throw new HubError("unknown session", 404, "session");
    return session;
  }

  private assertEnabled(providerId: string): void {
    const config = this.settings.providers[providerId];
    if (config && !config.enabled) throw new HubError("provider disabled", 409, "disabled");
  }

  private providerViews(): ProviderView[] {
    return this.metas().map((meta) => ({
      meta: publicMeta(meta),
      config: this.settings.providers[meta.id] ?? defaultConfig(meta),
      health: this.healthCache.get(meta.id) ?? standby(meta.id),
      keySource: this.keySource(meta),
      mcp: this.settings.demoMode && this.isBuiltin(meta.id) ? this.demo.mcp(meta.id) : [],
    }));
  }

  private metas(): ProviderMeta[] {
    return [...CATALOG, ...LOCAL_ONLY, ...extras.map((adapter) => adapter.meta)];
  }

  private requireMeta(id: string): ProviderMeta {
    const meta = this.metas().find((item) => item.id === id);
    if (!meta) throw new HubError("unknown provider", 404, "provider");
    return meta;
  }

  private isBuiltin(id: string): boolean {
    return CATALOG.some((entry) => entry.id === id);
  }

  private keySource(meta: ProviderMeta): KeySource {
    if (meta.envKeys.some((key) => Boolean(mergeUserEnv(process.env)[key]))) return "env";
    if (this.secrets[meta.id]) return "file";
    return "none";
  }

  /** Last 4 characters of the key in use for a provider ("" = none). The key itself is never returned. */
  keyHint(id: string): string {
    const meta = this.requireMeta(id);
    const env = mergeUserEnv(process.env);
    const key = meta.envKeys.map((name) => env[name]).find(Boolean) ?? this.secrets[id] ?? "";
    return key ? key.slice(-4) : "";
  }

  agentCtx(providerId: string): AgentCtx {
    const meta = this.requireMeta(providerId);
    const base = this.liveContext(providerId);
    const config = this.settings.providers[providerId];
    return {
      cliPath: base.cliPath,
      model: config && config.model !== meta.defaultModel ? config.model : "",
      env: base.env,
      keySource: this.keySource(meta),
      dataDir: this.dataDir,
      locale: this.settings.locale,
    };
  }

  private liveContext(providerId: string) {
    const meta = this.requireMeta(providerId);
    const config = this.settings.providers[providerId] ?? defaultConfig(meta);
    const env: NodeJS.ProcessEnv = mergeUserEnv(process.env);
    const primary = meta.envKeys[0];
    if (primary && this.secrets[providerId] && !env[primary]) env[primary] = this.secrets[providerId];
    if (providerId === "deepseek-harness" && config.endpoint) env.DEEPSEEK_BASE_URL = config.endpoint;
    return {
      workspacePath: this.settings.workspacePath,
      cliPath: config.cliPath || meta.cli,
      model: config.model,
      endpoint: config.endpoint,
      env,
      locale: this.settings.locale,
    };
  }

  private loadSettings(): Settings {
    const saved = readJson<SavedSettings>(path.join(this.dataDir, "settings.json"), {});
    const providers: Record<string, ProviderConfig> = {};
    for (const meta of this.metas()) {
      const override = saved.providers?.[meta.id] ?? {};
      providers[meta.id] = {
        ...defaultConfig(meta),
        ...cleanConfig(override),
      };
    }
    const active = saved.activeProviderId;
    return {
      locale: saved.locale === "en" ? "en" : "zh",
      theme: saved.theme === "dark" ? "dark" : "light",
      demoMode: saved.demoMode !== false,
      activeProviderId: active && providers[active] ? active : "cursor",
      workspacePath: typeof saved.workspacePath === "string" ? saved.workspacePath : "",
      providers,
    };
  }

  private loadSecrets(): Record<string, string> {
    const raw = readJson<Record<string, unknown>>(path.join(this.dataDir, "secrets.json"), {});
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value) secrets[key] = value;
    }
    return secrets;
  }

  private loadHostSecrets(): HostSecrets {
    const file = path.join(this.dataDir, "host.json");
    const saved = readJson<Partial<HostSecrets> & { token?: string }>(file, {});
    if (saved.code && /^[A-Z2-9]{6}$/.test(saved.code)) {
      // A legacy single shared "token" is intentionally dropped; phones must pair again to get a per-device token.
      const devices = Array.isArray(saved.devices) ? saved.devices.filter((d) => d && typeof d.tokenHash === "string") : [];
      const secrets = { code: saved.code, devices };
      if (saved.token !== undefined) {
        writeJson(file, secrets);
      }
      return secrets;
    }
    const created: HostSecrets = { code: makePairingCode(), devices: [] };
    writeJson(file, created);
    try { chmodSync(file, 0o600); } catch { /* windows */ }
    return created;
  }

  private persistSettings(): void {
    writeJson(path.join(this.dataDir, "settings.json"), this.settings);
  }

  private persistSecrets(): void {
    const file = path.join(this.dataDir, "secrets.json");
    writeJson(file, this.secrets);
    chmodSync(file, 0o600);
    if (process.platform === "win32") {
      // chmod is a no-op on Windows: strip inherited ACLs so only the current user can read the file
      try { __spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME ?? ""}:(F)`], { windowsHide: true, timeout: 5000 }); } catch { /* best effort */ }
    }
  }

  private persistDemo(): void {
    writeJson(path.join(this.dataDir, "demo-state.json"), this.demo.snapshot());
  }

  private persistLive(): void {
    writeJson(path.join(this.dataDir, "live-state.json"), this.live.snapshot());
  }
}

function defaultConfig(meta: ProviderMeta): ProviderConfig {
  return { enabled: true, model: meta.defaultModel, cliPath: meta.cli, endpoint: meta.endpoint };
}

function cleanConfig(override: Partial<ProviderConfig>): Partial<ProviderConfig> {
  const next: Partial<ProviderConfig> = {};
  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if (typeof override.model === "string") next.model = override.model;
  if (typeof override.cliPath === "string") next.cliPath = override.cliPath;
  if (typeof override.endpoint === "string") next.endpoint = override.endpoint;
  return next;
}

function publicMeta(meta: ProviderMeta): ProviderMeta {
  return {
    id: meta.id,
    name: meta.name,
    vendor: meta.vendor,
    cli: meta.cli,
    defaultModel: meta.defaultModel,
    models: [...meta.models],
    endpoint: meta.endpoint,
    envKeys: [...meta.envKeys],
    docsUrl: meta.docsUrl,
    accent: meta.accent,
    monogram: meta.monogram,
  };
}

function standby(id: string): HealthReport {
  return {
    id,
    state: "standby",
    latencyMs: null,
    version: null,
    messageKey: "health.unchecked",
    detail: "",
    checkedAt: new Date().toISOString(),
  };
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makePairingCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let index = 0; index < 6; index += 1) code += PAIRING_ALPHABET[bytes[index] % PAIRING_ALPHABET.length];
  return code;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function createHub(options?: HubOptions): Hub {
  return new Hub(options);
}
