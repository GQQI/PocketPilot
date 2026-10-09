import type { Hub } from "@mobileagent/agent-core";
import { DEFAULT_BROKERS, MqttBus, RemoteHost, type RtcCtor } from "@mobileagent/remote";
import { hostname } from "node:os";
import QRCode from "qrcode";

export interface RemoteSession {
  url: string;
  expiresAt: number;
  qrSvg: string;
}

export interface RemoteService {
  createSession(baseUrl: string): Promise<RemoteSession>;
  terminalQr(url: string): Promise<string>;
  close(): void;
}

/**
 * WebRTC + public-MQTT remote transport (opt-in with MOBILEAGENT_RTC=1).
 * Requests arriving over the data channel are handed to app.fetch with no socket (so never loopback) and must carry a device token.
 */
export async function startRemote(hub: Hub, handle: (request: Request) => Response | Promise<Response>, log: (message: string) => void): Promise<RemoteService | null> {
  let RTC: RtcCtor;
  try {
    const mod = await import("node-datachannel/polyfill");
    RTC = mod.RTCPeerConnection as unknown as RtcCtor;
  } catch (error) {
    log(`remote disabled: node-datachannel is not available (${(error as Error).message})`);
    return null;
  }
  const brokers = process.env.MOBILEAGENT_BROKERS?.split(",").map((item) => item.trim()).filter(Boolean) ?? DEFAULT_BROKERS;
  const stun = process.env.MOBILEAGENT_STUN?.split(",").map((item) => item.trim()).filter(Boolean);
  const bus = new MqttBus(brokers, (message) => log(message));
  const host = new RemoteHost({
    bus,
    RTC,
    iceServers: stun,
    hostName: hostname(),
    log,
    fetch: handle,
    grant: (name, linkSecret) => {
      const { token, device } = hub.grantDevice(name, linkSecret);
      return { token, deviceId: device.id };
    },
  });
  const sync = () => void host.syncLinks(hub.deviceLinks());
  hub.setDevicesListener(sync);
  sync();
  if (!(await bus.ready(10_000))) log("remote: no public MQTT broker reachable yet (will keep retrying)");

  async function createSession(baseUrl: string): Promise<RemoteSession> {
    const pairing = await host.createPairing(5 * 60 * 1000);
    // The secret lives in the URL fragment: it is never sent to whoever hosts the PWA.
    const url = `${baseUrl.replace(/\/$/, "")}/#pair=${pairing.sid}.${pairing.secret}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { url, expiresAt: pairing.expiresAt, qrSvg };
  }

  return {
    createSession,
    terminalQr: (url) => QRCode.toString(url, { type: "terminal", small: true }),
    close: () => {
      host.close();
      bus.close();
    },
  };
}