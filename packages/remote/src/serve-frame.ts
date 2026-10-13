import { b64uEncode } from "./crypto";
import type { Frame } from "./frames";

const ALLOWED_HEADERS = ["authorization", "content-type", "accept"];

export interface FrameMux {
  send(frame: Frame): Promise<void>;
}

/** Turns one encrypted `req` frame into `res` / `chunk` / `end` frames. Shared by WebRTC and BLE. */
export async function serveApiRequest(
  mux: FrameMux,
  frame: Extract<Frame, { t: "req" }>,
  fetchImpl: (request: Request) => Response | Promise<Response>,
  opts: { peer: string; signal: AbortSignal; closed: () => boolean; host?: string },
): Promise<void> {
  const host = opts.host ?? "rtc.local";
  const fail = (message: string, status = 400) => void mux.send({ t: "err", id: frame.id, message, status });
  if (!frame.path.startsWith("/api/")) return fail("bad path");
  try {
    const headers = new Headers();
    for (const name of ALLOWED_HEADERS) {
      const value = frame.headers[name];
      if (value) headers.set(name, value);
    }
    // No socket: the bridge treats this as non-loopback. The peer id is the rate-limit key.
    headers.set("host", host);
    headers.set("x-pocketpilot-peer", opts.peer);
    const method = frame.method.toUpperCase();
    const request = new Request(`http://${host}${frame.path}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : frame.body,
      signal: opts.signal,
    });
    const response = await fetchImpl(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key === "content-type" || key === "cache-control") outHeaders[key] = value;
    });
    await mux.send({ t: "res", id: frame.id, status: response.status, headers: outHeaders });
    const reader = response.body?.getReader();
    if (reader) {
      while (!opts.signal.aborted && !opts.closed()) {
        const { value, done } = await reader.read();
        if (done) break;
        await mux.send({ t: "chunk", id: frame.id, d: b64uEncode(value) });
      }
      if (opts.signal.aborted) await reader.cancel().catch(() => undefined);
    }
    if (!opts.closed()) await mux.send({ t: "end", id: frame.id });
  } catch (error) {
    if (!opts.closed()) fail((error as Error).message, 500);
  }
}
