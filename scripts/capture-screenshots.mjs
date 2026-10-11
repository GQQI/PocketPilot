// Drives the real web UI against a real host on this PC and saves screenshots.
// Everything shown is read from the platforms installed here (no demo data).
//   node scripts/capture-screenshots.mjs            -> .tmp/shots/*.png
// Optional env: SHOT_DIR, CLAUDE_CLI (full path to claude when it is not on PATH), SEND_CODEX=0 to skip the live Codex message.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.SHOT_DIR ?? path.join(root, ".tmp", "shots");
const home = path.join(root, ".tmp", "shots-home");
const port = 47251;
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const providers = process.env.CLAUDE_CLI ? { "claude-code": { enabled: true, model: "sonnet", cliPath: process.env.CLAUDE_CLI, endpoint: "" } } : {};
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "zh", theme: "light", demoMode: false, providers }));

function findChromium() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((n) => n.startsWith("chromium")).sort().reverse()) {
    for (const rel of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-linux/chrome"]) {
      const p = path.join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const server = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, HOST: "127.0.0.1", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home, POCKETPILOT_STATIC: path.join(root, "apps/web/dist") },
});
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: findChromium() }); }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const nav = (label) => page.locator("nav.dock a", { hasText: label }).click();

  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("agent-count").waitFor();
  await page.getByTestId("recent-sessions").locator(".row-card").first().waitFor({ timeout: 30000 });
  console.log("agents:", (await page.getByTestId("agent-count").innerText()).replace(/\n/g, " | "));
  await shot("01_overview");

  await nav("会话");
  await page.getByTestId("sessions").locator(".row-card").first().waitFor({ timeout: 30000 });
  await shot("02_sessions");

  // open a real history chat of the selected platform
  await page.getByTestId("sessions").locator(".row-card").first().click();
  await page.getByTestId("chat").locator(".user-bubble").first().waitFor({ timeout: 30000 });
  await shot("03_chat_history");

  await nav("项目");
  await page.getByTestId("projects").locator(".row-card").first().waitFor({ timeout: 30000 });
  await shot("04_projects");
  await page.getByTestId("projects").locator(".row-card").first().click();
  await page.getByTestId("project").waitFor();
  await page.waitForTimeout(500);
  await shot("05_project_sessions");

  await nav("设置");
  await page.getByTestId("platform-detail").waitFor();
  await page.getByTestId("usage").getByText(/请求|暂不提供/).first().waitFor({ timeout: 90000 });
  await shot("06_settings_cursor_usage");
  for (const [name, file] of [["Codex", "07_settings_codex_usage"], ["Claude Code", "08_settings_claude_usage"]]) {
    const tab = page.getByTestId("agent-picker").getByRole("tab", { name: new RegExp(name) });
    if (!(await tab.count())) { console.log("tab missing", name); continue; }
    await tab.click();
    await page.waitForTimeout(300);
    await page.getByTestId("usage").getByText(/请求|暂不提供/).first().waitFor({ timeout: 120000 });
    await shot(file);
  }

  // scan entry (top right) falls back to the paste dialog in a browser
  await page.getByTestId("scan-btn").click();
  await page.getByTestId("scan-sheet").waitFor();
  await shot("09_scan_dialog");
  await page.keyboard.press("Escape");

  // real Cursor chat when the CLI is missing: composer is disabled and says why
  await nav("项目");
  await page.getByTestId("agent-picker").getByRole("tab", { name: /Cursor/ }).click();
  await page.getByTestId("projects").locator(".row-card").first().click();
  await page.getByRole("button", { name: /在这里新对话|New chat here/ }).isDisabled().then((d) => console.log("cursor new chat disabled (no CLI):", d));

  if (process.env.SEND_CODEX !== "0") {
    // set a model this account accepts, then send a real prompt through Codex in a scratch folder
    await nav("设置");
    await page.getByTestId("agent-picker").getByRole("tab", { name: /Codex/ }).click();
    const detail = page.getByTestId("platform-detail");
    await detail.locator('input[list="models-codex"]').fill(process.env.CODEX_MODEL ?? "gpt-5.5");
    await detail.getByRole("button", { name: "保存", exact: true }).click();
    const scratch = path.join(root, ".tmp", "chatcwd");
    mkdirSync(scratch, { recursive: true });
    await page.goto(`${base}/chat/codex/new?cwd=${encodeURIComponent(scratch)}`, { waitUntil: "networkidle" });
    await page.getByTestId("composer").fill("Reply with exactly the word PONG and nothing else. Do not run any commands.");
    await page.getByTestId("composer").evaluate((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
    await shot("10_composer_filled");
    await page.getByTestId("send").click();
    await page.locator(".assistant-msg", { hasText: "PONG" }).first().waitFor({ timeout: 40000 }).catch(() => console.log("no PONG within 40s"));
    await page.waitForTimeout(800);
    await shot("11_codex_live_reply");
    console.log("codex page text:", (await page.locator("main").innerText()).slice(-400).replace(/\s+/g," "));
  }
  console.log("screenshots in", out);
} finally {
  await browser?.close();
  server.kill();
}
