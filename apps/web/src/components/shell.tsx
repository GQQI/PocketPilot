import { FolderTree, LayoutGrid, MessageCircle, ScanLine, Settings, Smartphone, X } from "lucide-react";
import { Logo } from "@/components/logo";
import { NavLink } from "react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { TaskNote } from "@/lib/notify";
import { Button, Input } from "@/components/ui";
import { useApp } from "@/lib/store";
import { useScanPair } from "@/components/remote-pair";

const links: { to: string; key: string; icon: typeof LayoutGrid }[] = [
  { to: "/", key: "nav.home", icon: LayoutGrid },
  { to: "/chat", key: "nav.chat", icon: MessageCircle },
  { to: "/projects", key: "nav.projects", icon: FolderTree },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

export function Shell({ children }: { children: ReactNode }) {
  const { data, loading, error, notice, needsPair, refresh, t, setNotice } = useApp();
  const scan = useScanPair();
  const gated = needsPair && !data;
  return (
    <div className="relative h-dvh">
      <div className="mx-auto flex h-full w-full max-w-[1240px] flex-col md:flex-row">
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
          <header className="app-header flex items-center justify-between px-4 pb-2 md:px-8">
            <div className="brand"><Logo size={26} className="brand-logo-svg" />PocketPilot</div>
            <button type="button" className="icon-btn" aria-label={t("scan.label")} data-testid="scan-btn" onClick={() => void scan.start()}>
              <ScanLine size={20} strokeWidth={1.9} />
            </button>
          </header>
          <div className="min-h-0 flex-1">
            {error && !data ? (
              <div className="px-4 pt-16 md:px-8">
                <h1 className="display text-4xl">{t("common.offline")}</h1>
                <p className="mt-3 max-w-md text-mute">{t("common.offlineHelp")}</p>
                <button type="button" className="btn btn-primary mt-6 h-11 rounded-full px-6 text-sm font-semibold" onClick={() => void refresh()}>
                  {t("common.retry")}
                </button>
              </div>
            ) : loading && !data ? (
              <div className="px-4 pt-10 text-mute md:px-8" role="status">{t("common.loading")}</div>
            ) : needsPair && !data ? (
              <PairGate />
            ) : (
              children
            )}
          </div>
        </div>
        <nav className="dock order-2 md:order-1" aria-label="PocketPilot">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === "/"}
                onClick={() => {
                  if (gated) setNotice(t("pair.first"));
                }}
              >
                <Icon size={22} strokeWidth={1.75} />
                <span>{t(link.key)}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
      {scan.modal}
      <TaskBanner />
      {notice ? <div className="notice">{notice}</div> : null}
    </div>
  );
}

function PairGate() {
  const { t, pair } = useApp();
  const [code, setCode] = useState("");
  const [origin, setOrigin] = useState("");
  const [failed, setFailed] = useState(false);
  return (
    <div className="pair-wrap app-scroll h-full overflow-y-auto px-4 pb-6 pt-2 md:px-8">
      <div className="hero" aria-hidden="true">
        <span className="hero-icon"><Smartphone size={26} strokeWidth={1.75} /></span>
        <span className="hero-link" />
        <span className="hero-icon hero-icon-main"><Logo size={44} /></span>
      </div>
      <h1 className="display text-3xl">{t("pair.title")}</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-mute">{t("pair.help")}</p>
      <label className="mt-6 block">{t("pair.url")}</label>
      <Input className="mt-2" value={origin} placeholder={t("settings.bridgePh")} onChange={(event) => setOrigin(event.target.value)} />
      <label className="mt-4 block">{t("pair.code")}</label>
      <Input className="mt-2" value={code} autoCapitalize="characters" placeholder={t("settings.pairPh")} onChange={(event) => setCode(event.target.value)} />
      {failed ? <p className="mt-2 text-sm text-coral">{t("settings.pairRemote")}</p> : null}
      <Button className="mt-6 w-full" disabled={code.trim().length < 4} onClick={() => {
        setFailed(false);
        void pair(code, origin).catch(() => setFailed(true));
      }}>{t("pair.go")}</Button>
    </div>
  );
}

export function Mark({ monogram, accent }: { monogram: string; accent: string }) {
  return (
    <span className="mark" style={{ background: accent }}>
      {monogram}
    </span>
  );
}

/** In-app popup for finished / failed tasks while the app is in the foreground. */
function TaskBanner() {
  const [note, setNote] = useState<TaskNote | null>(null);
  useEffect(() => {
    const on = (event: Event) => setNote((event as CustomEvent<TaskNote>).detail);
    window.addEventListener("pocketpilot:task", on);
    return () => window.removeEventListener("pocketpilot:task", on);
  }, []);
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [note]);
  if (!note) return null;
  return (
    <div className={`task-banner task-${note.kind}`} role="status" data-testid="task-banner">
      <span className="task-dot" />
      <div className="min-w-0 flex-1">
        <div className="task-title">{note.title}</div>
        <div className="task-body">{note.body}</div>
      </div>
      <button type="button" aria-label="close" className="task-x" onClick={() => setNote(null)}><X size={16} /></button>
    </div>
  );
}
