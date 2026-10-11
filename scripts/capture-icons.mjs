// Brand icon screenshots: header + pairing gate, and a size showcase.  node scripts/capture-icons.mjs -> .tmp/shots4/
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".tmp", "shots4"); const home = path.join(root, ".tmp", "shots4-home");
const port = 47255, base = `http://127.0.0.1:${port}`;
mkdirSync(out, { recursive: true }); rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "zh", theme: "light", demoMode: false }));
function findChromium() { const c = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright"); for (const d of readdirSync(c).filter((n) => n.startsWith("chromium")).sort().reverse()) for (const r of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"]) { const p = path.join(c, d, r); if (existsSync(p)) return p; } }
const server = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], { cwd: root, stdio: "ignore", env: { ...process.env, HOST: "127.0.0.1", POCKETPILOT_PORT: String(port), POCKETPILOT_HOME: home, POCKETPILOT_STATIC: path.join(root, "apps/web/dist") } });
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: findChromium() }); }
  const mk = async (dark) => { const c = await browser.newContext({ viewport: { width: 390, height: 520 }, deviceScaleFactor: 2 }); return c.newPage(); };
  const a = await mk(); await a.goto(`${base}/settings`, { waitUntil: "networkidle" }); await a.getByTestId("settings").waitFor(); await a.screenshot({ path: path.join(out, "header_paired.png") });
  const b = await mk();
  await b.route("**/api/**", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "pairing required", code: "pair" }) }));
  await b.goto(base, { waitUntil: "networkidle" }); await b.waitForTimeout(800); await b.screenshot({ path: path.join(out, "header_pair_gate.png") });
  // showcase
  const pub = path.join(root, "apps/web/public"), res = path.join(root, "apps/android/android/app/src/main/res"), bd = path.join(root, "apps/desktop/build");
  const png = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  const svg = (f) => `data:image/svg+xml;base64,${readFileSync(f).toString("base64")}`;
  const fav = svg(path.join(pub, "favicon.svg")), dark = svg(path.join(pub, "icon-dark.svg"));
  const cell = (src, w, label, extra = "") => `<div style="text-align:center"><img src="${src}" style="width:${w}px;height:${w}px;image-rendering:auto;${extra}"><div style="font-size:12px;color:#5b6b88;margin-top:6px">${label}</div></div>`;
  const zoom = (src, n, label) => `<div style="text-align:center"><img src="${src}" style="width:${n}px;height:${n}px;image-rendering:pixelated"><div style="font-size:12px;color:#5b6b88;margin-top:6px">${label}</div></div>`;
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;padding:24px;background:#f4f7fb;font-family:system-ui,'Microsoft YaHei'">
   <div style="display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap">
     ${cell(png(path.join(pub, "icons/icon-512.png")), 256, "PWA 512 (shown 256)")}
     ${cell(png(path.join(pub, "icons/icon-192.png")), 192, "PWA 192")}
     ${cell(png(path.join(pub, "icons/icon-maskable-512.png")), 160, "maskable 512 (shown 160)", "border-radius:50%")}
     ${cell(png(path.join(bd, "icon.png")), 128, "desktop icon.png 512 (shown 128)")}
     ${cell(dark, 128, "icon-dark.svg")}
   </div>
   <div style="display:flex;gap:28px;align-items:flex-end;margin-top:26px;flex-wrap:wrap">
     ${cell(png(path.join(res, "mipmap-xxxhdpi/ic_launcher.png")), 96, "Android launcher 192 (shown 96)")}
     ${cell(png(path.join(res, "mipmap-xxxhdpi/ic_launcher_round.png")), 96, "launcher round")}
     <div style="text-align:center"><div style="width:108px;height:108px;background:#2F6FED;border-radius:50%;display:grid;place-items:center;overflow:hidden"><img src="${png(path.join(res, "mipmap-xxxhdpi/ic_launcher_foreground.png"))}" style="width:108px;height:108px"></div><div style="font-size:12px;color:#5b6b88;margin-top:6px">adaptive: fg on #2F6FED, circle mask</div></div>
     <div style="text-align:center"><div style="width:108px;height:108px;background:#2F6FED;border-radius:26px;display:grid;place-items:center;overflow:hidden"><img src="${png(path.join(res, "mipmap-xxxhdpi/ic_launcher_foreground.png"))}" style="width:108px;height:108px"></div><div style="font-size:12px;color:#5b6b88;margin-top:6px">adaptive, squircle mask</div></div>
     <div style="text-align:center"><div style="background:#3b3f46;padding:10px 14px;border-radius:10px"><img src="${png(path.join(res, "drawable-xxxhdpi/ic_stat_pocketpilot.png"))}" style="width:48px;height:48px"></div><div style="font-size:12px;color:#5b6b88;margin-top:6px">notification small icon (white, on dark)</div></div>
   </div>
   <div style="display:flex;gap:28px;align-items:flex-end;margin-top:26px;flex-wrap:wrap">
     ${cell(png(path.join(pub, "icons/icon-192.png")), 48, "48px")}
     ${cell(png(path.join(pub, "icons/icon-192.png")), 32, "32px")}
     ${cell(png(path.join(pub, "icons/icon-192.png")), 24, "24px")}
     <div style="text-align:center"><div style="display:flex;gap:10px;align-items:flex-end"><img src="${png(path.join(bd, "tray-16.png"))}" style="width:16px;height:16px"><img src="${png(path.join(bd, "tray.png"))}" style="width:32px;height:32px"></div><div style="font-size:12px;color:#5b6b88;margin-top:6px">tray 16 / 32 (actual size)</div></div>
     ${zoom(png(path.join(bd, "tray-16.png")), 96, "tray 16 x6")}
     ${zoom(png(path.join(bd, "tray.png")), 128, "tray 32 x4")}
   </div></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0)); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "icon-final.png"), fullPage: true });
  console.log("done");
} finally { await browser?.close(); server.kill(); }
