import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../lib/brain.js";

test("parses the final spoken reply and Codex thread id", () => {
  const out = [
    JSON.stringify({ type: "thread.started", thread_id: "abc-123" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "one", type: "agent_message", text: "  Hello there.  " },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.deepEqual(brain.parseCodexJsonl(out), {
    reply: "Hello there.",
    sessionId: "abc-123",
  });
});

test("uses the last completed agent message as the spoken response", () => {
  const out = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "draft" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
  ].join("\n");
  assert.equal(brain.parseCodexJsonl(out).reply, "final");
});

test("surfaces terminal Codex failures", () => {
  const out = JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } });
  assert.throws(() => brain.parseCodexJsonl(out), /rate limited/);
});

test("starts a locked-down non-interactive Codex conversation", () => {
  const args = brain.buildCodexArgs("Status report.", null, brain.PERSONA);
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.some((arg) => arg.startsWith("developer_instructions=")));
  assert.deepEqual(args.slice(-2), ["--", "Status report."]);
});

test("full agent persona is not limited to registered build primitives", () => {
  const persona = brain.buildFullPersona();
  assert.match(persona, /full Codex agent/);
  assert.match(persona, /arbitrary requests/);
  assert.match(persona, /Never claim an authentication, DNS, or internet failure/);
  assert.match(persona, /sandbox needs approval/);
  assert.doesNotMatch(persona, /You have no builds installed/);
});

test("resumes the exact Codex thread", () => {
  const args = brain.buildCodexArgs("Carry on.", "session-1");
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "session-1"]);
  assert.deepEqual(args.slice(-2), ["--", "Carry on."]);
});

test("only pins a model when explicitly configured", () => {
  const inherited = brain.buildCodexArgs("Hi", null, brain.PERSONA, { model: "" });
  assert.equal(inherited.includes("--model"), false);

  const pinned = brain.buildCodexArgs("Hi", null, brain.PERSONA, { model: "gpt-5.6-sol" });
  const i = pinned.indexOf("--model");
  assert.equal(pinned[i + 1], "gpt-5.6-sol");
});

test("closes stdin so Codex does not wait for piped input", () => {
  assert.deepEqual(brain.buildSpawnOptions("/tmp/jarvis"), {
    cwd: "/tmp/jarvis",
    stdio: ["ignore", "pipe", "pipe"],
  });
});
