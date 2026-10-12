import assert from "node:assert/strict";
import test from "node:test";
import { parentRoute } from "./back.ts";

test("hardware back walks chat to home and only exits from home", () => {
  assert.equal(parentRoute("/"), "exit");
  assert.equal(parentRoute("/chat"), "/");
  assert.equal(parentRoute("/chat/in/grok"), "/chat");
  assert.equal(parentRoute("/chat/in/grok/sessions"), "/chat/in/grok");
  assert.equal(parentRoute("/chat/grok/ses_1"), "/chat/in/grok/sessions");
  assert.equal(parentRoute("/projects"), "/");
  assert.equal(parentRoute("/projects/view"), "/projects");
  assert.equal(parentRoute("/settings"), "/");
  assert.equal(parentRoute("/settings/platforms/grok/connection"), "/settings/platforms/grok");
  assert.equal(parentRoute("/settings/about/privacy"), "/settings/about");
});
