import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AgentSession, AgentUsage, UsageBucket } from "@pocketpilot/protocol";
import { AgentPicker, agentState, statusLabel, needsKey } from "@/components/agent-picker";
import { money, UsageDetail, useAllUsage } from "@/components/usage";
import { compact } from "@/lib/format";
import { Mark } from "@/components/shell";
import { EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useApp } from "@/lib/store";

export function SessionRow({ session, onOpen }: { session: AgentSession; onOpen: () => void }) {
  const { t } = useApp();
  return (
    <button type="button" className="row-card flex w-full items-center gap-3 p-3 text-left" onClick={onOpen}>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{session.title}</div>
        <div className="mt-0.5 truncate text-xs text-mute">
          {session.projectName || t("a.noProject")} · {formatTime(session.updatedAt, t)}
          {session.messageCount >= 0 ? ` · ${t("a.msgs", { n: session.messageCount })}` : ""}
        </div>
        {session.preview ? <div className="mt-1 truncate text-xs text-mute">{session.preview}</div> : null}
      </div>
      <ChevronRight size={18} className="shrink-0 text-mute" />
    </button>
  );
}

export function useSessions(agentId: string | undefined, project?: string, limit = 12) {
  const [rows, setRows] = useState<AgentSession[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setRows(null);
    setError("");
    void api.agentSessions(agentId, project, limit).then((next) => {
      if (!cancelled) setRows(next);
    }).catch((caught: unknown) => {
      if (!cancelled) { setRows([]); setError(caught instanceof Error ? caught.message : String(caught)); }
    });
    return () => { cancelled = true; };
  }, [agentId, project, limit]);
  return { rows, error };
}

export function HomePage() {
  const { overview, agent, t, refreshAgents, setNotice } = useApp();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { rows } = useSessions(agent?.id, undefined, 8);
  const ids = (overview?.agents ?? []).map((a) => a.id);
  const usageMap = useAllUsage(ids);

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      await refreshAgents(true);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [refreshAgents, setNotice]);

  if (!overview) return null;
  const history = overview.detected - overview.available;
  const state = agent ? agentState(agent.available, agent.hasHistory) : "missing";
  const total = totals(overview.agents.map((a) => usageMap[a.id]));
  return (
    <div data-testid="home" className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8">
      <section className="hero-card" data-testid="agent-count">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="hero-kicker">{t("a.current")}</div>
            <h1 className="hero-title">{overview.detected > 0 ? t("a.count", { n: overview.detected }) : t("a.none")}</h1>
            <p className="hero-sub">
              {overview.detected === 0 ? t("a.noneHelp") : history === 0 ? t("a.countSubAll") : t("a.countSub", { m: overview.available, k: history })}
            </p>
          </div>
          <button type="button" className="hero-btn" aria-label={t("a.recheck")} disabled={busy} onClick={() => void recheck()}>
            <RefreshCw size={18} className={busy ? "spin" : ""} />
          </button>
        </div>
        {agent ? (
          <div className="hero-agent" data-testid="current-agent">
            <Mark monogram={agent.monogram} accent={agent.accent} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{agent.name}</div>
              <div className="hero-agent-sub"><span className={`dot dot-${state}`} />{statusLabel(agent.available, agent.hasHistory, t, needsKey(agent))}{agent.version ? ` · ${agent.version}` : ""}</div>
            </div>
            <button type="button" className="hero-new" onClick={() => navigate(agent.available ? "/projects" : "/settings")}>
              {agent.available ? <><Plus size={16} />{t("a.newChat")}</> : t("set.title")}
            </button>
          </div>
        ) : null}
      </section>

      {overview.agents.length > 0 ? <div className="mt-3"><AgentPicker /></div> : null}

      {agent ? (
        <>
          {!agent.available ? <p className="mt-3 text-sm text-mute">{t("a.cliMissing")}</p> : null}

          <section className="mt-6" data-testid="home-usage">
            <h2 className="text-mute">{t("u.title")}</h2>
            <div className="plat-cards app-scroll mt-2">
              <div className="plat-card plat-card-total">
                <div className="text-xs font-semibold opacity-80">{t("u.total")}</div>
                <div className="plat-big">{compact(total.today)}<span>{t("set.today")}</span></div>
                <div className="plat-line">{t("set.week")} {compact(total.week)} · {t("set.month")} {compact(total.month)}</div>
                <div className="plat-line">{total.cost === null ? t("set.costNone") : `≈$${total.cost.toFixed(2)} ${t("u.est")}`} · {t("set.month")}</div>
              </div>
              {overview.agents.map((a) => {
                const u = usageMap[a.id];
                return (
                  <div key={a.id} className={`plat-card ${a.id === agent.id ? "plat-card-on" : ""}`}>
                    <div className="flex items-center gap-2"><Mark monogram={a.monogram} accent={a.accent} /><span className="truncate text-sm font-semibold">{a.name}</span></div>
                    {u === undefined ? <div className="plat-line mt-2">{t("set.usageLoading")}</div> : u === null || !u.supported ? (
                      <div className="plat-line mt-2">{t("set.noUsage")}</div>
                    ) : u.hasTokens ? (
                      <>
                        <div className="plat-big">{compact((u.today?.inputTokens ?? 0) + (u.today?.outputTokens ?? 0))}<span>{t("set.today")}</span></div>
                        <div className="plat-line">{t("set.month")} {compact((u.month?.inputTokens ?? 0) + (u.month?.outputTokens ?? 0))}</div>
                        <div className="plat-line">{money(u.month, u.costEstimated, t)}{u.costEstimated && u.month?.costUsd != null ? ` ${t("u.est")}` : ""}</div>
                      </>
                    ) : (
                      <>
                        <div className="plat-big">{u.today?.requests ?? 0}<span>{t("set.req")} · {t("set.today")}</span></div>
                        <div className="plat-line">{t("u.reqOnly", { n: u.month?.requests ?? 0 })} · {t("set.month")}</div>
                        <div className="plat-line">{t("u.noData")}: token / {t("set.cost")}</div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="panel mt-3 p-4" data-testid="home-usage-detail">
              <div className="text-sm font-semibold">{agent.name} · {t("u.current")}</div>
              <UsageDetail usage={usageMap[agent.id] ?? null} />
            </div>
            <p className="mt-2 text-[11px] text-mute">{t("u.totalNote")}</p>
          </section>

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-mute">{t("a.recent")}</h2>
            <Link to="/chat" className="text-sm text-accent">{t("a.all")}</Link>
          </div>
          <div className="mt-2 space-y-2" data-testid="recent-sessions">
            {rows === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
            {rows?.length === 0 ? <EmptyState text={agent.canListSessions ? t("a.recentEmpty") : t("set.noUsage")} /> : null}
            {rows?.map((session) => (
              <SessionRow key={session.id} session={session} onOpen={() => navigate(`/chat/${agent.id}/${session.id}`)} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function totals(list: (AgentUsage | null | undefined)[]) {
  const out = { today: 0, week: 0, month: 0, cost: null as number | null };
  for (const u of list) {
    if (!u || !u.supported || !u.hasTokens) continue;
    const sum = (b: UsageBucket | null) => (b ? b.inputTokens + b.outputTokens : 0);
    out.today += sum(u.today); out.week += sum(u.week); out.month += sum(u.month);
    if (u.month?.costUsd != null) out.cost = (out.cost ?? 0) + u.month.costUsd;
  }
  return out;
}
