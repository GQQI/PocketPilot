import type { Hub } from "@pocketpilot/agent-core";
import { BLE_IDS, BleHost } from "@pocketpilot/remote";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { WINRT_SCRIPT } from "./ble-winrt";

export interface BleService {
  stats(): { enabled: boolean; advertising: boolean; connections: number; error: string };
  syncLinks(): void;
  close(): void;
}

/**
 * Desktop Bluetooth peripheral.
 *
 * `@abandonware/bleno` and `noble` talk to the controller through a raw HCI socket. On Windows that
 * means replacing the inbox Bluetooth driver with WinUSB (Zadig), which breaks the user's mouse and
 * headphones and cannot ship inside an Electron installer. Classic RFCOMM (`bluetooth-serial-port`)
 * does run on Windows, but the phone uses `@capacitor-community/bluetooth-le`, which speaks GATT only.
 *
 * This host advertises a BLE GATT service through the Windows Runtime (`GattServiceProvider`), the
 * same stack Windows Settings uses. No extra driver. The helper is PowerShell, which ships with
 * Windows, so the Electron app does not need a native addon. Other desktops report `windows-only`
 * and keep serving LAN and WebRTC.
 */
export async function startBle(
  hub: Hub,
  handle: (request: Request) => Response | Promise<Response>,
  log: (message: string) => void,
): Promise<BleService | null> {
  if (process.env.POCKETPILOT_BLE !== "1") return null;
  if (process.platform !== "win32") {
    log("bluetooth: advertising uses the Windows Bluetooth stack; this OS will not start a peripheral");
    return {
      stats: () => ({ enabled: true, advertising: false, connections: 0, error: "windows-only" }),
      syncLinks: () => undefined,
      close: () => undefined,
    };
  }

  let advertising = false;
  let error = "";
  let child: ChildProcessWithoutNullStreams | null = null;
  let scriptDir = "";
  const host = new BleHost({
    links: () => hub.deviceLinks(),
    fetch: handle,
    send: (packet) => {
      const line = JSON.stringify({ op: "tx", d: Buffer.from(packet).toString("base64") });
      try {
        child?.stdin.write(`${line}\n`);
      } catch (err) {
        log(`bluetooth: notify failed (${(err as Error).message})`);
      }
    },
    log: (message) => log(`bluetooth: ${message}`),
  });
  const syncLinks = () => host.retain(hub.deviceLinks());
  hub.addDevicesListener(syncLinks);

  try {
    scriptDir = mkdtempSync(path.join(tmpdir(), "pocketpilot-ble-"));
    const file = path.join(scriptDir, "peripheral.ps1");
    writeFileSync(file, WINRT_SCRIPT, "utf8");
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        POCKETPILOT_BLE_SERVICE: BLE_IDS.service,
        POCKETPILOT_BLE_RX: BLE_IDS.rx,
        POCKETPILOT_BLE_TX: BLE_IDS.tx,
      },
    });
  } catch (err) {
    error = (err as Error).message;
    log(`bluetooth: failed to start helper (${error})`);
  }

  if (child) {
    const proc = child;
    proc.on("error", (err) => {
      error = err.message;
      advertising = false;
      log(`bluetooth: helper error (${err.message})`);
    });
    proc.on("exit", (code) => {
      advertising = false;
      if (code && !error) error = `helper exited ${code}`;
      host.drop();
      log(`bluetooth: helper exited (${code ?? 0})`);
    });
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`bluetooth: ${text}`);
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      let msg: { e?: string; m?: string; n?: number; mtu?: number; d?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        if (line.trim()) log(`bluetooth: ${line.trim()}`);
        return;
      }
      if (msg.e === "ready") {
        advertising = true;
        error = "";
        log("bluetooth: advertising PocketPilot");
      } else if (msg.e === "error") {
        advertising = false;
        error = msg.m || "bluetooth unavailable";
        log(`bluetooth: ${error}`);
      } else if (msg.e === "rx" && msg.d) {
        host.ingest(Buffer.from(msg.d, "base64"));
      } else if (msg.e === "link") {
        const n = msg.n ?? 0;
        if (n === 0) host.drop();
        if (msg.mtu && msg.mtu >= 20) host.setMaxPacket(msg.mtu);
      } else if (msg.e === "log" && msg.m) {
        log(`bluetooth: ${msg.m}`);
      }
    });
  }

  return {
    stats: () => ({ enabled: true, advertising, connections: host.connections, error }),
    syncLinks,
    close: () => {
      host.drop();
      try {
        child?.stdin.write(`${JSON.stringify({ op: "stop" })}\n`);
      } catch {
        /* helper already gone */
      }
      const proc = child;
      child = null;
      setTimeout(() => proc?.kill(), 500).unref?.();
      if (scriptDir) {
        setTimeout(() => {
          try {
            rmSync(scriptDir, { recursive: true, force: true });
          } catch {
            /* temp dir */
          }
        }, 1500).unref?.();
      }
    },
  };
}
