"use strict";
const $ = (id) => document.getElementById(id);
const api = window.pp;

const I18N = {
  zh: {
    brandSub: "口袋领航 · 电脑端", tabHome: "主页", tabSettings: "设置",
    statusTitle: "服务状态", lanAddr: "局域网地址", rtcState: "跨网络通道",
    devicesTitle: "已配对设备", pairTitle: "手机配对", pairHint: "打开手机端 PocketPilot，扫描二维码连接",
    pairCode: "配对码", copyLink: "复制链接", refreshQr: "刷新二维码",
    grpGeneral: "通用", autoStart: "开机自启", autoStartHint: "登录 Windows 后自动在托盘中运行",
    closeToTray: "关闭窗口时最小化到托盘", closeToTrayHint: "服务保持运行，可从托盘退出", language: "语言",
    grpNetwork: "网络", port: "服务端口", portHint: "修改后会自动重启服务",
    allowLan: "允许局域网访问", allowLanHint: "同一 Wi-Fi 下的手机可直接连接；关闭后仅本机",
    allowRtc: "允许跨网络（RTC）", allowRtcHint: "通过加密 WebRTC 通道在外网连接，二维码需要此功能",
    grpAgent: "代理", workspace: "工作目录", browse: "选择…", save: "保存", clear: "清除",
    demoMode: "演示模式", demoModeHint: "使用模拟数据，不调用真实命令行代理", apiKeys: "代理密钥",
    grpAbout: "关于", version: "版本", dataDir: "数据目录", logs: "服务日志", open: "打开",
    aboutText: "PocketPilot（口袋领航）让手机成为电脑上编码代理的遥控器。对外连接始终需要配对认证。",
    running: "服务运行中", stopped: "服务已停止", starting: "正在启动…", restarting: "服务异常，正在自动重启…", error: "服务启动失败",
    runningSub: "手机可以连接这台电脑", stoppedSub: "打开开关以允许手机连接", port_: "端口",
    lanOff: "已关闭（仅本机）", rtcOff: "已关闭", rtcOn: (m, t, c) => `信令 ${m}/${t} 已连接 · ${c} 个活跃连接`, rtcWaiting: "正在连接信令服务器…",
    noDevices: "还没有配对设备，用手机扫描右侧二维码即可添加", devCount: (n) => `${n} 台`,
    online: "刚刚在线", ago: (s) => { const m = Math.floor(s / 60); if (m < 1) return "刚刚在线"; if (m < 60) return `${m} 分钟前在线`; const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前在线`; return `${Math.floor(h / 24)} 天前在线`; },
    revoke: "撤销", confirmRevoke: "确认撤销？",
    qrStopped: "启动服务后生成二维码", qrRtcOff: "跨网络已关闭\n请在设置中开启，或在手机端输入下方地址和配对码", qrLoading: "正在生成…", qrFailed: "生成失败，请点击刷新",
    countdown: (t) => `二维码有效期 ${t}`, countdownNone: "—", lanHint: (u) => `局域网地址 ${u}`,
    copied: "已复制链接", copiedCode: "已复制", paired: (n) => `配对成功：${n}`, revoked: "已撤销", saved: "已保存", restartedSvc: "服务已重启",
    keyFor: (s) => `当前密钥来源：${s}`, keyNone: "未设置", failed: "操作失败",
  },
  en: {
    brandSub: "Desktop host", tabHome: "Home", tabSettings: "Settings",
    statusTitle: "Service", lanAddr: "LAN address", rtcState: "Remote channel",
    devicesTitle: "Paired devices", pairTitle: "Pair a phone", pairHint: "Open PocketPilot on your phone and scan the QR code",
    pairCode: "Pairing code", copyLink: "Copy link", refreshQr: "Refresh QR",
    grpGeneral: "General", autoStart: "Launch at login", autoStartHint: "Run in the tray after you sign in to Windows",
    closeToTray: "Minimize to tray on close", closeToTrayHint: "The service keeps running; quit from the tray", language: "Language",
    grpNetwork: "Network", port: "Service port", portHint: "The service restarts when changed",
    allowLan: "Allow LAN access", allowLanHint: "Phones on the same Wi-Fi can connect directly; off = this PC only",
    allowRtc: "Allow remote (RTC)", allowRtcHint: "Encrypted WebRTC channel over the internet; required for the QR code",
    grpAgent: "Agents", workspace: "Workspace folder", browse: "Browse…", save: "Save", clear: "Clear",
    demoMode: "Demo mode", demoModeHint: "Use simulated data instead of real CLI agents", apiKeys: "Agent API keys",
    grpAbout: "About", version: "Version", dataDir: "Data folder", logs: "Service log", open: "Open",
    aboutText: "PocketPilot turns your phone into a remote control for coding agents on this PC. Every outside connection must be paired.",
    running: "Service running", stopped: "Service stopped", starting: "Starting…", restarting: "Service crashed, restarting…", error: "Service failed to start",
    runningSub: "Phones can connect to this PC", stoppedSub: "Turn on the switch to accept phones", port_: "Port",
    lanOff: "Off (this PC only)", rtcOff: "Off", rtcOn: (m, t, c) => `Signaling ${m}/${t} up · ${c} active connections`, rtcWaiting: "Connecting to signaling servers…",
    noDevices: "No paired devices yet. Scan the QR code with your phone.", devCount: (n) => `${n}`,
    online: "Online just now", ago: (s) => { const m = Math.floor(s / 60); if (m < 1) return "Online just now"; if (m < 60) return `${m} min ago`; const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`; return `${Math.floor(h / 24)} d ago`; },
    revoke: "Revoke", confirmRevoke: "Confirm?",
    qrStopped: "Start the service to get a QR code", qrRtcOff: "Remote is off\nTurn it on in Settings, or enter the address and code below on the phone", qrLoading: "Generating…", qrFailed: "Failed, click refresh",
    countdown: (t) => `QR valid for ${t}`, countdownNone: "—", lanHint: (u) => `LAN address ${u}`,
    copied: "Link copied", copiedCode: "Copied", paired: (n) => `Paired: ${n}`, revoked: "Revoked", saved: "Saved", restartedSvc: "Service restarted",
    keyFor: (s) => `Key source: ${s}`, keyNone: "not set", failed: "Failed",
  },
};

let state = null;
let lang = "zh";
let session = null; // { url, qrSvg, expiresAt, code }
let sessionStartedAt = 0;
let sessionLoading = false;
let lastAttempt = 0;
let config = null;
let revokeArm = null;
let toastTimer = null;
const t = (key, ...args) => { const v = (I18N[lang] || I18N.zh)[key]; return typeof v === "function" ? v(...args) : v; };

function toast(text, ok) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (ok ? " ok" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

window.ppToast = (text, ok) => toast(text, ok);

function applyLang(next) {
  lang = next === "en" ? "en" : "zh";
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const v = I18N[lang][el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  }
}

// ---------- tabs ----------
function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
  $("page-home").hidden = name !== "home";
  $("page-settings").hidden = name !== "settings";
  if ($("page-platforms")) $("page-platforms").hidden = name !== "platforms";
  if (name === "platforms" && window.ppPlatforms) window.ppPlatforms.load();
  if (name === "settings") loadConfig();
}
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showTab(tab.dataset.tab));

// ---------- render ----------
function render() {
  if (!state) return;
  if (state.settings.language !== lang) applyLang(state.settings.language);
  const { phase, status, settings } = state;
  const running = phase === "running";
  const cls = running ? "ok" : phase === "stopped" ? "" : phase === "error" ? "bad" : "warn";
  const label = t(phase);
  $("stateDot").className = "dot lg " + cls;
  $("topPill").querySelector(".dot").className = "dot " + cls;
  $("topPillText").textContent = label;
  $("stateText").textContent = label;
  $("stateSub").textContent = running ? `${t("runningSub")} · ${t("port_")} ${status ? status.port : settings.port}` : phase === "stopped" ? t("stoppedSub") : state.error || "";
  const sw = $("serviceSwitch");
  sw.checked = phase !== "stopped" && phase !== "error";
  sw.disabled = false;

  $("lanAddr").textContent = !settings.allowLan ? t("lanOff") : status && status.urls.length ? [status.lanUrl, ...status.urls.filter((u) => u !== status.lanUrl)].slice(0, 3).join("\n") : `0.0.0.0:${settings.port}`;
  $("lanAddr").style.whiteSpace = "pre-line";
  let rtc = t("rtcOff");
  if (settings.allowRtc) {
    const r = status && status.rtc;
    rtc = !running ? "—" : r && r.mqttConnected > 0 ? t("rtcOn", r.mqttConnected, r.mqttTotal, r.connections) : t("rtcWaiting");
  }
  $("rtcState").textContent = rtc;

  renderDevices(status ? status.devices : []);
  renderPairing();

  $("setAutoStart").checked = settings.autoStart;
  $("setCloseToTray").checked = settings.closeToTray;
  $("setAllowLan").checked = settings.allowLan;
  $("setAllowRtc").checked = settings.allowRtc;
  $("setLanguage").value = settings.language;
  if (document.activeElement !== $("setPort")) $("setPort").value = settings.port;
  $("aboutVersion").textContent = `PocketPilot ${state.version}`;
  $("aboutRuntime").textContent = `${state.versions.electron} / ${state.versions.node}`;
}

function renderDevices(devices) {
  const list = $("deviceList");
  $("deviceCount").textContent = devices.length ? t("devCount", devices.length) : "";
  list.textContent = "";
  if (!devices.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("noDevices");
    list.appendChild(li);
    return;
  }
  for (const d of devices) {
    const li = document.createElement("li");
    const ico = Object.assign(document.createElement("div"), { className: "ico", textContent: "📱" });
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(Object.assign(document.createElement("div"), { className: "name", textContent: d.name }));
    meta.append(Object.assign(document.createElement("div"), { className: "muted", textContent: t("ago", Math.max(0, (Date.now() - d.lastSeen) / 1000)) }));
    const btn = document.createElement("button");
    btn.className = "btn danger";
    btn.dataset.id = d.id;
    btn.textContent = revokeArm === d.id ? t("confirmRevoke") : t("revoke");
    btn.addEventListener("click", async () => {
      if (revokeArm !== d.id) { revokeArm = d.id; setTimeout(() => { if (revokeArm === d.id) { revokeArm = null; render(); } }, 3500); render(); return; }
      revokeArm = null;
      try { await api.invoke("device:revoke", d.id); toast(t("revoked"), true); } catch (e) { toast(t("failed") + ": " + e.message); }
    });
    li.append(ico, meta, btn);
    list.appendChild(li);
  }
}

// ---------- pairing ----------
function fmt(sec) { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }

function renderPairing() {
  const running = state.phase === "running";
  const code = state.status ? state.status.code : session && session.code;
  $("pairCode").textContent = running && code ? code : "——————";
  const img = $("qrImg"), empty = $("qrEmpty"), box = $("qrBox");
  if (running && session && session.qrSvg) {
    img.src = "data:image/svg+xml;utf8," + encodeURIComponent(session.qrSvg);
    img.hidden = false; empty.textContent = ""; box.classList.remove("dim");
  } else {
    img.hidden = true; box.classList.remove("dim");
    empty.textContent = !running ? t("qrStopped") : !state.settings.allowRtc ? t("qrRtcOff") + (state.status ? "\n" + t("lanHint", state.status.lanUrl) : "") : sessionLoading ? t("qrLoading") : t("qrFailed");
    empty.style.whiteSpace = "pre-line";
  }
  $("refreshQr").disabled = !running || !state.settings.allowRtc;
  $("copyLink").disabled = !(running && session && session.url);
  tickCountdown();
}

function tickCountdown() {
  if (!state) return;
  const running = state.phase === "running";
  if (!(running && session && session.expiresAt)) { $("countdownText").textContent = t("countdownNone"); $("barFill").style.width = "0%"; return; }
  const left = (session.expiresAt - Date.now()) / 1000;
  const total = Math.max(1, (session.expiresAt - sessionStartedAt) / 1000);
  $("countdownText").textContent = t("countdown", fmt(left));
  $("barFill").style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  if (left <= 0) newSession();
}

async function newSession() {
  if (sessionLoading || !state || state.phase !== "running" || !state.settings.allowRtc) return;
  sessionLoading = true;
  lastAttempt = Date.now();
  renderPairing();
  try {
    const s = await api.invoke("pairing:new");
    session = s && s.rtc ? s : null;
    sessionStartedAt = Date.now();
  } catch {
    session = null;
  } finally {
    sessionLoading = false;
    renderPairing();
  }
}

$("refreshQr").addEventListener("click", newSession);
$("copyLink").addEventListener("click", async () => { if (session && session.url) { await api.invoke("clipboard:write", session.url); toast(t("copied"), true); } });
$("pairCode").addEventListener("click", async () => { const c = $("pairCode").textContent; if (/^[A-Z0-9]{6}$/i.test(c)) { await api.invoke("clipboard:write", c); toast(t("copiedCode"), true); } });

// ---------- service + settings ----------
$("serviceSwitch").addEventListener("change", async (e) => {
  e.target.disabled = true;
  if (!e.target.checked) session = null;
  try { await api.invoke("service:toggle", e.target.checked); } catch (err) { toast(t("failed") + ": " + err.message); }
});
async function setSetting(patch, okText) {
  try { state = await api.invoke("settings:set", patch); render(); if (okText) toast(okText, true); } catch (e) { toast(t("failed") + ": " + e.message); }
}
$("setAutoStart").addEventListener("change", (e) => setSetting({ autoStart: e.target.checked }));
$("setCloseToTray").addEventListener("change", (e) => setSetting({ closeToTray: e.target.checked }));
$("setLanguage").addEventListener("change", (e) => setSetting({ language: e.target.value }));
$("setAllowLan").addEventListener("change", (e) => { session = null; setSetting({ allowLan: e.target.checked }, t("restartedSvc")); });
$("setAllowRtc").addEventListener("change", (e) => { session = null; setSetting({ allowRtc: e.target.checked }, t("restartedSvc")); });
const commitPort = () => { const v = Number($("setPort").value); if (Number.isInteger(v) && v >= 1024 && v <= 65535 && v !== state.settings.port) { session = null; setSetting({ port: v }, t("restartedSvc")); } else $("setPort").value = state.settings.port; };
$("setPort").addEventListener("change", commitPort);
$("setPort").addEventListener("keydown", (e) => { if (e.key === "Enter") $("setPort").blur(); });

async function loadConfig() {
  if (!state || state.phase !== "running") return;
  try {
    config = await api.invoke("config:get");
    if (document.activeElement !== $("setWorkspace")) $("setWorkspace").value = config.workspacePath || "";
    $("setDemo").checked = config.demoMode;
    const sel = $("keyProvider"), prev = sel.value;
    sel.textContent = "";
    for (const p of config.providers) sel.appendChild(Object.assign(document.createElement("option"), { value: p.id, textContent: p.name }));
    if (prev) sel.value = prev;
    showKeyHint();
  } catch { /* service not ready */ }
}
function showKeyHint() {
  const p = config && config.providers.find((x) => x.id === $("keyProvider").value);
  $("keyHint").textContent = p ? t("keyFor", p.keySource === "none" || !p.keySource ? t("keyNone") : p.keySource) : "";
}
$("keyProvider").addEventListener("change", showKeyHint);
async function saveConfig(patch) {
  try { config = await api.invoke("config:set", patch); toast(t("saved"), true); await loadConfig(); } catch (e) { toast(t("failed") + ": " + e.message); }
}
$("saveWorkspace").addEventListener("click", () => saveConfig({ workspacePath: $("setWorkspace").value }));
$("pickWorkspace").addEventListener("click", async () => { const dir = await api.invoke("dialog:folder"); if (dir) { $("setWorkspace").value = dir; saveConfig({ workspacePath: dir }); } });
$("setDemo").addEventListener("change", (e) => saveConfig({ demoMode: e.target.checked }));
$("saveKey").addEventListener("click", async () => { const v = $("keyValue").value.trim(); if (!v) return; await saveConfig({ secrets: { [$("keyProvider").value]: v } }); $("keyValue").value = ""; });
$("clearKey").addEventListener("click", () => saveConfig({ secrets: { [$("keyProvider").value]: "" } }));
$("openData").addEventListener("click", () => api.invoke("shell:open", "data"));
$("openLogs").addEventListener("click", () => api.invoke("shell:open", "logs"));

// ---------- wiring ----------
function onState(next) {
  const wasRunning = state && state.phase === "running";
  state = next;
  if (next.phase !== "running") session = null;
  render();
  if (next.phase === "running" && (!wasRunning || (!session && !sessionLoading && Date.now() - lastAttempt > 2500 && next.settings.allowRtc && next.status && next.status.rtc && next.status.rtc.enabled))) newSession();
}
api.on("state", onState);
api.on("paired", (d) => { toast(t("paired", d.name), true); session = null; newSession(); });
api.on("goto", (page) => { showTab("home"); if (page === "pairing") $("pairCard").scrollIntoView({ block: "center" }); });
setInterval(tickCountdown, 1000);
api.invoke("state:get").then((s) => { applyLang(s.settings.language); onState(s); });
