const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const port = process.env.MOBILEAGENT_PORT || "47241";
let bridge;

function bridgeEntry() {
  if (app.isPackaged) return path.join(process.resourcesPath, "bridge", "server.cjs");
  return path.join(__dirname, "..", "bridge", "dist", "server.cjs");
}

function staticDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "web");
  return path.join(__dirname, "..", "web", "dist");
}

function startBridge() {
  bridge = spawn(process.execPath, [bridgeEntry()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MOBILEAGENT_PORT: port,
      MOBILEAGENT_STATIC: staticDir(),
      HOST: "127.0.0.1",
    },
    stdio: "inherit",
  });
}

function waitForBridge() {
  const url = `http://127.0.0.1:${port}/api/health`;
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry(left);
      });
      req.on("error", () => retry(left));
    };
    const retry = (left) => {
      if (left <= 0) reject(new Error("MobileAgent bridge did not start"));
      else setTimeout(() => attempt(left - 1), 200);
    };
    attempt(50);
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 920,
    minWidth: 360,
    minHeight: 640,
    title: "MobileAgent",
    backgroundColor: "#12110f",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    startBridge();
    await waitForBridge();
    await createWindow();
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on("before-quit", () => {
  bridge?.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});
