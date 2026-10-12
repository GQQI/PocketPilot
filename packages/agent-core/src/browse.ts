import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { FsEntry, FsListing } from "@pocketpilot/protocol";
import { HubError } from "./errors";

const SKIP = new Set(["node_modules", ".git", "dist", ".pocketpilot", ".mobileagent", "secrets.json", ".env", ".env.local"]);

const DEMO: Record<string, FsEntry[]> = {
  "": [{ name: "D:\\", path: "D:\\", kind: "dir" }],
  "D:\\": [{ name: "Project", path: "D:\\Project", kind: "dir" }],
  "D:\\Project": [
    { name: "PocketPilot", path: "D:\\Project\\AgentFrame", kind: "dir" },
    { name: "harbor-ledger", path: "D:\\Project\\harbor-ledger", kind: "dir" },
    { name: "northwind-mobile", path: "D:\\Project\\northwind-mobile", kind: "dir" },
    { name: "atlas-ingest", path: "D:\\Project\\atlas-ingest", kind: "dir" },
  ],
  "D:\\Project\\AgentFrame": [
    { name: "apps", path: "D:\\Project\\AgentFrame\\apps", kind: "dir" },
    { name: "packages", path: "D:\\Project\\AgentFrame\\packages", kind: "dir" },
    { name: "README.md", path: "D:\\Project\\AgentFrame\\README.md", kind: "file" },
  ],
  "D:\\Project\\harbor-ledger": [
    { name: "src", path: "D:\\Project\\harbor-ledger\\src", kind: "dir" },
    { name: "package.json", path: "D:\\Project\\harbor-ledger\\package.json", kind: "file" },
  ],
  "D:\\Project\\northwind-mobile": [
    { name: "src", path: "D:\\Project\\northwind-mobile\\src", kind: "dir" },
  ],
  "D:\\Project\\atlas-ingest": [
    { name: "atlas", path: "D:\\Project\\atlas-ingest\\atlas", kind: "dir" },
  ],
  "D:\\Project\\harbor-ledger\\src": [
    { name: "auth", path: "D:\\Project\\harbor-ledger\\src\\auth", kind: "dir" },
  ],
};

export function listDemoDirectory(input: string): FsListing {
  const key = normalizeDemo(input);
  const entries = DEMO[key];
  if (!entries) throw new HubError("directory not found", 404, "path");
  return { path: key, parent: parentOf(key), entries, demo: true };
}

export function listHostDirectory(input: string): FsListing {
  const raw = input.trim();
  if (raw.includes("\0")) throw new HubError("bad path", 400, "path");
  if (!raw) return roots();
  const target = path.resolve(raw);
  let info;
  try {
    info = statSync(target);
  } catch {
    throw new HubError("directory not found", 404, "path");
  }
  if (!info.isDirectory()) throw new HubError("not a directory", 400, "path");
  const out: FsEntry[] = [];
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    throw new HubError("directory not readable", 403, "path");
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    let kind: FsEntry["kind"] | null = null;
    if (entry.isDirectory()) kind = "dir";
    else if (entry.isFile()) kind = "file";
    if (!kind) continue;
    out.push({ name: entry.name, path: full, kind });
    if (out.length >= 200) break;
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return {
    path: target,
    parent: directoryParent(target),
    entries: out,
    demo: false,
  };
}

/**
 * Parent shown by the folder picker.
 * A Windows drive root (`C:\`) and POSIX `/` return `""`, which the picker treats as the drive/root list.
 * `null` is only the top chooser (no path yet).
 */
export function directoryParent(target: string): string | null {
  if (!target) return null;
  const win = /^[a-zA-Z]:/.test(target) || (!target.startsWith("/") && target.includes("\\"));
  const p = win ? path.win32 : path.posix;
  const normalized = p.normalize(win ? target.replace(/\//g, "\\") : target);
  const parent = p.dirname(normalized);
  if (parent === normalized) return "";
  return parent;
}

function roots(): FsListing {
  const entries: FsEntry[] = [];
  const home = homedir();
  if (home) entries.push({ name: path.basename(home) || home, path: home, kind: "dir" });
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) entries.push({ name: drive, path: drive, kind: "dir" });
    }
  } else if (existsSync("/")) {
    entries.push({ name: "/", path: "/", kind: "dir" });
  }
  return { path: "", parent: null, entries, demo: false };
}

function normalizeDemo(input: string): string {
  const trimmed = input.trim().replace(/\//g, "\\");
  if (!trimmed) return "";
  if (trimmed === "D:" || trimmed === "D:\\") return "D:\\";
  return trimmed.replace(/\\+$/, "");
}

function parentOf(key: string): string | null {
  if (!key) return null;
  if (key === "D:\\") return "";
  const index = key.lastIndexOf("\\");
  if (index <= 2) return "D:\\";
  return key.slice(0, index);
}
