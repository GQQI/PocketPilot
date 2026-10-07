import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useApp } from "@/lib/store";

export function QueuePage() {
  const { data, t, replace } = useApp();
  const navigate = useNavigate();
  const [runningId, setRunningId] = useState<string | null>(null);
  if (!data) return null;
  const snapshot = data;
  const waiting = snapshot.queue.filter((item) => item.status === "waiting" || item.status === "running");
  const done = snapshot.queue.filter((item) => item.status === "done" || item.status === "failed");
  const providerName = (id: string) => snapshot.providers.find((provider) => provider.meta.id === id)?.meta.name ?? id;

  function move(id: string, direction: -1 | 1) {
    const ids = snapshot.queue.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const swapped = [...ids];
    const [item] = swapped.splice(index, 1);
    if (!item) return;
    swapped.splice(target, 0, item);
    void api.reorderQueue(swapped).then(replace);
  }

  return (
    <div data-testid="queue" className="app-scroll h-full overflow-y-auto px-4 pb-6 md:px-8">
      <h1 className="display text-4xl">{t("queue.title")}</h1>
      <h2 className="mt-5 text-sm text-mute">{t("queue.waiting")}</h2>
      <div className="mt-3 space-y-3">
        {waiting.length === 0 ? <p className="text-sm text-mute">{t("queue.empty")}</p> : null}
        {waiting.map((item) => (
          <article key={item.id} className="row-card px-4 py-3">
            <div className="text-xs text-accent">{providerName(item.providerId)} · {item.status}</div>
            <p className="mt-1 text-sm">{item.prompt}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={runningId !== null} onClick={() => {
                setRunningId(item.id);
                void api.runQueue(item.id, () => undefined, new AbortController().signal)
                  .then(() => api.bootstrap())
                  .then(replace)
                  .finally(() => setRunningId(null));
              }}>{t("queue.run")}</Button>
              <Button size="sm" variant="ghost" onClick={() => move(item.id, -1)}>{t("queue.up")}</Button>
              <Button size="sm" variant="ghost" onClick={() => move(item.id, 1)}>{t("queue.down")}</Button>
              <Button size="sm" variant="danger" onClick={() => void api.removeQueue(item.id).then(replace)}>{t("queue.remove")}</Button>
            </div>
          </article>
        ))}
      </div>
      <h2 className="mt-6 text-sm text-mute">{t("queue.done")}</h2>
      <div className="mt-3 space-y-2">
        {done.map((item) => (
          <div key={item.id} className="text-sm text-mute">{providerName(item.providerId)} · {item.prompt}</div>
        ))}
      </div>
      <h2 className="mt-6 text-sm text-mute">{t("queue.history")}</h2>
      <div className="mt-3 space-y-2">
        {snapshot.sessions.map((session) => (
          <button key={session.id} type="button" className="row-card block w-full px-4 py-3 text-left" onClick={() => navigate(`/chat/${session.id}`)}>
            <div className="flex items-center justify-between gap-3">
              <span>{session.title}</span>
              <span className="text-xs text-mute">{formatTime(session.updatedAt, t)}</span>
            </div>
            <p className="text-xs text-mute">{providerName(session.providerId)}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
