import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts");
const base = process.env.POCKETPILOT_URL ?? "http://127.0.0.1:47231";

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

async function reset() {
  const response = await page.request.post(`${base}/api/demo/reset`);
  if (!response.ok()) throw new Error(`reset ${response.status()}`);
  const settings = await page.request.post(`${base}/api/settings`, {
    data: {
      theme: "light",
      locale: "zh",
      demoMode: true,
      activeProviderId: "cursor",
      workspacePath: "",
      providers: { cursor: { enabled: true, model: "auto", cliPath: "agent", endpoint: "" } },
    },
  });
  if (!settings.ok()) throw new Error(`settings ${settings.status()}`);
}

try {
await page.goto(base, { waitUntil: "networkidle" });
await reset();
await page.reload({ waitUntil: "networkidle" });
await page.getByTestId("home").waitFor();
await page.getByRole("heading", { name: "手机控制这台电脑" }).waitFor();
await page.screenshot({ path: path.join(outDir, "home_simplified.png") });

await page.getByTestId("open-agents").click();
await page.getByTestId("agent-switcher").waitFor();
const names = ["Cursor CLI", "Claude Code", "Codex", "OpenCode", "Gemini CLI", "DeepSeek Harness"];
for (const name of names) await page.getByRole("button", { name: new RegExp(name) }).waitFor();
await page.screenshot({ path: path.join(outDir, "agent_picker.png") });
await page.getByRole("button", { name: /Codex/ }).click();
await page.getByRole("heading", { name: "Codex" }).waitFor();
await page.getByText("生成迁移脚本").waitFor();
await page.getByTestId("open-agents").click();
await page.getByRole("button", { name: /DeepSeek Harness/ }).click();
await page.getByText("把会话工具拆成插件").waitFor();
await page.getByTestId("open-agents").click();
await page.getByRole("button", { name: /Cursor CLI/ }).click();
await page.getByText("收紧登录态中间件").waitFor();

await page.getByRole("button", { name: "选择目录" }).click();
await page.getByTestId("dir-picker").waitFor();
await page.getByRole("button", { name: "D:\\", exact: true }).click();
await page.getByRole("button", { name: "Project", exact: true }).click();
await page.getByRole("button", { name: "harbor-ledger", exact: true }).waitFor();
await page.screenshot({ path: path.join(outDir, "remote_directory.png") });
await page.getByRole("button", { name: "harbor-ledger", exact: true }).click();
await page.getByRole("button", { name: "用这个目录" }).click();
await page.getByText("D:\\Project\\harbor-ledger").waitFor();

await page.goto(`${base}/chat/ses_cursor_auth`, { waitUntil: "networkidle" });
await page.getByTestId("chat").waitFor();
await page.getByText("D:\\Project\\harbor-ledger").waitFor();
const box = page.getByPlaceholder("写在手机上，发到这台电脑");
await box.fill("看一下登录中间件");
await page.getByRole("button", { name: "发送" }).click();
const live = page.getByTestId("live-output");
await live.waitFor({ timeout: 8000 });
await page.screenshot({ path: path.join(outDir, "chat_live_output.png") });
await page.getByText("Cursor CLI 接手").waitFor({ timeout: 8000 });

await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
await page.getByTestId("theme-toggle").waitFor();
await page.getByRole("button", { name: "浅色" }).waitFor();
await page.getByRole("button", { name: "深色" }).waitFor();
await page.getByText("配对码").first().waitFor();
await page.screenshot({ path: path.join(outDir, "settings_theme.png") });
await page.getByRole("button", { name: "深色" }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
await page.getByRole("button", { name: "浅色" }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

const liveOff = await page.request.post(`${base}/api/settings`, {
  data: {
    demoMode: false,
    workspacePath: "/tmp",
    providers: { cursor: { enabled: true, model: "auto", cliPath: "pocketpilot-missing-cli", endpoint: "" } },
  },
});
if (!liveOff.ok()) throw new Error(`live settings ${liveOff.status()}`);
const created = await page.request.post(`${base}/api/sessions`, {
  data: { providerId: "cursor", projectId: "live__cursor", title: "bridge" },
});
if (!created.ok()) throw new Error(`session ${created.status()} ${await created.text()}`);
const body = await created.json();
await page.goto(`${base}/chat/${body.session.id}`, { waitUntil: "networkidle" });
await page.getByPlaceholder("写在手机上，发到这台电脑").fill("hello from the phone");
await page.getByRole("button", { name: "发送" }).click();
await page.getByText("pocketpilot-missing-cli").waitFor({ timeout: 8000 });

await reset();
console.log("screenshots written to", outDir);
} finally {
  await reset().catch(() => {});
  await browser.close();
}
