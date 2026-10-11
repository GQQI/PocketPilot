// Screenshots for the overview / settings redesign + Cursor onboarding, and a plumbing test of the Cursor adapter
// against a SIMULATED cursor-agent (a tiny node script; it is not the real Cursor CLI).
//   node scripts/capture-v2.mjs  -> .tmp/shots2/*.png
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp", "shots2");
const home = path.join(root, ".tmp", "shots2-home");
const fake = path.join(root, ".tmp", "fakecli");
const port = 47252;
const base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true });
mkdirSync(fake, { recursive: true });
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
const providers = process.env.CLAUDE_CLI ? { "claude-code": { enabled: true, model: "sonnet", cliPath: process.env.CLAUDE_CLI, endpoint: "" } } : {};
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "zh", theme: "light", demoMode: false, providers }));

// ---- simulated cursor-agent
writeFileSync(path.join(fake, "fake.mjs"), `
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(path.join(fake, "calls.log"))}, JSON.stringify({ args: a, cwd: process.cwd() }) + "\\n");
if (a[0] === "--version") console.log("2099.01.01-simulated");
else if (a[0] === "status") console.log("Logged in as simulated@example.invalid");
else if (a.includes("--list-models")) console.log("Available models\\n\\nauto - Auto\\ncomposer-2 - Composer 2\\ngpt-5.5 - GPT-5.5");
else {
  const sid = a.includes("--resume") ? a[a.indexOf("--resume") + 1] : "sim-session-1";
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd() }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "SIMULATED reply to: " + a[a.length - 1] }] }, session_id: sid }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid }));
}
`);
writeFileSync(path.join(fake, "cursor-agent.cmd"), `@echo off\r\nnode "%~dp0fake.mjs" %*\r\n`);
rmSync(path.join(fake, "calls.log"), { force: true });

function findChromium() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((n) => n.startsWith("chromium")).sort().reverse())
    for (const rel of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-linux/chrome"]) {
      const p = path.join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
}
const server = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, HOST: "127.0.0.1", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home, POCKETPILOT_STATIC: path.join(root, "apps/web/dist") },
});
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* */ } await new Promise((r) => setTimeout(r, 200)); }
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: findChromium() }); }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
  const nav = (label) => page.locator("nav.dock a", { hasText: label }).click();

  // overview with real usage (no CLI for Cursor on this PC)
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByTestId("home-usage-detail").waitFor();
  await page.getByTestId("home-usage").locator(".plat-card").nth(1).waitFor();
  await page.waitForTimeout(6000); // let every platform's usage arrive
  await shot("a1_overview_top");
  await page.getByTestId("home-usage").scrollIntoViewIfNeeded();
  await page.getByTestId("home").evaluate((el) => el.scrollTo(0, 260));
  await page.waitForTimeout(300);
  await shot("a2_overview_usage");
  console.log("overview:", (await page.getByTestId("home-usage").innerText()).replace(/\s+/g, " ").slice(0, 700));

  // settings: platform switching, Cursor onboarding when no CLI
  await nav("设置");
  await page.getByTestId("agent-picker").waitFor();
  await page.getByTestId("agent-picker").getByRole("tab", { name: /Cursor/ }).click();
  const guide = page.getByTestId("install-guide");
  console.log("cursor install guide shown:", await guide.isVisible().catch(() => false));
  await page.waitForTimeout(400);
  await shot("b1_settings_cursor_no_cli");
  await page.getByTestId("agent-picker").getByRole("tab", { name: /Claude/ }).click();
  await page.waitForTimeout(500);
  await shot("b2_settings_claude");
  await page.getByTestId("settings").evaluate((el) => el.scrollTo(0, 500));
  await page.waitForTimeout(300);
  await shot("b3_settings_sticky_scrolled");

  // dark mode
  await page.getByTestId("settings").evaluate((el) => el.scrollTo(0, 99999));
  await page.getByTestId("general").locator("summary").click();
  await page.getByTestId("general").getByRole("button", { name: /深色|Dark/ }).click();
  await page.waitForTimeout(500);
  await nav("总览");
  await page.getByTestId("home-usage-detail").waitFor();
  await page.waitForTimeout(1500);
  await shot("c1_dark_overview");
  await page.getByTestId("home").evaluate((el) => el.scrollTo(0, 260));
  await page.waitForTimeout(300);
  await shot("c2_dark_overview_usage");
  await nav("设置");
  await page.getByTestId("agent-picker").getByRole("tab", { name: /Cursor/ }).click();
  await page.waitForTimeout(400);
  await shot("c3_dark_settings_cursor_guide");

  // simulated Cursor CLI: configure path, recheck, chat (new + resume)
  const cfg = await page.request.post(`${base}/api/agents/cursor/config`, { data: { cliPath: path.join(fake, "cursor-agent.cmd") } });
  const st = await cfg.json();
  console.log("sim cursor status:", JSON.stringify({ available: st.available, version: st.version, auth: st.auth?.state, note: st.auth?.note, models: st.models }));
  async function chat(body) {
    const res = await fetch(`${base}/api/agents/cursor/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(" | ");
  }
  console.log("chat new   :", await chat({ cwd: root, prompt: "hello cursor" }));
  console.log("chat resume:", await chat({ cwd: root, prompt: "again", sessionId: "sim-session-1" }));
  console.log("calls:", readFileSync(path.join(fake, "calls.log"), "utf8").trim().split("\n").filter((l) => l.includes("-p")).join("\n"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("agent-picker").getByRole("tab", { name: /Cursor/ }).click();
  await page.waitForTimeout(600);
  await shot("d1_dark_settings_cursor_simulated_cli");
  console.log("done");
} finally {
  await browser?.close();
  server.kill();
}
