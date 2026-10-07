import type { ProviderConfig, ProviderView } from "@mobileagent/protocol";
import { useEffect, useState } from "react";
import { Button, Input, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";

export function SettingsPage() {
  const { data, t, replace, setNotice, locale } = useApp();
  const [configs, setConfigs] = useState<Record<string, ProviderConfig>>({});
  const [workspacePath, setWorkspacePath] = useState("");
  const [demoMode, setDemoMode] = useState(true);
  const [keys, setKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    setConfigs(Object.fromEntries(data.providers.map((provider) => [provider.meta.id, provider.config])));
    setWorkspacePath(data.settings.workspacePath);
    setDemoMode(data.settings.demoMode);
  }, [data]);

  if (!data) return null;

  function update(id: string, patch: Partial<ProviderConfig>) {
    setConfigs((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  return (
    <div data-testid="settings" className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8">
      <h1 className="display text-4xl">{t("settings.title")}</h1>
      <section className="panel mt-5 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">{t("settings.demo")}</h2>
            <p className="mt-1 text-sm text-mute">{t("settings.demoHelp")}</p>
          </div>
          <Toggle checked={demoMode} label={t("settings.demo")} onCheckedChange={setDemoMode} />
        </div>
        <div className="mt-4">
          <div className="text-xs text-mute">{t("settings.language")}</div>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant={locale === "zh" ? "primary" : "soft"} onClick={() => void api.saveSettings({ locale: "zh" }).then(replace)}>中文</Button>
            <Button type="button" size="sm" variant={locale === "en" ? "primary" : "soft"} onClick={() => void api.saveSettings({ locale: "en" }).then(replace)}>English</Button>
          </div>
        </div>
        <label className="mt-4 block text-xs text-mute">{t("settings.workspace")}</label>
        <Input className="mt-2" value={workspacePath} placeholder={t("settings.workspacePh")} onChange={(event) => setWorkspacePath(event.target.value)} />
        <Button className="mt-4" onClick={() => void api.saveSettings({ demoMode, workspacePath, providers: configs }).then((next) => {
          replace(next);
          setNotice(t("settings.saved"));
        })}>{t("settings.save")}</Button>
      </section>

      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {data.providers.map((provider) => (
          <a key={provider.meta.id} href={`#provider-${provider.meta.id}`} className="rounded-2xl border border-white/10 px-3 py-2 text-sm">
            {provider.meta.name}
          </a>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {data.providers.map((provider) => (
          <ProviderCard
            key={provider.meta.id}
            provider={provider}
            config={configs[provider.meta.id] ?? provider.config}
            secret={keys[provider.meta.id] ?? ""}
            onConfig={(patch) => update(provider.meta.id, patch)}
            onSecret={(value) => setKeys((current) => ({ ...current, [provider.meta.id]: value }))}
            onSaved={(next) => {
              replace(next);
              setKeys((current) => ({ ...current, [provider.meta.id]: "" }));
              setNotice(t("settings.saved"));
            }}
          />
        ))}
      </div>

      <section className="panel mt-4 p-4">
        <h2 className="font-medium">{t("settings.reset")}</h2>
        <p className="mt-1 text-sm text-mute">{t("settings.resetHelp")}</p>
        <Button className="mt-3" variant="danger" onClick={() => void api.resetDemo().then(replace)}>{t("settings.reset")}</Button>
      </section>
    </div>
  );
}

function ProviderCard({
  provider,
  config,
  secret,
  onConfig,
  onSecret,
  onSaved,
}: {
  provider: ProviderView;
  config: ProviderConfig;
  secret: string;
  onConfig: (patch: Partial<ProviderConfig>) => void;
  onSecret: (value: string) => void;
  onSaved: (next: Awaited<ReturnType<typeof api.setSecret>>) => void;
}) {
  const { t, hint } = useApp();
  const keyLabel = provider.keySource === "env" ? t("settings.keyEnv") : provider.keySource === "file" ? t("settings.keyFile") : t("settings.keyNone");
  return (
    <section id={`provider-${provider.meta.id}`} className="panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{provider.meta.name}</h2>
          <p className="text-xs text-mute">{provider.meta.vendor} · {keyLabel}</p>
        </div>
        <Toggle checked={config.enabled} label={t("settings.enabled")} onCheckedChange={(enabled) => onConfig({ enabled })} />
      </div>
      <p className="mt-3 text-sm text-mute">{hint(provider.meta.id)}</p>
      <a className="mt-2 inline-block text-sm text-lime" href={provider.meta.docsUrl} target="_blank" rel="noreferrer">{t("settings.docs")}</a>
      <label className="mt-4 block text-xs text-mute">{t("settings.cli")}</label>
      <Input className="mt-1" value={config.cliPath} onChange={(event) => onConfig({ cliPath: event.target.value })} />
      <label className="mt-3 block text-xs text-mute">{t("settings.model")}</label>
      <Input className="mt-1" list={`models-${provider.meta.id}`} value={config.model} onChange={(event) => onConfig({ model: event.target.value })} />
      <datalist id={`models-${provider.meta.id}`}>
        {provider.meta.models.map((model) => <option key={model} value={model} />)}
      </datalist>
      <label className="mt-3 block text-xs text-mute">{t("settings.endpoint")}</label>
      <Input className="mt-1" value={config.endpoint} placeholder={t("settings.endpointPh")} onChange={(event) => onConfig({ endpoint: event.target.value })} />
      <label className="mt-3 block text-xs text-mute">{t("settings.key")}</label>
      <Input className="mt-1" type="password" autoComplete="off" value={secret} placeholder={t("settings.keyPh")} onChange={(event) => onSecret(event.target.value)} />
      <p className="mt-1 text-xs text-mute">{t("settings.keyHelp")} {provider.meta.envKeys.join(", ")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="soft" disabled={!secret.trim()} onClick={() => void api.setSecret(provider.meta.id, secret).then(onSaved)}>{t("settings.saveKey")}</Button>
        <Button size="sm" variant="ghost" onClick={() => void api.clearSecret(provider.meta.id).then(onSaved)}>{t("settings.clearKey")}</Button>
      </div>
      <h3 className="mt-4 text-sm">{t("settings.mcp")}</h3>
      {provider.mcp.length === 0 ? <p className="mt-1 text-xs text-mute">{t("settings.mcpLive")}</p> : (
        <ul className="mt-2 space-y-2">
          {provider.mcp.map((server) => (
            <li key={server.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{server.name} · {server.transport}</span>
              <Toggle checked={server.enabled} label={server.name} onCheckedChange={(enabled) => void api.toggleMcp(provider.meta.id, server.id, enabled).then(onSaved)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
