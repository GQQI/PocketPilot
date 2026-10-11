import { ArrowLeft, ArrowUp, Plus, Square } from "lucide-react";
import type { ChatMessage, MessageBlock, StreamEvent } from "@pocketpilot/protocol";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { AgentPicker } from "@/components/agent-picker";
import { RichText } from "@/components/rich-text";
import { Button, EmptyState } from "@/components/ui";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { SessionRow, useSessions } from "./home";

/** "会话" tab: real chat history of the selected platform. */
export function ChatIndex() {
  const { agent, t } = useApp();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(40);
  const [query, setQuery] = useState("");
  const { rows } = useSessions(agent?.id, undefined, limit);
  if (!agent) return <div className="px-4 pt-8 text-mute md:px-8">{t("a.none")}</div>;
  const shown = (rows ?? []).filter((s) => !query.trim() || `${s.title} ${s.projectName}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="app-scroll h-full overflow-y-auto px-4 pb-8 md:px-8" data-testid="sessions">
      <div className="flex items-center justify-between gap-3">
        <h1 className="display !p-0 text-3xl">{t("nav.chat")}</h1>
        <Button size="sm" disabled={!agent.available} onClick={() => navigate("/projects")}><Plus size={16} />{t("a.newChat")}</Button>
      </div>
      <div className="mt-3"><AgentPicker /></div>
      <input className="input mt-3" value={query} placeholder={t("a.search")} onChange={(event) => setQuery(event.target.value)} />
      <div className="mt-3 space-y-2">
        {rows === null ? <p className="text-sm text-mute">{t("common.loading")}</p> : null}
        {rows && shown.length === 0 ? <EmptyState text={agent.canListSessions ? t("a.recentEmpty") : t("set.noUsage")} /> : null}
        {shown.map((session) => <SessionRow key={session.id} session={session} onOpen={() => navigate(`/chat/${agent.id}/${session.id}`)} />)}
      </div>
      {rows && rows.length >= limit ? <Button className="mt-4 w-full" variant="soft" onClick={() => setLimit(limit + 40)}>{t("a.more")}</Button> : null}
    </div>
  );
}

type UiMessage = ChatMessage & { error?: boolean };

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
  const stick = useRef(true);
  const streaming = useRef(false);

  // existing session: load real history + find its project
  useEffect(() => {
    if (isNew || !agentId) return;
    if (streaming.current) return;
    let cancelled = false;
    setLoaded(false);
    void api.agentMessages(agentId, sid, limit).then((rows) => {
      if (!cancelled) { setMessages(rows); setLoaded(true); }
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

  function patchLast(fn: (blocks: MessageBlock[]) => MessageBlock[]) {
    setMessages((rows) => {
      const last = rows[rows.length - 1];
      if (!last || last.role !== "assistant") return rows;
      return [...rows.slice(0, -1), { ...last, blocks: fn(last.blocks) }];
    });
  }

  function onEvent(event: StreamEvent) {
    if (event.type === "status") setStatus(event.status);
    else if (event.type === "session") {
      setSessionId(event.id);
      window.history.replaceState(null, "", `/chat/${agentId}/${event.id}`);
    } else if (event.type === "text") {
      setStatus("");
      patchLast((blocks) => {
        const last = blocks[blocks.length - 1];
        if (last?.type === "text") return [...blocks.slice(0, -1), { type: "text", text: last.text + event.delta }];
        return [...blocks, { type: "text", text: event.delta }];
      });
    } else if (event.type === "thinking") {
      patchLast((blocks) => {
        const last = blocks[blocks.length - 1];
        if (last?.type === "thinking") return [...blocks.slice(0, -1), { type: "thinking", text: last.text + event.delta }];
        return [...blocks, { type: "thinking", text: event.delta }];
      });
    } else if (event.type === "tool") {
      patchLast((blocks) => {
        if (event.phase === "done") {
          const at = blocks.findLastIndex((b) => b.type === "tool" && b.name === event.name && b.status === "running");
          if (at >= 0) return blocks.map((b, i) => (i === at && b.type === "tool" ? { ...b, status: "done" as const } : b));
        }
        return [...blocks, { type: "tool", name: event.name, detail: event.detail, status: event.phase === "done" ? "done" : "running" }];
      });
    } else if (event.type === "error") {
      setMessages((rows) => {
        const last = rows[rows.length - 1];
        const rest = last && last.role === "assistant" && last.blocks.length === 0 ? rows.slice(0, -1) : rows;
        return [...rest, { id: `err_${Date.now()}`, role: "assistant", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: event.message }], error: true }];
      });
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || running || !agent) return;
    if (!cwd) { setNotice(t("a.noCwd")); return; }
    setDraft("");
    requestAnimationFrame(autosize);
    stick.current = true;
    const now = new Date().toISOString();
    setMessages((rows) => [
      ...rows,
      { id: `u_${Date.now()}`, role: "user", createdAt: now, blocks: [{ type: "text", text }] },
      { id: `a_${Date.now()}`, role: "assistant", createdAt: now, blocks: [] },
    ]);
    if (!title) setTitle(text.slice(0, 40));
    const controller = new AbortController();
    abortRef.current = controller;
    streaming.current = true;
    setRunning(true);
    try {
      await api.agentChat(agent.id, { sessionId: sessionId || undefined, cwd, prompt: text }, onEvent, controller.signal);
    } catch (caught) {
      if (!controller.signal.aborted) onEvent({ type: "error", message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setRunning(false);
      setStatus("");
      abortRef.current = null;
      setMessages((rows) => rows.filter((row, i) => !(i === rows.length - 1 && row.role === "assistant" && row.blocks.length === 0)));
    }
  }

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
        if (block.type === "thinking") return <details key={i} className="thinking"><summary>{t("a.thinking")}</summary><p className="whitespace-pre-wrap">{block.text}</p></details>;
        return (
          <div key={i} className="tool-row">
            <span className={`dot ${block.status === "running" ? "dot-run" : block.status === "error" ? "dot-off" : "dot-ok"}`} />
            <span className="font-medium">{block.name}</span>
            <span className="min-w-0 flex-1 truncate text-mute">{block.detail}</span>
          </div>
        );
      })}
    </div>
  );
}
