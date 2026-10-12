import { ArrowLeft, ArrowUp, Square } from "lucide-react";
import type { StreamEvent } from "@pocketpilot/protocol";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { RichText } from "@/components/rich-text";
import { Button, EmptyState } from "@/components/ui";
import { applyChatEvent, type ChatRow, type ChatTurn } from "@/lib/chat-stream";
import { notifyTask } from "@/lib/notify";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";

type UiMessage = ChatRow;

export function ChatPage() {
  const { agent: agentId = "", sid = "new" } = useParams();
  const [params] = useSearchParams();
  const { overview, t, setNotice } = useApp();
  const navigate = useNavigate();
  const agent = overview?.agents.find((a) => a.id === agentId) ?? null;
  const isNew = sid === "new";
  const [sessionId, setSessionId] = useState(isNew ? "" : sid);
  const [cwd, setCwd] = useState(params.get("cwd") ?? "");
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [limit, setLimit] = useState(80);
  const [loaded, setLoaded] = useState(isNew);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [model, setModel] = useState("");
  const stick = useRef(true);
  const streaming = useRef(false);
  const outcome = useRef({ text: "", error: "" });
  const turn = useRef<ChatTurn>({ rows: [], status: "", sessionId: isNew ? "" : sid, text: "", error: "" });

  // existing session: load real history + find its project
  useEffect(() => {
    if (isNew || !agentId) return;
    if (streaming.current) return;
    let cancelled = false;
    setLoaded(false);
    void api.agentMessages(agentId, sid, limit).then((rows) => {
      if (!cancelled) { turn.current = { ...turn.current, rows }; setMessages(rows); setLoaded(true); }
    }).catch(() => {
      if (!cancelled) { setMessages([]); setLoaded(true); }
    });
    void api.agentSessions(agentId, undefined, 200).then((rows) => {
      const found = rows.find((row) => row.id === sid);
      if (!cancelled && found) { setTitle(found.title); setCwd((current) => current || found.projectPath); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agentId, sid, isNew, limit]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, loaded, status]);

  function autosize() {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function onEvent(event: StreamEvent) {
    const next = applyChatEvent(turn.current, event);
    turn.current = next;
    outcome.current = { text: next.text, error: next.error };
    if (event.type === "session" && next.sessionId) {
      setSessionId(next.sessionId);
      window.history.replaceState(null, "", `/chat/${agentId}/${next.sessionId}`);
    }
    if (event.type === "status" || event.type === "text") setStatus(next.status);
    setMessages(next.rows);
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim();
    if (!text || running || !agent) return;
    if (!cwd) { setNotice(t("a.noCwd")); return; }
    setDraft("");
    requestAnimationFrame(autosize);
    stick.current = true;
    const now = new Date().toISOString();
    const rows: UiMessage[] = [
      ...turn.current.rows,
      { id: `u_${Date.now()}`, role: "user", createdAt: now, blocks: [{ type: "text", text }] },
      { id: `a_${Date.now()}`, role: "assistant", createdAt: now, blocks: [] },
    ];
    turn.current = { ...turn.current, rows, text: "", error: "" };
    setMessages(rows);
    if (!title) setTitle(text.slice(0, 40));
    const controller = new AbortController();
    abortRef.current = controller;
    streaming.current = true;
    setRunning(true);
    outcome.current = { text: "", error: "" };
    try {
      await api.agentChat(agent.id, { sessionId: sessionId || undefined, cwd, prompt: text, ...(model ? { model } : {}) }, onEvent, controller.signal);
    } catch (caught) {
      if (!controller.signal.aborted) onEvent({ type: "error", message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setRunning(false);
      setStatus("");
      const aborted = controller.signal.aborted;
      abortRef.current = null;
      if (!aborted) {
        const proj = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
        const failed = Boolean(outcome.current.error);
        const summary = (failed ? outcome.current.error : outcome.current.text).replace(/\s+/g, " ").trim().slice(0, 120);
        void notifyTask({ title: `${agent.name}${proj ? ` · ${proj}` : ""}`, body: summary || (failed ? t("s.n.failed") : t("s.n.done")), kind: failed ? "error" : "done" });
      }
      setMessages((rows) => {
        const next = rows.filter((row, i) => !(i === rows.length - 1 && row.role === "assistant" && row.blocks.length === 0));
        turn.current = { ...turn.current, rows: next };
        return next;
      });
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(`pocketpilot.model.${agentId}`) ?? "";
    const known = agent?.models ?? [];
    setModel(saved && known.includes(saved) ? saved : agent?.defaultModel && known.includes(agent.defaultModel) ? agent.defaultModel : "");
  }, [agentId, agent?.defaultModel, agent?.models]);

  if (!overview) return null;
  if (!agent) return <div className="px-4 pt-8 text-mute md:px-8">{t("a.none")}</div>;
  const canSend = agent.available && Boolean(cwd);
  const projectName = cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat">
      <div className="flex items-center gap-2 px-4 pb-2 md:px-8">
        <Button size="icon" variant="ghost" aria-label={t("a.back")} onClick={() => navigate(-1)}><ArrowLeft size={20} /></Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{title || (isNew ? t("a.newIn") : "…")}</div>
          <div className="truncate text-xs text-mute">{agent.name}{projectName ? ` · ${projectName}` : ""}</div>
        </div>
      </div>
      <div
        ref={scroller}
        className="chat-scroll app-scroll min-h-0 flex-1 overflow-y-auto px-4 md:px-8"
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!loaded ? <p className="py-6 text-sm text-mute">{t("common.loading")}</p> : null}
        {loaded && !isNew && messages.length >= limit ? <Button className="mb-3 w-full" size="sm" variant="soft" onClick={() => setLimit(limit + 200)}>{t("a.loadEarlier")}</Button> : null}
        {loaded && messages.length === 0 && !isNew ? <EmptyState text={t("a.emptyChat")} /> : null}
        <div className="space-y-4 pb-4">
          {messages.map((message) => <Bubble key={message.id} message={message} />)}
          {status ? <div className="status-chip">{status}</div> : null}
        </div>
      </div>
      <div className="px-4 pb-2 md:px-8">
        {!agent.available ? <p className="mb-2 text-xs text-mute">{t("a.cliMissing")}</p> : !cwd ? <p className="mb-2 text-xs text-mute">{t("a.noCwd")}</p> : null}
        {agent.models.length > 0 ? (
          <label className="model-pick">
            <span>{t("a.model")}</span>
            <select
              value={model}
              data-testid="model-pick"
              onChange={(event) => {
                setModel(event.target.value);
                sessionStorage.setItem(`pocketpilot.model.${agent.id}`, event.target.value);
              }}
            >
              <option value="">{t("a.modelDefault")}</option>
              {agent.models.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        ) : null}
        <div className="composer">
          <textarea
            ref={area}
            rows={1}
            value={draft}
            disabled={!canSend}
            placeholder={t("a.chatPh", { name: agent.name })}
            data-testid="composer"
            onChange={(event) => { setDraft(event.target.value); autosize(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
            }}
          />
          {running ? (
            <button type="button" className="send-btn send-stop" aria-label={t("a.stop")} data-testid="stop" onClick={() => abortRef.current?.abort()}><Square size={14} fill="currentColor" /></button>
          ) : (
            <button type="button" className="send-btn" aria-label={t("a.send")} data-testid="send" disabled={!draft.trim() || !canSend} onClick={() => void send()}><ArrowUp size={18} strokeWidth={2.5} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: UiMessage }) {
  const { t } = useApp();
  if (message.role === "user") {
    return (
      <div className="user-bubble">
        {message.blocks.map((block, i) => (block.type === "text" ? <RichText key={i} text={block.text} /> : null))}
      </div>
    );
  }
  return (
    <div className={`assistant-msg ${message.error ? "assistant-error" : ""}`}>
      {message.blocks.map((block, i) => {
        if (block.type === "text") return <RichText key={i} text={block.text} />;
        if (block.type === "thinking") return <details key={i} className="thinking" open><summary>{t("a.thinking")}</summary><p className="whitespace-pre-wrap">{block.text}</p></details>;
        return (
          <details key={i} className="tool-card" open={block.status === "running"}>
            <summary className="tool-row">
              <span className={`dot ${block.status === "running" ? "dot-run" : block.status === "error" ? "dot-off" : "dot-ok"}`} />
              <span className="font-medium">{block.name}</span>
              <span className="min-w-0 flex-1 truncate text-mute">{block.detail}</span>
            </summary>
            {block.input ? <div className="tool-body"><div className="text-[11px] text-mute">{t("a.toolIn")}</div><pre>{block.input}</pre></div> : null}
            {block.output ? <div className="tool-body"><div className="text-[11px] text-mute">{t("a.toolOut")}</div><pre>{block.output}</pre></div> : null}
          </details>
        );
      })}
    </div>
  );
}
