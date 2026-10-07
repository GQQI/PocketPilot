import { FolderTree, LayoutGrid, ListOrdered, MessageCircle, Settings } from "lucide-react";
import { NavLink } from "react-router";
import type { ReactNode } from "react";
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
  const { data, loading, error, notice, refresh, t, locale } = useApp();
  return (
    <div className="relative h-dvh">
      <div className="mx-auto flex h-full w-full max-w-[1240px] flex-col md:flex-row">
        <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col md:order-2">
          <header className="flex items-center justify-between px-4 pt-4 pb-2 md:px-8">
            <div className="kicker">MobileAgent</div>
            {data?.settings.demoMode ? <span className="demo-pill">{locale === "zh" ? "演示" : "Demo"}</span> : <span className="live-pill">{locale === "zh" ? "实时" : "Live"}</span>}
          </header>
          <div className="min-h-0 flex-1">
            {error && !data ? (
              <div className="px-4 pt-16 md:px-8">
                <h1 className="display text-4xl">{t("common.offline")}</h1>
                <p className="mt-3 max-w-md text-mute">{t("common.offlineHelp")}</p>
                <button type="button" className="mt-6 rounded-full bg-lime px-4 py-2 text-sm font-medium text-ink" onClick={() => void refresh()}>
                  {t("common.retry")}
                </button>
              </div>
            ) : loading && !data ? (
              <div className="px-4 pt-10 text-mute md:px-8">{t("common.loading")}</div>
            ) : (
              children
            )}
          </div>
        </div>
        <nav className="dock order-2 md:order-1" aria-label="MobileAgent">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <NavLink key={link.to} to={link.to} end={link.to === "/"}>
                <Icon size={18} />
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

export function Mark({ monogram, accent }: { monogram: string; accent: string }) {
  return (
    <span className="mark" style={{ background: accent }}>
      {monogram}
    </span>
  );
}
