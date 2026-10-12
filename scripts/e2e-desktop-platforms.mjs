// Drives the real Electron desktop app: "Platforms & keys" page, key save/mask/delete, test connection, in-app guide viewer.
//   node scripts/e2e-desktop-platforms.mjs -> .tmp/shots5/d*.png
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp", "shots5");
mkdirSync(out, { recursive: true });
const userData = path.join(root, ".tmp", "shots5-electron");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); };
const electronPath = (await import("electron")).default;
const app = await electron.launch({ executablePath: electronPath, args: [path.join(root, "apps/desktop/main.cjs"), `--user-data-dir=${userData}`], env: { ...process.env, POCKETPILOT_PORT: "47287", POCKETPILOT_HOME: path.join(userData, "pp-home") } });
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => console.log("pageerror", e.message));
  await win.setViewportSize({ width: 1000, height: 760 });
  await win.waitForFunction(() => /运行中|running/i.test(document.getElementById("topPillText")?.textContent ?? ""), null, { timeout: 45000 }).catch(async () => console.log("pill:", await win.locator("#topPillText").innerText(), "|", await win.locator("#stateSub").innerText()));
  await win.click("#tabPlatforms");
  await win.waitForSelector("#platList .plat", { timeout: 20000 });
  const names = await win.locator(".plat-name").allInnerTexts();
  check("platform list on the desktop", names.length >= 7, names.join(", "));
  await win.screenshot({ path: path.join(out, "d1_platforms.png") });
  await win.fill("#key-grok", "xai-desktop-0000000000-WXYZ");
  await win.locator("#key-grok").locator("xpath=following-sibling::button[last()]").click();
  await win.waitForFunction(() => /\*{4}WXYZ/.test(document.querySelector('[data-testid="state-grok"]')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => undefined);
  const stateText = await win.locator('[data-testid="state-grok"]').innerText().catch(() => "");
  const dom = await win.content();
  check("key saved: only last 4 digits shown", /\*{4}WXYZ/.test(stateText) && !dom.includes("xai-desktop-0000000000"), stateText);
  await win.click("#test-grok");
  await win.waitForSelector('[data-testid="result-grok"]', { timeout: 40000 });
  check("test connection result shown", true, await win.locator('[data-testid="result-grok"]').innerText());
  await win.screenshot({ path: path.join(out, "d2_key_saved_tested.png") });
  await win.click("#guide-grok");
  await win.waitForSelector("#guideModal:not([hidden]) .guide-body img", { timeout: 10000 });
  const imgs = await win.locator("#guideBody img").count();
  check("guide opens in-window with images", imgs >= 1, `${imgs} images`);
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(out, "d3_guide_grok.png") });
  await win.evaluate(() => { document.getElementById("guideBody").scrollTop = 700; });
  await win.screenshot({ path: path.join(out, "d4_guide_grok_scrolled.png") });
  await win.click("#guideClose");
  // delete (2-step confirm)
  const del = win.locator("#key-grok").locator("xpath=ancestor::article//button[contains(@class,'danger')]");
  await del.click(); await del.click();
  await win.waitForFunction(() => /未配置|Not set/.test(document.querySelector('[data-testid="state-grok"]')?.textContent ?? ""), null, { timeout: 10000 }).catch(() => undefined);
  check("key deleted", /未配置|Not set/.test(await win.locator('[data-testid="state-grok"]').innerText()));
  await win.click("#guide-trae-cn");
  await win.waitForSelector("#guideModal:not([hidden])");
  await win.screenshot({ path: path.join(out, "d5_guide_trae.png") });
} catch (e) {
  console.log("ERROR", e?.message ?? e); results.push(false);
} finally {
  await app.close();
}
process.exit(results.every(Boolean) ? 0 : 1);