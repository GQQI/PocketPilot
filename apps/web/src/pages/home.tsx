import { ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AgentSession } from "@pocketpilot/protocol";
import { AgentPicker, statusLabel } from "@/components/agent-picker";
import { Mark } from "@/components/shell";
import { Button, EmptyState } from "@/components/ui";
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
  return (
    <div data-testid="home" className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8">
      <section className="now-card mt-1" data-testid="agent-count">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="display !p-0 text-2xl">{overview.detected > 0 ? t("a.count", { n: overview.detected }) : t("a.none")}</h1>
            <p className="mt-1 text-sm text-mute">
              {overview.detected === 0 ? t("a.noneHelp") : history === 0 ? t("a.countSubAll") : t("a.countSub", { m: overview.available, k: history })}
            </p>
          </div>
          <Button size="icon" variant="soft" aria-label={t("a.recheck")} disabled={busy} onClick={() => void recheck()}>
            <RefreshCw size={18} className={busy ? "spin" : ""} />
          </Button>
        </div>
        {overview.detected > 0 ? <div className="mt-3"><AgentPicker /></div> : null}
      </section>

      {agent ? (
        <section className="mt-4">
          <div className="flex items-center gap-3">
            <Mark monogram={agent.monogram} accent={agent.accent} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{agent.name}</div>
              <div className="truncate text-xs text-mute">
                {statusLabel(agent.available, agent.hasHistory, t)}
                {agent.version ? ` · ${agent.version}` : ""}
                {agent.canListSessions ? ` · ${t("set.counts", { n: agent.sessionCount, p: agent.projectCount })}` : ""}
              </div>
            </div>
            <Button size="sm" disabled={!agent.available} onClick={() => navigate("/projects")}>
              <Plus size={16} />{t("a.newChat")}
            </Button>
          </div>
          {!agent.available ? <p className="mt-3 text-sm text-mute">{t("a.cliMissing")}</p> : null}

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
        </section>
      ) : null}
    </div>
  );
}
