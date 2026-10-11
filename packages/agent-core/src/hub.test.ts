import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHub } from "./hub";
import { resolveInside } from "./paths";

test("demo hub covers CloudCLI agents plus DeepSeek Harness", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pocketpilot-"));
  try {
    const hub = createHub({ dataDir: dir, fast: true });
    const boot = hub.bootstrap();
    const ids = boot.providers.map((provider) => provider.meta.id);
    assert.deepEqual(ids, ["cursor", "claude-code", "codex", "opencode", "gemini", "deepseek-harness"]);
    assert.equal(ids.includes("vscode"), false);
    assert.equal(ids.includes("deepseek"), false);
    assert.equal(boot.settings.demoMode, true);
    assert.equal(boot.settings.theme, "light");
    assert.equal(JSON.stringify(boot).includes(hub.pairingCode()), false);

    const roots = hub.listDirs("");
    assert.equal(roots.demo, true);
    assert.equal(roots.entries[0]?.path, "D:\\");
    const projects = hub.listDirs("D:\\Project");
    assert.equal(projects.entries.some((entry) => entry.name === "harbor-ledger"), true);
    assert.equal(projects.parent, "D:\\");

    const code = hub.pairingCode();
    assert.throws(() => hub.pair("000000"), /rejected/);
    const { token } = hub.pair(code.toLowerCase());
    assert.equal(hub.tokenMatches(`Bearer ${token}`), true);
    assert.equal(hub.tokenMatches("Bearer nope"), false);
    assert.equal(hub.hostInfo({ loopback: false, authorized: true, port: 9, urls: [] }).pairingCode, undefined);
    assert.equal(hub.hostInfo({ loopback: true, authorized: false, port: 9, urls: ["http://127.0.0.1:9"] }).pairingCode, code);

    const themed = hub.updateSettings({ theme: "dark", activeProviderId: "codex" });
    assert.equal(themed.settings.theme, "dark");
    assert.equal(themed.settings.activeProviderId, "codex");
    const reloaded = createHub({ dataDir: dir, fast: true });
    assert.equal(reloaded.bootstrap().settings.theme, "dark");
    reloaded.updateSettings({ theme: "light", activeProviderId: "cursor", demoMode: false, workspacePath: dir, providers: {
      cursor: { enabled: true, model: "auto", cliPath: "pocketpilot-missing-cli", endpoint: "" },
    } });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "secrets.json"), "hidden");
    await writeFile(path.join(dir, "README.md"), "hello");
    const listed = reloaded.listDirs(dir);
    assert.equal(listed.demo, false);
    assert.equal(listed.entries.some((entry) => entry.name === "src"), true);
    assert.equal(listed.entries.some((entry) => entry.name === "secrets.json"), false);
    const created = reloaded.createSession("cursor", "live__cursor", "bridge");
    const liveEvents = [];
    for await (const event of reloaded.prompt(created.session.id, "hello from the phone", new AbortController().signal)) {
      liveEvents.push(event);
    }
    assert.equal(liveEvents.some((event) => event.type === "error"), true);
    const liveTranscript = reloaded.messages(created.session.id);
    assert.match(liveTranscript.at(-1)?.blocks.find((block) => block.type === "text" && block.text.includes("pocketpilot-missing-cli"))?.type ?? "", /text/);

    const harness = boot.providers.find((provider) => provider.meta.id === "deepseek-harness");
    assert.ok(harness);
    assert.equal(harness.meta.cli, "dsh");
    assert.equal(harness.health.state, "healthy");
    assert.equal(boot.providers.find((provider) => provider.meta.id === "codex")?.meta.name, "Codex");
    assert.equal(boot.providers.find((provider) => provider.meta.id === "gemini")?.health.state, "degraded");

    hub.setSecret("deepseek-harness", "sk-demo-secret");
    const after = hub.bootstrap();
    assert.equal(JSON.stringify(after).includes("sk-demo-secret"), false);
    // an env key on the dev machine legitimately takes precedence over the stored file key
    assert.ok(["file", "env"].includes(after.providers.find((provider) => provider.meta.id === "deepseek-harness")?.keySource ?? ""));

    const session = boot.sessions.find((item) => item.id === "ses_dsh_plugins");
    assert.ok(session);
    const events = [];
    for await (const event of hub.prompt(session.id, "列出还能拆成插件的部分", new AbortController().signal)) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "text"), true);
    assert.equal(events.at(-1)?.type, "done");
    const transcript = hub.messages(session.id);
    assert.equal(transcript.at(-1)?.role, "assistant");

    const queued = hub.enqueue(session.id, "下一轮再看调度插件");
    const waiting = queued.queue.filter((item) => item.status === "waiting").map((item) => item.id);
    assert.ok(waiting.length >= 2);
    const reordered = hub.reorderQueue([...waiting].reverse());
    assert.equal(reordered.queue.find((item) => item.status === "waiting")?.id, waiting.at(-1));

    assert.throws(() => resolveInside(dir, "../outside"), /escapes/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tmpHub(options: Parameters<typeof createHub>[0] = {}) {
  return mkdtemp(path.join(tmpdir(), "pocketpilot-sec-")).then((dir) => ({ dir, hub: createHub({ dataDir: dir, fast: true, ...options }) }));
}

test("pairing issues per-device tokens that can be revoked", async () => {
  const { dir, hub } = await tmpHub({ remote: false });
  try {
    const a = hub.pair(hub.pairingCode(), { name: "iPhone", ip: "1.1.1.1" });
    const b = hub.pair(hub.pairingCode(), { name: "Pixel", ip: "1.1.1.2" });
    assert.notEqual(a.token, b.token);
    assert.equal(hub.tokenMatches(`Bearer ${a.token}`), true);
    assert.equal(hub.listDevices(a.device.id).length, 2);
    assert.equal(hub.listDevices(a.device.id).find((d) => d.id === a.device.id)?.current, true);
    // tokens are stored hashed
    const raw = await readFile(path.join(dir, "host.json"), "utf8");
    assert.equal(raw.includes(a.token), false);
    hub.revokeDevice(a.device.id);
    assert.equal(hub.tokenMatches(`Bearer ${a.token}`), false);
    assert.equal(hub.tokenMatches(`Bearer ${b.token}`), true);
    assert.throws(() => hub.revokeDevice("dev_missing"), /unknown device/);
    // survives restart
    const again = createHub({ dataDir: dir, fast: true, remote: false });
    assert.equal(again.tokenMatches(`Bearer ${b.token}`), true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("device tokens expire", async () => {
  const { dir, hub } = await tmpHub({ remote: false, tokenTtlDays: 0.00000001 });
  try {
    const { token } = hub.pair(hub.pairingCode());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hub.tokenMatches(`Bearer ${token}`), false);
    assert.equal(hub.listDevices().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("pairing is rate limited and locks out", async () => {
  const { dir, hub } = await tmpHub({ remote: false });
  try {
    for (let i = 0; i < 5; i += 1) assert.throws(() => hub.pair("AAAAAA", { ip: "9.9.9.9" }), /rejected/);
    // even the correct code is refused while locked
    assert.throws(() => hub.pair(hub.pairingCode(), { ip: "9.9.9.9" }), (e: { status?: number; code?: string }) => e.status === 429 && e.code === "locked");
    // another client is unaffected
    assert.ok(hub.pair(hub.pairingCode(), { ip: "8.8.8.8" }).token);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("remote mode never exposes the code, ignores loopback and rotates the code", async () => {
  const rotated: string[] = [];
  const { dir, hub } = await tmpHub({ remote: true, onPairingCodeChange: (c) => rotated.push(c) });
  try {
    const first = hub.pairingCode();
    const info = hub.hostInfo({ loopback: true, authorized: false, port: 1, urls: [] });
    assert.equal(info.pairingCode, undefined);
    assert.equal(info.paired, false);
    assert.equal(info.loopback, false);
    assert.equal(info.remote, true);
    hub.pair(first, { ip: "2.2.2.2" });
    assert.notEqual(hub.pairingCode(), first);
    assert.equal(rotated.length, 1);
    assert.throws(() => hub.pair(first, { ip: "2.2.2.3" }), /rejected/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
