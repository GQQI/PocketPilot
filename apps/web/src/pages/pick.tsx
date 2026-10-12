import { ChevronLeft, ChevronRight, FolderOpen, Layers, Plus } from "lucide-react";
import type { AgentProject } from "@pocketpilot/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import { agentState, statusLabel, needsKey } from "@/components/agent-picker";
import { Mark } from "@/components/shell";
import { Button, EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useApp } from "@/lib/store";
import { SessionRow, useSessions } from "./home";

function Page({ title, sub, back, action, children, testid }: { title: string; sub?: string; back?: string; action?: ReactNode; children: ReactNode; testid: string }) {
  const navigate = useNavigate();
  const { t } = useApp();
  return (
    <div className="subpage app-scroll h-full overflow-y-auto" data-testid={testid}>
      <div className="sub-head">
        {back ? <button type="button" className="sub-back" aria-label={t("s.back")} onClick={() => navigate(back)}><ChevronLeft size={22} strokeWidth={2} /></button> : null}
        <div className="min-w-0 flex-1">
          <h1 className="sub-title">{title}</h1>
          {sub ? <div className="sub-sub">{sub}</div> : null}
        </div>
        {action}
      </div>
      <div className="px-4 pb-10 md:px-8">{children}</div>
    </div>
  );
}

/** "会话" tab: platform -> project -> session, one level at a time. */
export function ChatFlow() {
  return (
    <Routes>
      <Route path=":agent" element={<ProjectStep />} />
      <Route path=":agent/sessions" element={<SessionStep />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

export function PlatformStep() {
  const { overview, selectAgent, t } = useApp();
  const navigate = useNavigate();
  if (!overview) return null;
  return (
    <div className="subpage app-scroll h-full overflow-y-auto px-4 pb-10 md:px-8" data-testid="sessions">
      <h1 className="display !p-0 text-3xl">{t("s.pick.title")}</h1>
      <p className="mt-1 text-sm text-mute">{t("s.pick.sub")}</p>
      {overview.agents.length === 0 ? <EmptyState text={t("a.noneHelp")} /> : null}
      <div className="set-group mt-4" data-testid="pick-platforms">
        {overview.agents.map((a) => {
          const st = agentState(a.available, a.hasHistory);
          return (
            <button key={a.id} type="button" className="set-row" data-testid={`pick-${a.id}`} onClick={() => { selectAgent(a.id); navigate(`/chat/in/${a.id}`); }}>
              <Mark monogram={a.monogram} accent={a.accent} />
              <span className="min-w-0 flex-1 text-left">
                <span className="set-title block">{a.name}</span>
                <span className="block truncate text-xs text-mute"><span className={`dot dot-${st}`} /> {statusLabel(a.available, a.hasHistory, t, needsKey(a))}{a.canListSessions ? ` · ${t("s.pick.sessions", { n: a.sessionCount, p: a.projectCount })}` : ""}</span>
              </span>
              <ChevronRight size={18} className="set-chev" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function useAgentParam() {
  const { agent: id = "" } = useParams();
  const { overview } = useApp();
  return overview?.agents.find((a) => a.id === id) ?? null;
}

function ProjectStep() {
  const agent = useAgentParam();
  const { t } = useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AgentProject[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setRows(null);
    void api.agentProjects(agent.id).then((r) => { if (!cancelled) setRows(r); }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [agent?.id]);
  if (!agent) return <Navigate to="/chat" replace />;
  const base = `/chat/in/${agent.id}/sessions`;
  const shown = (rows ?? []).filter((p) => !query.trim() || `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Page testid="pick-projects" title={agent.name} sub={t("s.pick.projects")} back="/chat"
      action={<Button size="sm" disabled={!agent.available} onClick={() => navigate("/projects")}><Plus size={16} />{t("a.newChat")}</Button>}>
      <input className="input mt-3" value={query} placeholder={t("a.search")} onChange={(e) => setQuery(e.target.value)} />
      <div className="set-group mt-3">
        <button type="button" className="set-row" onClick={() => navigate(base)}>
          <span className="set-ico" style={{ background: "var(--ma-accent)" }}><Layers size={17} /></span>
          <span className="set-title">{t("s.pick.allSessions")}</span>
          <span className="set-value">{agent.sessionCount}</span>
          <ChevronRight size={18} className="set-chev" />
        </button>
      </div>
      {rows === null ? <p className="mt-4 text-sm text-mute">{t("common.loading")}</p> : null}
      {rows && shown.length === 0 ? <EmptyState text={t("s.pick.noProjects")} icon={FolderOpen} /> : null}
      <div className="set-group mt-3" data-testid="pick-project-list">
        {shown.slice(0, 60).map((p) => (
          <button key={p.path} type="button" className="set-row" onClick={() => navigate(`${base}?project=${encodeURIComponent(p.path)}`)}>
            <span className="set-ico" style={{ background: "#f59f00" }}><FolderOpen size={17} /></span>
            <span className="min-w-0 flex-1 text-left">
              <span className="set-title block truncate">{p.name}</span>
              <span className="block truncate text-xs text-mute">{p.sessions > 0 ? `${t("a.projectSessions", { n: p.sessions })} · ${formatTime(p.updatedAt, t)}` : t("a.projectNone")}</span>
            </span>
            <ChevronRight size={18} className="set-chev" />
          </button>
        ))}
      </div>
    </Page>
  );
}

function SessionStep() {
  const agent = useAgentParam();
  const { t } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const project = params.get("project") ?? undefined;
  const [limit, setLimit] = useState(40);
  const { rows } = useSessions(agent?.id, project, limit);
  if (!agent) return <Navigate to="/chat" replace />;
  const name = project ? project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : t("s.pick.allSessions");
  return (
    <Page testid="pick-sessions" title={name || agent.name} sub={`${agent.name} · ${t("s.pick.sessionsIn")}`} back={`/chat/in/${agent.id}`}
      action={project ? <Button size="sm" disabled={!agent.available} onClick={() => navigate(`/chat/${agent.id}/new?cwd=${encodeURIComponent(project)}`)}><Plus size={16} />{t("a.newChat")}</Button> : undefined}>
      <div className="mt-3 space-y-2">
        {rows === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
        {rows?.length === 0 ? <EmptyState text={t("a.recentEmpty")} /> : null}
        {rows?.map((s) => <SessionRow key={s.id} session={s} onOpen={() => navigate(`/chat/${agent.id}/${s.id}`)} />)}
      </div>
      {rows && rows.length >= limit ? <Button className="mt-4 w-full" variant="soft" onClick={() => setLimit(limit + 40)}>{t("a.more")}</Button> : null}
    </Page>
  );
}
