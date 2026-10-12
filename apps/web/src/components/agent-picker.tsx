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
                <span className="agent-tab-state"><span className={`dot dot-${state}`} aria-hidden="true" />{statusLabel(item.available, item.hasHistory, t, needsKey(item), item.auth)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function statusLabel(available: boolean, hasHistory: boolean, t: (k: string) => string, needKey = false, auth?: { state?: string; loginCommand?: string }): string {
  if (available) return t("a.st.ready");
  if (auth?.loginCommand && auth.state !== "ok") return t("a.st.login");
  if (hasHistory) return t("a.st.history");
  if (needKey) return t("a.st.needKey");
  return t("a.st.missing");
}

/** Key-only platforms: "missing" means "no key yet". A CLI login command means the user should sign in on the PC. */
export function needsKey(a: { id: string; available: boolean; keySource: string; cliPath?: string | null; envKeys?: string[]; auth?: { loginCommand?: string } }): boolean {
  if (a.available || a.keySource !== "none" || a.auth?.loginCommand) return false;
  if (a.id === "grok") return true;
  return Boolean(a.cliPath) && (a.envKeys?.length ?? 0) > 0;
}
