import type { Bootstrap } from "@mobileagent/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
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
  needsPair: boolean;
  pair: (code: string, origin?: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsPair, setNeedsPair] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.bootstrap());
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#161513" : "#f3f0ea");
  }, [theme]);

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
    needsPair,
    pair: async (code: string, origin?: string) => {
      await api.pair(code, origin);
      await refresh();
    },
  }), [data, error, loading, locale, needsPair, notice, refresh]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside provider");
  return value;
}
