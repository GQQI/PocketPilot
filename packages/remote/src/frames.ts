import { b64uDecode, b64uEncode, randomId, SecureChannel } from "./crypto";

/** Application frames carried (encrypted) over the WebRTC data channel. */
export type Frame =
  | { t: "hello"; name?: string }
  | { t: "welcome"; token: string; deviceId: string; linkSecret: string; host: string; urls?: string[] }
  | { t: "req"; id: string; method: string; path: string; headers: Record<string, string>; body?: string }
  | { t: "res"; id: string; status: number; headers: Record<string, string> }
  | { t: "chunk"; id: string; d: string }
  | { t: "end"; id: string }
  | { t: "err"; id: string; message: string; status?: number }
  | { t: "abort"; id: string }
  | { t: "ping" | "pong" }
  | { t: "frag"; id: string; i: number; n: number; d: string };

export interface RawTransport {
  send(data: Uint8Array): void;
  bufferedAmount(): number;
}

const FRAGMENT_CHARS = 24_000;
const HIGH_WATER = 512 * 1024;

/**
 * Encrypts/decrypts frames in strict order, fragments large JSON, and applies simple backpressure.
 * Counters are assigned inside the serialized queue so ordering matches wire order.
 */
export class SecureMux {
  private sendQueue: Promise<void> = Promise.resolve();
  private recvQueue: Promise<void> = Promise.resolve();
  private fragments = new Map<string, string[]>();
  onFrame: (frame: Frame) => void = () => undefined;
  onError: (error: Error) => void = () => undefined;

  private readonly channel: SecureChannel;
  private readonly transport: RawTransport;

  constructor(channel: SecureChannel, transport: RawTransport) {
    this.channel = channel;
    this.transport = transport;
  }

  send(frame: Frame): Promise<void> {
    const json = JSON.stringify(frame);
    const parts = json.length <= FRAGMENT_CHARS ? [json] : this.split(json);
    let last: Promise<void> = Promise.resolve();
    for (const part of parts) last = this.enqueue(part);
    return last;
  }

  private split(json: string): string[] {
    const id = randomId(6);
    const n = Math.ceil(json.length / FRAGMENT_CHARS);
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const frag: Frame = { t: "frag", id, i, n, d: json.slice(i * FRAGMENT_CHARS, (i + 1) * FRAGMENT_CHARS) };
      out.push(JSON.stringify(frag));
    }
    return out;
  }

  private enqueue(json: string): Promise<void> {
    const task = this.sendQueue.then(async () => {
      while (this.transport.bufferedAmount() > HIGH_WATER) await new Promise((r) => setTimeout(r, 15));
      this.transport.send(await this.channel.encrypt(new TextEncoder().encode(json)));
    });
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  receive(data: Uint8Array): void {
    this.recvQueue = this.recvQueue.then(async () => {
      try {
        const text = new TextDecoder().decode(await this.channel.decrypt(data));
        const frame = JSON.parse(text) as Frame;
        if (frame.t === "frag") {
          const list = this.fragments.get(frame.id) ?? new Array<string>(frame.n);
          list[frame.i] = frame.d;
          this.fragments.set(frame.id, list);
          if (list.filter((x) => x !== undefined).length === frame.n) {
            this.fragments.delete(frame.id);
            this.onFrame(JSON.parse(list.join("")) as Frame);
          }
          return;
        }
        this.onFrame(frame);
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export const bytesToB64 = b64uEncode;
export const b64ToBytes = b64uDecode;