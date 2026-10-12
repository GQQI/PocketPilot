import { Capacitor } from "@capacitor/core";
import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api";
import { parsePairPayload, pairFromPayload } from "@/lib/rtc";
import { useApp } from "@/lib/store";

/** Full-screen state shown when the PWA is opened from a pairing QR (`/#pair=<sid>.<secret>`). */
export function PairLanding({ payload }: { payload: string }) {
  const { t } = useApp();
  const [state, setState] = useState<"pairing" | "done" | "error">("pairing");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  function run() {
    setState("pairing");
    pairFromPayload(payload, api.deviceName(), api.stableDeviceId()).then((token) => {
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

function WebCamera({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const callbacks = useRef({ onResult, onClose });
  callbacks.current = { onResult, onClose };
  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    const canvas = document.createElement("canvas");
    async function start() {
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
    </div>
  );
}

/**
 * The scan entry used by the top-right icon (same component on the pairing screen and everywhere else).
 * In the APK it opens the camera scanner directly; in a browser it falls back to a paste-the-link dialog.
 */
export function useScanPair() {
  const { t, setNotice } = useApp();
  const [open, setOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pairWith(text: string) {
    const payload = parsePairPayload(text);
    if (!payload) {
      setNotice(t("remote.invalid"));
      return;
    }
    setCamera(false);
    setBusy(true);
    setOpen(true);
    setError("");
    pairFromPayload(payload, api.deviceName(), api.stableDeviceId()).then((token) => {
      api.adoptToken(token);
      window.location.replace("/");
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    });
  }

  async function start() {
    setError("");
    if (Capacitor.isNativePlatform() && (await nativeScan(pairWith, () => undefined))) return;
    setOpen(true);
  }

  const modal = (
    <Modal open={open} onOpenChange={(next) => { setOpen(next); if (!next) setCamera(false); }} title={t("scan.title")}>
      <div data-testid="scan-sheet">
        <p className="text-sm leading-6 text-mute">{t("scan.help")}</p>
        {typeof navigator.mediaDevices?.getUserMedia === "function" ? (
          <Button className="mt-4 w-full" variant="soft" disabled={busy} onClick={() => setCamera((value) => !value)}>{t("scan.camera")}</Button>
        ) : null}
        {camera ? <WebCamera onResult={pairWith} onClose={() => setCamera(false)} /> : null}
        <label className="mt-4 block">{t("scan.paste")}</label>
        <div className="mt-2 flex gap-2">
          <Input value={paste} placeholder="https://…#pair=…" onChange={(event) => setPaste(event.target.value)} />
          <Button size="sm" disabled={!paste.trim() || busy} onClick={() => pairWith(paste)}>{t("scan.go")}</Button>
        </div>
        {busy ? <p className="mt-3 text-sm">{t("remote.pairing")}</p> : null}
        {error ? <p className="mt-3 text-sm text-coral">{error}</p> : null}
      </div>
    </Modal>
  );

  return { start, modal };
}
