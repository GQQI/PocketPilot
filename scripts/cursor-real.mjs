// Drives the REAL cursor-agent through the PocketPilot bridge (no simulation). node scripts/cursor-real.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = path.join(root, ".tmp", "cursor-real-home");
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "en", theme: "light", demoMode: false }));
const port = 47253, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], { cwd: root, stdio: "ignore", env: { ...process.env, HOST: "127.0.0.1", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home } });
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  const st = await (await fetch(`${base}/api/agents/cursor`)).json();
  console.log("status:", JSON.stringify({ installed: st.installed, available: st.available, cliPath: st.cliPath, version: st.version, auth: st.auth, models: st.models?.slice(0, 5) }));
  const cwd = path.join(root, ".tmp", "cursortest");
  async function chat(body) {
    const res = await fetch(`${base}/api/agents/cursor/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(" | ");
  }
  console.log("chat #1:", await chat({ cwd, prompt: "用一句话回复你好" }));
  const us = await (await fetch(`${base}/api/agents/cursor/usage`)).json();
  console.log("usage:", JSON.stringify({ supported: us.supported, today: us.today, note: us.note?.slice(0, 80) }));
} finally { server.kill(); }
