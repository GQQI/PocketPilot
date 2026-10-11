// End-to-end self test of the remote (phone) path over REAL public MQTT + STUN.
// Starts a throwaway host (separate process, own data dir + port), then plays the phone in THIS process:
// QR pairing -> encrypted WebRTC data channel -> authenticated API calls -> link reconnect.
// Run: node --import tsx scripts/e2e-remote.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { DEFAULT_BROKERS, MqttBus, RemoteClient } from "@pocketpilot/remote";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 47299;
const host = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
  cwd: root,
  env: { ...process.env, POCKETPILOT_RTC: "1", POCKETPILOT_REMOTE: "1", POCKETPILOT_PORT: String(port), HOST: "127.0.0.1", POCKETPILOT_HOME: mkdtempSync(path.join(tmpdir(), "ma-e2e-")), POCKETPILOT_STATIC: path.join(root, "apps/web/dist") },
});
let out = "";
const pairUrl = new Promise((resolve, reject) => {
  host.stdout.on("data", (d) => { out += d; const m = /#pair=([\w-]+)\.([\w-]+)/.exec(out); if (m) resolve({ sid: m[1], secret: m[2] }); });
  host.stderr.on("data", (d) => (out += d));
  setTimeout(() => reject(new Error("no pairing link in host output:\n" + out)), 30_000);
});
const step = (m) => console.log(`[e2e ${new Date().toISOString()}] ${m}`);
let code = 1;
try {
  const { sid, secret } = await pairUrl;
  step("host up, pairing link parsed");
  const stunEnv = process.env.POCKETPILOT_STUN?.split(",").map((s) => s.trim()).filter(Boolean);
  const opts = { iceServers: stunEnv, RTC: RTCPeerConnection, createBus: () => new MqttBus(DEFAULT_BROKERS, () => undefined), log: (m) => step("client: " + m) };
  const c1 = new RemoteClient({ kind: "pair", sid, secret }, opts);
  const welcome = await c1.pair("e2e-phone");
  step(`paired OK device=${welcome.deviceId} host=${welcome.host}`);
  const auth = { authorization: `Bearer ${welcome.token}` };
  const noAuth = await c1.fetch("/api/bootstrap");
  step(`GET /api/bootstrap without token -> ${noAuth.status} (expect 401)`);
  const boot = await c1.fetch("/api/bootstrap", { headers: auth });
  step(`GET /api/bootstrap with token -> ${boot.status} (expect 200), providers=${(await boot.json()).providers?.length}`);
  c1.close();
  const c2 = new RemoteClient({ kind: "link", secret: welcome.linkSecret }, opts);
  const again = await c2.fetch("/api/bootstrap", { headers: auth });
  step(`link reconnect -> ${again.status} (expect 200)`);
  c2.close();
  code = noAuth.status === 401 && boot.status === 200 && again.status === 200 ? 0 : 1;
  step(code === 0 ? "PASS" : "FAIL");
} catch (e) {
  console.error("E2E ERROR:", e?.code ?? "", e?.message ?? e);
} finally {
  host.kill();
  process.exit(code);
}

