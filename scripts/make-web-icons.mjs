// Renders apps/web/public/favicon.svg (the brand mark, source of truth) into the PWA icons:
// icons/icon-192.png, icons/icon-512.png and icons/icon-maskable-512.png (full-bleed, mark inside the 80% safe zone).
// Needs Playwright's Chromium. Run: node scripts/make-web-icons.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "apps/web/public");
const svg = readFileSync(path.join(pub, "favicon.svg"), "utf8");
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
async function shot(size, html) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${html}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
for (const size of [192, 512]) writeFileSync(path.join(pub, "icons", `icon-${size}.png`), await shot(size, `<img src="${uri}" style="display:block;width:${size}px;height:${size}px">`));
// maskable: the launcher may crop to a circle, so keep the mark inside ~80% on a solid brand background
writeFileSync(path.join(pub, "icons", "icon-maskable-512.png"), await shot(512, `<div style="width:512px;height:512px;background:#2f6fed;display:grid;place-items:center"><img src="${uri}" style="width:410px;height:410px"></div>`));
await browser.close();
console.log("web icons written");
