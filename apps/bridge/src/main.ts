import { createHub, HubError, resolveInside } from "@pocketpilot/agent-core";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { startRemote, type RemoteService } from "./remote";

const hub = createHub({
  onPairingCodeChange: (code) => console.log(`  pairing code rotated: ${code}`),
});
const app = new Hono();
const staticDir = process.env.POCKETPILOT_STATIC;
const port = Number(process.env.POCKETPILOT_PORT ?? 47232);
const hostname = process.env.HOST ?? "127.0.0.1";
let remote: RemoteService | null = null;

app.onError((error, c) => {
  if (error instanceof HubError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

const extraOrigins = (process.env.POCKETPILOT_ORIGINS ?? "").split(",").map((item) => item.trim().replace(/\/$/, "")).filter(Boolean);
// Origins of the Capacitor WebView used by the Android/iOS app (it serves the bundled web UI from these).
// Only these exact origins are added; set POCKETPILOT_CAPACITOR_ORIGINS=0 to turn this off.
const CAPACITOR_ORIGINS = process.env.POCKETPILOT_CAPACITOR_ORIGINS === "0" ? [] : ["https://localhost", "capacitor://localhost"];
const SSE_HEARTBEAT_MS = Number(process.env.POCKETPILOT_SSE_HEARTBEAT_MS ?? 15000);

app.use("*", cors({
  // Never echo arbitrary origins: only explicit POCKETPILOT_ORIGINS, plus (outside remote mode) loopback / LAN pages.
  origin: (origin) => (originAllowed(origin) ? origin : ""),
  allowHeaders: ["authorization", "content-type"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
}));

app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin && !originAllowed(origin) && !sameOrigin(c, origin)) {
    return c.json({ error: "origin not allowed", code: "origin" }, 403);
  }
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
  const { token, device } = hub.pair(String(body.code ?? ""), { ip: clientIp(c), name: body.name ? String(body.name) : undefined });
  return c.json({
    token,
    device,
    host: hub.hostInfo({
      loopback: isLoopback(c),
      authorized: true,
      port,
      urls: phoneUrls(port, Boolean(staticDir)),
    }),
  });
});
app.get("/api/devices", (c) => c.json(hub.listDevices(hub.authenticate(c.req.header("authorization"))?.id)));
app.delete("/api/devices/:id", (c) => c.json(hub.revokeDevice(c.req.param("id"))));
app.post("/api/remote/session", async (c) => {
  if (!remote) return c.json({ error: "remote transport is disabled (start with POCKETPILOT_RTC=1)", code: "rtc-disabled" }, 503);
  return c.json(await remote.createSession(pwaBaseUrl()));
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
  console.log("PocketPilot host is running on this PC");
  for (const url of phoneUrls(port, Boolean(staticDir))) console.log(`  ${url}`);
  console.log(`  pairing code ${hub.pairingCode()}`);
  if (hub.remote) console.log("  remote mode: loopback is NOT trusted, every client must pair");
});

if (process.env.POCKETPILOT_RTC === "1") {
  void (async () => {
    remote = await startRemote(hub, (request) => app.fetch(request), (message) => console.log(`  [remote] ${message}`));
    if (!remote) return;
    const session = await remote.createSession(pwaBaseUrl());
    console.log("  Scan with the phone camera (expires in 5 min, one use):");
    console.log(await remote.terminalQr(session.url));
    console.log(`  ${session.url}`);
  })();
}

function pwaBaseUrl(): string {
  if (process.env.POCKETPILOT_PWA_URL) return process.env.POCKETPILOT_PWA_URL;
  // Prefer a typical home/office LAN address over virtual adapters (docker/WSL use 172.x).
  // Host-side addresses of VMware/Hyper-V/Docker virtual networks usually end in .1: push them last.
  const rank = (url: string) => (/\.1:\d+$/.test(url) ? 5 : 0) + (url.includes("//192.168.") ? 0 : url.includes("//10.") ? 1 : 2);
  const urls = phoneUrls(port, Boolean(staticDir)).filter((url) => !url.includes("127.0.0.1")).sort((x, y) => rank(x) - rank(y));
  return urls[0] ?? `http://127.0.0.1:${port}`;
}

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
    // Comment-line heartbeat keeps proxies/NATs from closing idle streams; clients ignore it.
    const beat = setInterval(() => { void stream.write(": ping\n\n").catch(() => undefined); }, SSE_HEARTBEAT_MS);
    try {
      if (!first.done) await stream.writeSSE({ data: JSON.stringify(first.value) });
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        await stream.writeSSE({ data: JSON.stringify(next.value) });
      }
    } finally {
      clearInterval(beat);
    }
  });
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "forwarded", "via", "cf-connecting-ip", "true-client-ip", "x-original-forwarded-for"];

function isLoopbackHostname(name: string): boolean {
  const host = name.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function hostHeaderName(c: Context): string {
  const host = c.req.header("host") ?? "";
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No socket: the request was injected by the WebRTC transport, which tags it with a per-connection id.
    return `rtc:${c.req.header("x-pocketpilot-peer") ?? "?"}`;
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const normalized = origin.replace(/\/$/, "");
  if (extraOrigins.includes(normalized) || CAPACITOR_ORIGINS.includes(normalized)) return true;
  if (hub.remote) return false;
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    if (isLoopbackHostname(host) || host.endsWith(".local")) return true;
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  } catch {
    return false;
  }
}

function sameOrigin(c: Context, origin: string): boolean {
  try {
    return new URL(origin).host === c.req.header("host");
  } catch {
    return false;
  }
}

function isLoopback(c: Context): boolean {
  // Remote mode, any proxy/tunnel header, or a non-loopback Host (DNS rebinding) means we cannot trust the socket address.
  if (hub.remote) return false;
  if (PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)) return false;
  if (!isLoopbackHostname(hostHeaderName(c))) return false;
  try {
    const address = getConnInfo(c).remote.address ?? "";
    return address === "127.0.0.1" || address === "::1" || address.endsWith("127.0.0.1");
  } catch {
    return false;
  }
}

function phoneUrls(bridgePort: number, servingUi: boolean): string[] {
  const uiPort = servingUi ? bridgePort : Number(process.env.POCKETPILOT_UI_PORT ?? 47231);
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
