// Generates docs/api-key-guides/*.md + schematic step diagrams (SVG) and, with --shots, real screenshots of the
// official PUBLIC docs pages (no login, no account data). Run: node scripts/make-guides.mjs [--shots]
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("docs/api-key-guides");
const IMG = path.join(OUT, "images");
mkdirSync(IMG, { recursive: true });
const CHECKED = "2026-10-11";

const G = [
  {
    id: "cursor", name: "Cursor", color: "#1f2937", env: "CURSOR_API_KEY",
    docs: "https://cursor.com/docs/cli/reference/authentication", shotFocus: "API key authentication",
    console: "https://cursor.com/dashboard",
    need: "Cursor CLI（`cursor-agent`）有两种登录方式：**浏览器登录（官方推荐）**——运行 `cursor-agent login`；以及 **API Key**——适合没有浏览器、脚本或自动化场景。PocketPilot 会把你保存的密钥作为环境变量 `CURSOR_API_KEY` 传给 `cursor-agent`。如果你已经用 `cursor-agent login` 登录成功，可以不填密钥。",
    steps: ["用浏览器打开 Cursor Dashboard（https://cursor.com/dashboard）并登录你的 Cursor 账号。", "按官方文档的说法进入 **Dashboard → API Keys**，生成一个 user API key。", "复制生成的密钥（请立刻保存，之后通常无法再次查看完整内容）。", "回到 PocketPilot 桌面程序 → 「平台与密钥」→ Cursor：粘贴（或从文本文件导入）→ 保存 → 测试连接。"],
    flow: ["登录 Cursor Dashboard", "Dashboard → API Keys", "生成并复制密钥", "粘贴到 PocketPilot"],
    cost: "官方 CLI 文档没有为 API Key 单独标价；用量按你的 Cursor 账号/套餐计算。免费或付费额度以 https://cursor.com/pricing 为准。",
    revoke: "回到生成密钥的 Dashboard → API Keys 页面，删除/撤销该密钥（按钮名称以官方当前界面为准），必要时再生成新密钥；然后在 PocketPilot 点「删除」。",
    extra: "命令行等价写法（来自官方文档）：`export CURSOR_API_KEY=你的密钥` 后运行 `agent -p \"…\"`，或 `agent --api-key 你的密钥`（不推荐，密钥会出现在进程列表/历史里）。",
  },
  {
    id: "grok", name: "Grok（xAI）", color: "#111111", env: "XAI_API_KEY",
    docs: "https://docs.x.ai/docs/tutorial", shotFocus: "Step 2: Generate an API key", console: "https://console.x.ai",
    need: "PocketPilot 的 Grok 适配器走 xAI API（`https://api.x.ai/v1`），**需要 `XAI_API_KEY`**，不依赖本机安装 grok 命令行。设置了密钥后该平台即视为可用。",
    steps: ["打开 xAI 控制台 https://console.x.ai 并注册/登录账号。", "按官方快速入门：先给账号充值额度（官方原话：load it with credits）。", "在控制台的 **API Keys** 页面创建一个 API key。", "复制密钥并妥善保存（官方示例用环境变量 `XAI_API_KEY`）。", "回到 PocketPilot →「平台与密钥」→ Grok：粘贴 → 保存 → 测试连接（会请求 `GET https://api.x.ai/v1/models`）。"],
    flow: ["登录 console.x.ai", "充值额度", "API Keys → Create", "复制并粘贴到 PocketPilot"],
    cost: "**付费**：API 按用量从充值额度中扣费，没有额度时请求会被拒绝。价格见官方 Models / Pricing 页面。",
    revoke: "在 console.x.ai 的 API Keys 页面删除该密钥（按钮名称以官方界面为准），再创建新密钥；PocketPilot 里点「删除」清除本地副本。",
    extra: "官方还提供 xAI SDK / OpenAI 兼容接口（base URL `https://api.x.ai/v1`），PocketPilot 用的就是这个兼容接口。",
  },
  {
    id: "claude-code", name: "Claude Code（Anthropic）", color: "#c2410c", env: "ANTHROPIC_API_KEY",
    docs: "https://docs.claude.com/en/docs/claude-code/setup", shotFocus: "Authenticate", console: "https://platform.claude.com/settings/keys",
    need: "官方文档：Claude Code 需要 Pro、Max、Team、Enterprise 或 **Console** 账号，免费的 claude.ai 套餐不包含 Claude Code。最常见的做法是运行 `claude` 并按浏览器提示登录（订阅用户无需 API Key）。如果设置了环境变量 `ANTHROPIC_API_KEY` 并在 Claude Code 询问时确认使用，它会跳过登录提示——这就是 PocketPilot 保存密钥的用途（按量计费的 Console 账号）。",
    steps: ["登录 Anthropic Console（https://platform.claude.com ，原 console.anthropic.com）。", "进入 **Settings → API Keys**（直达 https://platform.claude.com/settings/keys）。", "点击 **Create Key**，起一个便于识别的名字（例如 pocketpilot-pc）。", "复制密钥（通常只在创建时显示一次）。", "回到 PocketPilot →「平台与密钥」→ Claude Code：粘贴 → 保存 → 测试连接。"],
    flow: ["登录 Anthropic Console", "Settings → API Keys", "Create Key 并复制", "粘贴到 PocketPilot"],
    cost: "Console 的 API Key **按 token 付费**（需先绑定付款方式/充值）。若你已订阅 Pro/Max，直接 `claude` 登录即可，不必创建 API Key。",
    revoke: "在 Console 的 API Keys 页面删除或停用该密钥；然后在 PocketPilot 点「删除」。",
    extra: "本指南的步骤来自官方 Claude Code 文档；Console 页面需要登录，**本指南没有登录截取**，界面文字以官方当前版本为准。",
  },
  {
    id: "codex", name: "Codex（OpenAI）", color: "#047857", env: "OPENAI_API_KEY",
    docs: "https://developers.openai.com/codex/auth", shotFocus: "Sign in with an API key", console: "https://platform.openai.com/api-keys",
    need: "官方文档：Codex 支持两种登录——**Sign in with ChatGPT**（订阅，运行 `codex login`）和 **API Key**（按用量计费）。PocketPilot 把保存的密钥作为 `OPENAI_API_KEY` 传给 codex；如果你已经 `codex login` 过，可以不填。",
    steps: ["登录 OpenAI Platform（https://platform.openai.com）。", "打开 API keys 页面（https://platform.openai.com/api-keys）。", "点击 **Create new secret key**，命名后创建。", "立即复制并妥善保存（官方快速入门建议把密钥存放在安全位置）。", "回到 PocketPilot →「平台与密钥」→ Codex：粘贴 → 保存 → 测试连接。"],
    flow: ["登录 OpenAI Platform", "API keys 页面", "Create new secret key", "复制并粘贴到 PocketPilot"],
    cost: "官方文档：API Key 的用量按标准 API 价格从你的 OpenAI Platform 账户计费，不使用 ChatGPT 套餐里的额度。快速入门提到可先做免费测试请求，更高额度需要在 Billing 充值。",
    revoke: "在 API keys 页面删除该密钥；若密钥已泄露，请同时检查 Usage 页面是否有异常调用。然后在 PocketPilot 点「删除」。",
    extra: "官方命令行写法：`printenv OPENAI_API_KEY | codex login --with-api-key`。注意 `~/.codex/auth.json` 同样含登录凭据，要像密码一样保管。",
  },
  {
    id: "gemini", name: "Gemini CLI（Google）", color: "#1d4ed8", env: "GEMINI_API_KEY（或 GOOGLE_API_KEY）",
    docs: "https://ai.google.dev/gemini-api/docs/api-key", shotFocus: "Managing API keys in Google AI Studio", console: "https://aistudio.google.com/apikey",
    need: "Gemini CLI 可用 Google 账号登录，也可用 Gemini API Key。官方文档：客户端库会自动读取环境变量 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`（两者都设置时 `GOOGLE_API_KEY` 优先）。",
    steps: ["打开 Google AI Studio（https://aistudio.google.com）并用 Google 账号登录，接受服务条款。", "新用户会自动得到一个默认 Google Cloud 项目和 API key；已有 Cloud 账号则需要在 Dashboard → Projects 里 **Import projects**。", "打开 Dashboard 的 **API Keys** 页面，点击 **Create API key**（官方：自 2026-05-28 起新建的密钥默认是 auth key）。", "复制密钥。", "回到 PocketPilot →「平台与密钥」→ Gemini：粘贴 → 保存 → 测试连接。"],
    flow: ["登录 Google AI Studio", "Dashboard → API Keys", "Create API key", "复制并粘贴到 PocketPilot"],
    cost: "每个密钥属于一个 Google Cloud 项目，计费与配额按项目计算。免费额度与价格以官方 Pricing 页面为准（本指南不作具体数字承诺）。",
    revoke: "官方泄露应对清单：①创建新密钥 ②更新使用方 ③在 Cloud 控制台禁用/删除泄露的密钥（确认新密钥可用后）④检查账单与用量日志。官方还建议设置账单提醒，并给密钥加 API/IP 限制。",
    extra: "官方安全提示：不要把密钥提交到 Git，也不要写进客户端（网页/手机 App）代码里。",
  },
  {
    id: "opencode", name: "OpenCode", color: "#0f766e", env: "OPENCODE_API_KEY",
    docs: "https://opencode.ai/docs/providers/", shotFocus: "OpenCode Zen", console: "https://opencode.ai/auth",
    need: "OpenCode 自己通过 `/connect` 命令保存各模型提供商的凭据（存放在 `~/.local/share/opencode/auth.json`），你也可以直接使用它的任意提供商。PocketPilot 的密钥栏对应的是 **OpenCode Zen** 的密钥（`OPENCODE_API_KEY`），这是可选项。",
    steps: ["在 OpenCode 里运行 `/connect`，选择 OpenCode Zen，会指向 https://opencode.ai/auth 。", "登录该页面，**添加账单信息**，复制你的 API key（官方原话：Sign in, add your billing details, and copy your API key）。", "回到 PocketPilot →「平台与密钥」→ OpenCode：粘贴 → 保存 → 测试连接。"],
    flow: ["打开 opencode.ai/auth", "登录并添加账单", "复制 API key", "粘贴到 PocketPilot"],
    cost: "OpenCode Zen 需要绑定账单信息（按用量）；OpenCode Go 是低价订阅方案。具体价格以官方为准。",
    revoke: "在 opencode.ai 账户页删除/重置该密钥（以官方界面为准）；OpenCode 自己保存的凭据可在其 `/connect` 流程里重新设置。",
    extra: "若你使用的是别的提供商（Anthropic、OpenAI、DeepSeek 等），请按那些平台的指南获取密钥，再用 `/connect` 交给 OpenCode。",
  },
  {
    id: "deepseek-harness", name: "DeepSeek", color: "#2563eb", env: "DEEPSEEK_API_KEY",
    docs: "https://api-docs.deepseek.com/", shotFocus: "", console: "https://platform.deepseek.com/api_keys",
    need: "DeepSeek API 兼容 OpenAI/Anthropic 格式（base URL `https://api.deepseek.com`）。官方文档在 “Your First API Call” 里说明：先申请 API key。PocketPilot 把密钥作为 `DEEPSEEK_API_KEY` 传给相关工具。",
    steps: ["打开 DeepSeek 开放平台 https://platform.deepseek.com ，注册/登录。", "进入 **API keys** 页面，点击 **Create new API key**（OpenCode 官方文档对该步骤的描述同为 Create new API key）。", "复制密钥并保存。", "回到 PocketPilot →「平台与密钥」→ DeepSeek：粘贴 → 保存 → 测试连接。"],
    flow: ["登录 DeepSeek 平台", "API keys 页面", "Create new API key", "复制并粘贴到 PocketPilot"],
    cost: "按量计费（官方文档提到按模型价格计费，如 Flash 模型按 Flash 价格）；具体单价与是否有赠送额度以官方定价页为准。",
    revoke: "在 API keys 页面删除该密钥（按钮名称以官方界面为准），再创建新的；PocketPilot 里点「删除」。",
    extra: "官方文档还说明可以把 DeepSeek 作为 Claude Code、OpenCode 等工具的后端模型（Agent Integrations Guide）。",
  },
  {
    id: "trae-cn", name: "Trae CN", color: "#dc2626", env: "（无）", noKey: true,
    docs: "https://www.trae.cn/", shotFocus: "", console: "https://www.trae.cn/",
    need: "Trae CN 是桌面 IDE，没有公开的 API Key 机制，PocketPilot 对它**不需要也不保存密钥**。PocketPilot 只以**只读**方式读取本机 `%APPDATA%\\Trae CN` 下的历史会话与项目，用于在手机上查看；对话请在 Trae CN 里进行。",
    steps: ["在电脑上安装并打开 Trae CN，用你的 Trae 账号登录（登录在 IDE 内完成，PocketPilot 不接触账号）。", "正常使用后，PocketPilot 会自动发现 `%APPDATA%\\Trae CN` 里的项目和历史。", "手机端「平台」列表中的 Trae CN 会显示为「仅历史」。"],
    flow: ["安装并登录 Trae CN（IDE 内）", "正常使用产生历史", "PocketPilot 只读发现", "手机上查看历史/项目"],
    cost: "Trae CN 的免费/付费政策由官方决定，请查看 https://www.trae.cn/ 。PocketPilot 本身不收费也不代理其请求。",
    revoke: "无 API Key 可吊销。如需断开，只要不再使用即可；想让 PocketPilot 不再读取，可在设置→隐私里关闭历史记录或卸载桌面程序。",
    extra: "本页没有官方文档截图：官网首页不含获取密钥的步骤，且本指南未对 Trae CN 的内部存储格式做任何官方担保（仅本地只读解析，可能随版本变化）。",
  },
];

function svgFlow(g) {
  const n = g.flow.length, W = 960, H = 280, bw = 190, gap = (W - 60 - n * bw) / (n - 1 || 1);
  const boxes = g.flow.map((t, i) => {
    const x = 30 + i * (bw + gap);
    const words = t.length > 11 ? [t.slice(0, Math.ceil(t.length / 2)), t.slice(Math.ceil(t.length / 2))] : [t];
    const lines = words.map((w, k) => `<text x="${x + bw / 2}" y="${150 + k * 22 - (words.length - 1) * 11}" text-anchor="middle" font-size="17" font-weight="600" fill="#0f172a">${w}</text>`).join("");
    const arrow = i < n - 1 ? `<path d="M${x + bw + 8} 140 H${x + bw + gap - 8}" stroke="#2f6fed" stroke-width="3" marker-end="url(#a)"/>` : "";
    return `<rect x="${x}" y="95" width="${bw}" height="90" rx="16" fill="#fff" stroke="#c9d6f2" stroke-width="2"/><circle cx="${x + 24}" cy="95" r="15" fill="${g.color}"/><text x="${x + 24}" y="101" text-anchor="middle" font-size="15" font-weight="700" fill="#fff">${i + 1}</text>${lines}${arrow}`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Microsoft YaHei UI','PingFang SC','Noto Sans CJK SC',Segoe UI,sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#2f6fed"/></marker></defs>
<rect width="${W}" height="${H}" rx="22" fill="#eef3fd"/>
<text x="30" y="52" font-size="22" font-weight="700" fill="#1e3a8a">${g.name}：获取 API Key 的步骤</text>
<text x="30" y="76" font-size="13" fill="#475569">${g.noKey ? "该平台无需 API Key" : "密钥环境变量：" + g.env}</text>
${boxes}
<text x="${W / 2}" y="250" text-anchor="middle" font-size="14" fill="#b45309">示意图，实际界面以官方为准（未登录截取任何账号页面）</text>
</svg>
`;
}

const shots = process.argv.includes("--shots");
if (shots) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  for (const g of G) {
    if (g.id === "trae-cn") continue;
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      await page.goto(g.docs, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      if (g.shotFocus) {
        try { await page.getByText(g.shotFocus, { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 6000 }); await page.waitForTimeout(600); } catch { /* top of page */ }
      }
      await page.screenshot({ path: path.join(IMG, `${g.id}-docs.png`) });
      await page.close();
      console.log("shot", g.id);
    } catch (error) { console.log("shot failed", g.id, String(error).slice(0, 80)); }
  }
  await browser.close();
}

for (const g of G) {
  writeFileSync(path.join(IMG, `${g.id}-steps.svg`), svgFlow(g));
  const hasShot = existsSync(path.join(IMG, `${g.id}-docs.png`));
  const md = [
    `# ${g.name}：如何获取 API Key`,
    "",
    `> 内容依据官方文档：${g.docs}（查证日期 ${CHECKED}）。官方页面会改版，按钮名称以你看到的官方界面为准。`,
    "",
    "## 先确认：你需要 API Key 吗？",
    "",
    g.need,
    "",
    "## 获取步骤",
    "",
    ...g.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `![示意图：${g.name} 获取密钥流程（示意图，实际界面以官方为准）](images/${g.id}-steps.svg)`,
    "",
    "*上图是示意图（自绘），不是官方界面截图。*",
    "",
    ...(hasShot ? [`![真实截图：官方公开文档页面（无需登录）](images/${g.id}-docs.png)`, "", `*上图是**真实截图**：官方公开文档页面 ${g.docs} （无需登录即可看到，未包含任何账号信息）。*`, ""] : [g.noKey ? "" : `*本页没有官方公开页面的截图；需要登录才能看到的控制台页面不会被截取。*`, ""]),
    "## 免费还是付费",
    "",
    g.cost,
    "",
    "## 保密注意事项",
    "",
    "- 把密钥当作密码：不要发到聊天群、工单、截图，也不要提交到 Git。",
    "- PocketPilot 只把密钥保存在这台电脑的 `~/.pocketpilot` 下（仅当前用户可读），**不会同步到手机、不会写入日志**，界面上只显示最后 4 位。",
    "- 给每台电脑/用途创建独立的密钥，方便单独吊销；有额度/权限限制选项时尽量收紧。",
    "",
    "## 泄露后怎么吊销",
    "",
    g.revoke,
    "",
    ...(g.extra ? ["## 补充", "", g.extra, ""] : []),
    "## 官方链接",
    "",
    `- 官方文档：${g.docs}`,
    `- 控制台/入口：${g.console}`,
    "",
  ].join("\n");
  writeFileSync(path.join(OUT, `${g.id}.md`), md);
}
writeFileSync(path.join(OUT, "README.md"), [
  "# 如何获取各平台的 API Key",
  "",
  "PocketPilot 桌面程序 →「平台与密钥」里每个平台都有「获取密钥指南」按钮，内容与本目录相同。",
  "",
  "| 平台 | 指南 | 需要 API Key？ |",
  "| --- | --- | --- |",
  ...G.map((g) => `| ${g.name} | [${g.id}.md](${g.id}.md) | ${g.noKey ? "不需要（只读历史）" : "可选/按平台而定，见指南"} |`),
  "",
  "图片说明：`*-steps.svg` 均为**示意图**（自绘，未登录截取）；`*-docs.png` 为官方**公开**文档页面的**真实截图**（无需登录）。",
  "",
].join("\n"));
console.log("guides written");
