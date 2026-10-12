import { Mark } from "@/components/shell";
import { useApp } from "@/lib/store";

export type AgentState = "ready" | "history" | "missing";

export function agentState(available: boolean, hasHistory: boolean): AgentState {
  return available ? "ready" : hasHistory ? "history" : "missing";
}

/** Horizontal, swipeable platform cards. `sticky` pins the strip under the page top (used in Settings). */
export function AgentPicker({ onPick, sticky = false }: { onPick?: (id: string) => void; sticky?: boolean }) {
  const { overview, agent, selectAgent, t } = useApp();
  const list = overview?.agents ?? [];
  if (list.length === 0) return null;
  return (
    <div className={sticky ? "agent-strip" : undefined}>
      <div className="agent-tabs app-scroll" role="tablist" aria-label={t("a.current")} data-testid="agent-picker">
        {list.map((item) => {
          const state = agentState(item.available, item.hasHistory);
          const on = item.id === agent?.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={`agent-tab ${on ? "agent-tab-on" : ""}`}
              onClick={() => {
                selectAgent(item.id);
                onPick?.(item.id);
              }}
            >
              <Mark id={item.id} monogram={item.monogram} accent={item.accent} />
              <span className="agent-tab-text">
                <span className="agent-tab-name">{item.name}</span>
                <span className="agent-tab-state"><span className={`dot dot-${state}`} aria-hidden="true" />{t(`a.st.${state === "ready" ? "ready" : state === "history" ? "history" : "missing"}`)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function statusLabel(available: boolean, hasHistory: boolean, t: (k: string) => string, needKey = false): string {
  return available ? t("a.st.ready") : hasHistory ? t("a.st.history") : needKey ? t("a.st.needKey") : t("a.st.missing");
}

/** API-only platforms (no CLI to install): "missing" really means "no key yet". */
export function needsKey(a: { id: string; available: boolean; keySource: string }): boolean {
  return !a.available && a.id === "grok" && a.keySource === "none";
}
