import type { AgentSession } from "@pocketpilot/protocol";
import { normPath } from "./util";

/** One chat must not show up twice (platform transcript + PocketPilot copy, or the same id listed twice). */
export function dedupeSessions(list: AgentSession[]): AgentSession[] {
  const out: AgentSession[] = [];
  for (const session of list) {
    const at = out.findIndex((prev) => sameSession(prev, session));
    if (at < 0) out.push(session);
    else out[at] = preferSession(out[at], session);
  }
  return out;
}

function sameSession(a: AgentSession, b: AgentSession): boolean {
  if (a.agentId !== b.agentId) return false;
  if (a.id === b.id) return true;
  const title = a.title.trim();
  if (!title || title !== b.title.trim()) return false;
  if (normPath(a.projectPath) !== normPath(b.projectPath)) return false;
  if (a.preview && b.preview && a.preview !== b.preview) return false;
  return true;
}

function preferSession(a: AgentSession, b: AgentSession): AgentSession {
  const score = (session: AgentSession) => {
    let n = session.source === "pocketpilot" ? 0 : 2;
    if (session.title.trim() && !session.title.startsWith("（空")) n += 1;
    if (session.preview) n += 1;
    return n;
  };
  const delta = score(b) - score(a);
  if (delta !== 0) return delta > 0 ? b : a;
  return a.updatedAt >= b.updatedAt ? a : b;
}
