import { Mark } from "@/components/shell";
import { useApp } from "@/lib/store";

/** Horizontal platform switcher. Only platforms detected on this PC are offered. */
export function AgentPicker({ onPick }: { onPick?: (id: string) => void }) {
  const { overview, agent, selectAgent, t } = useApp();
  const list = overview?.agents ?? [];
  if (list.length === 0) return null;
  return (
    <div className="agent-tabs app-scroll" role="tablist" aria-label={t("a.current")} data-testid="agent-picker">
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === agent?.id}
          className={`agent-tab ${item.id === agent?.id ? "agent-tab-on" : ""}`}
          onClick={() => {
            selectAgent(item.id);
            onPick?.(item.id);
          }}
        >
          <Mark monogram={item.monogram} accent={item.accent} />
          <span className="agent-tab-name">{item.name}</span>
          <span className={`dot ${item.available ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function statusLabel(available: boolean, hasHistory: boolean, t: (k: string) => string): string {
  return available ? t("a.st.ready") : hasHistory ? t("a.st.history") : t("a.st.missing");
}
