import { BarChart3, Bell, ChevronLeft, ChevronRight, Cpu, FileText, FolderOpen, Info, KeyRound, Palette, ShieldCheck, Trash2, Wrench, Bot, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentProject, AgentStatus, AgentUsage } from "@pocketpilot/protocol";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { agentState, statusLabel, needsKey } from "@/components/agent-picker";
import { DevicesPanel } from "@/components/devices-panel";
import { Mark } from "@/components/shell";
import { Button, Input } from "@/components/ui";
import { UsageDetail } from "@/components/usage";
import { api } from "@/lib/api";
import { getPrefs, notifyTask, permissionState, requestPermission, setPrefs, type NotifyPrefs, type PermissionState } from "@/lib/notify";
import { rtcConfigured, rtcHost } from "@/lib/rtc";
import { useApp } from "@/lib/store";
import { APP_VERSION } from "@/lib/version";

/* ------------------------------------------------------------------ building blocks */

function SubPage({ title, back, children, testid }: { title: string; back?: string; children: ReactNode; testid?: string }) {
  const navigate = useNavigate();
  const { t } = useApp();
  return (
    <div className="subpage app-scroll h-full overflow-y-auto" data-testid={testid ?? "subpage"}>
      <div className="sub-head">
        {back ? (
          <button type="button" className="sub-back" aria-label={t("s.back")} onClick={() => navigate(back)}>
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
        ) : null}
        <h1 className="sub-title">{title}</h1>
      </div>
      <div className="px-4 pb-10 md:px-8">{children}</div>
    </div>
  );
}

function Group({ title, children, note }: { title?: string; children: ReactNode; note?: string }) {
  return (
    <section className="mt-5">
      {title ? <h2 className="set-cap">{title}</h2> : null}
      <div className="set-group">{children}</div>
      {note ? <p className="set-note">{note}</p> : null}
    </section>
  );
}

function Row({ icon: Icon, tint, mark, title, value, to, onClick, right, testid }: {
  icon?: LucideIcon; tint?: string; mark?: ReactNode; title: string; value?: string; to?: string; onClick?: () => void; right?: ReactNode; testid?: string;
}) {
  const body = (
    <>
      {mark ?? (Icon ? <span className="set-ico" style={{ background: tint ?? "var(--ma-accent)" }}><Icon size={17} strokeWidth={2} /></span> : null)}
      <span className="set-title">{title}</span>
      {value ? <span className="set-value">{value}</span> : null}
      {right ?? (to || onClick ? <ChevronRight size={18} className="set-chev" /> : null)}
    </>
  );
  if (to) return <Link to={to} className="set-row" data-testid={testid}>{body}</Link>;
  return <button type="button" className="set-row" onClick={onClick} disabled={!onClick} data-testid={testid}>{body}</button>;
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "switch-on" : ""}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/* ------------------------------------------------------------------ router */

export function SettingsRouter() {
  return (
    <Routes>
      <Route index element={<SettingsHome />} />
      <Route path="platforms" element={<PlatformList />} />
      <Route path="platforms/:id" element={<PlatformMenu />} />
      <Route path="platforms/:id/:section" element={<PlatformSection />} />
      <Route path="notifications" element={<NotifyPage />} />
      <Route path="security" element={<SecurityPage />} />
      <Route path="privacy" element={<PrivacyPage />} />
      <Route path="appearance" element={<AppearancePage />} />
      <Route path="about" element={<AboutPage />} />
      <Route path="about/:doc" element={<DocPage />} />
      <Route path="*" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}

/* ------------------------------------------------------------------ level 1 */

function SettingsHome() {
  const { t, agent, overview, data, locale } = useApp();
  const prefs = getPrefs();
  return (
    <div className="subpage app-scroll h-full overflow-y-auto px-4 pb-10 md:px-8" data-testid="settings">
      <h1 className="display !p-0 text-3xl">{t("s.title")}</h1>
      <Group>
        <Row testid="row-platforms" icon={Bot} title={t("s.agents")} value={overview ? t("s.agentsSum", { n: overview.detected, name: agent?.name ?? "—" }) : ""} to="/settings/platforms" />
      </Group>
      <Group>
        <Row testid="row-notify" icon={Bell} title={t("s.notify")} value={prefs.enabled ? t("s.on") : t("s.off")} to="/settings/notifications" />
        <Row icon={ShieldCheck} title={t("s.security")} to="/settings/security" />
        <Row icon={Lock} title={t("s.privacy")} to="/settings/privacy" />
        <Row icon={Palette} title={t("s.appearance")} value={`${data?.settings.theme === "dark" ? t("set.dark") : t("set.light")} · ${locale === "zh" ? "中文" : "English"}`} to="/settings/appearance" />
      </Group>
      <Group>
        <Row icon={Info} title={t("s.about")} value={APP_VERSION} to="/settings/about" />
      </Group>
    </div>
  );
}

/* ------------------------------------------------------------------ platforms: list -> menu -> section */

function PlatformList() {
  const { t, overview, agent } = useApp();
  return (
    <SubPage title={t("s.agents")} back="/settings" testid="platform-list">
      <p className="mt-1 text-sm text-mute">{t("s.agentsHelp")}</p>
      <Group>
        {(overview?.agents ?? []).map((a) => {
          const st = agentState(a.available, a.hasHistory);
          return (
            <Row key={a.id} testid={`plat-${a.id}`} mark={<Mark id={a.id} monogram={a.monogram} accent={a.accent} />} title={a.name}
              value={`${statusLabel(a.available, a.hasHistory, t, needsKey(a))}${a.id === agent?.id ? " ·✓" : ""}`} to={`/settings/platforms/${a.id}`}
              right={<><span className={`dot dot-${st}`} aria-hidden="true" /><ChevronRight size={18} className="set-chev" /></>} />
          );
        })}
      </Group>
    </SubPage>
  );
}

function useAgentParam(): AgentStatus | null {
  const { id = "" } = useParams();
  const { overview } = useApp();
  return overview?.agents.find((a) => a.id === id) ?? null;
}

function PlatformMenu() {
  const { t, selectAgent } = useApp();
  const agent = useAgentParam();
  if (!agent) return <Navigate to="/settings/platforms" replace />;
  const base = `/settings/platforms/${agent.id}`;
  return (
    <SubPage title={agent.name} back="/settings/platforms" testid="platform-menu">
      <div className="plat-head">
        <Mark id={agent.id} monogram={agent.monogram} accent={agent.accent} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{agent.name}</div>
          <div className="truncate text-xs text-mute"><span className={`dot dot-${agentState(agent.available, agent.hasHistory)}`} /> {statusLabel(agent.available, agent.hasHistory, t, needsKey(agent))}{agent.version ? ` · ${agent.version}` : ""}</div>
        </div>
        <Button size="sm" variant="soft" onClick={() => selectAgent(agent.id)}>{t("s.pick.title")}</Button>
      </div>
      <Group>
        <Row testid="sec-conn" icon={KeyRound} title={t("s.pm.conn")} value={agent.auth.state === "ok" ? t("set.authOk") : agent.auth.state === "missing" ? t("set.authMissing") : t("set.authUnknown")} to={`${base}/connection`} />
        <Row testid="sec-model" icon={Cpu} title={t("s.pm.model")} value={agent.defaultModel || "—"} to={`${base}/model`} />
        <Row testid="sec-projects" icon={FolderOpen} title={t("s.pm.projects")} value={agent.canListSessions ? t("s.pm.projSum", { n: agent.projectCount }) : "—"} to={`${base}/projects`} />
        <Row testid="sec-usage" icon={BarChart3} title={t("s.pm.usage")} to={`${base}/usage`} />
        <Row testid="sec-adv" icon={Wrench} title={t("s.pm.adv")} to={`${base}/advanced`} />
      </Group>
    </SubPage>
  );
}

function PlatformSection() {
  const { section = "" } = useParams();
  const agent = useAgentParam();
  const { t } = useApp();
  if (!agent) return <Navigate to="/settings/platforms" replace />;
  const back = `/settings/platforms/${agent.id}`;
  const titles: Record<string, string> = { connection: t("s.pm.conn"), model: t("s.pm.model"), projects: t("s.pm.projects"), usage: t("s.pm.usage"), advanced: t("s.pm.adv") };
  if (!titles[section]) return <Navigate to={back} replace />;
  return (
    <SubPage title={titles[section]} back={back} testid="platform-detail">
      {section === "connection" ? <ConnectionSection agent={agent} /> : null}
      {section === "model" ? <ModelSection agent={agent} /> : null}
      {section === "projects" ? <ProjectsSection agent={agent} /> : null}
      {section === "usage" ? <UsageSection agent={agent} /> : null}
      {section === "advanced" ? <AdvancedSection agent={agent} /> : null}
    </SubPage>
  );
}

function useSave(agent: AgentStatus) {
  const { t, setNotice, refreshAgents } = useApp();
  return useCallback(async (patch: { cliPath?: string; model?: string; apiKey?: string }) => {
    try {
      await api.agentConfig(agent.id, patch);
      await refreshAgents(true);
      setNotice(t("set.saved"));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    }
  }, [agent.id, refreshAgents, setNotice, t]);
}

const LOGIN: Record<string, string> = { cursor: "cursor-agent login", "claude-code": "claude login", codex: "codex login", gemini: "gemini", opencode: "opencode auth login", grok: "grok login" };

function ConnectionSection({ agent }: { agent: AgentStatus }) {
  const { t, refreshAgents } = useApp();
  const save = useSave(agent);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.agentTest(agent.id));
      await refreshAgents(true);
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }
  const authText = agent.auth.state === "ok" ? t("set.authOk") : agent.auth.state === "missing" ? t("set.authMissing") : t("set.authUnknown");
  return (
    <div data-testid="connection">
      {!agent.cliPath ? <InstallGuide agent={agent} /> : null}
      <section className="panel mt-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="!text-base font-semibold">{agent.name}</h2>
          <span className={`pill ${agent.available ? "pill-ok" : "pill-warn"}`}>{statusLabel(agent.available, agent.hasHistory, t, needsKey(agent))}</span>
        </div>
        <dl className="kv mt-3">
          <dt>{t("set.cli")}</dt><dd className="break-all">{agent.cliPath ?? `${agent.cli}（未找到）`}</dd>
          <dt>{t("set.version")}</dt><dd>{agent.version ?? "—"}</dd>
          <dt>{t("set.auth")}</dt><dd><span className={`dot ${agent.auth.state === "ok" ? "dot-ok" : agent.auth.state === "missing" ? "dot-off" : "dot-run"}`} /> {authText}<div className="text-xs text-mute">{agent.auth.note}</div></dd>
        </dl>
        {agent.auth.state !== "ok" && agent.cliPath ? <p className="mt-3 text-xs text-mute">{t(agent.id === "claude-code" ? "i.step2claude" : "i.step2", { login: LOGIN[agent.id] ?? agent.cli })}</p> : null}
        <Button className="mt-3" size="sm" variant="soft" onClick={() => void refreshAgents(true)}>{t("a.recheck")}</Button>
      </section>
      {agent.envKeys.length > 0 ? (
        <section className="panel mt-4 p-4">
          <h2 className="!text-base font-semibold">{t("set.key")}</h2>
          <p className="mt-1 text-xs text-mute">{agent.envKeys.join(" / ")} · {t("set.keyFrom")}: {agent.keySource}</p>
          <p className="mt-2 text-sm font-medium" data-testid="key-state">{agent.keyLast4 ? t("set.keyMasked", { last4: agent.keyLast4 }) : agent.id === "claude-code" ? t("set.keyClaude") : t("set.keyNone")}</p>
          {agent.id === "claude-code" ? <p className="mt-1 text-xs text-mute" data-testid="key-optional">{t("set.keyOptionalClaude")}</p> : null}
          {result ? <p className="mt-1 text-sm" style={{ color: result.ok ? "#1a8f4c" : "#d1453b" }} data-testid="key-test">{result.message}</p> : null}
          <Input className="mt-2" type="password" autoComplete="off" value={key} placeholder={t("set.keyPh")} onChange={(event) => setKey(event.target.value)} />
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="soft" disabled={!key.trim()} onClick={() => void save({ apiKey: key }).then(() => setKey(""))}>{t("set.keySave")}</Button>
            <Button size="sm" variant="ghost" onClick={() => void save({ apiKey: "" })}>{t("set.keyClear")}</Button>
            <Button size="sm" variant="soft" disabled={testing} data-testid="key-test-btn" onClick={() => void runTest()}>{testing ? t("set.testing") : t("set.test")}</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ModelSection({ agent }: { agent: AgentStatus }) {
  const { t } = useApp();
  const save = useSave(agent);
  const [model, setModel] = useState("");
  return (
    <section className="panel mt-4 p-4" data-testid="model">
      <div className="text-xs text-mute">{t("s.model.current")}</div>
      <div className="mt-1 font-semibold">{agent.defaultModel || "—"}</div>
      <p className="mt-3 text-xs text-mute">{t("set.modelHelp")}</p>
      <Input className="mt-2" list={`models-${agent.id}`} value={model} placeholder={agent.defaultModel} onChange={(event) => setModel(event.target.value)} />
      <datalist id={`models-${agent.id}`}>{agent.models.map((m) => <option key={m} value={m} />)}</datalist>
      {agent.models.length > 0 ? (
        <div className="chips mt-3">
          {agent.models.slice(0, 24).map((m) => <button key={m} type="button" className={`chip ${model === m ? "chip-on" : ""}`} onClick={() => setModel(m)}>{m}</button>)}
        </div>
      ) : null}
      <Button className="mt-4" size="sm" disabled={!model.trim()} onClick={() => void save({ model: model.trim() })}>{t("set.save")}</Button>
    </section>
  );
}

function ProjectsSection({ agent }: { agent: AgentStatus }) {
  const { t } = useApp();
  const [projects, setProjects] = useState<AgentProject[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (agent.canListSessions) void api.agentProjects(agent.id).then((rows) => { if (!cancelled) setProjects(rows); }).catch(() => { if (!cancelled) setProjects([]); });
    else setProjects([]);
    return () => { cancelled = true; };
  }, [agent.id, agent.canListSessions]);
  return (
    <section className="panel mt-4 p-4" data-testid="platform-projects">
      {projects === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
      {projects?.length === 0 ? <p className="text-sm text-mute">{t("a.recentEmpty")}</p> : null}
      <ul className="space-y-2">
        {projects?.slice(0, 30).map((p) => (
          <li key={p.path} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0"><span className="block truncate">{p.name}</span><span className="block truncate text-[11px] text-mute">{p.path}</span></span>
            <span className="shrink-0 text-xs text-mute">{p.sessions > 0 ? t("a.projectSessions", { n: p.sessions }) : t("a.projectNone")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UsageSection({ agent }: { agent: AgentStatus }) {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.agentUsage(agent.id).then((u) => { if (!cancelled) setUsage(u); }).catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [agent.id]);
  return (
    <section className="panel mt-4 p-4" data-testid="usage">
      <UsageDetail usage={usage} />
    </section>
  );
}

function AdvancedSection({ agent }: { agent: AgentStatus }) {
  const { t, refreshAgents } = useApp();
  const save = useSave(agent);
  const [cliPath, setCliPath] = useState(agent.configuredCliPath === agent.cli ? "" : agent.configuredCliPath);
  return (
    <section className="panel mt-4 p-4" data-testid="advanced">
      <h2 className="!text-base font-semibold">{t("set.cliPath")}</h2>
      <p className="mt-1 text-xs text-mute">{t("set.cliHelp")}</p>
      <Input className="mt-2" value={cliPath} placeholder={agent.cli} onChange={(event) => setCliPath(event.target.value)} />
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => void save({ cliPath: cliPath.trim() || agent.cli })}>{t("set.save")}</Button>
        <Button size="sm" variant="soft" onClick={() => void refreshAgents(true)}>{t("a.recheck")}</Button>
      </div>
      {agent.dataPath ? <><h2 className="mt-5 !text-base font-semibold">{t("set.data")}</h2><p className="mt-1 break-all text-xs text-mute">{agent.dataPath}</p></> : null}
    </section>
  );
}

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
    <section className="panel install-guide mt-4 p-4" data-testid="install-guide">
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
      <p className="mt-3 text-sm">{t(agent.id === "claude-code" ? "i.step2claude" : "i.step2", { login: LOGIN[agent.id] ?? agent.cli })}</p>
      <p className="mt-1 text-sm">{t("i.step3")}</p>
      {agent.id === "cursor" ? <p className="mt-3 text-xs text-mute">{t("i.ideNote")}</p> : null}
      <div className="mt-3"><a className="text-sm text-accent" href={agent.docsUrl} target="_blank" rel="noreferrer">{t("i.docs")}</a></div>
    </section>
  );
}

/* ------------------------------------------------------------------ notifications */

function NotifyPage() {
  const { t, agent } = useApp();
  const [prefs, setLocal] = useState<NotifyPrefs>(getPrefs);
  const [perm, setPerm] = useState<PermissionState>("prompt");
  useEffect(() => { void permissionState().then(setPerm); }, []);
  const update = (patch: Partial<NotifyPrefs>) => setLocal(setPrefs(patch));
  async function toggleMaster(on: boolean) {
    update({ enabled: on });
    if (on && perm !== "granted") setPerm(await requestPermission());
  }
  const permText = perm === "granted" ? t("s.n.granted") : perm === "denied" ? t("s.n.denied") : perm === "unsupported" ? t("s.n.unsupported") : t("s.n.prompt");
  return (
    <SubPage title={t("s.notify")} back="/settings" testid="notify-page">
      <Group note={t("s.n.masterHelp")}>
        <Row title={t("s.n.master")} right={<Switch on={prefs.enabled} label={t("s.n.master")} onChange={(v) => void toggleMaster(v)} />} testid="n-master" />
      </Group>
      <Group>
        <Row title={t("s.n.system")} right={<Switch on={prefs.system} label={t("s.n.system")} onChange={(v) => update({ system: v })} />} />
        <Row title={t("s.n.inapp")} right={<Switch on={prefs.inapp} label={t("s.n.inapp")} onChange={(v) => update({ inapp: v })} />} />
        <Row title={t("s.n.sound")} right={<Switch on={prefs.sound} label={t("s.n.sound")} onChange={(v) => update({ sound: v })} />} />
      </Group>
      <p className="set-note">{t("s.n.systemHelp")} {t("s.n.inappHelp")} {t("s.n.soundHelp")}</p>
      <Group>
        <Row title={t("s.n.perm")} value={permText} right={perm === "prompt" || perm === "denied" ? <Button size="sm" variant="soft" onClick={() => void requestPermission().then(setPerm)}>{t("s.n.ask")}</Button> : <span />} />
      </Group>
      <Button className="mt-5 w-full" variant="soft" onClick={() => void notifyTask({ title: `${agent?.name ?? "PocketPilot"} · demo`, body: t("s.n.testBody"), kind: "done" })}>{t("s.n.test")}</Button>
    </SubPage>
  );
}

/* ------------------------------------------------------------------ security / privacy / appearance / about */

function SecurityPage() {
  const { t, setNotice } = useApp();
  return (
    <SubPage title={t("s.security")} back="/settings" testid="security-page">
      <h2 className="set-cap mt-4">{t("s.sec.devices")}</h2>
      <DevicesPanel />
      <Group title={t("s.sec.access")} note={t("s.sec.accessHelp")}>
        {rtcConfigured() ? <Row title={t("set.connection")} value={t("set.linked", { host: rtcHost() })} /> : null}
        <Row icon={Trash2} title={t("s.sec.forget")} onClick={() => { api.forgetHost(); setNotice(t("set.forgot")); window.setTimeout(() => window.location.replace("/"), 600); }} />
      </Group>
      <p className="set-note">{t("s.sec.forgetHelp")}</p>
    </SubPage>
  );
}

function PrivacyPage() {
  const { t, setNotice } = useApp();
  const [info, setInfo] = useState<{ dataDir: string; keepHistory: boolean } | null>(null);
  useEffect(() => { void api.privacy().then(setInfo).catch(() => setInfo(null)); }, []);
  async function post(body: { keepHistory?: boolean; clearHistory?: boolean }) {
    setInfo(await api.setPrivacy(body));
  }
  return (
    <SubPage title={t("s.privacy")} back="/settings" testid="privacy-page">
      <Group title={t("s.pri.where")} note={t("s.pri.whereHelp")}>
        <Row title={t("s.pri.dir")} value={info?.dataDir ?? "—"} />
      </Group>
      <Group note={t("s.pri.keepHelp")}>
        <Row title={t("s.pri.keep")} right={<Switch on={info?.keepHistory ?? true} label={t("s.pri.keep")} onChange={(v) => void post({ keepHistory: v })} />} />
      </Group>
      <Group note={`${t("s.pri.clearPcHelp")} ${t("s.pri.clearPhoneHelp")}`}>
        <Row icon={Trash2} title={t("s.pri.clearPc")} onClick={() => { if (window.confirm(t("s.pri.confirm"))) void post({ clearHistory: true }).then(() => setNotice(t("s.pri.cleared"))); }} />
        <Row icon={Trash2} title={t("s.pri.clearPhone")} onClick={() => {
          if (!window.confirm(t("s.pri.confirm"))) return;
          for (const k of Object.keys(localStorage)) if (k.startsWith("pocketpilot.") && !/bridge|token|host|rtc|pair|sid|secret|device/i.test(k)) localStorage.removeItem(k);
          setNotice(t("s.pri.cleared"));
        }} />
      </Group>
    </SubPage>
  );
}

function AppearancePage() {
  const { t, data, locale, replace } = useApp();
  return (
    <SubPage title={t("s.appearance")} back="/settings" testid="appearance-page">
      <Group title={t("s.ap.theme")}>
        <Row title={t("set.light")} right={<Radio on={data?.settings.theme === "light"} />} onClick={() => void api.saveSettings({ theme: "light" }).then(replace)} />
        <Row title={t("set.dark")} right={<Radio on={data?.settings.theme === "dark"} />} onClick={() => void api.saveSettings({ theme: "dark" }).then(replace)} />
      </Group>
      <Group title={t("s.ap.lang")}>
        <Row title="中文" right={<Radio on={locale === "zh"} />} onClick={() => void api.saveSettings({ locale: "zh" }).then(replace)} />
        <Row title="English" right={<Radio on={locale === "en"} />} onClick={() => void api.saveSettings({ locale: "en" }).then(replace)} />
      </Group>
    </SubPage>
  );
}

function Radio({ on }: { on: boolean }) {
  return <span className={`radio ${on ? "radio-on" : ""}`} aria-hidden="true" />;
}

function AboutPage() {
  const { t, setNotice } = useApp();
  return (
    <SubPage title={t("s.about")} back="/settings" testid="about-page">
      <Group>
        <Row title={t("s.about.version")} value={APP_VERSION} />
        <Row title={t("s.about.update")} onClick={() => setNotice(t("s.about.updateHelp"))} />
      </Group>
      <Group>
        <Row icon={FileText} title={t("s.about.terms")} to="/settings/about/terms" />
        <Row icon={FileText} title={t("s.about.privacy")} to="/settings/about/privacy" />
        <Row icon={FileText} title={t("s.about.licenses")} to="/settings/about/licenses" />
      </Group>
    </SubPage>
  );
}

const LICENSES: [string, string][] = [["React", "MIT"], ["React Router", "MIT"], ["Hono", "MIT"], ["Capacitor", "MIT"], ["Electron", "MIT"], ["Tailwind CSS", "MIT"], ["lucide-react", "ISC"], ["Playwright", "Apache-2.0"]];

function DocPage() {
  const { doc = "" } = useParams();
  const { t } = useApp();
  const title = doc === "terms" ? t("s.about.terms") : doc === "privacy" ? t("s.about.privacy") : t("s.about.licenses");
  const body = doc === "terms" ? t("s.terms.body") : doc === "privacy" ? t("s.priv.body") : t("s.lic.body");
  return (
    <SubPage title={title} back="/settings/about" testid="doc-page">
      <div className="sample-flag">{t("s.sample")}</div>
      <p className="doc-body">{body}</p>
      {doc === "licenses" ? <Group>{LICENSES.map(([n, l]) => <Row key={n} title={n} value={l} />)}</Group> : null}
    </SubPage>
  );
}
