import type {
  ChatMessage,
  CommitRecord,
  GitChange,
  McpServer,
  QueueItem,
  Session,
} from "@mobileagent/protocol";

export const SEED_VERSION = 1;

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  language: string;
  summary: string;
  files: WorkspaceFile[];
}

export interface ProjectTemplate {
  id: string;
  providerId: string;
  workspaceId: string;
  branch: string;
  changes: GitChange[];
}

export interface DemoSnapshot {
  seedVersion: number;
  sessions: Session[];
  messages: Record<string, ChatMessage[]>;
  queue: QueueItem[];
  changes: Record<string, GitChange[]>;
  commits: Record<string, CommitRecord[]>;
  mcp: Record<string, McpServer[]>;
}

const harborMiddleware = `import type { Request, Response, NextFunction } from "express";
import { readCookie, verifySession } from "./session.js";

export class SessionError extends Error {
  constructor(readonly code: "missing" | "expired") {
    super(code);
  }
}

export function requireSession(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, "sid");
  if (!token) return next(new SessionError("missing"));
  try {
    req.session = verifySession(token);
    return next();
  } catch {
    return next(new SessionError("expired"));
  }
}
`;

const harborSession = `export interface SessionClaims {
  sub: string;
  exp: number;
}

export function readCookie(req: { headers: { cookie?: string } }, name: string) {
  const raw = req.headers.cookie ?? "";
  const hit = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

export function verifySession(token: string): SessionClaims {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("malformed");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims;
  if (claims.exp * 1000 < Date.now()) throw new Error("expired");
  return claims;
}
`;

const harborTest = `import assert from "node:assert/strict";
import test from "node:test";
import { requireSession, SessionError } from "./middleware.js";

test("missing cookie fails closed", () => {
  const req = { headers: {} };
  requireSession(req as never, {} as never, (err) => {
    assert.ok(err instanceof SessionError);
    assert.equal(err.code, "missing");
  });
});
`;

const harborReconcile = `export interface LedgerRow {
  id: string;
  cents: number;
  source: "bank" | "app";
}

export function explainGap(rows: LedgerRow[]) {
  const bank = rows.filter((row) => row.source === "bank").reduce((sum, row) => sum + row.cents, 0);
  const app = rows.filter((row) => row.source === "app").reduce((sum, row) => sum + row.cents, 0);
  return { bank, app, delta: bank - app };
}
`;

const feedScreen = `export function FeedScreen() {
  return (
    <section className="feed">
      <header>北风</header>
      <ul>{/* rows hydrate after the first paint */}</ul>
    </section>
  );
}
`;

const pipeline = `from dataclasses import dataclass

@dataclass
class Batch:
  name: str
  rows: int

def run_batch(batch: Batch) -> dict:
    if batch.rows < 0:
        raise ValueError("rows must be >= 0")
    return {"name": batch.name, "rows": batch.rows, "ok": True}
`;

const migrate = `"""One-shot reshape of the ingest ledger columns."""

STEPS = (
    "add column received_at timestamp",
    "backfill received_at from filename stamps",
    "drop column imported_on",
)
`;

export const WORKSPACES: Workspace[] = [
  {
    id: "harbor",
    name: "harbor-ledger",
    path: "~/src/harbor-ledger",
    language: "TypeScript",
    summary: "登录态和支付对账",
    files: [
      { path: "package.json", content: '{\n  "name": "harbor-ledger",\n  "private": true,\n  "type": "module"\n}\n' },
      { path: "README.md", content: "# harbor-ledger\n\n支付对账服务。登录态 cookie 与刷新令牌分开处理。\n" },
      { path: "src/auth/session.ts", content: harborSession },
      { path: "src/auth/middleware.ts", content: harborMiddleware },
      { path: "src/auth/session.test.ts", content: harborTest },
      { path: "src/payments/reconcile.ts", content: harborReconcile },
    ],
  },
  {
    id: "northwind",
    name: "northwind-mobile",
    path: "~/src/northwind-mobile",
    language: "TSX",
    summary: "北风信息流客户端",
    files: [
      { path: "package.json", content: '{\n  "name": "northwind-mobile",\n  "private": true\n}\n' },
      { path: "README.md", content: "# northwind-mobile\n\n信息流首屏。列表虚拟化还在调整。\n" },
      { path: "src/screens/Feed.tsx", content: feedScreen },
      { path: "src/screens/Feed.module.css", content: ".feed { padding: 16px; }\n.feed ul { margin: 0; padding: 0; }\n" },
    ],
  },
  {
    id: "atlas",
    name: "atlas-ingest",
    path: "~/src/atlas-ingest",
    language: "Python",
    summary: "入湖批处理",
    files: [
      { path: "pyproject.toml", content: "[project]\nname = \"atlas-ingest\"\nversion = \"0.4.0\"\n" },
      { path: "README.md", content: "# atlas-ingest\n\n按批次把对账文件送进湖里。\n" },
      { path: "atlas/pipeline.py", content: pipeline },
      { path: "atlas/migrate.py", content: migrate },
      { path: "atlas/checks.py", content: "def non_negative(rows: int) -> bool:\n    return rows >= 0\n" },
    ],
  },
];

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: "harbor__cursor", providerId: "cursor", workspaceId: "harbor", branch: "auth/split-session", changes: [
    { path: "src/auth/middleware.ts", status: "M" },
    { path: "src/auth/session.test.ts", status: "A" },
  ] },
  { id: "northwind__cursor", providerId: "cursor", workspaceId: "northwind", branch: "main", changes: [] },
  { id: "harbor__claude-code", providerId: "claude-code", workspaceId: "harbor", branch: "recon/explain-gap", changes: [
    { path: "src/payments/reconcile.ts", status: "M" },
  ] },
  { id: "atlas__claude-code", providerId: "claude-code", workspaceId: "atlas", branch: "docs/pipeline", changes: [] },
  { id: "atlas__codex", providerId: "codex", workspaceId: "atlas", branch: "migrate/received-at", changes: [
    { path: "atlas/pipeline.py", status: "M" },
    { path: "atlas/migrate.py", status: "A" },
  ] },
  { id: "harbor__codex", providerId: "codex", workspaceId: "harbor", branch: "test/payments", changes: [] },
  { id: "northwind__opencode", providerId: "opencode", workspaceId: "northwind", branch: "nav/review", changes: [
    { path: "src/screens/Feed.tsx", status: "M" },
  ] },
  { id: "atlas__opencode", providerId: "opencode", workspaceId: "atlas", branch: "ci/retry", changes: [] },
  { id: "atlas__gemini", providerId: "gemini", workspaceId: "atlas", branch: "notes/latency", changes: [
    { path: "README.md", status: "M" },
  ] },
  { id: "northwind__gemini", providerId: "gemini", workspaceId: "northwind", branch: "release/notes", changes: [] },
  { id: "harbor__deepseek-harness", providerId: "deepseek-harness", workspaceId: "harbor", branch: "plugins/session-tools", changes: [
    { path: "src/auth/session.ts", status: "M" },
  ] },
  { id: "atlas__deepseek-harness", providerId: "deepseek-harness", workspaceId: "atlas", branch: "batch/failed-files", changes: [] },
];

const MCP: Record<string, McpServer[]> = {
  cursor: [
    { id: "notes", name: "filesystem-notes", transport: "stdio", enabled: true },
    { id: "git", name: "git-insight", transport: "http", enabled: true },
  ],
  "claude-code": [
    { id: "docs", name: "docs-search", transport: "http", enabled: true },
    { id: "tickets", name: "ticket-bridge", transport: "stdio", enabled: false },
  ],
  codex: [{ id: "map", name: "repo-map", transport: "stdio", enabled: true }],
  opencode: [{ id: "lint", name: "lint-hints", transport: "stdio", enabled: true }],
  gemini: [{ id: "cache", name: "search-cache", transport: "http", enabled: false }],
  "deepseek-harness": [
    { id: "plugins", name: "cordis-plugins", transport: "stdio", enabled: true },
    { id: "schedule", name: "scheduler", transport: "http", enabled: true },
  ],
};

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function textMessage(id: string, role: "user" | "assistant", text: string, minutes: number, extra: ChatMessage["blocks"] = []): ChatMessage {
  return {
    id,
    role,
    createdAt: ago(minutes),
    blocks: role === "assistant" ? extra.concat([{ type: "text", text }]) : [{ type: "text", text }],
    tokens: role === "assistant" ? { input: 640, output: text.length } : undefined,
  };
}

export function buildSeed(): DemoSnapshot {
  const cursorReply = [
    "先把刷新令牌从鉴权中间件里拆出去。缺失 cookie 和过期签名走不同的 `SessionError`。",
    "",
    "```ts",
    "export function requireSession(req: Request, _res: Response, next: NextFunction) {",
    "  const token = readCookie(req, \"sid\");",
    "  if (!token) return next(new SessionError(\"missing\"));",
    "  try {",
    "    req.session = verifySession(token);",
    "    return next();",
    "  } catch {",
    "    return next(new SessionError(\"expired\"));",
    "  }",
    "}",
    "```",
    "",
    "失败用例已经加在 `src/auth/session.test.ts`，覆盖缺失 cookie。过期签名还在队列里。",
  ].join("\n");

  const messages: Record<string, ChatMessage[]> = {
    ses_cursor_auth: [
      textMessage("ses_cursor_auth_u", "user", "登录态中间件把刷新和鉴权缠在一起了，帮我拆开，并补一个失败用例。", 14),
      {
        id: "ses_cursor_auth_a",
        role: "assistant",
        createdAt: ago(12),
        tokens: { input: 980, output: 420 },
        blocks: [
          { type: "thinking", text: "中间件同时做了 cookie 读取和刷新。先把失败路径分开，再补测试。" },
          { type: "tool", name: "read_file", detail: "src/auth/middleware.ts", status: "done" },
          { type: "tool", name: "apply_patch", detail: "src/auth/session.test.ts", status: "done" },
          { type: "text", text: cursorReply },
        ],
      },
    ],
    ses_cursor_rn: [
      textMessage("ses_cursor_rn_u", "user", "信息流首屏滚动会掉帧，先看 Feed 列表。", 130),
      textMessage("ses_cursor_rn_a", "assistant", "首屏把整表渲染进 DOM 了。先固定行高，再只挂载可视区附近的节点。", 120, [
        { type: "tool", name: "read_file", detail: "src/screens/Feed.tsx", status: "done" },
      ]),
    ],
    ses_claude_recon: [
      textMessage("ses_claude_recon_u", "user", "银行和 App 的总额对不上，帮我解释差额从哪来。", 40),
      textMessage("ses_claude_recon_a", "assistant", "差额来自 `explainGap`：银行入账减去 App 记账。现在还没区分未达账和重复扣款，下一步把这两类分开计。", 32, [
        { type: "thinking", text: "先看对账函数的加减方向，再决定要不要拆未达账。" },
        { type: "tool", name: "read_file", detail: "src/payments/reconcile.ts", status: "done" },
      ]),
    ],
    ses_claude_docs: [
      textMessage("ses_claude_docs_u", "user", "给 atlas 管道补一段能给同事看的说明。", 1500),
      textMessage("ses_claude_docs_a", "assistant", "说明放在 README 顶部：批次名、行数、以及负数行会直接失败。", 1480),
    ],
    ses_codex_migrate: [
      textMessage("ses_codex_migrate_u", "user", "写一个把 imported_on 迁到 received_at 的脚本。", 18),
      textMessage("ses_codex_migrate_a", "assistant", "步骤在 `atlas/migrate.py`：加列、按文件名时间回填、再删旧列。还没对生产库执行。", 8, [
        { type: "tool", name: "apply_patch", detail: "atlas/migrate.py", status: "done" },
      ]),
    ],
    ses_codex_tests: [
      textMessage("ses_codex_tests_u", "user", "给支付差额补一个单测。", 200),
      textMessage("ses_codex_tests_a", "assistant", "单测可以钉住 bank - app。我先不改生产公式。", 190),
    ],
    ses_opencode_review: [
      textMessage("ses_opencode_review_u", "user", "看一眼导航改动，列出会影响首屏的地方。", 28),
      textMessage("ses_opencode_review_a", "assistant", "Feed 仍是同步渲染。导航改动本身不大，风险在首屏列表没有窗口化。", 20, [
        { type: "tool", name: "read_file", detail: "src/screens/Feed.tsx", status: "done" },
      ]),
    ],
    ses_opencode_ci: [
      textMessage("ses_opencode_ci_u", "user", "CI 里 ingest 任务偶发失败，帮我看重试点。", 320),
      textMessage("ses_opencode_ci_a", "assistant", "负数行会抛 ValueError。CI 样本里有一个空批次被记成 -1。", 300),
    ],
    ses_gemini_summary: [
      textMessage("ses_gemini_summary_u", "user", "用几句话说明摄取为什么变慢。", 25),
      textMessage("ses_gemini_summary_a", "assistant", "回填 received_at 会扫全表。慢在回填，不在校验函数。", 15),
    ],
    ses_gemini_notes: [
      textMessage("ses_gemini_notes_u", "user", "把发布说明写成三行。", 400),
      textMessage("ses_gemini_notes_a", "assistant", "1. 首屏仍是整表渲染。2. 行高还没固定。3. 不要在这次发布里改导航结构。", 380),
    ],
    ses_dsh_plugins: [
      textMessage("ses_dsh_plugins_u", "user", "按 DeepSeek Harness 的插件方式，把会话工具拆开。", 10),
      {
        id: "ses_dsh_plugins_a",
        role: "assistant",
        createdAt: ago(6),
        tokens: { input: 1100, output: 360 },
        blocks: [
          { type: "thinking", text: "headless 档案只跑一轮。先看会话读取，再决定哪个工具能单独变成插件。" },
          { type: "tool", name: "shell", detail: "dsh --profile headless", status: "done" },
          { type: "tool", name: "read_file", detail: "src/auth/session.ts", status: "done" },
          { type: "text", text: "这一轮用 DeepSeek Harness 的 headless 档案跑完。会话读取留在核心里，cookie 解析可以收成独立插件，不和校验缠在一起。模型仍以 dsh 配置档为准（示例里是 deepseek-v4-pro）。" },
        ],
      },
    ],
    ses_dsh_batch: [
      textMessage("ses_dsh_batch_u", "user", "批处理遇到坏文件时不要整批停掉。", 50),
      textMessage("ses_dsh_batch_a", "assistant", "现在一行非法就会让整个批次失败。可以改成记录坏文件、继续剩下的行。", 40, [
        { type: "tool", name: "read_file", detail: "atlas/pipeline.py", status: "done" },
      ]),
    ],
  };

  const sessions: Session[] = [
    { id: "ses_cursor_auth", providerId: "cursor", projectId: "harbor__cursor", title: "收紧登录态中间件", status: "idle", updatedAt: ago(12), preview: "失败用例已经加在 session.test.ts", messageCount: 2 },
    { id: "ses_cursor_rn", providerId: "cursor", projectId: "northwind__cursor", title: "信息流滚动掉帧", status: "idle", updatedAt: ago(120), preview: "先固定行高，再窗口化列表", messageCount: 2 },
    { id: "ses_claude_recon", providerId: "claude-code", projectId: "harbor__claude-code", title: "解释对账差额", status: "idle", updatedAt: ago(32), preview: "差额是银行入账减去 App 记账", messageCount: 2 },
    { id: "ses_claude_docs", providerId: "claude-code", projectId: "atlas__claude-code", title: "补管道说明", status: "idle", updatedAt: ago(1480), preview: "说明放在 README 顶部", messageCount: 2 },
    { id: "ses_codex_migrate", providerId: "codex", projectId: "atlas__codex", title: "生成迁移脚本", status: "idle", updatedAt: ago(8), preview: "还没对生产库执行", messageCount: 2 },
    { id: "ses_codex_tests", providerId: "codex", projectId: "harbor__codex", title: "补支付单测", status: "idle", updatedAt: ago(190), preview: "先不改生产公式", messageCount: 2 },
    { id: "ses_opencode_review", providerId: "opencode", projectId: "northwind__opencode", title: "审导航改动", status: "idle", updatedAt: ago(20), preview: "风险在首屏列表没有窗口化", messageCount: 2 },
    { id: "ses_opencode_ci", providerId: "opencode", projectId: "atlas__opencode", title: "CI 失败重试", status: "idle", updatedAt: ago(300), preview: "空批次被记成 -1", messageCount: 2 },
    { id: "ses_gemini_summary", providerId: "gemini", projectId: "atlas__gemini", title: "总结摄取延迟", status: "idle", updatedAt: ago(15), preview: "慢在回填，不在校验", messageCount: 2 },
    { id: "ses_gemini_notes", providerId: "gemini", projectId: "northwind__gemini", title: "缩短发布说明", status: "idle", updatedAt: ago(380), preview: "不要在这次发布里改导航", messageCount: 2 },
    { id: "ses_dsh_plugins", providerId: "deepseek-harness", projectId: "harbor__deepseek-harness", title: "把会话工具拆成插件", status: "idle", updatedAt: ago(6), preview: "cookie 解析可以收成独立插件", messageCount: 2 },
    { id: "ses_dsh_batch", providerId: "deepseek-harness", projectId: "atlas__deepseek-harness", title: "坏文件不要停掉整批", status: "idle", updatedAt: ago(40), preview: "记录坏文件，继续剩下的行", messageCount: 2 },
  ];

  const queue: QueueItem[] = [
    { id: "q_samesite", providerId: "cursor", sessionId: "ses_cursor_auth", projectId: "harbor__cursor", prompt: "把过期签名的用例补进 session.test.ts", status: "waiting", createdAt: ago(4) },
    { id: "q_plugins", providerId: "deepseek-harness", sessionId: "ses_dsh_plugins", projectId: "harbor__deepseek-harness", prompt: "列出还能拆成插件的会话工具", status: "waiting", createdAt: ago(3) },
    { id: "q_dryrun", providerId: "codex", sessionId: "ses_codex_migrate", projectId: "atlas__codex", prompt: "再给迁移脚本写一段 dry-run 说明", status: "done", createdAt: ago(30) },
  ];

  const changes: Record<string, GitChange[]> = {};
  for (const project of PROJECT_TEMPLATES) changes[project.id] = project.changes.map((change) => ({ ...change }));

  return {
    seedVersion: SEED_VERSION,
    sessions,
    messages,
    queue,
    changes,
    commits: {},
    mcp: structuredClone(MCP),
  };
}

export function workspaceById(id: string): Workspace | undefined {
  return WORKSPACES.find((workspace) => workspace.id === id);
}

export function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}
