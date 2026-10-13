import assert from "node:assert/strict";
import { test } from "node:test";
import { joinDictation, voiceSupported } from "./voice";

test("dictation joins onto typed text without spaces between CJK", () => {
  assert.equal(joinDictation("", "你好"), "你好");
  assert.equal(joinDictation("请帮我", "看看测试"), "请帮我看看测试");
  assert.equal(joinDictation("run", "the tests"), "run the tests");
  assert.equal(joinDictation("run ", "tests"), "run tests");
});

test("voice input is hidden outside the native app", async () => {
  assert.equal(await voiceSupported(), false);
});
