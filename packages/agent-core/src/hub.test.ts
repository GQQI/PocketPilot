import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHub } from "./hub";
import { resolveInside } from "./paths";

test("demo hub covers CloudCLI agents plus DeepSeek Harness", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mobileagent-"));
  try {
    const hub = createHub({ dataDir: dir, fast: true });
    const boot = hub.bootstrap();
    const ids = boot.providers.map((provider) => provider.meta.id);
    assert.deepEqual(ids, ["cursor", "claude-code", "codex", "opencode", "gemini", "deepseek-harness", "grok", "trae-cn"]);
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
    const token = hub.pair(code.toLowerCase());
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
      cursor: { enabled: true, model: "auto", cliPath: "mobileagent-missing-cli", endpoint: "" },
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
    assert.match(liveTranscript.at(-1)?.blocks.find((block) => block.type === "text" && block.text.includes("mobileagent-missing-cli"))?.type ?? "", /text/);

    const harness = boot.providers.find((provider) => provider.meta.id === "deepseek-harness");
    assert.ok(harness);
    assert.equal(harness.meta.cli, "dsh");
    assert.equal(harness.health.state, "healthy");
    assert.equal(boot.providers.find((provider) => provider.meta.id === "codex")?.meta.name, "Codex");
    assert.equal(boot.providers.find((provider) => provider.meta.id === "gemini")?.health.state, "degraded");

    hub.setSecret("deepseek-harness", "sk-demo-secret");
    const after = hub.bootstrap();
    assert.equal(JSON.stringify(after).includes("sk-demo-secret"), false);
    assert.equal(after.providers.find((provider) => provider.meta.id === "deepseek-harness")?.keySource, "file");

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
    await rm(dir, { recursive: true, force: true });
  }
});
