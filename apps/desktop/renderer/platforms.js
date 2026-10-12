"use strict";
// "Platforms & keys" page: per-platform API key management (+ in-app key guides).
// The key is typed/pasted/imported here, sent once to the main process -> bridge and stored in ~/.pocketpilot (current user only).
// It is never displayed again (only the last 4 characters), never sent to phones and never logged.
(() => {
  const api = window.pp;
  const $ = (id) => document.getElementById(id);
  const L = {
    zh: {
      title: "平台与登录", hint: "优先使用各平台命令行自己的登录。API Key 只是备用，已登录时不会传给子进程。密钥只保存在这台电脑。",
      none: "未配置", set: (l4) => `已配置 ****${l4}`, noKey: "无需 API Key（使用该应用自己的登录）",
      loggedIn: "已登录", loggedOut: "未登录", backupOn: "备用密钥", login: "登录", loginStarted: (cmd) => `已打开终端：${cmd}`,
      backup: "备用密钥（可选）", keyOnly: "这个平台没有可登录的命令行，所以需要密钥。", loginHint: "在电脑上运行",
      ph: "粘贴或输入 API Key", paste: "粘贴", file: "从文件导入", save: "保存", test: "测试连接", del: "删除", guide: "获取密钥指南",
      testing: "测试中…", saved: "已保存", deleted: "已删除", imported: "已从文件导入并保存", badFile: "文件里没有找到密钥（支持单行密钥或 NAME=密钥）", empty: "剪贴板里没有文字",
      confirmDel: "再点一次确认删除", back: "关闭", loadFail: "无法读取平台列表（服务未运行？）", envNote: "也可通过系统环境变量：", ready: "可用", needInstall: "未安装", history: "仅历史",
    },
    en: {
      title: "Platforms & sign-in", hint: "Each platform uses its own CLI login first. An API key is only a backup and is not passed to the process while you are signed in. Keys stay on this PC.",
      none: "Not set", set: (l4) => `Configured ****${l4}`, noKey: "No API key needed (uses the app's own sign-in)",
      loggedIn: "Signed in", loggedOut: "Not signed in", backupOn: "Backup key", login: "Sign in", loginStarted: (cmd) => `Opened a terminal: ${cmd}`,
      backup: "Backup key (optional)", keyOnly: "This platform has no CLI login, so a key is required.", loginHint: "On this PC run",
      ph: "Paste or type an API key", paste: "Paste", file: "Import from file", save: "Save", test: "Test connection", del: "Delete", guide: "How to get a key",
      testing: "Testing…", saved: "Saved", deleted: "Deleted", imported: "Imported from file and saved", badFile: "No key found in that file (a single key or NAME=key)", empty: "Clipboard has no text",
      confirmDel: "Click again to delete", back: "Close", loadFail: "Cannot load platforms (service not running?)", envNote: "Or via environment variable: ", ready: "ready", needInstall: "not installed", history: "history only",
    },
  };
  const tr = (k, ...a) => { const v = L[document.documentElement.lang === "en" ? "en" : "zh"][k]; return typeof v === "function" ? v(...a) : v; };
  const GUIDES = new Set(["cursor", "grok", "claude-code", "codex", "gemini", "opencode", "deepseek-harness", "trae-cn"]);
  let providers = [];
  let delArm = null;
  const results = new Map();

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function toastMsg(text, ok) { if (window.ppToast) window.ppToast(text, ok); }

  async function call(channel, ...args) {
    try { return await api.invoke(channel, ...args); }
    catch (e) { toastMsg(String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), false); return null; }
  }

  async function load() {
    const cfg = await call("platforms:list");
    if (!cfg) { $("platList").replaceChildren(el("p", "muted", tr("loadFail"))); return; }
    providers = cfg.providers || [];
    render();
  }

  function render() {
    $("platTitle").textContent = tr("title");
    $("platHint").textContent = tr("hint");
    const list = $("platList");
    list.replaceChildren();
    for (const p of providers) list.append(card(p));
  }

  function card(p) {
    const needsKey = Array.isArray(p.envKeys) && p.envKeys.length > 0;
    const loginCommand = p.auth && p.auth.loginCommand ? p.auth.loginCommand : "";
    const signedIn = p.auth && p.auth.state === "ok" && p.auth.source === "login";
    const c = el("article", "card plat");
    const head = el("div", "plat-head");
    const badge = el("span", "plat-badge", (p.name || p.id).slice(0, 1).toUpperCase());
    head.append(badge);
    const names = el("div", "plat-names");
    names.append(el("div", "plat-name", p.name || p.id));
    const sub = signedIn ? tr("loggedIn") : loginCommand ? tr("loggedOut") : (needsKey ? p.envKeys.join(" / ") : tr("noKey"));
    names.append(el("div", "muted small", sub));
    head.append(names);
    const stateLabel = signedIn ? tr("loggedIn") : (p.auth && p.auth.state === "ok" && p.keyLast4 ? tr("backupOn") : (needsKey && p.keyLast4 ? tr("set", p.keyLast4) : (loginCommand ? tr("loggedOut") : (needsKey ? tr("none") : "—"))));
    const state = el("span", "plat-state" + (signedIn || p.keyLast4 ? " ok" : ""), stateLabel);
    state.dataset.testid = "state-" + p.id;
    head.append(state);
    c.append(head);

    if (p.auth && p.auth.note) c.append(el("p", "muted small", p.auth.note));
    if (loginCommand && !signedIn) c.append(el("p", "muted small", tr("loginHint") + " " + loginCommand + (p.id === "claude-code" ? "  (/login)" : "")));

    if (needsKey) {
      const box = loginCommand ? el("details", "plat-backup") : el("div");
      if (loginCommand) box.append(el("summary", "muted small", tr("backup")));
      else box.append(el("p", "muted small", tr("keyOnly")));
      const row = el("div", "inline plat-row");
      const input = el("input"); input.type = "password"; input.placeholder = tr("ph"); input.autocomplete = "off"; input.spellcheck = false; input.id = "key-" + p.id;
      row.append(input);
      const bPaste = el("button", "btn", tr("paste"));
      bPaste.addEventListener("click", async () => { const t = await call("clipboard:read"); if (t) input.value = t; else if (t !== null) toastMsg(tr("empty"), false); });
      const bFile = el("button", "btn", tr("file"));
      bFile.addEventListener("click", async () => {
        const r = await call("platforms:import", p.id);
        if (r && !r.canceled) { providers = r.config.providers; toastMsg(tr("imported"), true); render(); }
      });
      const bSave = el("button", "btn primary", tr("save"));
      bSave.addEventListener("click", async () => {
        const v = input.value.trim();
        if (!v) return;
        const cfg = await call("platforms:save", p.id, v);
        input.value = "";
        if (cfg) { providers = cfg.providers; toastMsg(tr("saved"), true); render(); }
      });
      row.append(bPaste, bFile, bSave);
      box.append(row);
      c.append(box);
    }

    const actions = el("div", "inline plat-row");
    if (needsKey) {
      const bTest = el("button", "btn", tr("test"));
      bTest.id = "test-" + p.id;
      bTest.addEventListener("click", async () => {
        bTest.disabled = true; bTest.textContent = tr("testing");
        const r = await call("platforms:test", p.id);
        bTest.disabled = false; bTest.textContent = tr("test");
        if (r) { results.set(p.id, r); render(); }
      });
      const bDel = el("button", "btn danger", delArm === p.id ? tr("confirmDel") : tr("del"));
      bDel.disabled = !p.keyLast4;
      bDel.addEventListener("click", async () => {
        if (delArm !== p.id) { delArm = p.id; render(); setTimeout(() => { if (delArm === p.id) { delArm = null; render(); } }, 3000); return; }
        delArm = null;
        const cfg = await call("platforms:save", p.id, "");
        if (cfg) { providers = cfg.providers; results.delete(p.id); toastMsg(tr("deleted"), true); render(); }
      });
      actions.append(bTest, bDel);
    }
    if (loginCommand) {
      const bLogin = el("button", "btn primary", tr("login"));
      bLogin.addEventListener("click", async () => {
        const r = await call("platforms:login", loginCommand);
        if (r && r.ok) toastMsg(tr("loginStarted", loginCommand), true);
      });
      actions.append(bLogin);
    }
    if (GUIDES.has(p.id)) {
      const bGuide = el("button", "btn link", tr("guide"));
      bGuide.id = "guide-" + p.id;
      bGuide.addEventListener("click", () => openGuide(p.id, p.name));
      actions.append(bGuide);
    }
    c.append(actions);
    const r = results.get(p.id);
    if (r) { const m = el("p", "plat-result " + (r.ok ? "ok" : "bad"), r.message); m.dataset.testid = "result-" + p.id; c.append(m); }
    return c;
  }

  // ---------- guide viewer (markdown -> DOM, no innerHTML) ----------
  function inline(text, parent) {
    const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      if (m[2] !== undefined) {
        if (/^data:image\/(png|jpeg|svg\+xml);base64,/.test(m[2])) { const img = el("img", "guide-img"); img.src = m[2]; img.alt = m[1]; parent.append(img); }
      } else if (m[4]) {
        const a = el("a", "guide-link", m[3]); a.href = "#"; a.addEventListener("click", (ev) => { ev.preventDefault(); void call("shell:url", m[4]); }); parent.append(a);
      } else if (m[5] !== undefined) parent.append(el("code", "", m[5]));
      else if (m[6] !== undefined) parent.append(el("strong", "", m[6]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function renderMd(md) {
    const root = el("div", "guide-body");
    const lines = md.replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; root.append(el("pre", "", buf.join("\n"))); continue; }
      let m = /^(#{1,3})\s+(.*)$/.exec(line);
      if (m) { const h = el("h" + (m[1].length + 1)); inline(m[2], h); root.append(h); i++; continue; }
      if (/^>\s?/.test(line)) { const bq = el("blockquote"); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); inline(buf.join(" "), bq); root.append(bq); continue; }
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line); const list = el(ordered ? "ol" : "ul");
        while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) { const li = el("li"); inline(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""), li); list.append(li); i++; }
        root.append(list); continue;
      }
      if (/^\|.*\|\s*$/.test(line)) {
        const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const table = el("table"); rows.filter((r) => !/^\|[\s:|-]+\|\s*$/.test(r)).forEach((r, idx) => { const tr_ = el("tr"); r.replace(/^\||\|\s*$/g, "").split("|").forEach((cell) => { const td = el(idx === 0 ? "th" : "td"); inline(cell.trim(), td); tr_.append(td); }); table.append(tr_); });
        root.append(table); continue;
      }
      if (/^---+\s*$/.test(line)) { root.append(el("hr")); i++; continue; }
      if (line.trim() === "") { i++; continue; }
      const p = el("p"); const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\||---)/.test(lines[i])) buf.push(lines[i++]);
      inline(buf.join(" "), p); root.append(p);
    }
    return root;
  }

  async function openGuide(id, name) {
    const r = await call("guide:get", id);
    if (!r) return;
    const modal = $("guideModal");
    $("guideTitle").textContent = name + " · " + tr("guide");
    $("guideBody").replaceChildren(renderMd(r.md));
    $("guideBody").scrollTop = 0;
    $("guideClose").textContent = tr("back");
    modal.hidden = false;
  }
  $("guideClose").addEventListener("click", () => { $("guideModal").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("guideModal").hidden = true; });

  window.ppPlatforms = { load, openGuide };
})();
