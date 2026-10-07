import type { CopyKey } from "./i18n";

export function formatTime(iso: string, t: (key: CopyKey, vars?: Record<string, string | number>) => string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 36) return t("time.hours", { n: hours });
  return t("time.days", { n: Math.round(hours / 24) });
}
