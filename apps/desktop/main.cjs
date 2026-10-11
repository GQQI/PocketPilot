"use strict";
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, clipboard, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Legacy MOBILEAGENT_* variables still work.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("MOBILEAGENT_") && process.env["POCKETPILOT_" + key.slice(12)] === undefined) process.env["POCKETPILOT_" + key.slice(12)] = value;
}

// Tests/dev can isolate the desktop settings + logs.
if (process.env.POCKETPILOT_DESKTOP_USERDATA) app.setPath("userData", process.env.POCKETPILOT_DESKTOP_USERDATA);

const DEFAULTS = { autoStart: false, closeToTray: true, port: 47241, allowRtc: true, allowLan: true, language: "zh", serviceEnabled: true };
const startHidden = process.argv.includes("--hidden");
const internalToken = crypto.randomBytes(24).toString("hex");

let settings = { ...DEFAULTS };
let win = null;
let tray = null;
let quitting = false;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath("userData"), "desktop-settings.json");

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    settings = { ...DEFAULTS, ...pick(saved) };
  } catch {
    settings = { ...DEFAULTS };
  }
  if (process.env.POCKETPILOT_PORT) settings.port = Number(process.env.POCKETPILOT_PORT) || settings.port;
}

function pick(input) {
  const out = {};
  for (const key of ["autoStart", "closeToTray", "allowRtc", "allowLan", "serviceEnabled"]) if (typeof input[key] === "boolean") out[key] = input[key];
  const port = Number(input.port);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  if (input.language === "zh" || input.language === "en") out.language = input.language;
  return out;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (error) {
    log(`save settings failed: ${error.message}`);
  }
}

function applyLoginItem() {
  try {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: settings.autoStart, args: ["--hidden"] });
  } catch (error) {
    log(`login item: ${error.message}`);
  }
}

// ---------- logging ----------
let logStream = null;
const recent = [];
function logFile() { return path.join(app.getPath("userData"), "logs", "bridge.log"); }
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  recent.push(text);
  if (recent.length > 40) recent.shift();
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true });
      try { if (fs.statSync(logFile()).size > 2 * 1024 * 1024) fs.renameSync(logFile(), logFile() + ".old"); } catch {}
      logStream = fs.createWriteStream(logFile(), { flags: "a" });
    }
    logStream.write(text + os.EOL);
  } catch {}
}

// ---------- bridge supervisor ----------
let child = null;
let wanted = false;
let restartTimer = null;
let lastStartAt = 0;
let failStreak = 0;
let restarts = 0;
let serviceError = "";
let phase = "stopped"; // stopped | starting | running | restarting | error
let lastStatus = null;
let knownDevices = null;

function bridgeEntry() {
  return app.isPackaged ? path.join(process.resourcesPath, "bridge", "server.cjs") : path.join(__dirname, "..", "bridge", "dist", "server.cjs");
}
function staticDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web", "dist");
}

function startBridge() {
  clearTimeout(restartTimer);
  if (child) return;
  wanted = true;
  serviceError = "";
  phase = restarts > 0 ? "restarting" : "starting";
  lastStartAt = Date.now();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    POCKETPILOT_PORT: String(settings.port),
    POCKETPILOT_STATIC: staticDir(),
    HOST: settings.allowLan ? "0.0.0.0" : "127.0.0.1",
    POCKETPILOT_REMOTE: "1",
    POCKETPILOT_RTC: settings.allowRtc ? "1" : "0",
    POCKETPILOT_INTERNAL_TOKEN: internalToken,
    POCKETPILOT_QUIET_PAIRING: "1",
  };
  log(`starting bridge ${bridgeEntry()} port=${settings.port} lan=${settings.allowLan} rtc=${settings.allowRtc}`);
  let proc;
  try {
    proc = spawn(process.execPath, [bridgeEntry()], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    serviceError = error.message;
    phase = "error";
    wanted = false;
    return;
  }
  child = proc;
  proc.stdout.on("data", (d) => log(String(d).trimEnd()));
  proc.stderr.on("data", (d) => log("ERR " + String(d).trimEnd()));
  proc.on("error", (error) => log(`bridge spawn error: ${error.message}`));
  proc.on("exit", (code, signal) => {
    log(`bridge exited code=${code} signal=${signal}`);
    if (child === proc) child = null;
    lastStatus = null;
    if (!wanted) { phase = "stopped"; broadcast(); return; }
    if (Date.now() - lastStartAt < 5000) failStreak += 1; else failStreak = 0;
    if (failStreak >= 5) {
      wanted = false;
      phase = "error";
      serviceError = recent.filter((l) => /EADDRINUSE|ERR /.test(l)).slice(-1)[0] || "bridge keeps exiting";
      broadcast();
      return;
    }
    restarts += 1;
    phase = "restarting";
    const delay = Math.min(1000 * 2 ** Math.min(failStreak, 4), 15000);
    restartTimer = setTimeout(startBridge, delay);
    broadcast();
  });
  broadcast();
}

function stopBridge() {
  wanted = false;
  clearTimeout(restartTimer);
  restarts = 0;
  failStreak = 0;
  const proc = child;
  if (!proc) { phase = "stopped"; lastStatus = null; return Promise.resolve(); }
  return new Promise((resolve) => {
    const done = () => { phase = "stopped"; lastStatus = null; resolve(); };
    proc.once("exit", done);
    try { proc.kill(); } catch { done(); }
    setTimeout(done, 3000);
  });
}

async function restartBridge() {
  await stopBridge();
  startBridge();
}

function bridgeFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: settings.port,
      path: urlPath,
      method,
      timeout: 5000,
      headers: { "x-pocketpilot-internal": internalToken, ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function poll() {
  if (!child) return;
  try {
    const status = await bridgeFetch("GET", "/api/desktop/status");
    lastStatus = status;
    if (phase !== "running") { phase = "running"; if (Date.now() - lastStartAt > 30000) restarts = 0; failStreak = 0; }
    detectPairing(status.devices || []);
  } catch {
    if (phase === "running") phase = "restarting";
    lastStatus = null;
  }
  broadcast();
}

function detectPairing(devices) {
  const ids = new Set(devices.map((d) => d.id));
  if (knownDevices) {
    const added = devices.filter((d) => !knownDevices.has(d.id));
    for (const device of added) send("paired", { name: device.name });
  }
  knownDevices = ids;
}

// ---------- state to renderer ----------
function snapshot() {
  return {
    phase,
    error: serviceError,
    restarts,
    status: lastStatus,
    settings,
    version: app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: process.platform,
    host: os.hostname(),
    logFile: logFile(),
    dataDir: process.env.POCKETPILOT_HOME || path.join(os.homedir(), ".pocketpilot"),
    packaged: app.isPackaged,
  };
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function broadcast() {
  send("state", snapshot());
  refreshTray();
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "PocketPilot 口袋领航",
    icon: iconPath("icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#10151d" : "#f4f6fa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => { if (!startHidden) win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("close", (event) => {
    if (!quitting && settings.closeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => { win = null; });
}

function showWindow(page) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (page) send("goto", page);
}

function iconPath(name) {
  const dir = app.isPackaged ? path.join(process.resourcesPath, "build") : path.join(__dirname, "build");
  return path.join(dir, name);
}

// ---------- tray ----------
const TRAY_TEXT = {
  zh: { show: "显示窗口", hide: "隐藏窗口", qr: "显示二维码", start: "启动服务", stop: "停止服务", quit: "退出 PocketPilot", tip: "PocketPilot 口袋领航" },
  en: { show: "Show window", hide: "Hide window", qr: "Show QR code", start: "Start service", stop: "Stop service", quit: "Quit PocketPilot", tip: "PocketPilot" },
};

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath("tray.png")));
  } catch (error) {
    log(`tray unavailable: ${error.message}`);
    tray = null;
    return;
  }
  tray.on("click", () => (win && win.isVisible() ? win.hide() : showWindow()));
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const t = TRAY_TEXT[settings.language] || TRAY_TEXT.zh;
  const visible = Boolean(win && win.isVisible());
  const on = wanted;
  tray.setToolTip(`${t.tip} · ${phase === "running" ? "●" : "○"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? t.hide : t.show, click: () => (visible ? win.hide() : showWindow()) },
    { label: t.qr, click: () => showWindow("pairing") },
    { type: "separator" },
    { label: on ? t.stop : t.start, click: () => toggleService() },
    { type: "separator" },
    { label: t.quit, click: () => app.quit() },
  ]));
}

async function toggleService(force) {
  const next = typeof force === "boolean" ? force : !wanted;
  settings.serviceEnabled = next;
  saveSettings();
  if (next) { restarts = 0; failStreak = 0; startBridge(); } else await stopBridge();
  broadcast();
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error("forbidden");
    return fn(...args);
  });
}

handle("state:get", () => snapshot());
handle("service:toggle", async (force) => { await toggleService(typeof force === "boolean" ? force : undefined); return snapshot(); });
handle("pairing:new", async () => {
  if (!child || phase !== "running") throw new Error("service-not-running");
  return bridgeFetch("POST", "/api/desktop/pairing", {});
});
handle("clipboard:write", (text) => { clipboard.writeText(String(text)); return true; });
handle("device:revoke", async (id) => {
  const devices = await bridgeFetch("DELETE", `/api/desktop/devices/${encodeURIComponent(String(id))}`);
  knownDevices = new Set(devices.map((d) => d.id));
  await poll();
  return devices;
});
handle("settings:set", async (patch) => {
  const clean = pick(patch || {});
  const before = { ...settings };
  settings = { ...settings, ...clean };
  saveSettings();
  if ("autoStart" in clean) applyLoginItem();
  const needsRestart = ["port", "allowRtc", "allowLan"].some((k) => k in clean && clean[k] !== before[k]);
  if (needsRestart && wanted) await restartBridge();
  broadcast();
  return snapshot();
});
handle("config:get", () => bridgeFetch("GET", "/api/desktop/config"));
handle("config:set", async (patch) => {
  const body = {};
  if (typeof patch.workspacePath === "string") body.workspacePath = patch.workspacePath;
  if (typeof patch.demoMode === "boolean") body.demoMode = patch.demoMode;
  if (patch.secrets && typeof patch.secrets === "object") body.secrets = patch.secrets;
  await bridgeFetch("POST", "/api/desktop/config", body);
  return bridgeFetch("GET", "/api/desktop/config");
});
handle("dialog:folder", async () => {
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
handle("shell:open", async (what) => {
  if (what === "logs") return shell.showItemInFolder(logFile());
  if (what === "data") return shell.openPath(snapshot().dataDir);
  return false;
});

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(() => {
    loadSettings();
    applyLoginItem();
    createWindow();
    createTray();
    if (settings.serviceEnabled) startBridge();
    setInterval(poll, 2000);
    // Right after (re)start poll quickly until the bridge answers.
    const fast = setInterval(() => { if (phase === "running") clearInterval(fast); else poll(); }, 400);
    setTimeout(() => clearInterval(fast), 30000);
    nativeTheme.on("updated", () => send("theme", nativeTheme.shouldUseDarkColors));
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (!tray || !settings.closeToTray) app.quit();
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  wanted = false;
  clearTimeout(restartTimer);
  try { child && child.kill(); } catch {}
});
