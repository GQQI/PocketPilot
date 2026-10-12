import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import type {
  Bootstrap,
  ChatMessage,
  FileContent,
  FileEntry,
  FsListing,
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
} from "@mobileagent/protocol";
import { listDemoDirectory, listHostDirectory } from "./browse";
import { loadTraeSessions, presentHistory } from "./history";
import { CATALOG, type CatalogEntry } from "./catalog";
import { DemoEngine } from "./demo-engine";
import { HubError } from "./errors";
import { LiveEngine, type LiveSnapshot } from "./live-engine";
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

interface HostSecrets {
  code: string;
  token: string;
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

  constructor(options: HubOptions = {}) {
    this.dataDir = options.dataDir ?? process.env.MOBILEAGENT_HOME ?? path.join(homedir(), ".mobileagent");
    this.fast = options.fast ?? false;
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
    const own = this.settings.demoMode ? this.demo.sessions() : this.live.sessions();
    const external = this.settings.demoMode ? [] : loadTraeSessions();
    const sessions = presentHistory([...own, ...external, ...extras.flatMap((adapter) => adapter.listSessions())]);
    const queue = this.settings.demoMode ? this.demo.queue() : this.live.queue();
    return {
      settings: this.settings,
      providers: this.providerViews(),
      projects: [...projects, ...extras.flatMap((adapter) => adapter.listProjects())],
      sessions,
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

  pair(code: string): string {
    const given = code.trim().toUpperCase().replace(/\s+/g, "");
    if (!safeEqual(given, this.hostSecrets.code)) throw new HubError("pairing code rejected", 401, "pair");
    return this.hostSecrets.token;
  }

  tokenMatches(header: string | undefined): boolean {
    if (!header) return false;
    const value = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
    if (!value) return false;
    return safeEqual(value, this.hostSecrets.token);
  }

  hostInfo(input: HostInfoInput): HostView {
    const paired = input.loopback || input.authorized;
    return {
      name: hostname(),
      platform: process.platform,
      port: input.port,
      urls: input.urls,
      workspacePath: this.settings.workspacePath,
      demoMode: this.settings.demoMode,
      paired,
      loopback: input.loopback,
      ...(input.loopback ? { pairingCode: this.hostSecrets.code } : {}),
    };
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
    return [...CATALOG, ...extras.map((adapter) => adapter.meta)];
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
    if (meta.envKeys.some((key) => Boolean(process.env[key]))) return "env";
    if (this.secrets[meta.id]) return "file";
    return "none";
  }

  private liveContext(providerId: string) {
    const meta = this.requireMeta(providerId);
    const config = this.settings.providers[providerId] ?? defaultConfig(meta);
    const env: NodeJS.ProcessEnv = { ...process.env };
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
    const saved = readJson<Partial<HostSecrets>>(path.join(this.dataDir, "host.json"), {});
    if (saved.code && saved.token && /^[A-Z2-9]{6}$/.test(saved.code)) {
      return { code: saved.code, token: saved.token };
    }
    const created = { code: makePairingCode(), token: randomBytes(24).toString("hex") };
    const file = path.join(this.dataDir, "host.json");
    writeJson(file, created);
    chmodSync(file, 0o600);
    return created;
  }

  private persistSettings(): void {
    writeJson(path.join(this.dataDir, "settings.json"), this.settings);
  }

  private persistSecrets(): void {
    const file = path.join(this.dataDir, "secrets.json");
    writeJson(file, this.secrets);
    chmodSync(file, 0o600);
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
