import { createHub, HubError, resolveInside } from "@mobileagent/agent-core";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

const hub = createHub();
const app = new Hono();
const staticDir = process.env.MOBILEAGENT_STATIC;
const port = Number(process.env.MOBILEAGENT_PORT ?? 47232);
const hostname = process.env.HOST ?? "127.0.0.1";

app.onError((error, c) => {
  if (error instanceof HubError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

app.use("*", cors({
  origin: (origin) => origin || "*",
  allowHeaders: ["authorization", "content-type"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
}));

app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const loopback = isLoopback(c);
  const pathname = new URL(c.req.url).pathname;
  const open = pathname === "/api/health" || pathname === "/api/host" || pathname === "/api/pair";
  if (!open && !loopback && !hub.tokenMatches(c.req.header("authorization"))) {
    return c.json({ error: "pairing required", code: "pair" }, 401);
  }
  await next();
});

app.get("/api/bootstrap", (c) => c.json(hub.bootstrap()));
app.get("/api/health", (c) => c.json({ ok: true, demoMode: hub.bootstrap().settings.demoMode }));
app.get("/api/host", (c) => c.json(hub.hostInfo({
  loopback: isLoopback(c),
  authorized: hub.tokenMatches(c.req.header("authorization")),
  port,
  urls: phoneUrls(port, Boolean(staticDir)),
})));
app.post("/api/pair", async (c) => {
  const body = await c.req.json().catch(() => ({ code: "" }));
  const token = hub.pair(String(body.code ?? ""));
  return c.json({
    token,
    host: hub.hostInfo({
      loopback: isLoopback(c),
      authorized: true,
      port,
      urls: phoneUrls(port, Boolean(staticDir)),
    }),
  });
});
app.get("/api/fs", (c) => c.json(hub.listDirs(c.req.query("path") ?? "")));

app.post("/api/settings", async (c) => c.json(hub.updateSettings(await c.req.json())));
app.post("/api/providers/:id/secret", async (c) => {
  const body = await c.req.json().catch(() => ({ apiKey: "" }));
  return c.json(hub.setSecret(c.req.param("id"), String(body.apiKey ?? "")));
});
app.delete("/api/providers/:id/secret", (c) => c.json(hub.clearSecret(c.req.param("id"))));
app.post("/api/providers/:id/probe", async (c) => {
  await hub.probe(c.req.param("id"));
  return c.json(hub.bootstrap());
});
app.post("/api/probe", async (c) => c.json(await hub.probeAll()));
app.post("/api/demo/reset", (c) => c.json(hub.resetDemo()));

app.post("/api/sessions", async (c) => {
  const body = await c.req.json();
  return c.json(hub.createSession(String(body.providerId ?? ""), String(body.projectId ?? ""), body.title ? String(body.title) : undefined));
});
app.get("/api/sessions/:id/messages", (c) => c.json(hub.messages(c.req.param("id"))));
app.post("/api/sessions/:id/prompt", async (c) => {
  const body = await c.req.json().catch(() => ({ prompt: "" }));
  return sseFrom(c, hub.prompt(c.req.param("id"), String(body.prompt ?? ""), c.req.raw.signal));
});
app.post("/api/sessions/:id/terminal", async (c) => {
  const body = await c.req.json().catch(() => ({ command: "" }));
  return sseFrom(c, hub.terminal(c.req.param("id"), String(body.command ?? ""), c.req.raw.signal));
});

app.get("/api/projects/:id/files", (c) => c.json(hub.files(c.req.param("id"), c.req.query("path") ?? "")));
app.get("/api/projects/:id/file", (c) => c.json(hub.file(c.req.param("id"), c.req.query("path") ?? "")));
app.post("/api/projects/:id/commit", async (c) => {
  const body = await c.req.json().catch(() => ({ message: "" }));
  return c.json(hub.commit(c.req.param("id"), String(body.message ?? "")));
});

app.post("/api/queue", async (c) => {
  const body = await c.req.json();
  return c.json(hub.enqueue(String(body.sessionId ?? ""), String(body.prompt ?? "")));
});
app.delete("/api/queue/:id", (c) => c.json(hub.removeQueue(c.req.param("id"))));
app.post("/api/queue/reorder", async (c) => {
  const body = await c.req.json().catch(() => ({ ids: [] }));
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  return c.json(hub.reorderQueue(ids));
});
app.post("/api/queue/:id/run", (c) => sseFrom(c, hub.runQueue(c.req.param("id"), c.req.raw.signal)));
app.post("/api/providers/:id/mcp/:mcpId", async (c) => {
  const body = await c.req.json().catch(() => ({ enabled: true }));
  return c.json(hub.toggleMcp(c.req.param("id"), c.req.param("mcpId"), Boolean(body.enabled)));
});

if (staticDir) {
  app.get("*", (c) => {
    const file = resolveStatic(staticDir, new URL(c.req.url).pathname);
    if (!file) return c.text("not found", 404);
    return c.body(readFileSync(file), 200, { "content-type": contentType(file) });
  });
}

serve({ fetch: app.fetch, port, hostname }, () => {
  console.log("MobileAgent host is running on this PC");
  for (const url of phoneUrls(port, Boolean(staticDir))) console.log(`  ${url}`);
  console.log(`  pairing code ${hub.pairingCode()}`);
});

async function sseFrom(c: Context, source: AsyncIterable<unknown>) {
  const iterator = source[Symbol.asyncIterator]();
  let first: IteratorResult<unknown>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (error instanceof HubError) return c.json({ error: error.message, code: error.code }, error.status as 400);
    throw error;
  }
  return streamSSE(c, async (stream) => {
    if (!first.done) await stream.writeSSE({ data: JSON.stringify(first.value) });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      await stream.writeSSE({ data: JSON.stringify(next.value) });
    }
  });
}

function isLoopback(c: Context): boolean {
  try {
    const address = getConnInfo(c).remote.address ?? "";
    return address === "127.0.0.1" || address === "::1" || address.endsWith("127.0.0.1");
  } catch {
    return false;
  }
}

function phoneUrls(bridgePort: number, servingUi: boolean): string[] {
  const uiPort = servingUi ? bridgePort : Number(process.env.MOBILEAGENT_UI_PORT ?? 47231);
  const target = Number.isFinite(uiPort) && uiPort > 0 ? uiPort : bridgePort;
  const hosts = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      hosts.add(entry.address);
    }
  }
  return [...hosts].map((host) => `http://${host}:${target}`);
}

function resolveStatic(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let file: string;
  try {
    file = resolveInside(root, rel);
  } catch {
    return null;
  }
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (path.extname(decoded)) return null;
  const index = path.join(root, "index.html");
  return existsSync(index) ? index : null;
}

function contentType(file: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };
  return types[path.extname(file)] ?? "application/octet-stream";
}
