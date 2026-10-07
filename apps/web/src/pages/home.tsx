import type { HealthState } from "@mobileagent/protocol";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Mark } from "@/components/shell";
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
  const { data, t, blurb, selectProvider, replace } = useApp();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  if (!data) return null;
  const active = data.settings.activeProviderId;
  const provider = data.providers.find((item) => item.meta.id === active) ?? data.providers[0];
  const sessions = data.sessions.filter((session) => session.providerId === active);
  const current = sessions[0];
  const project = data.projects.find((item) => item.id === current?.projectId);

  return (
    <div data-testid="home" className="app-scroll h-full overflow-y-auto px-4 pb-6 md:px-8">
      <h1 className="display text-[2.6rem] leading-none">{t("home.title")}</h1>
      <p className="mt-3 max-w-xl text-mute">{t("home.subtitle")}</p>
      <p className="mt-2 text-sm text-lime">{healthSummary(data.providers.map((item) => item.health.state), t)}</p>

      {current && provider ? (
        <section className="now-card mt-5">
          <div className="kicker">{t("home.now")}</div>
          <div className="mt-3 flex items-center gap-3">
            <Mark monogram={provider.meta.monogram} accent={provider.meta.accent} />
            <div>
              <div className="text-sm text-mute">{provider.meta.name}</div>
              <h2 className="display text-3xl leading-tight">{current.title}</h2>
            </div>
          </div>
          <p className="mt-3 text-sm text-ivory/80">{current.preview}</p>
          <div className="mt-4 flex items-center justify-between gap-3 text-xs text-mute">
            <span>{project?.name} · {formatTime(current.updatedAt, t)}</span>
            <button type="button" className="rounded-full bg-lime px-3 py-2 text-sm font-medium text-ink" onClick={() => navigate(`/chat/${current.id}`)}>
              {t("home.continue")}
            </button>
          </div>
        </section>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm text-mute">{t("home.agents")}</h2>
        <button
          type="button"
          className="text-sm text-lime disabled:opacity-40"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void api.probeAll().then(replace).finally(() => setChecking(false));
          }}
        >
          {t("home.recheck")}
        </button>
      </div>
      <div data-testid="agent-switcher" className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
        {data.providers.map((item) => (
          <button
            key={item.meta.id}
            type="button"
            className={item.meta.id === active ? "agent-card agent-card-active" : "agent-card"}
            onClick={() => void selectProvider(item.meta.id)}
          >
            <div className="flex items-center gap-2">
              <Mark monogram={item.meta.monogram} accent={item.meta.accent} />
              <div className="min-w-0">
                <div className="text-sm font-medium leading-tight">{item.meta.name}</div>
                <div className="text-xs text-mute">{t(healthKey[item.health.state])} · {item.health.latencyMs ?? "–"} ms</div>
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-mute">{blurb(item.meta.id)}</p>
          </button>
        ))}
      </div>

      <h2 className="mt-6 text-sm text-mute">{t("home.recent")}</h2>
      <div className="mt-3 space-y-2">
        {sessions.length === 0 ? <p className="text-sm text-mute">{t("home.empty")}</p> : null}
        {sessions.slice(0, 4).map((session) => (
          <button key={session.id} type="button" className="row-card block w-full px-4 py-3 text-left" onClick={() => navigate(`/chat/${session.id}`)}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{session.title}</span>
              <span className="text-xs text-mute">{formatTime(session.updatedAt, t)}</span>
            </div>
            <p className="mt-1 truncate text-sm text-mute">{session.preview}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function healthSummary(states: HealthState[], t: (key: CopyKey, vars?: Record<string, string | number>) => string) {
  const tally = { healthy: 0, degraded: 0, offline: 0, standby: 0 };
  for (const state of states) tally[state] += 1;
  return [
    tally.healthy ? t("home.healthy", { n: tally.healthy }) : "",
    tally.degraded ? t("home.degraded", { n: tally.degraded }) : "",
    tally.offline ? t("home.offline", { n: tally.offline }) : "",
    tally.standby ? t("home.standby", { n: tally.standby }) : "",
  ].filter(Boolean).join(" · ");
}
