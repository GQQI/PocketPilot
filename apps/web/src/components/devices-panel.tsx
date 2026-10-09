import type { DeviceView } from "@mobileagent/protocol";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";

export function DevicesPanel() {
  const { t, setNotice } = useApp();
  const [devices, setDevices] = useState<DeviceView[]>([]);

  const load = useCallback(() => {
    void api.devices().then(setDevices).catch(() => setDevices([]));
  }, []);

  useEffect(load, [load]);

  return (
    <section className="panel mt-4 p-4" data-testid="devices">
      <h2 className="font-medium">{t("devices.title")}</h2>
      <p className="mt-1 text-sm leading-6 text-mute">{t("devices.help")}</p>
      {devices.length === 0 ? <p className="mt-3 text-sm text-mute">{t("devices.empty")}</p> : null}
      <ul className="mt-3 space-y-2">
        {devices.map((device) => (
          <li key={device.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{device.name}{device.current ? ` · ${t("devices.current")}` : ""}</div>
              <div className="text-xs text-mute">{t("devices.lastSeen")} {new Date(device.lastSeen).toLocaleString()} · {t("devices.expires")} {new Date(device.expiresAt).toLocaleDateString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void api.revokeDevice(device.id).then((next) => { setDevices(next); setNotice(t("devices.revoked")); }).catch(load)}>{t("devices.revoke")}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
