/** Pull complete SSE frames out of a growing buffer. `flush` emits a trailing frame that never got a blank line. */
export function consumeSse(buffer: string, onEvent: (data: unknown) => void, flush = false): string {
  const parts = buffer.split(/\n\n/);
  const rest = flush ? "" : (parts.pop() ?? "");
  const frames = flush ? parts.concat(rest ? [rest] : []) : parts;
  for (const part of frames) {
    const line = part.split("\n").find((item) => item.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* ignore a malformed frame */
    }
  }
  return rest;
}
