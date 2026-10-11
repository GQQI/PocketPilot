import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyLegacyEnv, resolveDefaultDataDir } from "./compat";

test("legacy MOBILEAGENT_* variables map to POCKETPILOT_* without overriding new ones", () => {
  const env: NodeJS.ProcessEnv = { MOBILEAGENT_PORT: "1111", MOBILEAGENT_RTC: "1", POCKETPILOT_RTC: "0" };
  applyLegacyEnv(env);
  assert.equal(env.POCKETPILOT_PORT, "1111");
  assert.equal(env.POCKETPILOT_RTC, "0");
});

test("legacy ~/.mobileagent is copied to ~/.pocketpilot once and kept as backup", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pp-home-"));
  try {
    mkdirSync(path.join(home, ".mobileagent"));
    writeFileSync(path.join(home, ".mobileagent", "state.json"), '{"devices":1}');
    const dir = resolveDefaultDataDir(home);
    assert.equal(dir, path.join(home, ".pocketpilot"));
    assert.equal(readFileSync(path.join(dir, "state.json"), "utf8"), '{"devices":1}');
    assert.ok(existsSync(path.join(home, ".mobileagent", "state.json")));
    writeFileSync(path.join(dir, "state.json"), "new");
    assert.equal(resolveDefaultDataDir(home), dir);
    assert.equal(readFileSync(path.join(dir, "state.json"), "utf8"), "new");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh machine uses ~/.pocketpilot", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pp-home-"));
  try {
    assert.equal(resolveDefaultDataDir(home), path.join(home, ".pocketpilot"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
