import assert from "node:assert/strict";
import test from "node:test";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { b64uEncode, deriveSession, deriveSignaling, MemoryBus, newEcdh, open, randomBytes, RemoteClient, RemoteHost, seal, SecureChannel, type RtcCtor } from "./index";

const RTC = RTCPeerConnection as unknown as RtcCtor;

test("signaling encryption rejects wrong secret and tampering", async () => {
  const a = await deriveSignaling(randomBytes(32), "sid");
  const b = await deriveSignaling(randomBytes(32), "sid");
  assert.notEqual(a.topic, b.topic);
  const sealed = await seal(a.key, new TextEncoder().encode("hi"), a.topic);
  assert.equal(new TextDecoder().decode(await open(a.key, sealed, a.topic)), "hi");
  await assert.rejects(open(b.key, sealed, a.topic));
  await assert.rejects(open(a.key, sealed, "other-topic"));
  sealed[sealed.length - 1] ^= 1;
  await assert.rejects(open(a.key, sealed, a.topic));
});

test("ECDH session keys agree, are directional, and reject replay", async () => {
  const secret = randomBytes(32);
  const c = await newEcdh();
  const h = await newEcdh();
  const ck = await deriveSession(c, h.publicKey, secret, "s", "client", c.publicKey, h.publicKey);
  const hk = await deriveSession(h, c.publicKey, secret, "s", "host", c.publicKey, h.publicKey);
  const client = new SecureChannel(ck);
  const host = new SecureChannel(hk);
  const msg = await client.encrypt(new TextEncoder().encode("secret"));
  assert.equal(new TextDecoder().decode(await host.decrypt(msg)), "secret");
  await assert.rejects(host.decrypt(msg), /replayed/);
  // wrong pairing secret => different keys
  const evil = new SecureChannel(await deriveSession(h, c.publicKey, randomBytes(32), "s", "host", c.publicKey, h.publicKey));
  await assert.rejects(evil.decrypt(await client.encrypt(new Uint8Array([1]))));
});

// node-datachannel (libjuice) on Windows cannot connect two peers living in the SAME process (ICE stays "checking"
// even on 127.0.0.1); the same pair connects instantly across two processes. Use scripts/e2e-remote.mjs there.
test("QR pairing then link reconnect over WebRTC data channel", { timeout: 60_000, skip: process.platform === "win32" && (process.env.POCKETPILOT_FORCE_INPROC ?? process.env.MOBILEAGENT_FORCE_INPROC) !== "1" ? "in-process dual WebRTC peers unsupported on Windows (see scripts/e2e-remote.mjs)" : false }, async () => {
  const bus = new MemoryBus();
  let granted: { token: string; deviceId: string; linkSecret: string } | undefined;
  const host = new RemoteHost({
    bus,
    RTC,
    iceServers: [],
    hostName: "test-host",
    grant: (name, linkSecret) => {
      granted = { token: "tok_" + name, deviceId: "dev1", linkSecret };
      return { token: granted.token, deviceId: "dev1" };
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      assert.equal(request.headers.get("host"), "rtc.local");
      if (url.pathname === "/api/echo") {
        if (request.headers.get("authorization") !== "Bearer tok_phone") return Response.json({ error: "pairing required" }, { status: 401 });
        return Response.json({ body: await request.text(), method: request.method });
      }
      if (url.pathname === "/api/big") return new Response("x".repeat(300_000), { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/api/stream") {
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 3; i += 1) {
              controller.enqueue(enc.encode(`data: ${i}\n\n`));
              await new Promise((r) => setTimeout(r, 30));
            }
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  const mk = (target: ConstructorParameters<typeof RemoteClient>[0]) => new RemoteClient(target, { RTC, createBus: () => bus, iceServers: [], answerTimeoutMs: 8000, iceTimeoutMs: 15000 });
  try {
    const pairing = await host.createPairing(60_000);
    const first = mk({ kind: "pair", sid: pairing.sid, secret: pairing.secret });
    const welcome = await first.pair("phone");
    assert.equal(welcome.token, "tok_phone");
    assert.equal(welcome.linkSecret, granted?.linkSecret);
    first.close();

    // one-time: second use of the same QR must fail
    const reuse = mk({ kind: "pair", sid: pairing.sid, secret: pairing.secret });
    await assert.rejects(reuse.pair("again"));
    reuse.close();

    await host.syncLinks([{ id: "dev1", linkSecret: welcome.linkSecret }]);
    const link = mk({ kind: "link", secret: welcome.linkSecret });
    const auth = { authorization: `Bearer ${welcome.token}` };
    const denied = await link.fetch("/api/echo", { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    const ok = await link.fetch("/api/echo", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ big: "y".repeat(100_000) }) });
    const json = (await ok.json()) as { body: string; method: string };
    assert.equal(json.method, "POST");
    assert.equal(json.body.length > 100_000, true);
    const big = await link.fetch("/api/big", { headers: auth });
    assert.equal((await big.text()).length, 300_000);
    const sse = await link.fetch("/api/stream", { headers: auth });
    assert.equal(await sse.text(), "data: 0\n\ndata: 1\n\ndata: 2\n\n");
    await assert.rejects(link.fetch("/etc/passwd"), /bad path/);

    // revocation: dropping the link closes the connection and blocks reconnects
    await host.syncLinks([]);
    await new Promise((r) => setTimeout(r, 300));
    link.close();
    const after = new RemoteClient({ kind: "link", secret: welcome.linkSecret }, { RTC, createBus: () => bus, iceServers: [], answerTimeoutMs: 1500, iceTimeoutMs: 3000 });
    await assert.rejects(after.connect(), (error: { code?: string }) => error.code === "no-host");
  } finally {
    host.close();
    bus.close();
  }
  void b64uEncode;
});