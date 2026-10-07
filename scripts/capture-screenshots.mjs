import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts");
const base = process.env.MOBILEAGENT_URL ?? "http://127.0.0.1:47231";

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(base, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  await fetch("/api/demo/reset", { method: "POST" });
});
await page.reload({ waitUntil: "networkidle" });
await page.getByTestId("agent-switcher").waitFor();
await page.screenshot({ path: path.join(outDir, "home_agent_switcher.png") });

await page.goto(`${base}/chat/ses_cursor_auth`, { waitUntil: "networkidle" });
await page.getByTestId("chat").waitFor();
await page.screenshot({ path: path.join(outDir, "chat_session.png") });

await page.goto(`${base}/projects`, { waitUntil: "networkidle" });
await page.getByTestId("projects").waitFor();
await page.screenshot({ path: path.join(outDir, "project_list.png") });

await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
await page.getByTestId("settings").waitFor();
await page.screenshot({ path: path.join(outDir, "settings.png") });

await browser.close();
console.log("screenshots written to", outDir);
