// End-to-end crypto for PocketPilot remote pairing. WebCrypto only (works in browsers and Node >= 20).
//
// Key schedule
//   secret (32 random bytes, from the QR code or a stored link)  ──HKDF──▶ signaling key + MQTT topic
//   ephemeral ECDH P-256 per connection (public keys exchanged inside encrypted signaling)
//   session keys = HKDF(ECDH shared secret, salt = SHA-256(secret ‖ sid), info = direction ‖ both public keys)
// The signaling AEAD key proves possession of the secret (an attacker without it cannot inject a public key),
// the ECDH adds forward secrecy for the data-channel traffic.

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function randomId(bytes = 12): string {
  return b64uEncode(randomBytes(bytes));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const out = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, base, bits);
  return new Uint8Array(out);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return new Uint8Array(await subtle().digest("SHA-256", joined as BufferSource));
}

export interface SignalingKeys {
  /** Random-looking MQTT topic only holders of the secret can compute. */
  topic: string;
  key: CryptoKey;
}

/** `sid` is the pairing session id, or the constant "link" for a persisted device link. */
export async function deriveSignaling(secret: Uint8Array, sid: string): Promise<SignalingKeys> {
  const salt = enc.encode(`mobileagent/v1/${sid}`);
  const topic = hex(await hkdfBits(secret, salt, enc.encode("topic"), 128));
  const key = await aesKey(await hkdfBits(secret, salt, enc.encode("signal-key"), 256));
  return { topic: `ma1/${topic}`, key };
}

/** AES-GCM with random 96-bit IV, output = iv ‖ ciphertext. Used for low-volume signaling messages. */
export async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function open(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array> {
  if (data.length < 13) throw new Error("short ciphertext");
  const iv = data.subarray(0, 12);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, key, data.subarray(12) as BufferSource);
  return new Uint8Array(pt);
}

export interface Ecdh {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function newEcdh(): Promise<Ecdh> {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: b64uEncode(raw) };
}

export interface SessionKeys {
  send: CryptoKey;
  recv: CryptoKey;
}

export async function deriveSession(
  mine: Ecdh,
  peerPublic: string,
  secret: Uint8Array,
  sid: string,
  role: "client" | "host",
  clientPub: string,
  hostPub: string,
): Promise<SessionKeys> {
  const peerKey = await subtle().importKey("raw", b64uDecode(peerPublic) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: peerKey }, mine.privateKey, 256));
  const salt = await sha256(secret, enc.encode(sid));
  const bind = `${clientPub}|${hostPub}`;
  const c2h = await aesKey(await hkdfBits(shared, salt, enc.encode(`ma1 c2h ${bind}`), 256));
  const h2c = await aesKey(await hkdfBits(shared, salt, enc.encode(`ma1 h2c ${bind}`), 256));
  return role === "client" ? { send: c2h, recv: h2c } : { send: h2c, recv: c2h };
}

/**
 * BLE has no signaling round-trip, so both directions are derived straight from the pairing
 * secret (the QR one-time secret, or the persisted link secret). Same AES-GCM counter channel as WebRTC.
 */
export async function deriveBleSession(secret: Uint8Array, role: "client" | "host"): Promise<SessionKeys> {
  const salt = enc.encode("pocketpilot/ble/v1");
  const c2h = await aesKey(await hkdfBits(secret, salt, enc.encode("ble c2h"), 256));
  const h2c = await aesKey(await hkdfBits(secret, salt, enc.encode("ble h2c"), 256));
  return role === "client" ? { send: c2h, recv: h2c } : { send: h2c, recv: c2h };
}

function counterIv(counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

/** Data-channel AEAD: strictly increasing counter doubles as IV (unique per key) and replay guard. */
export class SecureChannel {
  private sendCounter = 0;
  private recvCounter = -1;
  private readonly keys: SessionKeys;

  constructor(keys: SessionKeys) {
    this.keys = keys;
  }

  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    const counter = this.sendCounter++;
    const iv = counterIv(counter);
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.keys.send, plain as BufferSource));
    const out = new Uint8Array(8 + ct.length);
    out.set(iv.subarray(4), 0);
    out.set(ct, 8);
    return out;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 9) throw new Error("short frame");
    const counter = Number(new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0));
    if (counter <= this.recvCounter) throw new Error("replayed frame");
    const iv = counterIv(counter);
    const pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.keys.recv, data.subarray(8) as BufferSource));
    this.recvCounter = counter;
    return pt;
  }
}