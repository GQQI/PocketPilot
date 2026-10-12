// Real-browser test of the phone web app against a real host (the app is served by a separate static server, like the APK bundle):
// pair -> re-enter (cached UI first, link < 10 s) -> host down (specific failure + retry/re-pair, cached data stays) -> host back (retry works)
// -> API-key UI (Grok listed without a key, saving shows only the last 4 digits, test connection).
//   node scripts/e2e-web-reconnect.mjs  -> .tmp/shots5/*.png
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/web/dist");
const out = path.join(root, ".tmp", "shots5");
const home = path.join(root, ".tmp", "shots5-home");
const port = 47298, sport = 47297, sbase = `http://127.0.0.1:${sport}`, base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const staticServer = createServer((req, res) => {
  let file = path.join(dist, decodeURIComponent(new URL(req.url, sbase).pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(sport, "127.0.0.1");
function findChromium() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((n) => n.startsWith("chromium")).sort().reverse())
    for (const rel of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"]) { const p = path.join(cache, dir, rel); if (existsSync(p)) return p; }
}
function startHost() {
  const proc = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], { cwd: root, env: { ...process.env, HOST: "0.0.0.0", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home, POCKETPILOT_RTC: "1", POCKETPILOT_REMOTE: "1" } });
  const st = { out: "", proc };
  st.pair = new Promise((resolve) => { proc.stdout.on("data", (d) => { st.out += d; const m = /#pair=([\w-]+\.[\w-]+)/.exec(st.out); if (m) resolve(m[1]); }); });
  return st;
}
async function healthy() { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {} await sleep(250); } throw new Error("host not healthy"); }
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); };

let host = startHost(), browser;
try {
  await healthy();
  const payload = await host.pair;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: findChromium() }); }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });

  let t0 = Date.now();
  await page.goto(`${sbase}/#pair=${payload}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(localStorage.getItem("pocketpilot.token")), null, { timeout: 40000 });
  await page.waitForFunction(() => Boolean(localStorage.getItem("pocketpilot.cache.boot")), null, { timeout: 40000 });
  check("pair in the browser", true, `${Date.now() - t0} ms`);
  await page.waitForTimeout(800);
  await shot("01_paired_home");

  t0 = Date.now();
  await page.goto(`${sbase}/`, { waitUntil: "domcontentloaded" });
  await page.locator("nav").first().waitFor({ timeout: 5000 });
  const tUi = Date.now() - t0;
  check("re-enter shows the cached UI at once (no full-page blocker)", (await page.getByTestId("connecting").count()) === 0 && tUi < 3000, `${tUi} ms`);
  await shot("02_reenter_cached_connecting");
  await page.waitForFunction(() => !document.querySelector('[data-testid="link-banner"]'), null, { timeout: 15000 });
  const tUp = Date.now() - t0;
  check("link up after re-enter (< 10 s)", tUp < 10000, `${tUp} ms`);
  await page.waitForTimeout(600);
  await shot("03_reenter_connected");

  host.proc.kill(); await sleep(1500);
  t0 = Date.now();
  await page.goto(`${sbase}/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("link-retry").waitFor({ timeout: 30000 });
  const tFail = Date.now() - t0;
  const reason = (await page.locator(".link-sub").first().innerText()).trim();
  check("host down: explicit failure with retry / re-pair, cached UI stays", (await page.locator("nav").count()) > 0 && reason.length > 8 && tFail < 20000, `${tFail} ms, reason="${reason.slice(0, 40)}…"`);
  await shot("04_host_down_failed_banner");

  host = startHost(); await healthy();
  t0 = Date.now();
  await page.getByTestId("link-retry").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="link-banner"]'), null, { timeout: 20000 });
  check("host back: retry reconnects", true, `${Date.now() - t0} ms`);
  await page.waitForTimeout(600);
  await shot("05_retry_connected");

  await page.goto(`${sbase}/settings/platforms`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("platform-list").waitFor({ timeout: 20000 });
  const ids = await page.locator("[data-testid^=plat-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  check("platform list always shows Grok and the other platforms", ["plat-grok", "plat-cursor", "plat-trae-cn"].every((i) => ids.includes(i)), ids.join(","));
  await shot("06_platform_list_all");
  await page.getByTestId("plat-grok").click();
  await page.getByTestId("sec-conn").click();
  await page.getByTestId("key-state").waitFor();
  check("Grok without key shows 'not configured' + key field", /未配置|not/i.test(await page.getByTestId("key-state").innerText()));
  await shot("07_grok_connection_no_key");
  await page.locator('input[type="password"]').first().fill("xai-playwright-0000000000-ABCD");
  await page.getByRole("button", { name: /保存密钥|Save key/ }).first().click();
  await page.waitForFunction(() => /\*{4}ABCD/.test(document.querySelector('[data-testid="key-state"]')?.textContent ?? ""), null, { timeout: 15000 });
  check("saved key shows only ****ABCD", !(await page.content()).includes("xai-playwright-0000000000"));
  await page.getByTestId("key-test-btn").click();
  await page.getByTestId("key-test").waitFor({ timeout: 30000 });
  check("test connection returns a message", (await page.getByTestId("key-test").innerText()).length > 4, await page.getByTestId("key-test").innerText());
  await shot("08_grok_key_saved_tested");
} catch (error) {
  console.log("ERROR", error?.message ?? error);
  results.push(false);
  try { await (browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(out, "zz_error.png") })); } catch {}
} finally {
  try { await browser?.close(); } catch {}
  host.proc.kill(); staticServer.close();
}
process.exit(results.every(Boolean) ? 0 : 1);