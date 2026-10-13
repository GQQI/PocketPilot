import { b64uDecode, deriveBleSession, randomId, SecureChannel } from "./crypto";
import { BLE_DEFAULT_PACKET, PacketReassembler, splitMessage } from "./framing";
import { SecureMux, type Frame } from "./frames";
import { serveApiRequest } from "./serve-frame";

export interface PacketSink {
  send(packet: Uint8Array): void;
  bufferedAmount(): number;
}

/** Encrypted frames (the same SecureMux as WebRTC) split into BLE-sized packets. */
export class EncryptedLink {
  readonly mux: SecureMux;
  private asm = new PacketReassembler();
  private msgId = 1;
  maxPacket: number;
  private readonly sink: PacketSink;

  constructor(channel: SecureChannel, sink: PacketSink, maxPacket = BLE_DEFAULT_PACKET) {
    this.sink = sink;
    this.maxPacket = Math.max(BLE_DEFAULT_PACKET, maxPacket);
    this.mux = new SecureMux(channel, {
      send: (data) => {
        const id = this.msgId;
        this.msgId = (this.msgId + 1) & 0xffff;
        if (this.msgId === 0) this.msgId = 1;
        for (const packet of splitMessage(id, data, this.maxPacket)) this.sink.send(packet);
      },
      bufferedAmount: () => this.sink.bufferedAmount(),
    });
  }

  setMaxPacket(maxPacket: number): void {
    this.maxPacket = Math.max(BLE_DEFAULT_PACKET, maxPacket);
  }

  ingest(packet: Uint8Array): void {
    const message = this.asm.push(packet);
    if (message) this.mux.receive(message);
  }
}

interface Pending {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  started: boolean;
}

/** fetch()-shaped client over a SecureMux. BLE uses it; WebRTC keeps its own copy inside RemoteClient. */
export class MuxClient {
  private pending = new Map<string, Pending>();
  private pongWaiter?: () => void;
  lastRx = 0;
  private readonly mux: SecureMux;

  constructor(mux: SecureMux) {
    this.mux = mux;
    mux.onFrame = (frame) => this.onFrame(frame);
  }

  waitPong(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongWaiter = undefined;
        reject(new Error("蓝牙握手超时"));
      }, timeoutMs);
      this.pongWaiter = () => {
        clearTimeout(timer);
        this.pongWaiter = undefined;
        resolve();
      };
    });
  }

  async probe(timeoutMs = 3000): Promise<boolean> {
    const before = this.lastRx;
    await this.mux.send({ t: "ping" });
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.lastRx > before) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const mux = this.mux;
    const id = randomId(6);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const frame: Frame = {
      t: "req",
      id,
      method: init.method ?? "GET",
      path,
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = { resolve, reject, started: false };
      this.pending.set(id, entry);
      const signal = init.signal;
      const onAbort = () => {
        void mux.send({ t: "abort", id }).catch(() => undefined);
        this.finish(id, new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      mux.send(frame).catch((error) => this.finish(id, error as Error));
    });
  }

  private finish(id: string, error?: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (!entry.started) {
      if (error) entry.reject(error);
      return;
    }
    if (error) entry.controller?.error(error);
    else entry.controller?.close();
  }

  private onFrame(frame: Frame): void {
    this.lastRx = Date.now();
    if (frame.t === "pong") this.pongWaiter?.();
    switch (frame.t) {
      case "res": {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            entry.controller = controller;
          },
        });
        entry.started = true;
        const nullBody = frame.status === 204 || frame.status === 304;
        entry.resolve(new Response(nullBody ? null : stream, { status: frame.status, headers: frame.headers }));
        if (nullBody) this.pending.delete(frame.id);
        return;
      }
      case "chunk":
        this.pending.get(frame.id)?.controller?.enqueue(b64uDecode(frame.d));
        return;
      case "end":
        this.finish(frame.id);
        return;
      case "err":
        this.finish(frame.id, new Error(frame.message));
        return;
      default:
    }
  }
}

export interface BlePeer {
  id: string;
  linkSecret: string;
}

/** Desktop side of the BLE pipe. The first frame is tried against every paired link secret. */
export class BleHost {
  private asm = new PacketReassembler();
  private link: EncryptedLink | null = null;
  private pinnedSecret = "";
  private pinnedId = "";
  private queue: Promise<void> = Promise.resolve();
  private inflight = new Map<string, AbortController>();
  private maxPacket: number;
  connections = 0;
  private readonly opts: {
    links: () => BlePeer[];
    fetch: (request: Request) => Response | Promise<Response>;
    send: (packet: Uint8Array) => void;
    log?: (message: string) => void;
    maxPacket?: number;
  };

  constructor(opts: {
    links: () => BlePeer[];
    fetch: (request: Request) => Response | Promise<Response>;
    send: (packet: Uint8Array) => void;
    log?: (message: string) => void;
    maxPacket?: number;
  }) {
    this.opts = opts;
    this.maxPacket = opts.maxPacket ?? BLE_DEFAULT_PACKET;
  }

  ingest(packet: Uint8Array): void {
    this.queue = this.queue.then(() => this.onPacket(packet)).catch((error) => {
      this.opts.log?.(`ble ${(error as Error).message}`);
    });
  }

  setMaxPacket(maxPacket: number): void {
    this.maxPacket = Math.max(BLE_DEFAULT_PACKET, maxPacket);
    this.link?.setMaxPacket(this.maxPacket);
  }

  /** Drop the live phone. The next write starts a new handshake. */
  drop(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    this.link = null;
    this.pinnedSecret = "";
    this.pinnedId = "";
    this.connections = 0;
    this.asm.reset();
  }

  retain(links: readonly BlePeer[]): void {
    if (this.pinnedSecret && !links.some((link) => link.linkSecret === this.pinnedSecret)) this.drop();
  }

  private sink(): PacketSink {
    return { send: (packet) => this.opts.send(packet), bufferedAmount: () => 0 };
  }

  private async onPacket(packet: Uint8Array): Promise<void> {
    if (this.link) {
      this.link.ingest(packet);
      return;
    }
    const message = this.asm.push(packet);
    if (!message) return;
    for (const peer of this.opts.links()) {
      let secret: Uint8Array;
      try {
        secret = b64uDecode(peer.linkSecret);
      } catch {
        continue;
      }
      const channel = new SecureChannel(await deriveBleSession(secret, "host"));
      let plain: Uint8Array;
      try {
        plain = await channel.decrypt(message);
      } catch {
        continue;
      }
      const link = new EncryptedLink(channel, this.sink(), this.maxPacket);
      link.mux.onFrame = (frame) => {
        void this.onFrame(frame);
      };
      link.mux.onError = (error) => {
        this.opts.log?.(`ble frame ${error.message}`);
        this.drop();
      };
      this.link = link;
      this.pinnedSecret = peer.linkSecret;
      this.pinnedId = peer.id;
      this.connections = 1;
      link.mux.deliverPlain(plain);
      return;
    }
    this.opts.log?.("ble frame did not match a paired device");
  }

  private async onFrame(frame: Frame): Promise<void> {
    const mux = this.link?.mux;
    if (!mux) return;
    switch (frame.t) {
      case "ping":
      case "hello":
        void mux.send({ t: "pong" });
        return;
      case "abort":
        this.inflight.get(frame.id)?.abort();
        return;
      case "req": {
        const controller = new AbortController();
        this.inflight.set(frame.id, controller);
        try {
          await serveApiRequest(mux, frame, (request) => this.opts.fetch(request), {
            peer: `ble:${this.pinnedId || "?"}`,
            signal: controller.signal,
            closed: () => this.link == null,
            host: "ble.local",
          });
        } finally {
          this.inflight.delete(frame.id);
        }
        return;
      }
      default:
    }
  }
}

/** Phone side: handshake with the pairing secret, then fetch() over the same frames. */
export class BleClientLink {
  private link: EncryptedLink | null = null;
  private client: MuxClient | null = null;
  private readonly opts: {
    secret: Uint8Array;
    deviceId: string;
    name?: string;
    send: (packet: Uint8Array) => void;
    maxPacket?: number;
    handshakeMs?: number;
  };

  constructor(opts: {
    secret: Uint8Array;
    deviceId: string;
    name?: string;
    send: (packet: Uint8Array) => void;
    maxPacket?: number;
    handshakeMs?: number;
  }) {
    this.opts = opts;
  }

  setMaxPacket(maxPacket: number): void {
    this.link?.setMaxPacket(maxPacket);
  }

  async handshake(): Promise<void> {
    const channel = new SecureChannel(await deriveBleSession(this.opts.secret, "client"));
    this.link = new EncryptedLink(channel, { send: (packet) => this.opts.send(packet), bufferedAmount: () => 0 }, this.opts.maxPacket ?? BLE_DEFAULT_PACKET);
    this.client = new MuxClient(this.link.mux);
    const pong = this.client.waitPong(this.opts.handshakeMs ?? 4000);
    await this.link.mux.send({ t: "hello", deviceId: this.opts.deviceId, ...(this.opts.name ? { name: this.opts.name } : {}) });
    await pong;
  }

  ingest(packet: Uint8Array): void {
    this.link?.ingest(packet);
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.client) return Promise.reject(new Error("蓝牙未连接"));
    return this.client.fetch(path, init);
  }

  probe(timeoutMs = 3000): Promise<boolean> {
    if (!this.client) return Promise.resolve(false);
    return this.client.probe(timeoutMs);
  }

  close(): void {
    this.link = null;
    this.client = null;
  }
}
