// Renders apps/web/public/favicon.svg into the Android launcher icons (legacy square, round, adaptive foreground).
// Uses Playwright's Chromium (or installed Edge as fallback).
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "apps/web/public/favicon.svg"), "utf8");
const res = path.join(root, "apps/android/android/app/src/main/res");
if (!existsSync(res)) throw new Error("run `npx cap add android` in apps/android first");
const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const adaptive = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const fgSvg = readFileSync(path.join(root, "apps/web/public/icon-foreground.svg"), "utf8");
const fgUri = `data:image/svg+xml;base64,${Buffer.from(fgSvg).toString("base64")}`;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const page = await browser.newPage();
async function render(size, { round = false, inset = 0, src = uri } = {}) {
  const inner = Math.round(size * (1 - inset * 2));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
    <img src="${src}" style="width:${inner}px;height:${inner}px;${round ? "border-radius:50%;" : ""}"></body>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
for (const [density, size] of Object.entries(legacy)) {
  const dir = path.join(res, `mipmap-${density}`);
  writeFileSync(path.join(dir, "ic_launcher.png"), await render(size));
  writeFileSync(path.join(dir, "ic_launcher_round.png"), await render(size, { round: true }));
}
for (const [density, size] of Object.entries(adaptive)) {
  writeFileSync(path.join(res, `mipmap-${density}`, "ic_launcher_foreground.png"), await render(size, { inset: 0.12, src: fgUri }));
}
writeFileSync(path.join(res, "values/ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2F6FED</color>\n</resources>\n`);
await browser.close();
console.log("android icons written");

