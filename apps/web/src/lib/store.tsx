import type { AgentsOverview, AgentStatus, Bootstrap } from "@pocketpilot/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { copy } from "./i18n";
import { extra } from "./i18n2";

const AGENT_KEY = "pocketpilot.agent";

interface AppContextValue {
  data: Bootstrap | null;
  overview: AgentsOverview | null;
  /** the platform chosen in the picker; always one of the detected ones */
  agent: AgentStatus | null;
  selectAgent: (id: string) => void;
  loading: boolean;
  error: string | null;
  notice: string | null;
  refresh: () => Promise<void>;
  refreshAgents: (force?: boolean) => Promise<void>;
  replace: (next: Bootstrap) => void;
  setNotice: (text: string | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: "zh" | "en";
  needsPair: boolean;
  pair: (code: string, origin?: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function readAgentId(): string {
  try {
    return localStorage.getItem(AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [overview, setOverview] = useState<AgentsOverview | null>(null);
  const [agentId, setAgentId] = useState(readAgentId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsPair, setNeedsPair] = useState(false);

  const refreshAgents = useCallback(async (force = false) => {
    setOverview(await api.agents(force));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [boot, agents] = await Promise.all([api.bootstrap(), api.agents()]);
      setData(boot);
      setOverview(agents);
      setError(null);
      setNeedsPair(false);
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === "pair" || caught.status === 401)) {
        setNeedsPair(true);
        setError(null);
      } else {
        setNeedsPair(false);
        setError(caught instanceof Error ? caught.message : "offline");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2400);
    return () => clearTimeout(timer);
  }, [notice]);

  const locale = data?.settings.locale ?? "zh";
  const theme = data?.settings.theme === "dark" ? "dark" : "light";
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh" : "en";
  }, [locale]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0a0f16" : "#f2f5fa");
  }, [theme]);

  const agent = useMemo(() => {
    const list = overview?.agents ?? [];
    return list.find((item) => item.id === agentId) ?? list.find((item) => item.available) ?? list[0] ?? null;
  }, [overview, agentId]);

  const value = useMemo<AppContextValue>(() => ({
    data,
    overview,
    agent,
    selectAgent: (id: string) => {
      setAgentId(id);
      try {
        localStorage.setItem(AGENT_KEY, id);
      } catch {
        /* private mode */
      }
    },
    loading,
    error,
    notice,
    refresh,
    refreshAgents,
    replace: setData,
    setNotice,
    t: (key, vars) => {
      const table = extra[locale] as Record<string, string>;
      const fallback = extra.zh as Record<string, string>;
      const old = copy[locale] as Record<string, string>;
      const oldZh = copy.zh as Record<string, string>;
      const template = table[key] ?? old[key] ?? fallback[key] ?? oldZh[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
    },
    locale,
    needsPair,
    pair: async (code: string, origin?: string) => {
      await api.pair(code, origin);
      await refresh();
    },
  }), [agent, data, error, loading, locale, needsPair, notice, overview, refresh, refreshAgents]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside provider");
  return value;
}
