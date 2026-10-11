import type { AgentProject, AgentStatus, AgentUsage } from "@pocketpilot/protocol";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AgentPicker, statusLabel } from "@/components/agent-picker";
import { Button, Input } from "@/components/ui";
import { UsageDetail } from "@/components/usage";
import { api } from "@/lib/api";
import { rtcConfigured, rtcHost } from "@/lib/rtc";
import { useApp } from "@/lib/store";

export function SettingsPage() {
  const { agent, data, t, locale, replace, setNotice } = useApp();
  return (
    <div data-testid="settings" className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8">
      <h1 className="display !p-0 text-3xl">{t("set.title")}</h1>
      <AgentPicker sticky />
      {agent ? <PlatformDetail key={agent.id} agent={agent} /> : <p className="mt-6 text-sm text-mute">{t("a.noneHelp")}</p>}

      <details className="panel mt-6 p-4" data-testid="general">
        <summary className="cursor-pointer font-semibold">{t("set.general")}</summary>
        <div className="mt-4">
          <div className="text-xs text-mute">{t("set.theme")}</div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant={data?.settings.theme === "light" ? "primary" : "soft"} onClick={() => void api.saveSettings({ theme: "light" }).then(replace)}>{t("set.light")}</Button>
            <Button size="sm" variant={data?.settings.theme === "dark" ? "primary" : "soft"} onClick={() => void api.saveSettings({ theme: "dark" }).then(replace)}>{t("set.dark")}</Button>
          </div>
        </div>
        <div className="mt-4">
          <div className="text-xs text-mute">{t("set.lang")}</div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant={locale === "zh" ? "primary" : "soft"} onClick={() => void api.saveSettings({ locale: "zh" }).then(replace)}>中文</Button>
            <Button size="sm" variant={locale === "en" ? "primary" : "soft"} onClick={() => void api.saveSettings({ locale: "en" }).then(replace)}>English</Button>
          </div>
        </div>
        <div className="mt-4">
          <div className="text-xs text-mute">{t("set.connection")}</div>
          {rtcConfigured() ? <p className="mt-1 text-sm">{t("set.linked", { host: rtcHost() })}</p> : null}
          <Button className="mt-2" size="sm" variant="danger" onClick={() => { api.forgetHost(); setNotice(t("set.forgot")); window.setTimeout(() => window.location.replace("/"), 600); }}>{t("set.forget")}</Button>
        </div>
      </details>
    </div>
  );
}

function PlatformDetail({ agent }: { agent: AgentStatus }) {
  const { t, setNotice, refreshAgents } = useApp();
  const [cliPath, setCliPath] = useState(agent.configuredCliPath === agent.cli ? "" : agent.configuredCliPath);
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [projects, setProjects] = useState<AgentProject[] | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (agent.canListSessions) void api.agentProjects(agent.id).then((rows) => { if (!cancelled) setProjects(rows); }).catch(() => { if (!cancelled) setProjects([]); });
    else setProjects([]);
    void api.agentUsage(agent.id).then((u) => { if (!cancelled) setUsage(u); }).catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [agent.id, agent.canListSessions]);

  async function save(patch: { cliPath?: string; model?: string; apiKey?: string }) {
    try {
      await api.agentConfig(agent.id, patch);
      await refreshAgents(true);
      setKey("");
      setNotice(t("set.saved"));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const authText = agent.auth.state === "ok" ? t("set.authOk") : agent.auth.state === "missing" ? t("set.authMissing") : t("set.authUnknown");
  return (
    <div className="mt-4 space-y-4" data-testid="platform-detail">
      {!agent.cliPath ? <InstallGuide agent={agent} /> : null}
      <section className="panel p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="!text-base font-semibold">{agent.name}</h2>
          <span className={`pill ${agent.available ? "pill-ok" : "pill-warn"}`}>{statusLabel(agent.available, agent.hasHistory, t)}</span>
        </div>
        <dl className="kv mt-3">
          <dt>{t("set.cli")}</dt><dd className="break-all">{agent.cliPath ?? `${agent.cli}（未找到）`}</dd>
          <dt>{t("set.version")}</dt><dd>{agent.version ?? "—"}</dd>
          <dt>{t("set.auth")}</dt><dd><span className={`dot ${agent.auth.state === "ok" ? "dot-ok" : agent.auth.state === "missing" ? "dot-off" : "dot-run"}`} /> {authText}<div className="text-xs text-mute">{agent.auth.note}</div></dd>
          <dt>{t("set.model")}</dt><dd>{agent.defaultModel || "—"}</dd>
          {agent.dataPath ? (<><dt>{t("set.data")}</dt><dd className="break-all text-xs">{agent.dataPath}</dd></>) : null}
          {agent.canListSessions ? (<><dt>{t("nav.chat")}</dt><dd>{t("set.counts", { n: agent.sessionCount, p: agent.projectCount })}</dd></>) : null}
        </dl>
      </section>

      <section className="panel p-4">
        <h2 className="!text-base font-semibold">{t("set.cliPath")}</h2>
        <p className="mt-1 text-xs text-mute">{t("set.cliHelp")}</p>
        <Input className="mt-2" value={cliPath} placeholder={agent.cli} onChange={(event) => setCliPath(event.target.value)} />
        <h2 className="mt-4 !text-base font-semibold">{t("set.model")}</h2>
        <p className="mt-1 text-xs text-mute">{t("set.modelHelp")}</p>
        <Input className="mt-2" list={`models-${agent.id}`} value={model} placeholder={agent.defaultModel} onChange={(event) => setModel(event.target.value)} />
        <datalist id={`models-${agent.id}`}>{agent.models.map((m) => <option key={m} value={m} />)}</datalist>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void save({ cliPath: cliPath.trim() || agent.cli, ...(model.trim() ? { model: model.trim() } : {}) })}>{t("set.save")}</Button>
          <Button size="sm" variant="soft" onClick={() => void refreshAgents(true)}>{t("a.recheck")}</Button>
        </div>
        {agent.envKeys.length > 0 ? (
          <div className="mt-5">
            <h2 className="!text-base font-semibold">{t("set.key")}</h2>
            <p className="mt-1 text-xs text-mute">{agent.envKeys.join(" / ")} · {t("set.keyFrom")}: {agent.keySource}</p>
            <Input className="mt-2" type="password" autoComplete="off" value={key} placeholder={t("set.keyPh")} onChange={(event) => setKey(event.target.value)} />
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="soft" disabled={!key.trim()} onClick={() => void save({ apiKey: key })}>{t("set.keySave")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void save({ apiKey: "" })}>{t("set.keyClear")}</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel p-4" data-testid="platform-projects">
        <div className="flex items-center justify-between">
          <h2 className="!text-base font-semibold">{t("set.projects")}</h2>
          <Link className="text-sm text-accent" to="/projects">{t("set.projectsAll")}</Link>
        </div>
        {projects === null ? <p className="mt-2 text-sm text-mute">{t("common.loading")}</p> : null}
        {projects?.length === 0 ? <p className="mt-2 text-sm text-mute">{t("a.recentEmpty")}</p> : null}
        <ul className="mt-2 space-y-1">
          {projects?.slice(0, 5).map((p) => (
            <li key={p.path} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-xs text-mute">{p.sessions > 0 ? t("a.projectSessions", { n: p.sessions }) : t("a.projectNone")}</span>
            </li>
          ))}
        </ul>
      </section>

      <UsageCard usage={usage} />
    </div>
  );
}

function UsageCard({ usage }: { usage: AgentUsage | null }) {
  const { t } = useApp();
  return (
    <section className="panel p-4" data-testid="usage">
      <h2 className="!text-base font-semibold">{t("set.usage")}</h2>
      <UsageDetail usage={usage} />
    </section>
  );
}

const LOGIN: Record<string, string> = { cursor: "cursor-agent login", "claude-code": "claude login", codex: "codex login", gemini: "gemini", opencode: "opencode auth login" };

function InstallGuide({ agent }: { agent: AgentStatus }) {
  const { t, setNotice } = useApp();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(agent.installCmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice(agent.installCmd);
    }
  }
  return (
    <section className="panel install-guide p-4" data-testid="install-guide">
      <h2 className="!text-base font-semibold">{t("i.title")}</h2>
      <p className="mt-1 text-sm text-mute">{t("i.lead", { name: agent.name })}</p>
      {agent.installCmd ? (
        <>
          <p className="mt-3 text-sm">{t("i.step1")}</p>
          <div className="cmd-box">
            <code>{agent.installCmd}</code>
            <button type="button" className="cmd-copy" onClick={() => void copy()}>{copied ? t("i.copied") : t("i.copy")}</button>
          </div>
        </>
      ) : null}
      <p className="mt-3 text-sm">{t("i.step2", { login: LOGIN[agent.id] ?? agent.cli })}</p>
      <p className="mt-1 text-sm">{t("i.step3")}</p>
      {agent.id === "cursor" ? <p className="mt-3 text-xs text-mute">{t("i.ideNote")}</p> : null}
      <div className="mt-3"><a className="text-sm text-accent" href={agent.docsUrl} target="_blank" rel="noreferrer">{t("i.docs")}</a></div>
    </section>
  );
}
