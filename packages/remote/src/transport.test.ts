import assert from "node:assert/strict";
import test from "node:test";
import { b64uEncode, randomBytes } from "./crypto";
import { BLE_HEADER, PacketReassembler, splitMessage } from "./framing";
import { BleHost } from "./session";
import { connectByPolicy, nextCandidate, normalizePolicy } from "./select";
import { BleTransport, type BytePipe } from "./transport";

test("BLE packets split, survive reordering, and reassemble", () => {
  const data = new Uint8Array(100);
  for (let i = 0; i < data.length; i += 1) data[i] = i;
  const packets = splitMessage(7, data, 20);
  assert.ok(packets.length > 1);
  assert.ok(packets.every((packet) => packet.byteLength <= 20 && packet.byteLength >= BLE_HEADER));
  const asm = new PacketReassembler();
  const order = [packets[1]!, packets[0]!, ...packets.slice(2)];
  let out: Uint8Array | null = null;
  for (const packet of order) out = asm.push(packet) ?? out;
  assert.deepEqual(out, data);

  const again = new PacketReassembler();
  const first = splitMessage(1, new Uint8Array([1, 2, 3]), 20);
  const second = splitMessage(2, new Uint8Array([4, 5]), 20);
  assert.deepEqual(again.push(first[0]!), new Uint8Array([1, 2, 3]));
  assert.deepEqual(again.push(second[0]!), new Uint8Array([4, 5]));
  assert.equal(again.push(new Uint8Array([1, 2, 3])), null);
});

test("automatic selection prefers LAN, then remote, then Bluetooth", async () => {
  assert.equal(nextCandidate(normalizePolicy(null), []), "lan");
  assert.equal(nextCandidate(normalizePolicy({ mode: "auto" }), ["lan"]), "rtc");
  assert.equal(nextCandidate(normalizePolicy({ mode: "auto" }), ["lan", "rtc"]), "ble");
  assert.equal(nextCandidate(normalizePolicy({ mode: "auto", enabled: { lan: false } }), []), "rtc");
  assert.equal(nextCandidate(normalizePolicy({ mode: "ble", enabled: { ble: false } }), []), null);
  assert.equal(nextCandidate(normalizePolicy({ mode: "ble" }), ["ble"]), null);

  const autoTried: string[] = [];
  const auto = await connectByPolicy(normalizePolicy({ mode: "auto" }), async (kind) => {
    autoTried.push(kind);
    return kind === "ble";
  });
  assert.deepEqual(autoTried, ["lan", "rtc", "ble"]);
  assert.equal(auto, "ble");

  const manualTried: string[] = [];
  const manual = await connectByPolicy(normalizePolicy({ mode: "rtc" }), async (kind) => {
    manualTried.push(kind);
    return false;
  });
  assert.deepEqual(manualTried, ["rtc"]);
  assert.equal(manual, null);

  const thrown = await connectByPolicy(normalizePolicy({ mode: "lan" }), async () => {
    throw new Error("down");
  });
  assert.equal(thrown, null);
});

test("encrypted BLE transport streams a response across a 20-byte MTU", async () => {
  const secret = randomBytes(32);
  const encoded = b64uEncode(secret);
  const seen: number[] = [];
  let host!: BleHost;
  const pipe: BytePipe = {
    maxPacket: 20,
    onPacket: () => undefined,
    onClose: () => undefined,
    open: async () => undefined,
    send: (packet) => {
      seen.push(packet.byteLength);
      host.ingest(packet);
    },
    close: () => undefined,
  };
  host = new BleHost({
    links: () => [{ id: "dev_1", linkSecret: encoded }],
    maxPacket: 20,
    send: (packet) => {
      seen.push(packet.byteLength);
      pipe.onPacket(packet);
    },
    fetch: (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer tok");
      assert.equal(new URL(request.url).pathname, "/api/echo");
      const body = new Uint8Array(20_000);
      body.fill(65);
      return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
    },
  });
  const transport = new BleTransport({ secret, deviceId: "pp_phone", pipe, handshakeMs: 2000 });
  await transport.connect();
  assert.equal(transport.connected, true);
  const response = await transport.request("/api/echo", { headers: { authorization: "Bearer tok" } });
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.byteLength, 20_000);
  assert.ok(bytes.every((byte) => byte === 65));
  assert.ok(seen.length > 10);
  assert.ok(seen.every((size) => size <= 20));
  transport.close();
  assert.equal(transport.connected, false);
});

test("a wrong pairing secret cannot open the Bluetooth channel", async () => {
  let fetches = 0;
  let pipe!: BytePipe;
  const host = new BleHost({
    links: () => [{ id: "dev_1", linkSecret: b64uEncode(randomBytes(32)) }],
    maxPacket: 20,
    send: (packet) => pipe.onPacket(packet),
    fetch: () => {
      fetches += 1;
      return new Response("no");
    },
  });
  pipe = {
    maxPacket: 20,
    onPacket: () => undefined,
    onClose: () => undefined,
    open: async () => undefined,
    send: (packet) => host.ingest(packet),
    close: () => undefined,
  };
  const transport = new BleTransport({ secret: randomBytes(32), deviceId: "pp_x", pipe, handshakeMs: 200 });
  await assert.rejects(transport.connect(), /握手超时/);
  assert.equal(fetches, 0);
  assert.equal(transport.connected, false);
});
