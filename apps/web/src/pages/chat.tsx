import type { ChatMessage, StreamEvent, TerminalEvent } from "@mobileagent/protocol";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Mark } from "@/components/shell";
import { RichText } from "@/components/rich-text";
import { Button, Modal, Textarea } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useApp } from "@/lib/store";

export function ChatIndex() {
  const { data } = useApp();
  if (!data) return null;
  const active = data.settings.activeProviderId;
  const session = data.sessions.find((item) => item.providerId === active) ?? data.sessions[0];
  if (!session) return <EmptyChat />;
  return <Navigate to={`/chat/${session.id}`} replace />;
}

export function ChatPage() {
  const { sessionId = "" } = useParams();
  const { data, t, ideas, replace, setNotice } = useApp();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pane, setPane] = useState<"chat" | "terminal">("chat");
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const session = data?.sessions.find((item) => item.id === sessionId);
  const provider = data?.providers.find((item) => item.meta.id === session?.providerId);
  const project = data?.projects.find((item) => item.id === session?.projectId);
  const related = data?.sessions.filter((item) => item.providerId === session?.providerId) ?? [];

  useEffect(() => {
    let cancelled = false;
    setLive(null);
    void api.messages(sessionId).then((rows) => {
      if (!cancelled) setMessages(rows);
    }).catch(() => {
      if (!cancelled) setMessages([]);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, live, lines, pane]);

  if (!data || !session || !provider) {
    return <div className="px-4 pt-8 text-mute md:px-8">{t("home.empty")}</div>;
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || running) return;
    setDraft("");
    setRunning(true);
    setLive({ thinking: "", text: "", tools: [] });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.prompt(sessionId, prompt, (event) => setLive((current) => applyEvent(current, event)), controller.signal);
      setMessages(await api.messages(sessionId));
      replace(await api.bootstrap());
    } catch (error) {
      if (error instanceof ApiError && error.code === "busy") {
        replace(await api.enqueue(sessionId, prompt));
        setNotice(t("shell.noticeQueued"));
      }
    } finally {
      setRunning(false);
      setLive(null);
      abortRef.current = null;
    }
  }

  async function runCommand() {
    const line = command.trim();
    if (!line) return;
    setCommand("");
    const controller = new AbortController();
    try {
      await api.terminal(sessionId, line, (event: TerminalEvent) => {
        setLines((current) => [...current, event.text].slice(-80));
      }, controller.signal);
    } catch {
      setLines((current) => [...current, "failed"]);
    }
  }

  return (
    <div data-testid="chat" className="flex h-full flex-col px-4 md:px-8">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Mark monogram={provider.meta.monogram} accent={provider.meta.accent} />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-medium">{session.title}</h1>
            <p className="truncate text-xs text-mute">{provider.meta.name} · {project?.name}</p>
          </div>
        </div>
        <Button size="sm" variant="soft" onClick={() => setCreating(true)}>{t("chat.new")}</Button>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {related.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === session.id ? "shrink-0 rounded-full bg-lime px-3 py-1 text-xs text-ink" : "shrink-0 rounded-full bg-white/5 px-3 py-1 text-xs text-mute"}
            onClick={() => navigate(`/chat/${item.id}`)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 rounded-full bg-black/20 p-1 text-sm">
        <button type="button" className={pane === "chat" ? "rounded-full bg-ivory text-ink" : "text-mute"} onClick={() => setPane("chat")}>{t("chat.talk")}</button>
        <button type="button" className={pane === "terminal" ? "rounded-full bg-ivory text-ink" : "text-mute"} onClick={() => setPane("terminal")}>{t("chat.term")}</button>
      </div>
      <div ref={scroller} className="app-scroll mt-3 min-h-0 flex-1 overflow-y-auto pb-3">
        {pane === "chat" ? (
          <div className="space-y-4">
            {messages.length === 0 ? <p className="text-sm text-mute">{t("chat.empty")}</p> : null}
            {messages.map((message) => <MessageView key={message.id} message={message} name={provider.meta.name} />)}
            {live ? <LiveView live={live} name={provider.meta.name} /> : null}
          </div>
        ) : (
          <div>
            <p className="mb-2 text-xs text-mute">{data.settings.demoMode ? t("term.note") : project?.path}</p>
            <div className="terminal">{lines.join("\n") || `${provider.meta.cli}\n`}</div>
            <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); void runCommand(); }}>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("term.ph")} className="h-11 flex-1 rounded-2xl border border-white/10 bg-black/20 px-3 text-sm" />
              <Button type="submit" size="sm">{t("term.run")}</Button>
            </form>
          </div>
        )}
      </div>
      {pane === "chat" ? (
        <form className="pb-3" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
          <div className="mb-2 flex gap-2 overflow-x-auto">
            {ideas(provider.meta.id).map((idea) => (
              <button key={idea} type="button" className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-mute" onClick={() => setDraft(idea)}>
                {idea}
              </button>
            ))}
          </div>
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("chat.placeholder")} rows={2} />
          <div className="mt-2 flex justify-end gap-2">
            {running ? <Button type="button" variant="danger" size="sm" onClick={() => abortRef.current?.abort()}>{t("chat.abort")}</Button> : null}
            <Button type="button" variant="soft" size="sm" onClick={() => void api.enqueue(session.id, draft).then((next) => { replace(next); setDraft(""); })}>{t("chat.queue")}</Button>
            <Button type="submit" size="sm" disabled={running || !draft.trim()}>{t("chat.send")}</Button>
          </div>
        </form>
      ) : null}
      <NewSession open={creating} onOpenChange={setCreating} providerId={provider.meta.id} />
    </div>
  );
}

function EmptyChat() {
  const { t, data } = useApp();
  const [open, setOpen] = useState(true);
  const providerId = data?.settings.activeProviderId ?? "cursor";
  return (
    <div className="px-4 pt-8 md:px-8">
      <p className="text-mute">{t("chat.empty")}</p>
      <NewSession open={open} onOpenChange={setOpen} providerId={providerId} />
    </div>
  );
}

function NewSession({ open, onOpenChange, providerId }: { open: boolean; onOpenChange: (open: boolean) => void; providerId: string }) {
  const { data, t, replace } = useApp();
  const navigate = useNavigate();
  const projects = data?.projects.filter((project) => project.providerId === providerId) ?? [];
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("chat.new")}>
      {projects.length === 0 ? <p className="text-sm text-mute">{t("chat.noProject")}</p> : (
        <form onSubmit={(event) => {
          event.preventDefault();
          void api.createSession(providerId, projectId).then((result) => {
            replace(result.bootstrap);
            onOpenChange(false);
            navigate(`/chat/${result.session.id}`);
          });
        }}>
          <label className="text-xs text-mute">{t("chat.pick")}</label>
          <select className="mt-2 h-11 w-full rounded-2xl border border-white/10 bg-black/20 px-3" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit">{t("chat.create")}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function MessageView({ message, name }: { message: ChatMessage; name: string }) {
  const { t } = useApp();
  if (message.role === "user") {
    const text = message.blocks.find((block) => block.type === "text");
    return (
      <div className="user-bubble">
        <div className="mb-1 text-[11px] text-coral">{t("chat.you")}</div>
        <p className="whitespace-pre-wrap text-sm">{text && text.type === "text" ? text.text : ""}</p>
      </div>
    );
  }
  return (
    <article>
      <div className="mb-2 text-xs text-mute">{name}</div>
      <div className="space-y-2">
        {message.blocks.map((block, index) => {
          if (block.type === "thinking") return <p key={index} className="text-xs text-mute">{t("chat.thinking")} · {block.text}</p>;
          if (block.type === "tool") return <div key={index} className="tool-row"><span className="text-lime">{block.name}</span><span className="truncate text-mute">{block.detail}</span></div>;
          return <RichText key={index} text={block.text} />;
        })}
      </div>
    </article>
  );
}

interface Live {
  thinking: string;
  text: string;
  tools: { name: string; detail: string }[];
}

function applyEvent(current: Live | null, event: StreamEvent): Live {
  const next = current ?? { thinking: "", text: "", tools: [] };
  if (event.type === "thinking") return { ...next, thinking: next.thinking + event.delta };
  if (event.type === "text") return { ...next, text: next.text + event.delta };
  if (event.type === "tool" && event.phase === "done") return { ...next, tools: [...next.tools, { name: event.name, detail: event.detail }] };
  return next;
}

function LiveView({ live, name }: { live: Live; name: string }) {
  const { t } = useApp();
  return (
    <article>
      <div className="mb-2 text-xs text-lime">{name}</div>
      {live.thinking ? <p className="text-xs text-mute">{t("chat.thinking")} · {live.thinking}</p> : null}
      <div className="mt-2 space-y-2">
        {live.tools.map((tool, index) => <div key={index} className="tool-row"><span className="text-lime">{tool.name}</span><span className="text-mute">{tool.detail}</span></div>)}
      </div>
      {live.text ? <div className="mt-2"><RichText text={live.text} /></div> : null}
    </article>
  );
}
