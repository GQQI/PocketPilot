import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Backward compatibility with the product's former name (MobileAgent).
 * Legacy MOBILEAGENT_* variables are copied to POCKETPILOT_* when the new one is unset.
 */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MOBILEAGENT_") || value === undefined) continue;
    const next = `POCKETPILOT_${key.slice("MOBILEAGENT_".length)}`;
    if (env[next] === undefined) env[next] = value;
  }
}

/**
 * Default data directory: ~/.pocketpilot. If only the legacy ~/.mobileagent exists, it is copied once
 * (paired devices, secrets, state) and the old directory is left untouched as a backup.
 * If copying fails the legacy directory keeps being used, so existing pairings never break.
 */
export function resolveDefaultDataDir(home: string = homedir()): string {
  const next = path.join(home, ".pocketpilot");
  const legacy = path.join(home, ".mobileagent");
  if (existsSync(next) || !existsSync(legacy)) return next;
  try {
    cpSync(legacy, next, { recursive: true });
    return next;
  } catch {
    try {
      rmSync(next, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return legacy;
  }
}
