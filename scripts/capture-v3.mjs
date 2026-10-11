// Screenshots for the multi-level settings, chat picker flow, notifications and new icons (real data, real Cursor CLI install).
//   node scripts/capture-v3.mjs  -> .tmp/shots3/*.png
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp", "shots3");
const home = path.join(root, ".tmp", "shots3-home");
const port = 47254, base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "zh", theme: "light", demoMode: false }));
function findChromium() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((n) => n.startsWith("chromium")).sort().reverse())
    for (const rel of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"]) { const p = path.join(cache, dir, rel); if (existsSync(p)) return p; }
}
const server = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], { cwd: root, stdio: "ignore", env: { ...process.env, HOST: "127.0.0.1", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home, POCKETPILOT_STATIC: path.join(root, "apps/web/dist") } });
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: findChromium() }); }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });
  const step = async (name, fn) => { try { await fn(); console.log("ok", name); } catch (e) { console.log("FAIL", name, String(e.message).split("\n")[0]); } };
  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });

  await step("home", async () => { await page.getByTestId("row-platforms").waitFor(); await page.waitForTimeout(500); await shot("01_settings_home"); });
  await step("platforms", async () => { await page.getByTestId("row-platforms").click(); await page.getByTestId("platform-list").waitFor(); await page.waitForTimeout(400); await shot("02_platform_list"); });
  await step("menu", async () => { await page.getByTestId("plat-claude-code").click(); await page.getByTestId("platform-menu").waitFor(); await page.waitForTimeout(400); await shot("03_platform_menu_claude"); });
  await step("usage", async () => { await page.getByTestId("sec-usage").click(); await page.getByTestId("usage").waitFor(); await page.waitForTimeout(1500); await shot("04_platform_usage_claude"); });
  await step("back via history", async () => { await page.goBack(); await page.getByTestId("platform-menu").waitFor(); await page.goBack(); await page.getByTestId("platform-list").waitFor(); console.log("history back works"); });
  await step("cursor connection (real CLI, not signed in)", async () => { await page.getByTestId("plat-cursor").click(); await page.getByTestId("sec-conn").click(); await page.getByTestId("connection").waitFor(); await page.waitForTimeout(500); await shot("05_cursor_connection_real_cli"); });
  await step("grok / trae listed", async () => { await page.goto(`${base}/settings/platforms`, { waitUntil: "networkidle" }); await page.getByTestId("platform-list").waitFor(); console.log("platform ids:", await page.locator("[data-testid^=plat-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))); await shot("06_platform_list_all"); });
  await step("trae menu", async () => { const t = page.getByTestId("plat-trae-cn"); if (await t.count()) { await t.click(); await page.getByTestId("sec-projects").click(); await page.getByTestId("platform-projects").waitFor(); await page.waitForTimeout(800); await shot("07_trae_projects"); } else console.log("trae-cn not detected"); });
  await step("notify", async () => { await page.goto(`${base}/settings/notifications`, { waitUntil: "networkidle" }); await page.getByTestId("notify-page").waitFor(); await shot("08_notifications"); });
  await step("test alert banner", async () => { await page.getByRole("button", { name: "发送测试提醒" }).click(); await page.getByTestId("task-banner").waitFor(); await page.waitForTimeout(400); await shot("09_inapp_banner"); });
  for (const [p, n] of [["security", "10_security"], ["privacy", "11_privacy"], ["appearance", "12_appearance"], ["about", "13_about"], ["about/terms", "14_terms_sample"]])
    await step(p, async () => { await page.goto(`${base}/settings/${p}`, { waitUntil: "networkidle" }); await page.waitForTimeout(700); await shot(n); });
  // chat picker flow
  await step("pick platform", async () => { await page.goto(`${base}/chat`, { waitUntil: "networkidle" }); await page.getByTestId("pick-platforms").waitFor(); await shot("20_pick_platform"); });
  await step("pick project", async () => { await page.getByTestId("pick-claude-code").click(); await page.getByTestId("pick-projects").waitFor(); await page.waitForTimeout(800); await shot("21_pick_project"); });
  await step("pick session", async () => { await page.getByTestId("pick-project-list").locator("button").first().click(); await page.getByTestId("pick-sessions").waitFor(); await page.waitForTimeout(900); await shot("22_pick_session"); });
  await step("open session", async () => { await page.locator("[data-testid=pick-sessions] .row-card, [data-testid=pick-sessions] button").nth(1).click(); await page.getByTestId("chat").waitFor(); await page.waitForTimeout(1200); await shot("23_chat_opened"); });
  // dark
  await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "dark" }) });
  for (const [p, n] of [["settings", "30_dark_settings_home"], ["settings/notifications", "31_dark_notifications"], ["chat", "32_dark_pick_platform"]])
    await step(p, async () => { await page.goto(`${base}/${p}`, { waitUntil: "networkidle" }); await page.waitForTimeout(700); await shot(n); });
  // icon showcase
  const pub = path.join(root, "apps/web/public");
  const uri = (f) => `data:image/svg+xml;base64,${readFileSync(path.join(pub, f)).toString("base64")}`;
  const tile = (src, size, extra = "") => `<img src="${src}" style="width:${size}px;height:${size}px;${extra}">`;
  await page.setViewportSize({ width: 560, height: 420 });
  await page.setContent(`<body style="margin:0;font:13px system-ui;background:#f4f7fb;padding:24px"><div style="display:flex;gap:20px;align-items:flex-end">
    <div>${tile(uri("favicon.svg"), 160)}<div>favicon.svg (light)</div></div>
    <div>${tile(uri("icon-dark.svg"), 160)}<div>icon-dark.svg</div></div>
    <div><div style="width:160px;height:160px;border-radius:50%;background:#2f6fed;display:grid;place-items:center">${tile(uri("icon-foreground.svg"), 128)}</div><div>Android adaptive (round mask)</div></div></div>
    <div style="margin-top:28px;display:flex;gap:16px;align-items:center">${[16, 24, 32, 48, 64].map((s) => tile(uri("favicon.svg"), s)).join("")}<span>小尺寸 16–64px</span></div>
    <div style="margin-top:20px;display:flex;gap:16px;background:#0b1220;padding:14px;border-radius:14px;align-items:center">${[32, 48, 64].map((s) => tile(uri("icon-dark.svg"), s)).join("")}<span style="color:#cfe0ff">深色背景</span></div></body>`);
  await shot("40_icons");
} finally { await browser?.close(); server.kill(); }
