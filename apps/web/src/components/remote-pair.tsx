import { Capacitor } from "@capacitor/core";
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { parsePairPayload, pairFromPayload, rtcConfigured, rtcHost } from "@/lib/rtc";
import { useApp } from "@/lib/store";

/** Full-screen state shown when the PWA is opened from a pairing QR (`/#pair=<sid>.<secret>`). */
export function PairLanding({ payload }: { payload: string }) {
  const { t } = useApp();
  const [state, setState] = useState<"pairing" | "done" | "error">("pairing");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  function run() {
    setState("pairing");
    pairFromPayload(payload, api.deviceName()).then((token) => {
      api.adoptToken(token);
      setState("done");
      setTimeout(() => window.location.replace("/"), 600);
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    });
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-dvh items-center justify-center p-6">
      <div className="panel w-full max-w-sm p-5 text-center" data-testid="pair-landing">
        <h1 className="display text-2xl">{t("remote.title")}</h1>
        <p className="mt-3 text-sm leading-6">{state === "pairing" ? t("remote.pairing") : state === "done" ? t("remote.done") : message || t("remote.failed")}</p>
        {state === "error" ? (
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" onClick={run}>{t("remote.retry")}</Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.replace("/")}>{t("remote.cancel")}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Native app only: Google ML Kit code scanner (full-screen camera UI, no CAMERA permission prompt of our own).
 * Resolves true when it handled the scan (result or user cancel); false means "not available, use the web camera".
 */
async function nativeScan(onResult: (text: string) => void, onClose: () => void): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { BarcodeScanner, BarcodeFormat } = await import("@capacitor-mlkit/barcode-scanning");
    if (!(await BarcodeScanner.isSupported()).supported) return false;
    if (!(await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available) return false;
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const text = barcodes.map((item) => item.rawValue).find((value) => parsePairPayload(value)) ?? barcodes[0]?.rawValue;
    if (text) onResult(text);
    else onClose();
    return true;
  } catch (caught) {
    if (/cancel/i.test(caught instanceof Error ? caught.message : String(caught))) {
      onClose();
      return true;
    }
    return false;
  }
}

export function Scanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const callbacks = useRef({ onResult, onClose });
  callbacks.current = { onResult, onClose };
  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    const canvas = document.createElement("canvas");
    async function start() {
      if (await nativeScan((text) => callbacks.current.onResult(text), () => callbacks.current.onClose())) return;
      if (stop) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        const tick = () => {
          if (stop) return;
          if (el.videoWidth > 0) {
            canvas.width = el.videoWidth;
            canvas.height = el.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx?.drawImage(el, 0, 0);
            const image = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            const code = image ? jsQR(image.data, image.width, image.height) : null;
            if (code && parsePairPayload(code.data)) {
              callbacks.current.onResult(code.data);
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "camera unavailable");
      }
    }
    void start();
    return () => {
      stop = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  return (
    <div className="mt-3">
      <video ref={video} className="w-full rounded-2xl bg-black" playsInline muted />
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      <Button className="mt-2" size="sm" variant="ghost" onClick={onClose}>{useApp().t("remote.cancel")}</Button>
    </div>
  );
}

/** Settings section: show a pairing QR (on the PC) or scan one (on the phone). */
export function RemotePairPanel() {
  const { t, setNotice } = useApp();
  const [session, setSession] = useState<{ url: string; expiresAt: number; qrSvg: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) setSession(null);
    }, 500);
    return () => clearInterval(timer);
  }, [session]);

  function pairWith(text: string) {
    const payload = parsePairPayload(text);
    if (!payload) {
      setNotice(t("remote.invalid"));
      return;
    }
    setScanning(false);
    setBusy(true);
    setError("");
    pairFromPayload(payload, api.deviceName()).then((token) => {
      api.adoptToken(token);
      window.location.replace("/");
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    });
  }

  return (
    <section className="panel mt-4 p-4" data-testid="remote-pair">
      <h2 className="font-medium">{t("remote.title")}</h2>
      <p className="mt-1 text-sm leading-6 text-mute">{t("remote.help")}</p>
      {rtcConfigured() ? <p className="mt-2 text-xs text-mute">{t("remote.linked", { host: rtcHost() })}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void api.remoteSession().then((next) => { setSession(next); setLeft(Math.round((next.expiresAt - Date.now()) / 1000)); setError(""); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))}>{t("remote.generate")}</Button>
        <Button size="sm" variant="soft" onClick={() => setScanning((value) => !value)}>{t("remote.scan")}</Button>
      </div>
      {session ? (
        <div className="mt-3">
          <img alt="pairing QR" className="mx-auto w-56 rounded-2xl bg-white p-2" src={`data:image/svg+xml;utf8,${encodeURIComponent(session.qrSvg)}`} />
          <p className="mt-2 text-center text-xs text-mute">{t("remote.expires", { s: left })}</p>
          <p className="mt-1 break-all text-center text-[10px] text-mute">{session.url}</p>
        </div>
      ) : null}
      {scanning ? <Scanner onResult={pairWith} onClose={() => setScanning(false)} /> : null}
      <div className="mt-3 flex gap-2">
        <Input value={paste} placeholder={t("remote.paste")} onChange={(event) => setPaste(event.target.value)} />
        <Button size="sm" variant="soft" disabled={!paste.trim() || busy} onClick={() => pairWith(paste)}>{t("remote.pasteBtn")}</Button>
      </div>
      {busy ? <p className="mt-2 text-sm">{t("remote.pairing")}</p> : null}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
/** Pairing by QR scan or pasted link (works in the browser and in the Capacitor app). Used on the unpaired screen. */
export function PairByLink() {
  const { t, setNotice } = useApp();
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pairWith(text: string) {
    const payload = parsePairPayload(text);
    if (!payload) {
      setNotice(t("remote.invalid"));
      return;
    }
    setScanning(false);
    setBusy(true);
    setError("");
    pairFromPayload(payload, api.deviceName()).then((token) => {
      api.adoptToken(token);
      window.location.replace("/");
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    });
  }

  return (
    <div data-testid="pair-by-link">
      <Button className="mt-6 w-full" variant="soft" disabled={busy} onClick={() => setScanning((value) => !value)}>{t("remote.scan")}</Button>
      {scanning ? <Scanner onResult={pairWith} onClose={() => setScanning(false)} /> : null}
      <div className="mt-3 flex gap-2">
        <Input value={paste} placeholder={t("remote.paste")} onChange={(event) => setPaste(event.target.value)} />
        <Button size="sm" variant="soft" disabled={!paste.trim() || busy} onClick={() => pairWith(paste)}>{t("remote.pasteBtn")}</Button>
      </div>
      {busy ? <p className="mt-2 text-sm">{t("remote.pairing")}</p> : null}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
