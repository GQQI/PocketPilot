import type { Bootstrap } from "@mobileagent/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { blurbs, copy, hints, suggestions, type CopyKey } from "./i18n";

interface AppContextValue {
  data: Bootstrap | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  refresh: () => Promise<void>;
  replace: (next: Bootstrap) => void;
  setNotice: (text: string | null) => void;
  selectProvider: (id: string) => Promise<void>;
  t: (key: CopyKey, vars?: Record<string, string | number>) => string;
  blurb: (id: string) => string;
  hint: (id: string) => string;
  ideas: (id: string) => string[];
  locale: "zh" | "en";
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.bootstrap());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "offline");
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
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh" : "en";
  }, [locale]);

  const value = useMemo<AppContextValue>(() => ({
    data,
    loading,
    error,
    notice,
    refresh,
    replace: setData,
    setNotice,
    selectProvider: async (id: string) => {
      const next = await api.saveSettings({ activeProviderId: id });
      setData(next);
    },
    t: (key, vars) => {
      const template = copy[locale][key] ?? copy.zh[key];
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));
    },
    blurb: (id: string) => blurbs[locale][id] ?? blurbs.zh[id] ?? id,
    hint: (id: string) => hints[locale][id] ?? hints.zh[id] ?? "",
    ideas: (id: string) => suggestions[locale][id] ?? suggestions.zh.cursor ?? [],
    locale,
  }), [data, error, loading, locale, notice, refresh]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside provider");
  return value;
}
