import type { AgentUsage, UsageBucket, UsageDay } from "@pocketpilot/protocol";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { compact } from "@/lib/format";
import { useApp } from "@/lib/store";

/** Pure-SVG 7-day bars. Values are real per-day totals from the PC; nothing is interpolated. */
export function Spark({ days, tokens }: { days: UsageDay[]; tokens: boolean }) {
  const values = days.map((d) => (tokens ? d.tokens : d.requests));
  const max = Math.max(1, ...values);
  const w = 14, gap = 8, h = 44;
  return (
    <svg className="spark" viewBox={`0 0 ${days.length * (w + gap) - gap} ${h + 14}`} role="img" aria-label="7-day trend" data-testid="spark">
      {values.map((v, i) => {
        const bh = v === 0 ? 2 : Math.max(4, Math.round((v / max) * h));
        const x = i * (w + gap);
        return (
          <g key={days[i].date}>
            <rect x={x} y={h - bh} width={w} height={bh} rx={4} className={i === values.length - 1 ? "spark-bar spark-today" : "spark-bar"} />
            <text x={x + w / 2} y={h + 12} textAnchor="middle" className="spark-label">{days[i].date.slice(8)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function money(b: UsageBucket | null, estimated: boolean, t: (k: string) => string): string {
  if (!b || b.costUsd === null) return t("set.costNone");
  return `${estimated ? "≈" : ""}$${b.costUsd.toFixed(2)}`;
}

export function Buckets({ usage }: { usage: AgentUsage }) {
  const { t } = useApp();
  const rows: [string, UsageBucket | null][] = [[t("set.today"), usage.today], [t("set.week"), usage.week], [t("set.month"), usage.month]];
  return (
    <div className="usage-grid">
      {rows.map(([title, b]) => b && (
        <div className="usage-cell" key={title}>
          <div className="text-xs font-semibold text-mute">{title}</div>
          {usage.hasTokens ? (
            <>
              <div className="usage-main">{compact(b.inputTokens + b.outputTokens)}</div>
              <div className="usage-sub">{t("set.in")} {compact(b.inputTokens)} · {t("set.out")} {compact(b.outputTokens)}</div>
              {b.cacheTokens > 0 ? <div className="usage-sub">{t("set.cache")} {compact(b.cacheTokens)}</div> : null}
              <div className="usage-sub">{t("set.req")} {b.requests}</div>
              <div className="usage-cost">{money(b, usage.costEstimated, t)}{usage.costEstimated && b.costUsd !== null ? <em>{t("u.est")}</em> : null}</div>
            </>
          ) : (
            <>
              <div className="usage-main">{b.requests}</div>
              <div className="usage-sub">{t("set.req")}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function UsageDetail({ usage }: { usage: AgentUsage | null }) {
  const { t } = useApp();
  if (usage === null) return <p className="mt-2 text-sm text-mute">{t("set.usageLoading")}</p>;
  if (!usage.supported) {
    return (
      <div className="mt-2">
        <p className="text-sm font-medium">{t("set.noUsage")}</p>
        <p className="mt-1 text-sm text-mute">{usage.reason}</p>
      </div>
    );
  }
  return (
    <>
      <div className="mt-3"><Buckets usage={usage} /></div>
      {usage.daily ? (
        <div className="mt-4">
          <div className="text-xs font-semibold text-mute">{usage.hasTokens ? t("u.trendTokens") : t("u.trendReq")}</div>
          <Spark days={usage.daily} tokens={usage.hasTokens} />
        </div>
      ) : null}
      {usage.models.length > 0 ? <p className="mt-3 break-words text-xs text-mute">{t("set.models")}: {usage.models.join(", ")}</p> : null}
      {usage.note ? <p className="mt-2 text-xs leading-5 text-mute">{usage.note}</p> : null}
      <p className="mt-1 break-all text-[11px] text-mute">{usage.source}</p>
    </>
  );
}

/** Usage for every detected platform, fetched in parallel (the bridge reads local files; the phone only gets totals). */
export function useAllUsage(ids: string[]): Record<string, AgentUsage | null> {
  const [map, setMap] = useState<Record<string, AgentUsage | null>>({});
  const key = ids.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const id of ids) {
      void api.agentUsage(id).then((u) => { if (!cancelled) setMap((m) => ({ ...m, [id]: u })); }).catch(() => { if (!cancelled) setMap((m) => ({ ...m, [id]: null })); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}
