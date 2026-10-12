import assert from "node:assert/strict";
import test from "node:test";
import { consumeSse } from "./sse.ts";

test("SSE frames flush as they arrive, including a trailing frame", () => {
  const seen: unknown[] = [];
  let rest = consumeSse('data: {"type":"text","delta":"a"}\n\n: ping\n\ndata: {"type":"thinking","delta":"b"}', (event) => seen.push(event));
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { delta: string }).delta, "a");
  rest = consumeSse(`${rest}\n\n`, (event) => seen.push(event), true);
  assert.equal(rest, "");
  assert.equal((seen[1] as { type: string }).type, "thinking");
});
