// Renders apps/web/public/favicon.svg into the PWA icons (icons/icon-192.png, icon-512.png).
// Needs Playwright's Chromium. Run: node scripts/make-web-icons.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "apps/web/public");
const svg = readFileSync(path.join(pub, "favicon.svg"), "utf8");
async function launch() {
  try { return await chromium.launch(); } catch (error) {
    const base = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    for (const dir of existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [])
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = path.join(base, dir, sub, "chrome.exe");
        if (existsSync(exe)) return chromium.launch({ executablePath: exe });
      }
    throw error;
  }
}
const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  writeFileSync(path.join(pub, "icons", `icon-${size}.png`), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();
console.log("web icons written");
