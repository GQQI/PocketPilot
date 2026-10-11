import { FolderTree, LayoutGrid, ListOrdered, MessageCircle, Monitor, Settings, Smartphone, Sparkles } from "lucide-react";
import { NavLink } from "react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { useApp } from "@/lib/store";
import type { CopyKey } from "@/lib/i18n";

const links: { to: string; key: CopyKey; icon: typeof LayoutGrid }[] = [
  { to: "/", key: "nav.home", icon: LayoutGrid },
  { to: "/chat", key: "nav.chat", icon: MessageCircle },
  { to: "/projects", key: "nav.projects", icon: FolderTree },
  { to: "/queue", key: "nav.queue", icon: ListOrdered },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

export function Shell({ children }: { children: ReactNode }) {
  const { data, loading, error, notice, needsPair, refresh, t, locale, setNotice } = useApp();
  const gated = needsPair && !data;
  return (
    <div className="relative h-dvh">
      <div className="mx-auto flex h-full w-full max-w-[1240px] flex-col md:flex-row">
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
          <header className="app-header flex items-center justify-between px-4 pb-2 md:px-8">
            <div className="brand"><span className="brand-logo"><Sparkles size={14} strokeWidth={2.25} /></span>MobileAgent</div>
            {data?.settings.demoMode ? <span className="demo-pill">{locale === "zh" ? "演示" : "Demo"}</span> : <span className="live-pill">{locale === "zh" ? "实时" : "Live"}</span>}
          </header>
          <div className="page-in min-h-0 flex-1">
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
        <nav className="dock order-2 md:order-1" aria-label="MobileAgent">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === "/"}
                onClick={() => {
                  if (gated) setNotice(locale === "zh" ? "请先完成配对后再使用" : "Pair this device first");
                }}
              >
                <Icon size={22} strokeWidth={1.75} />
                <span>{t(link.key)}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
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
        <span className="hero-icon hero-icon-main"><Monitor size={26} strokeWidth={1.75} /></span>
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
