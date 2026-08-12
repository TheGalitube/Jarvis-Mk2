import test from "node:test";
import assert from "node:assert/strict";
import { detectWakeWord, WakeWordController } from "../public/voice/wake-word.js";

test("recognizes wake phrases and an inline command", () => {
  assert.deepEqual(detectWakeWord("Hey, Jarvis! Check the server.", ["hey jarvis"]), { wake: "hey jarvis", command: "check the server" });
  assert.equal(detectWakeWord("hello there", ["jarvis"]), null);
});

test("emits the latest command after silence and rearms on wake-only input", () => {
  const events = [], timers = [];
  const wake = new WakeWordController({ wakeWords: ["jarvis"], silenceTimeoutMs: 10, onEvent: (event) => events.push(event), setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {} });
  wake.arm(); wake.observe("jarvis check cpu"); wake.observe("jarvis check cpu usage"); timers.at(-1)();
  assert.deepEqual(events.at(-1), { type: "voice.command", text: "check cpu usage" });
  wake.arm(); wake.observe("jarvis"); timers.at(-1)();
  assert.equal(events.at(-1).type, "voice.armed");
});

test("approval input bypasses wake-word matching", () => {
  const timers = [], events = [];
  const wake = new WakeWordController({ onEvent: (event) => events.push(event), setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {} });
  wake.observe("approve", { approval: true }); timers[0]();
  assert.deepEqual(events, [{ type: "voice.command", text: "approve" }]);
});
