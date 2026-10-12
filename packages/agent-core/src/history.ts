import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Session, SessionStatus } from "@mobileagent/protocol";

const MAX_FILES = 80;
const MAX_BYTES = 1_000_000;
const NAME_HINT = /session|chat|history|conversation|message/i;

export interface HistorySession extends Session {
  providerId: string;
}

/** Codex writes an internal cwd probe named chatcwd. It is not a user conversation. */
export function isInternalCodexSession(session: { providerId: string; id: string; title: string; preview?: string }): boolean {
  if (session.providerId !== "codex") return false;
  return [session.id, session.title, session.preview ?? ""].some((field) => isChatCwdName(field));
}

function isChatCwdName(field: string): boolean {
  const value = field.trim();
  if (!value) return false;
  if (/^chatcwd$/i.test(value)) return true;
  return /(?:^|[\\/])chatcwd$/i.test(value.replace(/\\/g, "/"));
}

export function presentHistory<T extends HistorySession>(sessions: T[]): T[] {
  const visible = sessions.filter((session) => !isInternalCodexSession(session));
  const byId = new Map<string, T>();
  for (const session of visible) {
    const previous = byId.get(session.id);
    if (!previous || session.updatedAt >= previous.updatedAt) byId.set(session.id, session);
  }
  const unique = [...byId.values()];
  const seen = new Map<string, T>();
  const drafts: T[] = [];
  for (const session of unique) {
    const preview = session.preview.trim();
    if (!preview) {
      drafts.push(session);
      continue;
    }
    const key = `${session.providerId}\0${session.title.trim()}\0${preview}`;
    const previous = seen.get(key);
    if (!previous || session.updatedAt >= previous.updatedAt) seen.set(key, session);
  }
  return [...seen.values(), ...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface TraeRecord {
  id?: string;
  conversationId?: string;
  sessionId?: string;
  chatId?: string;
  threadId?: string;
  parentId?: string;
  role?: string;
  title?: string;
  text?: string;
  content?: string;
  updatedAt?: string;
  createdAt?: string;
  file?: string;
}

export function groupTraeRecords(records: TraeRecord[], now = new Date().toISOString()): Session[] {
  const groups = new Map<string, TraeRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  const sessions: Session[] = [];
  for (const [key, list] of groups) {
    const texts = list.map(recordText).filter(Boolean);
    const title = firstUserText(list) || list.find((record) => record.title?.trim())?.title?.trim() || texts[0] || "Trae CN";
    const preview = texts.at(-1) || title;
    const updatedAt = list.map(recordTime).filter(Boolean).sort().at(-1) || now;
    sessions.push({
      id: `trae_${safeId(key)}`,
      providerId: "trae-cn",
      projectId: "live__trae-cn",
      title: clip(title, 80),
      status: "idle" satisfies SessionStatus,
      updatedAt,
      preview: clip(preview, 80),
      messageCount: list.length,
    });
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function groupKey(record: TraeRecord): string {
  const explicit = record.conversationId || record.sessionId || record.chatId || record.threadId || record.parentId;
  if (explicit) return String(explicit);
  const file = record.file ?? "";
  const base = file ? path.basename(file) : "";
  if (file && /^(msg|message|part)[-_]/i.test(base)) return path.dirname(file);
  if (file) return file;
  return record.id || record.title || "trae";
}

function recordText(record: TraeRecord): string {
  return (record.text || record.content || record.title || "").trim();
}

function firstUserText(records: TraeRecord[]): string {
  const user = records.find((record) => (record.role ?? "").toLowerCase() === "user" && recordText(record));
  return user ? recordText(user) : "";
}

function recordTime(record: TraeRecord): string {
  return record.updatedAt || record.createdAt || "";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "session").slice(0, 120);
}

export function discoverTraeDirs(): string[] {
  if (process.env.MOBILEAGENT_SKIP_EXTERNAL_HISTORY === "1") return [];
  const home = homedir();
  const candidates = [
    process.env.TRAE_CN_HOME ?? "",
    path.join(home, ".trae-cn"),
    path.join(home, ".trae"),
    path.join(home, "AppData", "Roaming", "Trae CN"),
    path.join(home, "AppData", "Roaming", "Trae"),
  ];
  return candidates.filter((dir) => dir && existsSync(dir));
}

export function loadTraeSessions(roots = discoverTraeDirs()): Session[] {
  const records: TraeRecord[] = [];
  for (const root of roots) records.push(...readTraeTree(root));
  if (!records.length) return [];
  return groupTraeRecords(records);
}

function readTraeTree(root: string): TraeRecord[] {
  const files: string[] = [];
  walk(root, files, 0);
  const records: TraeRecord[] = [];
  for (const file of files) {
    let raw = "";
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    records.push(...recordsFromFile(raw, file));
  }
  return records;
}

function walk(dir: string, files: string[], depth: number): void {
  if (files.length >= MAX_FILES || depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(json|jsonl)$/i.test(entry.name)) continue;
    if (depth > 0 && !NAME_HINT.test(entry.name) && !NAME_HINT.test(path.basename(dir))) continue;
    files.push(full);
  }
}

function recordsFromFile(raw: string, file: string): TraeRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (file.endsWith(".jsonl") || trimmed.includes("\n{")) {
    const records: TraeRecord[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const parsed = parseJson(line);
      if (parsed) records.push(...flattenRecord(parsed, file));
    }
    if (records.length) return records;
  }
  const parsed = parseJson(trimmed);
  return parsed ? flattenRecord(parsed, file) : [];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flattenRecord(value: unknown, file: string): TraeRecord[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenRecord(item, file));
  const record = value as Record<string, unknown>;
  const messages = record.messages ?? record.items;
  if (Array.isArray(messages)) {
    const conversationId = stringField(record, ["conversationId", "sessionId", "chatId", "threadId", "id"]) || file;
    return messages.flatMap((item) => flattenRecord(item, file).map((row) => ({ ...row, conversationId: row.conversationId || conversationId, file })));
  }
  const text = stringField(record, ["text", "content", "message", "title"]);
  if (!text && !stringField(record, ["title"])) return [];
  return [{
    id: stringField(record, ["id", "messageId"]),
    conversationId: stringField(record, ["conversationId", "conversation_id"]),
    sessionId: stringField(record, ["sessionId", "session_id"]),
    chatId: stringField(record, ["chatId", "chat_id"]),
    threadId: stringField(record, ["threadId", "thread_id"]),
    parentId: stringField(record, ["parentId", "parent_id"]),
    role: stringField(record, ["role", "type"]),
    title: stringField(record, ["title", "name"]),
    text: stringField(record, ["text", "content", "message"]),
    updatedAt: stringField(record, ["updatedAt", "updated_at", "timestamp"]),
    createdAt: stringField(record, ["createdAt", "created_at"]),
    file,
  }];
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
