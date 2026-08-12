import test from "node:test";
import assert from "node:assert/strict";
import { ChromeSpeechProvider, browserRecognition } from "../public/stt/chrome-speech-provider.js";
import { SttManager } from "../public/stt/manager.js";

class FakeRecognition {
  static latest = null;
  constructor() { FakeRecognition.latest = this; this.starts = 0; this.stops = 0; }
  start() { this.starts++; this.onstart?.(); }
  stop() { this.stops++; this.onend?.(); }
  result(final, transcript) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript } }] });
  }
  error(error) { this.onerror?.({ error }); }
  end() { this.onend?.(); }
}

test("normalizes Chrome partial and final transcripts", () => {
  const events = [];
  const provider = new ChromeSpeechProvider({ Recognition: FakeRecognition, language: "de-DE", onEvent: (event) => events.push(event) });
  assert.equal(provider.start(), true);
  const recognition = FakeRecognition.latest;
  assert.equal(recognition.lang, "de-DE");
  recognition.result(false, "hallo");
  recognition.result(true, "hallo welt");
  provider.stop();
  assert.deepEqual(events.map((event) => event.type), ["stt.started", "stt.partial", "stt.partial", "stt.final"]);
  assert.equal(events.at(-1).text, "hallo welt");
});

test("resumes recoverable recognition endings while the microphone remains active", () => {
  const events = [];
  const provider = new ChromeSpeechProvider({ Recognition: FakeRecognition, onEvent: (event) => events.push(event) });
  provider.start();
  FakeRecognition.latest.end();
  assert.equal(FakeRecognition.latest.starts, 2);
  assert.equal(events.at(-1).type, "stt.resumed");
});

test("fatal browser errors discard a partial transcript and stop the provider", () => {
  const events = [];
  const provider = new ChromeSpeechProvider({ Recognition: FakeRecognition, onEvent: (event) => events.push(event) });
  provider.start();
  FakeRecognition.latest.result(true, "do not send");
  FakeRecognition.latest.error("not-allowed");
  FakeRecognition.latest.end();
  assert.equal(events.find((event) => event.type === "stt.error").fatal, true);
  assert.deepEqual(events.at(-1), { type: "stt.final", provider: "chrome", text: "", discarded: true });
});

test("reports unavailable browsers without relying on a global window", () => {
  assert.equal(browserRecognition(undefined), null);
  const events = [];
  const provider = new ChromeSpeechProvider({ Recognition: null, onEvent: (event) => events.push(event) });
  assert.equal(provider.start(), false);
  assert.deepEqual(events, [{ type: "stt.unavailable", provider: "chrome" }]);
});

test("manager forwards a provider-neutral lifecycle and language setting", () => {
  const calls = [];
  const provider = {
    supported: true,
    start: () => { calls.push("start"); return true; }, stop: () => { calls.push("stop"); return true; },
    setLanguage: (language) => calls.push(language),
  };
  const events = [];
  const manager = new SttManager({ provider, onEvent: (event) => events.push(event) });
  manager.start(); manager.setLanguage("de-DE"); manager.stop(); provider.onEvent({ type: "stt.partial", text: "Hallo" });
  assert.deepEqual(calls, ["start", "de-DE", "stop"]);
  assert.deepEqual(events, [{ type: "stt.partial", text: "Hallo" }]);
});
