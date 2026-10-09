import { MqttBus, RemoteClient, RemoteError, type RemoteTarget } from "@mobileagent/remote";

const LINK_KEY = "mobileagent.rtc";

interface Link {
  secret: string;
  host: string;
}

function read(): Link | null {
  try {
    const raw = localStorage.getItem(LINK_KEY);
    return raw ? (JSON.parse(raw) as Link) : null;
  } catch {
    return null;
  }
}

function newClient(target: RemoteTarget): RemoteClient {
  return new RemoteClient(target, {
    RTC: RTCPeerConnection,
    createBus: () => new MqttBus(),
    log: (message) => console.debug("[rtc]", message),
  });
}

let client: RemoteClient | null = null;

export function rtcConfigured(): boolean {
  return read() !== null;
}

export function rtcHost(): string {
  return read()?.host ?? "";
}

export function forgetRtc() {
  client?.close();
  client = null;
  try {
    localStorage.removeItem(LINK_KEY);
  } catch {
    /* private mode */
  }
}

/** fetch() replacement that tunnels through the end-to-end encrypted WebRTC channel. */
export function rtcFetch(path: string, init?: RequestInit): Promise<Response> {
  const link = read();
  if (!link) return Promise.reject(new RemoteError("closed", "未配对"));
  client ??= newClient({ kind: "link", secret: link.secret });
  return client.fetch(path, init);
}

/** Accepts a full pairing URL, a `#pair=...` fragment, or `sid.secret`. */
export function parsePairPayload(text: string): string | null {
  const match = /(?:#|^)pair=([\w-]+\.[\w-]+)/.exec(text.trim()) ?? /^([\w-]+\.[\w-]{40,})$/.exec(text.trim());
  return match ? match[1] : null;
}

export async function pairFromPayload(payload: string, deviceName: string): Promise<string> {
  const [sid, secret] = payload.split(".");
  if (!sid || !secret) throw new RemoteError("expired", "二维码无效");
  const pairing = newClient({ kind: "pair", sid, secret });
  try {
    const welcome = await pairing.pair(deviceName);
    forgetRtc();
    localStorage.setItem(LINK_KEY, JSON.stringify({ secret: welcome.linkSecret, host: welcome.host } satisfies Link));
    return welcome.token;
  } finally {
    pairing.close();
  }
}