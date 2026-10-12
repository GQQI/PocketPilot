import type { StreamEvent } from "@mobileagent/protocol";
import { consumeSse } from "@mobileagent/protocol";
import { eventsFromXaiPayload } from "./stream-map";

export type TransportKind = "auth" | "timeout" | "network" | "unknown";

export function collectErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? "");
  const cause = (error as Error & { cause?: unknown }).cause;
  const parts = [error.name, error.message];
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    parts.push(cause.name, cause.message, code ?? "");
  } else if (typeof cause === "string") {
    parts.push(cause);
  }
  return parts.filter(Boolean).join(" ");
}

export function classifyTransport(error: unknown, status?: number, body?: string): TransportKind {
  if (status === 401 || status === 403) return "auth";
  const text = `${collectErrorText(error)} ${body ?? ""}`.toLowerCase();
  if (text.includes("invalid api key") || text.includes("incorrect api key") || text.includes("unauthorized")) return "auth";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborterror")) return "timeout";
  if (
    text.includes("fetch failed")
    || text.includes("enotfound")
    || text.includes("econnrefused")
    || text.includes("econnreset")
    || text.includes("eai_again")
    || text.includes("getaddrinfo")
    || text.includes("network")
    || text.includes("und_err")
  ) return "network";
  return "unknown";
}

export function explainGrokFailure(input: {
  error?: unknown;
  status?: number;
  body?: string;
  locale: "zh" | "en";
  missingKey?: boolean;
}): string {
  if (input.missingKey) {
    return input.locale === "en"
      ? "xAI API: XAI_API_KEY is not set on this PC. Add it in the environment or the local secret store. This is not a network failure."
      : "xAI API：这台电脑没有 XAI_API_KEY。请写到环境变量，或在设置里保存到本机密钥。这不是网络故障。";
  }
  const kind = classifyTransport(input.error, input.status, input.body);
  const status = input.status ? `HTTP ${input.status}` : "";
  if (kind === "auth") {
    return input.locale === "en"
      ? `xAI API rejected the key${status ? ` (${status})` : ""}. Check XAI_API_KEY on this PC. The key stays on the computer.`
      : `xAI API 拒绝了密钥${status ? `（${status}）` : ""}。请在这台电脑上检查 XAI_API_KEY。密钥只留在电脑上。`;
  }
  if (kind === "timeout") {
    return input.locale === "en"
      ? "xAI API timed out before a reply. Reasoning models can sit quiet for a long time. This PC still has to reach api.x.ai; a timeout is not a bad key."
      : "xAI API 超时，还没有收到回复。推理模型可能要很久才出第一个字。这台电脑必须能连上 api.x.ai。超时不是密钥错误。";
  }
  if (kind === "network") {
    return input.locale === "en"
      ? "xAI API: network error (fetch failed). This PC could not reach api.x.ai. A firewall or a regional block (some networks in mainland China cannot reach it) causes this. It is not a bad key unless the status is 401 or 403."
      : "xAI API：网络失败（fetch failed）。这台电脑连不上 api.x.ai。防火墙，或地区网络限制（中国大陆部分网络访问不到 api.x.ai），都会变成这个错误。除非状态是 401 或 403，否则不是密钥错误。";
  }
  const detail = (input.body || collectErrorText(input.error) || "request failed").replace(/\s+/g, " ").slice(0, 240);
  return input.locale === "en" ? `xAI API: ${detail}` : `xAI API：${detail}`;
}

export interface GrokTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GrokStreamOptions {
  apiKey: string;
  model: string;
  endpoint: string;
  messages: GrokTurn[];
  locale: "zh" | "en";
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function* streamGrok(options: GrokStreamOptions): AsyncGenerator<StreamEvent> {
  if (!options.apiKey.trim()) {
    yield { type: "error", message: explainGrokFailure({ locale: options.locale, missingKey: true }) };
    return;
  }
  const endpoint = (options.endpoint || "https://api.x.ai/v1").replace(/\/$/, "");
  const url = `${endpoint}/chat/completions`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 600_000);
  const signal = AbortSignal.any([options.signal, timeout]);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model || "grok-4",
        stream: true,
        messages: options.messages,
      }),
      signal,
    });
  } catch (error) {
    if (options.signal.aborted) {
      yield { type: "error", message: options.locale === "en" ? "aborted" : "已中止" };
      return;
    }
    yield { type: "error", message: explainGrokFailure({ error, locale: options.locale }) };
    return;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    yield { type: "error", message: explainGrokFailure({ status: response.status, body, locale: options.locale }) };
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", message: explainGrokFailure({ body: "empty response body", locale: options.locale }) };
    return;
  }
  const decoder = new TextDecoder();
  let pending = "";
  const queued: StreamEvent[] = [];
  const take = (chunk: string) => {
    pending = consumeSse(pending + chunk, (payload) => {
      for (const event of eventsFromXaiPayload(payload)) {
        if (event.type === "error") {
          queued.push({ type: "error", message: explainGrokFailure({ body: event.message, locale: options.locale }) });
        } else {
          queued.push(event);
        }
      }
    });
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    take(decoder.decode(value, { stream: true }));
    while (queued.length) {
      const event = queued.shift();
      if (event) yield event;
    }
  }
  take("\n\n");
  while (queued.length) {
    const event = queued.shift();
    if (event) yield event;
  }
}
