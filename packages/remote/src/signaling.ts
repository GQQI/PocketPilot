import mqtt from "mqtt";
import { b64uDecode, b64uEncode, open, seal } from "./crypto";

/** Free public MQTT brokers over secure websockets. We use several in parallel; any one reachable broker is enough. */
export const DEFAULT_BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081",
  "wss://mqtt.eclipseprojects.io:443/mqtt",
];

/** Free public STUN servers. (No TURN: there is no free, reliable public TURN, so symmetric NATs cannot be traversed.) */
export const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
  "stun:global.stun.twilio.com:3478",
];

export function iceConfig(urls: string[] = DEFAULT_STUN): RTCIceServer[] {
  // One entry per URL: node-datachannel on Windows fails ICE entirely when several STUN URLs share one RTCIceServer.
  return urls.map((url) => ({ urls: url }));
}

export interface SignalBus {
  publish(topic: string, payload: string): void;
  subscribe(topic: string, listener: (payload: string) => void): () => void;
  /** Resolves true as soon as at least one broker is connected, false after the timeout. */
  ready(timeoutMs: number): Promise<boolean>;
  close(): void;
}

/** Fan-out MQTT bus: publishes to and listens on every broker, de-duplicating identical payloads. */
export class MqttBus implements SignalBus {
  private clients: mqtt.MqttClient[] = [];
  private listeners = new Map<string, Set<(payload: string) => void>>();
  private seen = new Set<string>();
  private connected = 0;
  private waiters: Array<() => void> = [];

  private readonly log: (message: string) => void;

  constructor(brokers: string[] = DEFAULT_BROKERS, log: (message: string) => void = () => undefined) {
    this.log = log;
    for (const url of brokers) {
      const client = mqtt.connect(url, { reconnectPeriod: 4000, connectTimeout: 10_000, clientId: `ma_${Math.random().toString(16).slice(2, 12)}`, clean: true, keepalive: 30 });
      let up = false;
      client.on("connect", () => {
        if (!up) {
          up = true;
          this.connected += 1;
          this.log(`mqtt connected ${url}`);
          for (const waiter of this.waiters.splice(0)) waiter();
        }
        for (const topic of this.listeners.keys()) client.subscribe(topic, { qos: 0 });
      });
      client.on("close", () => {
        if (up) {
          up = false;
          this.connected -= 1;
        }
      });
      client.on("error", (error) => this.log(`mqtt ${url}: ${error.message}`));
      client.on("message", (topic, message) => {
        const payload = message.toString();
        const key = `${topic}|${payload}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
        for (const listener of this.listeners.get(topic) ?? []) listener(payload);
      });
      this.clients.push(client);
    }
  }

  publish(topic: string, payload: string): void {
    for (const client of this.clients) if (client.connected) client.publish(topic, payload, { qos: 0 });
  }

  subscribe(topic: string, listener: (payload: string) => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      for (const client of this.clients) if (client.connected) client.subscribe(topic, { qos: 0 });
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(topic);
        for (const client of this.clients) if (client.connected) client.unsubscribe(topic);
      }
    };
  }

  ready(timeoutMs: number): Promise<boolean> {
    if (this.connected > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(this.connected > 0);
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.push(done);
    });
  }

  close(): void {
    for (const client of this.clients) client.end(true);
    this.clients = [];
  }
}

/** In-process bus for tests. */
export class MemoryBus implements SignalBus {
  private listeners = new Map<string, Set<(payload: string) => void>>();
  publish(topic: string, payload: string): void {
    for (const listener of this.listeners.get(topic) ?? []) queueMicrotask(() => listener(payload));
  }
  subscribe(topic: string, listener: (payload: string) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(listener);
    this.listeners.set(topic, set);
    return () => set.delete(listener);
  }
  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): void {
    this.listeners.clear();
  }
}

export interface SignalMessage {
  mid: string;
  ts: number;
  /** connection attempt id */
  cid: string;
  from: "c" | "h";
  type: "offer" | "answer" | "cand" | "bye";
  pub?: string;
  sdp?: string;
  cand?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
}

export async function sealSignal(key: CryptoKey, topic: string, message: SignalMessage): Promise<string> {
  return b64uEncode(await seal(key, new TextEncoder().encode(JSON.stringify(message)), topic));
}

export async function openSignal(key: CryptoKey, topic: string, payload: string): Promise<SignalMessage | null> {
  try {
    const plain = await open(key, b64uDecode(payload), topic);
    const message = JSON.parse(new TextDecoder().decode(plain)) as SignalMessage;
    if (Math.abs(Date.now() - message.ts) > 10 * 60 * 1000) return null;
    return message;
  } catch {
    return null;
  }
}