import type { HealthState, HostView } from "@mobileagent/protocol";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { DirectoryPicker } from "@/components/directory-picker";
import { Mark } from "@/components/shell";
import { Button, Modal, EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { CopyKey } from "@/lib/i18n";
import { useApp } from "@/lib/store";

const healthKey: Record<HealthState, CopyKey> = {
  healthy: "health.healthy",
  degraded: "health.degraded",
  offline: "health.offline",
  standby: "health.standby",
};

export function HomePage() {
  const { data, t, blurb, selectProvider } = useApp();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [host, setHost] = useState<HostView | null>(null);
  useEffect(() => {
    void api.host().then(setHost).catch(() => setHost(null));
  }, [data?.settings.workspacePath, data?.settings.demoMode]);

  if (!data) return null;
  const active = data.settings.activeProviderId;
  const provider = data.providers.find((item) => item.meta.id === active) ?? data.providers[0];
  const sessions = data.sessions.filter((session) => session.providerId === active);
  const current = sessions[0];
  const folder = data.settings.workspacePath;

  return (
    <div data-testid="home" className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8">
      <h1 className="display text-3xl leading-tight">{t("home.title")}</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-mute">{t("home.subtitle")}</p>

      <section className="panel mt-6 p-4">
        <div className="text-xs text-mute">{t("home.computer")}</div>
        <h2 className="mt-1 text-lg font-medium">{host?.name ?? "…"}</h2>
        <p className="mt-1 text-sm text-mute">{host?.paired ? t("settings.pairHint") : t("settings.phoneHelp")}</p>
        <div className="mt-4 text-xs text-mute">{t("home.directory")}</div>
        <p className="mt-1 break-all text-sm">{folder || t("home.noDirectory")}</p>
        <Button className="mt-4" variant="soft" onClick={() => setPicking(true)}>{t("home.pickDirectory")}</Button>
      </section>

      {provider ? (
        <section className="panel mt-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-mute">{t("home.roster", { n: data.providers.length })}</div>
            <button type="button" className="text-sm text-accent" data-testid="open-agents" onClick={() => setAgentsOpen(true)}>{t("home.changeAgent")}</button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Mark monogram={provider.meta.monogram} accent={provider.meta.accent} />
            <div>
              <h2 className="text-lg font-medium">{provider.meta.name}</h2>
              <p className="text-sm text-mute">{t(healthKey[provider.health.state])} · {blurb(provider.meta.id)}</p>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-mute">{t("home.outputHint")}</p>
        </section>
      ) : null}

      <h2 className="mt-6 text-sm text-mute">{t("home.recent")}</h2>
      <div className="mt-3 space-y-2">
        {sessions.length === 0 ? <EmptyState text={t("home.empty")} /> : null}
        {sessions.slice(0, 4).map((session) => (
          <button key={session.id} type="button" className="row-card block w-full px-4 py-3 text-left" onClick={() => navigate(`/chat/${session.id}`)}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{session.title}</span>
              <span className="text-xs text-mute">{formatTime(session.updatedAt, t)}</span>
            </div>
            <p className="mt-1 truncate text-sm text-mute">{session.preview}</p>
          </button>
        ))}
        {current ? (
          <Button className="mt-2" onClick={() => navigate(`/chat/${current.id}`)}>{t("home.continue")}</Button>
        ) : null}
      </div>

      <Modal open={agentsOpen} onOpenChange={setAgentsOpen} title={t("home.pickAgent")}>
        <div data-testid="agent-switcher" className="space-y-2">
          {data.providers.map((item) => (
            <button
              key={item.meta.id}
              type="button"
              className={item.meta.id === active ? "agent-card agent-card-active w-full" : "agent-card w-full"}
              onClick={() => {
                void selectProvider(item.meta.id).then(() => setAgentsOpen(false));
              }}
            >
              <div className="flex items-center gap-3">
                <Mark monogram={item.meta.monogram} accent={item.meta.accent} />
                <div className="min-w-0 text-left">
                  <div className="text-sm font-medium">{item.meta.name}</div>
                  <div className="text-xs text-mute">{t(healthKey[item.health.state])} · {item.meta.cli}</div>
                  <p className="mt-1 text-xs leading-5 text-mute">{blurb(item.meta.id)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </Modal>
      <DirectoryPicker open={picking} onOpenChange={setPicking} />
    </div>
  );
}
