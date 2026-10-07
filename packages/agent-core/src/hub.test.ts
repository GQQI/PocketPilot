import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHub } from "./hub";
import { resolveInside } from "./paths";

test("demo hub covers CloudCLI agents plus DeepSeek Harness", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mobileagent-"));
  try {
    const hub = createHub({ dataDir: dir, fast: true });
    const boot = hub.bootstrap();
    const ids = boot.providers.map((provider) => provider.meta.id);
    assert.deepEqual(ids, ["cursor", "claude-code", "codex", "opencode", "gemini", "deepseek-harness"]);
    assert.equal(ids.includes("vscode"), false);
    assert.equal(ids.includes("deepseek"), false);
    assert.equal(boot.settings.demoMode, true);

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
