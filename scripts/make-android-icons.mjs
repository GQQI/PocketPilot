// Renders apps/web/public/favicon.svg into the Android icons:
//  - legacy launcher (square + round) in every density
//  - adaptive icon foreground: the white three-robot silhouette (cut-outs are transparent) inside the 66% safe zone; background is a solid #2F6FED layer
//  - notification small icon (ic_stat_pocketpilot): white silhouette on transparent, 24dp, every density
// Uses Playwright's Chromium (or installed Edge as fallback).
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "apps/web/public/favicon.svg"), "utf8");
const res = path.join(root, "apps/android/android/app/src/main/res");
if (!existsSync(res)) throw new Error("run `npx cap add android` in apps/android first");
const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const adaptive = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const stat = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const page = await browser.newPage();
await page.setContent("<body></body>");

async function legacyIcon(size, round) {
  await page.setViewportSize({ width: size, height: size });
  const inner = round ? Math.round(size * 0.82) : size;
  await page.setContent(`<body style="margin:0;background:transparent;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center;${round ? "border-radius:50%;background:#2f6fed;" : ""}"><img src="${uri}" style="width:${inner}px;height:${inner}px"></div></body>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

// white silhouette: alpha = how "white" a pixel of the brand mark is (brand blue -> transparent)
async function silhouette(size, { inset = 0, crop = null }) {
  const data = await page.evaluate(async ({ uri, size, inset, crop }) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const big = 1024;
    const src = document.createElement("canvas");
    src.width = big; src.height = big;
    const sctx = src.getContext("2d");
    sctx.drawImage(img, 0, 0, big, big);
    const px = sctx.getImageData(0, 0, big, big);
    for (let i = 0; i < px.data.length; i += 4) {
      const a = px.data[i + 3] / 255;
      const w = Math.min(1, Math.max(0, (px.data[i] - 47) / 208));
      px.data[i] = px.data[i + 1] = px.data[i + 2] = 255;
      px.data[i + 3] = Math.round(255 * a * w);
    }
    sctx.putImageData(px, 0, 0);
    const out = document.createElement("canvas");
    out.width = size; out.height = size;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    if (crop) {
      const [cx, cy, cw, ch] = crop.map((v) => (v / 64) * big);
      const scale = (size * (1 - inset * 2)) / Math.max(cw, ch);
      const dw = cw * scale, dh = ch * scale;
      ctx.drawImage(src, cx, cy, cw, ch, (size - dw) / 2, (size - dh) / 2, dw, dh);
    } else {
      const inner = size * (1 - inset * 2);
      ctx.drawImage(src, (size - inner) / 2, (size - inner) / 2, inner, inner);
    }
    return out.toDataURL("image/png");
  }, { uri, size, inset, crop });
  return Buffer.from(data.split(",")[1], "base64");
}

for (const [density, size] of Object.entries(legacy)) {
  const dir = path.join(res, `mipmap-${density}`);
  writeFileSync(path.join(dir, "ic_launcher.png"), await legacyIcon(size, false));
  writeFileSync(path.join(dir, "ic_launcher_round.png"), await legacyIcon(size, true));
}
// adaptive: the 108dp canvas shows a 72dp window, 66dp is always safe. The mark is ~92% of its box, so inset 0.17 keeps it within ~61% of the canvas.
for (const [density, size] of Object.entries(adaptive)) {
  writeFileSync(path.join(res, `mipmap-${density}`, "ic_launcher_foreground.png"), await silhouette(size, { inset: 0.17 }));
}
for (const [density, size] of Object.entries(stat)) {
  const dir = path.join(res, `drawable-${density}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "ic_stat_pocketpilot.png"), await silhouette(size, { inset: 0.04, crop: [2, 8, 61, 46] }));
}
writeFileSync(path.join(res, "values/ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2F6FED</color>\n</resources>\n`);
await browser.close();
console.log("android icons written");
