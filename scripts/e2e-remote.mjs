// End-to-end self test of the remote (phone) path over REAL public MQTT + STUN.
// Starts a throwaway host (separate process, own data dir + port) and plays the phone in THIS process:
//   QR pairing -> LAN address advertised -> encrypted WebRTC channel -> reconnect with the saved link secret
//   (right away, after an idle period, and again after the host process was restarted) -> dead-link detection
//   -> a wrong link secret fails fast with a specific reason -> API key save/mask/test/persist-across-restart.
// Run: node --import tsx scripts/e2e-remote.mjs      (E2E_IDLE_SEC=300 to simulate a longer-running host)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { DEFAULT_BROKERS, MqttBus, RemoteClient } from "@pocketpilot/remote";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 47299;
const home = mkdtempSync(path.join(tmpdir(), "ma-e2e-"));
const idleSec = Number(process.env.E2E_IDLE_SEC ?? 20);
const step = (m) => console.log(`[e2e ${new Date().toISOString()}] ${m}`);
const checks = [];
const check = (name, ok, detail = "") => { checks.push(ok); step(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHost() {
  const proc = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
    cwd: root,
    env: { ...process.env, POCKETPILOT_RTC: "1", POCKETPILOT_REMOTE: "1", POCKETPILOT_PORT: String(port), HOST: "0.0.0.0", POCKETPILOT_HOME: home, POCKETPILOT_STATIC: path.join(root, "apps/web/dist") },
  });
  const state = { out: "" };
  state.pair = new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => { state.out += d; const m = /#pair=([\w-]+)\.([\w-]+)/.exec(state.out); if (m) resolve({ sid: m[1], secret: m[2] }); });
    proc.stderr.on("data", (d) => (state.out += d));
    setTimeout(() => reject(new Error("no pairing link in host output:\n" + state.out)), 30_000);
  });
  state.proc = proc;
  return state;
}

let host = startHost();
const stunEnv = process.env.POCKETPILOT_STUN?.split(",").map((s) => s.trim()).filter(Boolean);
const mk = (target) => new RemoteClient(target, { iceServers: stunEnv, RTC: RTCPeerConnection, createBus: () => new MqttBus(DEFAULT_BROKERS, () => undefined), log: () => undefined });
async function timed(fn) { const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; }
async function waitHealthy() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* starting */ } await sleep(500); } throw new Error("host not healthy"); }

let code = 1;
try {
  const { sid, secret } = await host.pair;
  step("host up, pairing link parsed");
  const c1 = mk({ kind: "pair", sid, secret });
  const [welcome, tPair] = await timed(() => c1.pair("e2e-phone"));
  check("pairing", Boolean(welcome.token && welcome.linkSecret), `${tPair} ms`);
  check("welcome carries LAN urls", Array.isArray(welcome.urls) && welcome.urls.length > 0, JSON.stringify(welcome.urls));
  const auth = { authorization: `Bearer ${welcome.token}` };

  const noAuth = await c1.fetch("/api/bootstrap");
  check("no token -> 401", noAuth.status === 401);
  const boot = await c1.fetch("/api/bootstrap", { headers: auth });
  check("token -> 200", boot.status === 200);
  check("probe() on a live link", await c1.probe(3000));
  c1.close();
  check("probe() on a closed link is false", (await c1.probe(500)) === false);

  const lan = (welcome.urls ?? []).find((u) => !u.includes("127.0.0.1"));
  if (lan) {
    const r = await fetch(`${lan}/api/devices`, { headers: auth, signal: AbortSignal.timeout(2500) }).catch(() => null);
    check("LAN address answers with the device token (HTTP, no MQTT/WebRTC)", r?.status === 200, lan);
    const bad = await fetch(`${lan}/api/devices`, { headers: { authorization: "Bearer nope" } }).catch(() => null);
    check("LAN address rejects a wrong token", bad?.status === 401);
  }

  // reconnect right after, and after the host has been idle for a while
  for (const [label, wait] of [["immediately", 0], [`after ${idleSec}s idle`, idleSec * 1000]]) {
    if (wait) await sleep(wait);
    const c = mk({ kind: "link", secret: welcome.linkSecret });
    const [res, ms] = await timed(async () => c.fetch("/api/bootstrap", { headers: auth }));
    check(`link reconnect ${label}`, res.status === 200 && ms < 10_000, `${ms} ms`);
    c.close();
  }

  // API key: save -> masked only -> test -> survives a host restart
  const KEY = "xai-e2e-0123456789abcdefWXYZ";
  const saved = await fetch(`http://127.0.0.1:${port}/api/agents/grok/config`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ apiKey: KEY }) });
  const savedText = await saved.text();
  check("saving a key never echoes it", saved.status === 200 && !savedText.includes(KEY) && savedText.includes('"keyLast4":"WXYZ"'));
  const list = await (await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: auth })).text();
  check("agents list masks the key and always lists Grok", !list.includes(KEY) && list.includes('"id":"grok"') && list.includes('"available":true'));
  const tested = await fetch(`http://127.0.0.1:${port}/api/agents/grok/test`, { method: "POST", headers: auth });
  const testedJson = await tested.json();
  check("test connection answers with a result", tested.status === 200 && typeof testedJson.message === "string", testedJson.message);

  host.proc.kill();
  await sleep(1500);
  host = startHost();
  await waitHealthy();
  const after = await (await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: auth })).text();
  check("key persists across a host restart (masked)", after.includes('"keyLast4":"WXYZ"') && !after.includes(KEY));
  // the restarted host must accept the saved link (persistent reconnect topic) without a new pairing
  const c3 = mk({ kind: "link", secret: welcome.linkSecret });
  const [res3, ms3] = await timed(async () => c3.fetch("/api/bootstrap", { headers: auth }));
  check("link reconnect after host restart", res3.status === 200 && ms3 < 12_000, `${ms3} ms`);
  c3.close();

  // wrong secret: must fail fast and say why
  const c4 = mk({ kind: "link", secret: "A".repeat(43) });
  const [err, ms4] = await timed(async () => c4.fetch("/api/bootstrap").then(() => null, (e) => e));
  check("unknown link fails fast with a specific reason", Boolean(err) && ["no-host", "signal"].includes(err.code) && ms4 < 12_000, `${err?.code} in ${ms4} ms`);
  c4.close();

  code = checks.every(Boolean) ? 0 : 1;
  step(code === 0 ? "ALL PASS" : "SOME CHECKS FAILED");
} catch (e) {
  console.error("E2E ERROR:", e?.code ?? "", e?.message ?? e);
} finally {
  host.proc.kill();
  process.exit(code);
}