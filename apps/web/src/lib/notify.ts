import { Capacitor } from "@capacitor/core";

export interface NotifyPrefs {
  /** master switch */
  enabled: boolean;
  /** system notification while the app is in the background */
  system: boolean;
  /** in-app banner while the app is in the foreground */
  inapp: boolean;
  /** sound + vibration */
  sound: boolean;
}

const KEY = "pocketpilot.notify";
const DEFAULTS: NotifyPrefs = { enabled: true, system: true, inapp: true, sound: true };

export function getPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...getPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

export type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

export async function permissionState(): Promise<PermissionState> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const r = await LocalNotifications.checkPermissions();
      return r.display === "granted" ? "granted" : r.display === "denied" ? "denied" : "prompt";
    }
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission === "default" ? "prompt" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

/** Asks for the notification permission (Android 13+ shows the system dialog). */
export async function requestPermission(): Promise<PermissionState> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const r = await LocalNotifications.requestPermissions();
      return r.display === "granted" ? "granted" : "denied";
    }
    if (typeof Notification === "undefined") return "unsupported";
    const r = await Notification.requestPermission();
    return r === "default" ? "prompt" : r;
  } catch {
    return "unsupported";
  }
}

export type TaskKind = "done" | "error" | "confirm";
export interface TaskNote { title: string; body: string; kind: TaskKind }

function beep(kind: TaskKind) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = kind === "error" ? 330 : 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
    window.setTimeout(() => void ctx.close(), 400);
  } catch { /* audio is optional */ }
}

function buzz(kind: TaskKind) {
  try { navigator.vibrate?.(kind === "error" ? [120, 60, 120] : 90); } catch { /* optional */ }
}

let nextId = 1000;

/**
 * Task finished / failed / needs confirmation.
 * Foreground: in-app banner (event "pocketpilot:task"). Background: system notification
 * (Capacitor Local Notifications in the APK, Notification API in a browser). Returns where it went, for tests.
 */
export async function notifyTask(note: TaskNote): Promise<"inapp" | "system" | "none"> {
  const prefs = getPrefs();
  if (!prefs.enabled) return "none";
  const foreground = typeof document === "undefined" || document.visibilityState === "visible";
  if (foreground) {
    if (prefs.sound) { beep(note.kind); buzz(note.kind); }
    if (!prefs.inapp) return "none";
    window.dispatchEvent(new CustomEvent("pocketpilot:task", { detail: note }));
    return "inapp";
  }
  if (!prefs.system) return "none";
  try {
    if (Capacitor.isNativePlatform()) {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      if ((await LocalNotifications.checkPermissions()).display !== "granted") {
        if ((await LocalNotifications.requestPermissions()).display !== "granted") return "none";
      }
      await LocalNotifications.schedule({ notifications: [{ id: nextId++, title: note.title, body: note.body, smallIcon: "ic_stat_pocketpilot" }] });
      return "system";
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(note.title, { body: note.body, icon: "/icons/icon-192.png", silent: !prefs.sound });
      return "system";
    }
  } catch { /* notification failures must never break the chat */ }
  return "none";
}
