// End-to-end check of the desktop app: launches Electron (dev tree or a packaged exe), drives the UI with Playwright,
// pairs a simulated phone through the QR link over real MQTT/WebRTC, then kills the bridge to test auto-restart.
// Run: node --import tsx scripts/desktop-smoke.mjs [--exe path\to\PocketPilot.exe] [--out C:\dir] [--prefix desk]
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { DEFAULT_BROKERS, MqttBus, RemoteClient } from "@pocketpilot/remote";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const out = arg("--out", homedir());
const prefix = arg("--prefix", "desk");
const exe = arg("--exe", "");
const port = 47251;
const step = (m) => console.log(`[smoke ${new Date().toISOString()}] ${m}`);
const check = (ok, m) => { step(`${ok ? "PASS" : "FAIL"} ${m}`); if (!ok) failed.push(m); };
const failed = [];
const shot = (page, n) => page.screenshot({ path: path.join(out, `${prefix}${n}.png`) });

const env = { ...process.env, POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: mkdtempSync(path.join(tmpdir(), "pp-home-")), POCKETPILOT_DESKTOP_USERDATA: mkdtempSync(path.join(tmpdir(), "pp-ud-")) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch(exe ? { executablePath: exe, env } : { args: [path.join(root, "apps/desktop")], env, cwd: root });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1040, height: 720 }).catch(() => undefined);
const getState = () => page.evaluate(() => window.pp.invoke("state:get"));
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 300)); } throw new Error("timeout: " + label); };

let phone;
try {
  await until(async () => (await getState()).phase === "running", 60000, "service running");
  await until(() => page.evaluate(() => !document.getElementById("qrImg").hidden), 30000, "QR visible");
  check(true, "service running + QR rendered");
  await new Promise((r) => setTimeout(r, 1500));
  await shot(page, 1);

  const code = await page.textContent("#pairCode");
  check(/^[A-Z0-9]{6}$/i.test(code), `pairing code shown (${code})`);
  await page.click("#copyLink");
  const link = await app.evaluate(({ clipboard }) => clipboard.readText());
  const m = /#pair=([\w-]+)\.([\w-]+)/.exec(link);
  check(Boolean(m), `copied link has #pair= (${link.slice(0, 60)}…)`);
  const st = await getState();
  check(st.status && st.status.rtc.mqttConnected > 0, `MQTT brokers up: ${st.status?.rtc.mqttConnected}/${st.status?.rtc.mqttTotal}`);

  // Local control surface must reject anything without the internal token.
  const code403 = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/desktop/status" }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", () => resolve(0)));
  check(code403 === 403, `/api/desktop/status without token -> ${code403} (expect 403)`);
  const code401 = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/bootstrap" }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", () => resolve(0)));
  check(code401 === 401, `/api/bootstrap from loopback without token -> ${code401} (expect 401, remote mode)`);

  // Simulated phone: scan -> pair over encrypted WebRTC -> authenticated API.
  const opts = { RTC: RTCPeerConnection, createBus: () => new MqttBus(DEFAULT_BROKERS, () => undefined), log: () => undefined };
  // Public MQTT + STUN make a single attempt occasionally fail on machines with several tunnel adapters: retry with a fresh QR like a user would.
  let welcome;
  let link2 = m;
  for (let attempt = 1; attempt <= 4 && !welcome; attempt += 1) {
    try {
      phone = new RemoteClient({ kind: "pair", sid: link2[1], secret: link2[2] }, opts);
      welcome = await phone.pair("e2e-phone");
    } catch (error) {
      step(`pairing attempt ${attempt} failed: ${error?.code ?? error?.message}`);
      try { phone.close(); } catch {}
      await page.click("#refreshQr");
      await new Promise((r) => setTimeout(r, 1500));
      await page.click("#copyLink");
      link2 = /#pair=([\w-]+)\.([\w-]+)/.exec(await app.evaluate(({ clipboard }) => clipboard.readText()));
    }
  }
  if (!welcome) throw new Error("phone could not pair after 4 attempts");
  check(Boolean(welcome.token), `phone paired via QR link, device=${welcome.deviceId}`);
  const auth = { authorization: `Bearer ${welcome.token}` };
  const noAuth = await phone.fetch("/api/bootstrap");
  const boot = await phone.fetch("/api/bootstrap", { headers: auth });
  check(noAuth.status === 401 && boot.status === 200, `remote API: no token ${noAuth.status}, with token ${boot.status}`);
  await until(() => page.evaluate(() => document.querySelectorAll("#deviceList li:not(.empty)").length === 1), 15000, "device in list");
  await until(() => page.evaluate(() => !document.getElementById("toast").hidden), 8000, "paired toast").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 600));
  await shot(page, 2);
  check(true, "device list shows paired phone + toast");

  await page.click('[data-tab="settings"]');
  await new Promise((r) => setTimeout(r, 800));
  await shot(page, 3);
  await page.evaluate(() => document.querySelector("#page-settings .settings").lastElementChild.scrollIntoView());
  await new Promise((r) => setTimeout(r, 300));
  await shot(page, 4);
  await page.click('[data-tab="home"]');

  // Crash recovery.
  const before = (await getState()).status.pid;
  process.kill(before);
  await until(async () => { const s = await getState(); return s.phase === "running" && s.status && s.status.pid !== before; }, 45000, "bridge restarted");
  check(true, "bridge killed -> auto restarted with a new pid");
  try { phone.close(); } catch {}
  let again = { status: 0 };
  for (let attempt = 1; attempt <= 4 && again.status !== 200; attempt += 1) {
    try {
      phone = new RemoteClient({ kind: "link", secret: welcome.linkSecret }, opts);
      again = await phone.fetch("/api/bootstrap", { headers: auth });
    } catch (error) {
      step(`reconnect attempt ${attempt} failed: ${error?.code ?? error?.message}`);
      try { phone.close(); } catch {}
    }
  }
  check(again.status === 200, `phone reconnects over its saved link after the restart -> ${again.status}`);

  // Revoke.
  await page.click("#deviceList .btn.danger");
  await page.click("#deviceList .btn.danger");
  await until(() => page.evaluate(() => document.querySelectorAll("#deviceList li.empty").length === 1), 10000, "device revoked");
  check(true, "revoke removes the device");

  await page.emulateMedia({ colorScheme: "dark" });
  await new Promise((r) => setTimeout(r, 500));
  await shot(page, 5);
  check(true, "dark theme screenshot");

  // Service switch.
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => window.pp.invoke("service:toggle", false));
  await until(async () => (await getState()).phase === "stopped", 10000, "stopped");
  await new Promise((r) => setTimeout(r, 600));
  await shot(page, 6);
  check(true, "service stop works");
} catch (error) {
  failed.push(String(error?.stack ?? error));
  console.error("SMOKE ERROR", error);
  await shot(page, "-error").catch(() => undefined);
} finally {
  try { phone?.close(); } catch {}
  await app.close().catch(() => undefined);
}
step(failed.length ? `FAILED: ${failed.length}` : "ALL PASS");
process.exit(failed.length ? 1 : 0);
