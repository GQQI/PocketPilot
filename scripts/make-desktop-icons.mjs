// Renders the brand mark into the desktop app icons: build/icon.ico (16..256), build/icon.png (512), build/tray.png (32), build/tray-16.png.
// Small sizes (<= 32px) use apps/web/public/icon-tray.svg: the same three robots without antennas, so they stay readable.
// Uses the Playwright Chromium that is already a dev dependency. Run: node scripts/make-desktop-icons.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = readFileSync(path.join(root, "apps/web/public/favicon.svg"), "utf8");
const small = readFileSync(path.join(root, "apps/web/public/icon-tray.svg"), "utf8");
const outDir = path.join(root, "apps/desktop/build");
mkdirSync(outDir, { recursive: true });

async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    const base = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const dir of dirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = path.join(base, dir, sub, "chrome.exe");
        if (existsSync(exe)) return chromium.launch({ executablePath: exe });
      }
    }
    throw error;
  }
}
const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(size, svg) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = new Map();
for (const size of sizes) pngs.set(size, await render(size, size <= 32 ? small : full));
const icon512 = await render(512, full);
const tray32 = pngs.get(32);
const tray16 = pngs.get(16);
await browser.close();

// ICO container with embedded PNG images (Windows Vista+).
const entries = sizes.map((s) => ({ size: s, data: pngs.get(s) }));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((entry, i) => {
  const at = 6 + 16 * i;
  header[at] = entry.size === 256 ? 0 : entry.size;
  header[at + 1] = entry.size === 256 ? 0 : entry.size;
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(entry.data.length, at + 8); header.writeUInt32LE(offset, at + 12);
  offset += entry.data.length;
});
writeFileSync(path.join(outDir, "icon.ico"), Buffer.concat([header, ...entries.map((e) => e.data)]));
writeFileSync(path.join(outDir, "icon.png"), icon512);
writeFileSync(path.join(outDir, "tray.png"), tray32);
writeFileSync(path.join(outDir, "tray-16.png"), tray16);
console.log("wrote", outDir);
