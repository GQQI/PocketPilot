import { ChevronRight, FolderOpen, FolderSearch, Plus } from "lucide-react";
import type { AgentProject } from "@pocketpilot/protocol";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AgentPicker } from "@/components/agent-picker";
import { DirectoryPicker } from "@/components/directory-picker";
import { Button, EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useApp } from "@/lib/store";
import { SessionRow, useSessions } from "./home";

/** "项目" tab: folders this platform has really opened on the PC. */
export function ProjectsPage() {
  const { agent, t } = useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<AgentProject[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setRows(null);
    void api.agentProjects(agent.id).then((next) => { if (!cancelled) setRows(next); }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [agent?.id]);

  if (!agent) return <div className="px-4 pt-8 text-mute md:px-8">{t("a.none")}</div>;
  const shown = (rows ?? []).filter((p) => !query.trim() || `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8" data-testid="projects">
      <h1 className="display !p-0 text-3xl">{t("a.projects")}</h1>
      <p className="mt-1 text-sm text-mute">{t("a.projectsHelp")}</p>
      <div className="mt-3"><AgentPicker /></div>
      <input className="input mt-3" value={query} placeholder={t("a.search")} onChange={(event) => setQuery(event.target.value)} />
      <Button className="mt-3 w-full" variant="soft" disabled={!agent.available} onClick={() => setPicking(true)}><FolderSearch size={18} />{t("a.pickOther")}</Button>
      <div className="mt-3 space-y-2">
        {rows === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
        {rows && shown.length === 0 ? <EmptyState text={t("a.recentEmpty")} icon={FolderOpen} /> : null}
        {shown.slice(0, limit).map((project) => (
          <button key={project.path} type="button" className="row-card flex w-full items-center gap-3 p-3 text-left" onClick={() => navigate(`/projects/view?path=${encodeURIComponent(project.path)}`)}>
            <span className="empty-icon !h-10 !w-10 shrink-0"><FolderOpen size={18} /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{project.name}</div>
              <div className="truncate text-xs text-mute">{project.path}</div>
              <div className="mt-0.5 text-xs text-mute">
                {project.sessions > 0 ? `${t("a.projectSessions", { n: project.sessions })} · ${formatTime(project.updatedAt, t)}` : t("a.projectNone")}
                {project.exists ? "" : ` · ${t("a.projectGone")}`}
              </div>
            </div>
            <ChevronRight size={18} className="shrink-0 text-mute" />
          </button>
        ))}
      </div>
      {rows && shown.length > limit ? <Button className="mt-4 w-full" variant="soft" onClick={() => setLimit(limit + 40)}>{t("a.more")}</Button> : null}
      <DirectoryPicker open={picking} onOpenChange={setPicking} onPick={(path) => navigate(`/projects/view?path=${encodeURIComponent(path)}`)} />
    </div>
  );
}

/** One project: its real sessions on this platform, plus "new chat here". */
export function ProjectPage() {
  const { agent, t } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const { rows } = useSessions(agent?.id, path, 60);
  if (!agent) return null;
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return (
    <div className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8" data-testid="project">
      <h1 className="display !p-0 text-3xl">{name}</h1>
      <p className="mt-1 break-all text-xs text-mute">{path}</p>
      <Button className="mt-4 w-full" disabled={!agent.available} onClick={() => navigate(`/chat/${agent.id}/new?cwd=${encodeURIComponent(path)}`)}><Plus size={18} />{t("a.startHere")}</Button>
      {!agent.available ? <p className="mt-2 text-sm text-mute">{t("a.cliMissing")}</p> : null}
      <h2 className="mt-6 text-mute">{t("a.sessionsIn")}</h2>
      <div className="mt-2 space-y-2">
        {rows === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
        {rows?.length === 0 ? <EmptyState text={t("a.projectNone")} /> : null}
        {rows?.map((session) => <SessionRow key={session.id} session={session} onOpen={() => navigate(`/chat/${agent.id}/${session.id}`)} />)}
      </div>
    </div>
  );
}
