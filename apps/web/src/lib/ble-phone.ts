import { BleClient, ConnectionPriority, ScanMode } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";
import { BLE_DEFAULT_PACKET, BLE_IDS, type BytePipe } from "@pocketpilot/remote";

export function bleAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function toView(bytes: Uint8Array): DataView {
  const copy = new Uint8Array(bytes);
  return new DataView(copy.buffer);
}

/** Android central. The desktop is the GATT peripheral; this pipe only moves packets. */
export function openBlePipe(): BytePipe {
  let deviceId = "";
  let closed = false;
  let writing: Promise<void> = Promise.resolve();
  const pipe: BytePipe = {
    maxPacket: BLE_DEFAULT_PACKET,
    onPacket: () => undefined,
    onClose: () => undefined,
    send: (packet) => {
      if (!deviceId || closed) return;
      const view = toView(packet);
      writing = writing.then(() => BleClient.writeWithoutResponse(deviceId, BLE_IDS.service, BLE_IDS.rx, view)).catch(() => undefined);
    },
    close: () => {
      closed = true;
      if (!deviceId) return;
      void BleClient.stopNotifications(deviceId, BLE_IDS.service, BLE_IDS.tx).catch(() => undefined);
      void BleClient.disconnect(deviceId).catch(() => undefined);
    },
    open: async () => {
      await BleClient.initialize({ androidNeverForLocation: true });
      if (!(await BleClient.isEnabled())) {
        try {
          await BleClient.requestEnable();
        } catch {
          throw new Error("请在系统设置里打开蓝牙");
        }
      }
      const found = new Map<string, number>();
      await BleClient.requestLEScan(
        { services: [BLE_IDS.service], allowDuplicates: false, scanMode: ScanMode.SCAN_MODE_LOW_LATENCY },
        (result) => {
          const id = result.device?.deviceId;
          if (!id) return;
          const rssi = result.rssi ?? -127;
          const prev = found.get(id);
          if (prev === undefined || rssi > prev) found.set(id, rssi);
        },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      } finally {
        await BleClient.stopLEScan().catch(() => undefined);
      }
      if (closed) throw new Error("蓝牙已取消");
      const best = [...found.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!best) throw new Error("附近没有找到已开启蓝牙的电脑");
      deviceId = best[0];
      await BleClient.connect(deviceId, () => {
        if (!closed) pipe.onClose();
      }, { timeout: 8000 });
      await BleClient.requestConnectionPriority(deviceId, ConnectionPriority.CONNECTION_PRIORITY_HIGH).catch(() => undefined);
      const mtu = await BleClient.getMtu(deviceId).catch(() => 23);
      pipe.maxPacket = Math.max(BLE_DEFAULT_PACKET, mtu - 3);
      await BleClient.startNotifications(deviceId, BLE_IDS.service, BLE_IDS.tx, (value) => {
        pipe.onPacket(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
      });
    },
  };
  return pipe;
}
