import { b64uDecode, b64uEncode, deriveSession, deriveSignaling, newEcdh, randomBytes, randomId, SecureChannel, type Ecdh, type SessionKeys } from "./crypto";
import { SecureMux, type Frame } from "./frames";
import { openSignal, sealSignal, iceConfig, type SignalBus, type SignalMessage } from "./signaling";

export type RtcCtor = new (config?: RTCConfiguration) => RTCPeerConnection;

export interface HostOptions {
  bus: SignalBus;
  RTC: RtcCtor;
  iceServers?: string[];
  /** Runs an API request through the app. MUST treat it as a non-loopback, unauthenticated-by-default request. */
  fetch: (request: Request) => Response | Promise<Response>;
  /** Called once per successful QR pairing. */
  grant: (name: string, linkSecret: string) => { token: string; deviceId: string };
  hostName: string;
  /** LAN base URLs of this PC; sent to the phone at pairing so it can reconnect over the LAN without MQTT/WebRTC */
  lanUrls?: () => string[];
  log?: (message: string) => void;
}

interface Sub {
  kind: "pair" | "link";
  topic: string;
  key: CryptoKey;
  secret: Uint8Array;
  sid: string;
  deviceId?: string;
  unsubscribe: () => void;
}

interface Pairing {
  sid: string;
  secret: Uint8Array;
  expiresAt: number;
  used: boolean;
}

interface Conn {
  cid: string;
  sub: Sub;
  pc: RTCPeerConnection;
  ecdh: Ecdh;
  keys?: SessionKeys;
  mux?: SecureMux;
  inflight: Map<string, AbortController>;
  seenCands: Set<string>;
  lastRx: number;
  closed: boolean;
  remoteSet: Promise<void>;
  resolveRemote: () => void;
}

const ALLOWED_HEADERS = ["authorization", "content-type", "accept"];

export function toU8(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Desktop side: accepts WebRTC connections signalled through encrypted MQTT and serves API frames. */
export class RemoteHost {
  private subs = new Map<string, Sub>();
  private pairings = new Map<string, Pairing>();
  private conns = new Map<string, Conn>();
  private early = new Map<string, SignalMessage[]>();
  private timer: ReturnType<typeof setInterval>;
  private readonly log: (message: string) => void;

  private readonly options: HostOptions;

  constructor(options: HostOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.timer = setInterval(() => this.sweep(), 15_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Create a one-time, expiring pairing session. The secret only ever travels inside the QR fragment. */
  async createPairing(ttlMs = 5 * 60 * 1000): Promise<{ sid: string; secret: string; expiresAt: number }> {
    const sid = randomId(9);
    const secret = randomBytes(32);
    const pairing: Pairing = { sid, secret, expiresAt: Date.now() + ttlMs, used: false };
    this.pairings.set(sid, pairing);
    await this.listen("pair", sid, secret, sid);
    setTimeout(() => this.dropPairing(sid), ttlMs + 1000).unref?.();
    return { sid, secret: b64uEncode(secret), expiresAt: pairing.expiresAt };
  }

  /** Subscribe to the persisted links of all paired devices; drop revoked ones. */
  async syncLinks(links: Array<{ id: string; linkSecret: string }>): Promise<void> {
    const wanted = new Set(links.map((link) => link.id));
    for (const [key, sub] of this.subs) {
      if (sub.kind === "link" && sub.deviceId && !wanted.has(sub.deviceId)) {
        this.dropSub(key);
        for (const conn of [...this.conns.values()]) if (conn.sub === sub) this.closeConn(conn);
      }
    }
    for (const link of links) {
      if ([...this.subs.values()].some((sub) => sub.deviceId === link.id)) continue;
      await this.listen("link", "link", b64uDecode(link.linkSecret), link.id);
    }
  }

  /** Live WebRTC connections and paired-device links being listened on. */
  stats(): { connections: number; links: number } {
    return { connections: this.conns.size, links: [...this.subs.values()].filter((sub) => sub.kind === "link").length };
  }

  close(): void {
    clearInterval(this.timer);
    for (const conn of [...this.conns.values()]) this.closeConn(conn);
    for (const key of [...this.subs.keys()]) this.dropSub(key);
  }

  private async listen(kind: "pair" | "link", sid: string, secret: Uint8Array, id: string): Promise<void> {
    const { topic, key } = await deriveSignaling(secret, sid);
    const subKey = `${kind}:${id}`;
    if (this.subs.has(subKey)) return;
    const sub: Sub = { kind, topic, key, secret, sid, deviceId: kind === "link" ? id : undefined, unsubscribe: () => undefined };
    sub.unsubscribe = this.options.bus.subscribe(topic, (payload) => void this.onSignal(sub, payload));
    this.subs.set(subKey, sub);
  }

  private dropSub(subKey: string): void {
    const sub = this.subs.get(subKey);
    sub?.unsubscribe();
    this.subs.delete(subKey);
  }

  private dropPairing(sid: string): void {
    this.pairings.delete(sid);
    this.dropSub(`pair:${sid}`);
  }

  private async onSignal(sub: Sub, payload: string): Promise<void> {
    const msg = await openSignal(sub.key, sub.topic, payload);
    if (!msg || msg.from !== "c") return;
    const ckey = `${sub.topic}|${msg.cid}`;
    const conn = this.conns.get(ckey);
    if (msg.type === "offer") {
      if (conn) return; // repeated offer
      await this.accept(sub, msg, ckey);
    } else if (msg.type === "cand" && msg.cand) {
      if (!conn) {
        const list = this.early.get(ckey) ?? [];
        if (list.length < 64) list.push(msg);
        this.early.set(ckey, list);
        return;
      }
      await this.addCandidate(conn, msg);
    } else if (msg.type === "bye" && conn) {
      this.closeConn(conn);
    }
  }

  private async addCandidate(conn: Conn, msg: SignalMessage): Promise<void> {
    const cand = msg.cand;
    if (!cand || conn.seenCands.has(cand.candidate)) return;
    conn.seenCands.add(cand.candidate);
    await conn.remoteSet;
    try {
      await conn.pc.addIceCandidate(cand as RTCIceCandidateInit);
    } catch (error) {
      this.log(`addIceCandidate: ${(error as Error).message}`);
    }
  }

  private async accept(sub: Sub, offer: SignalMessage, ckey: string): Promise<void> {
    if (!offer.pub || !offer.sdp) return;
    this.log(`offer received (${sub.kind})`);
    if (sub.kind === "pair") {
      const pairing = this.pairings.get(sub.sid);
      if (!pairing || pairing.used || pairing.expiresAt < Date.now()) return;
    }
    const ecdh = await newEcdh();
    const conn: Conn = {
      cid: offer.cid,
      sub,
      pc: new this.options.RTC({ iceServers: iceConfig(this.options.iceServers) }),
      ecdh,
      inflight: new Map(),
      seenCands: new Set(),
      lastRx: Date.now(),
      closed: false,
      remoteSet: Promise.resolve(),
      resolveRemote: () => undefined,
    };
    conn.remoteSet = new Promise<void>((resolve) => { conn.resolveRemote = resolve; });
    this.conns.set(ckey, conn);
    try {
      conn.keys = await deriveSession(ecdh, offer.pub, sub.secret, sub.sid, "host", offer.pub, ecdh.publicKey);
    } catch {
      this.closeConn(conn);
      return;
    }
    const publish = async (message: Omit<SignalMessage, "mid" | "ts" | "cid" | "from">) => {
      const full: SignalMessage = { mid: randomId(6), ts: Date.now(), cid: conn.cid, from: "h", ...message };
      this.options.bus.publish(sub.topic, await sealSignal(sub.key, sub.topic, full));
    };
    conn.pc.onicecandidate = (event) => {
      if (event.candidate) void publish({ type: "cand", cand: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } });
    };
    conn.pc.onconnectionstatechange = () => {
      const state = conn.pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") this.closeConn(conn);
    };
    conn.pc.ondatachannel = (event) => this.attachChannel(conn, event.channel);
    await conn.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    conn.resolveRemote();
    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    await publish({ type: "answer", sdp: conn.pc.localDescription?.sdp ?? answer.sdp, pub: ecdh.publicKey });
    for (const msg of this.early.get(`${sub.topic}|${conn.cid}`) ?? []) await this.addCandidate(conn, msg);
    this.early.delete(`${sub.topic}|${conn.cid}`);
  }

  private attachChannel(conn: Conn, dc: RTCDataChannel): void {
    if (!conn.keys) return;
    dc.binaryType = "arraybuffer";
    const mux = new SecureMux(new SecureChannel(conn.keys), {
      send: (data) => dc.send(data as unknown as ArrayBuffer),
      bufferedAmount: () => dc.bufferedAmount,
    });
    conn.mux = mux;
    mux.onError = (error) => {
      this.log(`frame error: ${error.message}`);
      this.closeConn(conn);
    };
    mux.onFrame = (frame) => {
      conn.lastRx = Date.now();
      void this.onFrame(conn, frame);
    };
    dc.onmessage = (event) => {
      const bytes = toU8(event.data);
      if (bytes) mux.receive(bytes);
    };
    dc.onclose = () => this.closeConn(conn);
  }

  private async onFrame(conn: Conn, frame: Frame): Promise<void> {
    const mux = conn.mux;
    if (!mux) return;
    switch (frame.t) {
      case "ping":
        void mux.send({ t: "pong" });
        return;
      case "hello": {
        if (conn.sub.kind !== "pair") return;
        const pairing = this.pairings.get(conn.sub.sid);
        if (!pairing || pairing.used || pairing.expiresAt < Date.now()) {
          void mux.send({ t: "err", id: "hello", message: "expired", status: 410 });
          return;
        }
        pairing.used = true;
        const linkSecret = b64uEncode(randomBytes(32));
        const granted = this.options.grant(frame.name ?? "Phone", linkSecret);
        void mux.send({ t: "welcome", token: granted.token, deviceId: granted.deviceId, linkSecret, host: this.options.hostName, urls: this.options.lanUrls?.() ?? [] });
        setTimeout(() => this.dropPairing(conn.sub.sid), 1000).unref?.();
        return;
      }
      case "abort":
        conn.inflight.get(frame.id)?.abort();
        return;
      case "req":
        await this.serve(conn, frame);
        return;
      default:
    }
  }

  private async serve(conn: Conn, frame: Extract<Frame, { t: "req" }>): Promise<void> {
    const mux = conn.mux;
    if (!mux) return;
    const fail = (message: string, status = 400) => void mux.send({ t: "err", id: frame.id, message, status });
    if (!frame.path.startsWith("/api/")) return fail("bad path");
    const controller = new AbortController();
    conn.inflight.set(frame.id, controller);
    try {
      const headers = new Headers();
      for (const name of ALLOWED_HEADERS) {
        const value = frame.headers[name];
        if (value) headers.set(name, value);
      }
      // Marks the request as coming from a tunnel: no socket (never loopback), per-peer rate-limit key, never trusted.
      headers.set("host", "rtc.local");
      headers.set("x-pocketpilot-peer", conn.cid);
      const method = frame.method.toUpperCase();
      const request = new Request(`http://rtc.local${frame.path}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : frame.body,
        signal: controller.signal,
      });
      const response = await this.options.fetch(request);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key === "content-type" || key === "cache-control") outHeaders[key] = value;
      });
      await mux.send({ t: "res", id: frame.id, status: response.status, headers: outHeaders });
      const reader = response.body?.getReader();
      if (reader) {
        while (!controller.signal.aborted && !conn.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          await mux.send({ t: "chunk", id: frame.id, d: b64uEncode(value) });
        }
        if (controller.signal.aborted) await reader.cancel().catch(() => undefined);
      }
      if (!conn.closed) await mux.send({ t: "end", id: frame.id });
    } catch (error) {
      if (!conn.closed) fail((error as Error).message, 500);
    } finally {
      conn.inflight.delete(frame.id);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const conn of [...this.conns.values()]) if (now - conn.lastRx > 60_000) this.closeConn(conn);
    for (const pairing of [...this.pairings.values()]) if (pairing.expiresAt + 1000 < now) this.dropPairing(pairing.sid);
  }

  private closeConn(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const controller of conn.inflight.values()) controller.abort();
    for (const [key, value] of this.conns) if (value === conn) this.conns.delete(key);
    try {
      conn.pc.close();
    } catch {
      /* already closed */
    }
  }
}