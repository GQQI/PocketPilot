import type { FileContent, FileEntry } from "@mobileagent/protocol";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";

export function ProjectsPage() {
  const { data, t } = useApp();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  if (!data) return null;
  const active = data.settings.activeProviderId;
  const projects = all ? data.projects : data.projects.filter((project) => project.providerId === active);
  return (
    <div data-testid="projects" className="app-scroll h-full overflow-y-auto px-4 pb-6 md:px-8">
      <div className="flex items-end justify-between gap-3">
        <h1 className="display text-4xl">{t("projects.title")}</h1>
        <button type="button" className="text-sm text-accent" onClick={() => setAll((value) => !value)}>
          {all ? t("projects.mine") : t("projects.all")}
        </button>
      </div>
      <div className="mt-5 space-y-3">
        {projects.length === 0 ? <p className="text-sm text-mute">{t("projects.empty")}</p> : null}
        {projects.map((project) => {
          const provider = data.providers.find((item) => item.meta.id === project.providerId);
          return (
            <button key={project.id} type="button" className="row-card block w-full px-4 py-4 text-left" onClick={() => navigate(`/projects/${project.id}`)}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{project.name}</span>
                <span className="text-xs text-mute">{provider?.meta.name}</span>
              </div>
              <p className="mt-1 text-sm text-mute">{project.summary}</p>
              <p className="mt-2 text-xs text-mute">{project.branch || "—"} · {project.changes.length} · {t("projects.stats", { files: project.stats.files, loc: project.stats.loc })}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const { data, t, replace, setNotice } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dir = params.get("dir") ?? "";
  const selected = params.get("file");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [message, setMessage] = useState("");
  const project = data?.projects.find((item) => item.id === projectId);

  useEffect(() => {
    void api.files(projectId, dir).then(setEntries).catch(() => setEntries([]));
  }, [projectId, dir]);

  useEffect(() => {
    if (!selected) {
      setFile(null);
      return;
    }
    void api.file(projectId, selected).then(setFile).catch(() => setFile(null));
  }, [projectId, selected]);

  if (!data || !project) return <div className="px-4 pt-8 text-mute">{t("projects.empty")}</div>;

  return (
    <div className="app-scroll h-full overflow-y-auto px-4 pb-6 md:px-8">
      <button type="button" className="text-sm text-mute" onClick={() => navigate("/projects")}>{t("projects.back")}</button>
      <h1 className="display mt-2 text-4xl">{project.name}</h1>
      <p className="mt-2 text-sm text-mute">{project.path}</p>
      <p className="mt-1 text-sm text-mute">{project.branch} · {t("projects.stats", { files: project.stats.files, loc: project.stats.loc })}</p>

      <section className="panel mt-4 p-4">
        <h2 className="text-sm text-mute">{t("projects.changes")}</h2>
        {project.changes.length === 0 ? <p className="mt-2 text-sm">{t("projects.clean")}</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {project.changes.map((change) => <li key={change.path}><span className="text-accent">{change.status}</span> {change.path}</li>)}
          </ul>
        )}
        {data.settings.demoMode && project.changes.length > 0 ? (
          <form className="mt-3 flex gap-2" onSubmit={(event) => {
            event.preventDefault();
            void api.commit(project.id, message).then((next) => {
              replace(next);
              setMessage("");
              setNotice(t("shell.noticeCommit"));
            });
          }}>
            <Input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={t("projects.commitPh")} />
            <Button type="submit" size="sm">{t("projects.commit")}</Button>
          </form>
        ) : null}
      </section>

      <div className="mt-4 grid gap-3 lg:grid-cols-[240px_1fr]">
        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-mute">
            <span>{t("projects.files")}</span>
            {dir ? <button type="button" onClick={() => setParams(dir.includes("/") ? { dir: dir.slice(0, dir.lastIndexOf("/")) } : {})}>{t("projects.back")}</button> : null}
          </div>
          <ul className="space-y-1">
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="w-full truncate rounded-xl px-2 py-2 text-left text-sm hover:bg-soft"
                  onClick={() => {
                    if (entry.kind === "dir") setParams({ dir: entry.path });
                    else setParams(dir ? { dir, file: entry.path } : { file: entry.path });
                  }}
                >
                  {entry.kind === "dir" ? "▸ " : ""}{entry.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel min-h-48 p-4">
          {file ? (
            <>
              <div className="mb-2 text-xs text-mute">{file.path}</div>
              <pre className="code-block whitespace-pre-wrap">{file.content}</pre>
            </>
          ) : <p className="text-sm text-mute">{project.summary}</p>}
        </section>
      </div>
    </div>
  );
}
