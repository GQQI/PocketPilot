import { b64uDecode, b64uEncode, deriveSession, deriveSignaling, newEcdh, randomId, SecureChannel } from "./crypto";
import { SecureMux, type Frame } from "./frames";
import { iceConfig, openSignal, sealSignal, type SignalBus, type SignalMessage } from "./signaling";
import { RemoteError, ERROR_HINTS } from "./errors";
import type { RtcCtor } from "./host";

export type RemoteTarget = { kind: "pair"; sid: string; secret: string } | { kind: "link"; secret: string };

export interface ClientOptions {
  RTC: RtcCtor;
  /** Creates a (new) signaling bus; the client closes it once the data channel is up. */
  createBus: () => SignalBus;
  iceServers?: string[];
  signalTimeoutMs?: number;
  answerTimeoutMs?: number;
  iceTimeoutMs?: number;
  log?: (message: string) => void;
}

interface Pending {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  started: boolean;
}

export interface Welcome {
  token: string;
  deviceId: string;
  linkSecret: string;
  host: string;
}

/** Phone side: opens an end-to-end encrypted data channel and exposes a fetch()-like API over it. */
export class RemoteClient {
  private mux?: SecureMux;
  private pc?: RTCPeerConnection;
  private pending = new Map<string, Pending>();
  private connecting?: Promise<void>;
  private open = false;
  private lastRx = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private helloWaiter?: { resolve: (welcome: Welcome) => void; reject: (error: Error) => void };
  onClose: (error: RemoteError) => void = () => undefined;

  private target: RemoteTarget;
  private readonly options: ClientOptions;

  constructor(target: RemoteTarget, options: ClientOptions) {
    this.target = target;
    this.options = options;
  }

  get connected(): boolean {
    return this.open;
  }

  setTarget(target: RemoteTarget): void {
    this.target = target;
  }

  connect(): Promise<void> {
    if (this.open) return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** QR flow: connect, say hello, receive the device token + persistent link secret. */
  async pair(name: string): Promise<Welcome> {
    await this.connect();
    const mux = this.mux;
    if (!mux) throw new RemoteError("closed", ERROR_HINTS.closed);
    const result = new Promise<Welcome>((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
      setTimeout(() => reject(new RemoteError("expired", ERROR_HINTS.expired)), 15_000);
    });
    await mux.send({ t: "hello", name });
    return result;
  }

  close(): void {
    this.teardown(new RemoteError("closed", ERROR_HINTS.closed), false);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.connect();
    const mux = this.mux;
    if (!mux) throw new RemoteError("closed", ERROR_HINTS.closed);
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
    switch (frame.t) {
      case "welcome":
        this.helloWaiter?.resolve(frame);
        this.helloWaiter = undefined;
        return;
      case "res": {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        const stream = new ReadableStream<Uint8Array>({ start: (controller) => { entry.controller = controller; } });
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
        if (frame.id === "hello") {
          this.helloWaiter?.reject(new RemoteError("expired", ERROR_HINTS.expired));
          this.helloWaiter = undefined;
        } else this.finish(frame.id, new Error(frame.message));
        return;
      default:
    }
  }

  private teardown(error: RemoteError, notify = true): void {
    const wasOpen = this.open;
    this.open = false;
    clearInterval(this.heartbeat);
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = undefined;
    this.mux = undefined;
    for (const id of [...this.pending.keys()]) this.finish(id, error);
    this.helloWaiter?.reject(error);
    this.helloWaiter = undefined;
    if (wasOpen && notify) this.onClose(error);
  }

  private async doConnect(): Promise<void> {
    const o = this.options;
    const log = o.log ?? (() => undefined);
    const bus = o.createBus();
    const target = this.target;
    const secret = b64uDecode(target.secret);
    const sid = target.kind === "pair" ? target.sid : "link";
    try {
      if (!(await bus.ready(o.signalTimeoutMs ?? 15_000))) throw new RemoteError("signal", ERROR_HINTS.signal);
      const { topic, key } = await deriveSignaling(secret, sid);
      const ecdh = await newEcdh();
      const cid = randomId(8);
      const pc = new o.RTC({ iceServers: iceConfig(o.iceServers) });
      this.pc = pc;
      const dc = pc.createDataChannel("ma", { ordered: true });
      dc.binaryType = "arraybuffer";
      const local: SignalMessage[] = [];
      const send = async (message: Omit<SignalMessage, "mid" | "ts" | "cid" | "from">) => {
        const full: SignalMessage = { mid: randomId(6), ts: Date.now(), cid, from: "c", ...message };
        bus.publish(topic, await sealSignal(key, topic, full));
        return full;
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const cand = { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex };
        local.push({ mid: "", ts: 0, cid, from: "c", type: "cand", cand });
        void send({ type: "cand", cand });
      };
      await pc.setLocalDescription(await pc.createOffer());
      const offerSdp = pc.localDescription?.sdp ?? "";

      const opened = new Promise<void>((resolve, reject) => {
        let answered = false;
        let remoteSet: Promise<void> = Promise.resolve();
        let iceTimer: ReturnType<typeof setTimeout> | undefined;
        const fail = (error: RemoteError) => {
          clearInterval(resend);
          clearTimeout(answerTimer);
          clearTimeout(iceTimer);
          reject(error);
        };
        const resend = setInterval(() => {
          if (answered) return;
          // The host may subscribe late or a broker may drop a message: repeat offer + candidates until answered.
          void send({ type: "offer", sdp: offerSdp, pub: ecdh.publicKey });
          for (const cand of local) void send({ type: "cand", cand: cand.cand });
        }, 3000);
        const answerTimer = setTimeout(() => fail(new RemoteError("no-host", ERROR_HINTS["no-host"])), o.answerTimeoutMs ?? 30_000);
        const unsubscribe = bus.subscribe(topic, (payload) => {
          void openSignal(key, topic, payload).then(async (msg) => {
            if (!msg || msg.from !== "h" || msg.cid !== cid) return;
            if (msg.type === "answer" && msg.sdp && msg.pub && !answered) {
              answered = true;
              clearInterval(resend);
              clearTimeout(answerTimer);
              iceTimer = setTimeout(() => fail(new RemoteError("ice", ERROR_HINTS.ice)), o.iceTimeoutMs ?? 25_000);
              const keys = await deriveSession(ecdh, msg.pub, secret, sid, "client", ecdh.publicKey, msg.pub);
              const mux = new SecureMux(new SecureChannel(keys), {
                send: (data) => dc.send(data as unknown as ArrayBuffer),
                bufferedAmount: () => dc.bufferedAmount,
              });
              mux.onFrame = (frame) => this.onFrame(frame);
              mux.onError = (error) => {
                log(`frame error ${error.message}`);
                this.teardown(new RemoteError("closed", ERROR_HINTS.closed));
              };
              dc.onmessage = (event) => {
                const data = event.data as unknown;
                const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
                if (bytes) mux.receive(bytes);
              };
              this.mux = mux;
              remoteSet = pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
              await remoteSet;
            } else if (msg.type === "cand" && msg.cand && answered) {
              await remoteSet;
              await pc.addIceCandidate(msg.cand as RTCIceCandidateInit).catch(() => undefined);
            }
          });
        });
        dc.onopen = () => {
          clearTimeout(iceTimer);
          clearTimeout(answerTimer);
          clearInterval(resend);
          unsubscribe();
          resolve();
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            if (!this.open) fail(new RemoteError("ice", ERROR_HINTS.ice));
            else this.teardown(new RemoteError("closed", ERROR_HINTS.closed));
          }
        };
        dc.onclose = () => {
          if (this.open) this.teardown(new RemoteError("closed", ERROR_HINTS.closed));
        };
        void send({ type: "offer", sdp: offerSdp, pub: ecdh.publicKey });
      });
      await opened;
      this.open = true;
      this.lastRx = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastRx > 35_000) return this.teardown(new RemoteError("closed", ERROR_HINTS.closed));
        void this.mux?.send({ t: "ping" }).catch(() => undefined);
      }, 10_000);
    } catch (error) {
      this.teardown(error instanceof RemoteError ? error : new RemoteError("closed", (error as Error).message), false);
      throw error;
    } finally {
      bus.close();
    }
  }
}

export { b64uEncode };