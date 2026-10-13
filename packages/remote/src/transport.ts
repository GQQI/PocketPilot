import { RemoteClient } from "./client";
import { BLE_DEFAULT_PACKET } from "./framing";
import { BleClientLink } from "./session";
import type { TransportKind } from "./select";

/**
 * One way to reach the desktop host.
 * `connect` is safe to call again after `close` (reconnect).
 * `rtc` and `ble` encrypt with the pairing secret; `lan` is the existing HTTP + device token path.
 */
export interface Transport {
  readonly kind: TransportKind;
  connect(): Promise<void>;
  readonly connected: boolean;
  request(path: string, init?: RequestInit): Promise<Response>;
  probe(timeoutMs?: number): Promise<boolean>;
  close(): void;
  onClose: ((error: Error) => void) | null;
}

/** Byte pipe underneath BLE. The desktop WinRT helper and the Android plugin both implement this. */
export interface BytePipe {
  /** Largest GATT write/notify, header included. Updated after MTU negotiation. */
  maxPacket: number;
  open(): Promise<void>;
  send(packet: Uint8Array): void;
  close(): void;
  onPacket: (packet: Uint8Array) => void;
  onClose: () => void;
}

export class LanTransport implements Transport {
  readonly kind = "lan" as const;
  onClose: ((error: Error) => void) | null = null;
  private base = "";
  private readonly locate: () => Promise<string>;
  private readonly probeAt: (url: string, timeoutMs: number) => Promise<boolean>;
  private readonly remember?: (url: string) => void;

  constructor(locate: () => Promise<string>, probeAt: (url: string, timeoutMs: number) => Promise<boolean>, remember?: (url: string) => void) {
    this.locate = locate;
    this.probeAt = probeAt;
    this.remember = remember;
  }

  async connect(): Promise<void> {
    const base = (await this.locate()).replace(/\/$/, "");
    if (!base) throw new Error("局域网不可达");
    this.base = base;
    this.remember?.(base);
  }

  get connected(): boolean {
    return this.base !== "";
  }

  get origin(): string {
    return this.base;
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.base) return Promise.reject(new Error("局域网未连接"));
    return fetch(`${this.base}${path}`, init);
  }

  probe(timeoutMs = 2500): Promise<boolean> {
    return this.base ? this.probeAt(this.base, timeoutMs) : Promise.resolve(false);
  }

  close(): void {
    this.base = "";
  }
}

export class RtcTransport implements Transport {
  readonly kind = "rtc" as const;
  onClose: ((error: Error) => void) | null = null;
  private client: RemoteClient | null = null;
  private readonly factory: () => RemoteClient;

  constructor(factory: () => RemoteClient) {
    this.factory = factory;
  }

  async connect(): Promise<void> {
    if (this.client?.connected) return;
    this.client?.close();
    const client = this.factory();
    client.onClose = (error) => {
      if (this.client === client) {
        this.client = null;
        this.onClose?.(error);
      }
    };
    this.client = client;
    try {
      await client.connect();
    } catch (error) {
      client.close();
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  get connected(): boolean {
    return Boolean(this.client?.connected);
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.client) return Promise.reject(new Error("远程通道未连接"));
    return this.client.fetch(path, init);
  }

  probe(timeoutMs = 3000): Promise<boolean> {
    return this.client?.probe(timeoutMs) ?? Promise.resolve(false);
  }

  close(): void {
    const client = this.client;
    this.client = null;
    client?.close();
  }
}

export class BleTransport implements Transport {
  readonly kind = "ble" as const;
  onClose: ((error: Error) => void) | null = null;
  private session: BleClientLink | null = null;
  private up = false;
  private closing = false;
  private readonly opts: { secret: Uint8Array; deviceId: string; name?: string; pipe: BytePipe; handshakeMs?: number };

  constructor(opts: { secret: Uint8Array; deviceId: string; name?: string; pipe: BytePipe; handshakeMs?: number }) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.closing = false;
    const early: Uint8Array[] = [];
    this.opts.pipe.onPacket = (packet) => {
      if (this.session) this.session.ingest(packet);
      else early.push(packet);
    };
    this.opts.pipe.onClose = () => {
      if (this.closing) return;
      this.up = false;
      this.session?.close();
      this.session = null;
      this.onClose?.(new Error("蓝牙已断开"));
    };
    await this.opts.pipe.open();
    const session = new BleClientLink({
      secret: this.opts.secret,
      deviceId: this.opts.deviceId,
      ...(this.opts.name ? { name: this.opts.name } : {}),
      send: (packet) => this.opts.pipe.send(packet),
      maxPacket: this.opts.pipe.maxPacket || BLE_DEFAULT_PACKET,
      ...(this.opts.handshakeMs ? { handshakeMs: this.opts.handshakeMs } : {}),
    });
    this.session = session;
    this.opts.pipe.onPacket = (packet) => session.ingest(packet);
    for (const packet of early) session.ingest(packet);
    await session.handshake();
    this.up = true;
  }

  get connected(): boolean {
    return this.up;
  }

  request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.session || !this.up) return Promise.reject(new Error("蓝牙未连接"));
    return this.session.request(path, init);
  }

  probe(timeoutMs = 3000): Promise<boolean> {
    if (!this.session || !this.up) return Promise.resolve(false);
    return this.session.probe(timeoutMs);
  }

  close(): void {
    this.closing = true;
    this.up = false;
    this.session?.close();
    this.session = null;
    try {
      this.opts.pipe.close();
    } catch {
      /* already closed */
    }
  }
}
