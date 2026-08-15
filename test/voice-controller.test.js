import test from "node:test";
import assert from "node:assert/strict";
import { float32ToPcm16Base64 } from "../public/voice/microphone.js";
import { VoiceController } from "../public/voice/controller.js";
import { VoiceStateMachine } from "../public/voice/state-machine.js";

test("converts float microphone frames to signed little-endian PCM16", () => {
  assert.equal(float32ToPcm16Base64(new Float32Array([-1, 0, 1])), "AIAAAP9/");
});

function controller(config, options = {}) {
  const sent = [], events = [], calls = [];
  const chrome = { supported: true, start: () => { calls.push("chrome.start"); return true; }, stop: () => { calls.push("chrome.stop"); }, setLanguage: (language) => calls.push(`language:${language}`) };
  const microphone = { start: async (onAudio) => { calls.push("mic.start"); microphone.onAudio = onAudio; }, stop: async () => calls.push("mic.stop") };
  const voice = new VoiceController({ chrome, microphone, sendTransport: (message) => sent.push(message), onEvent: (event) => events.push(event), ...options });
  voice.configure(config);
  return { voice, sent, events, calls, microphone, chrome };
}

test("keeps Chrome Push-to-Talk as the default provider", () => {
  const { voice, calls } = controller({ stt: { provider: "chrome", chrome: { language: "en-US" } } });
  voice.start(); voice.stop();
  assert.deepEqual(calls, ["language:en-US", "chrome.start", "chrome.stop"]);
});

test("streams PCM only after server selects configured Nemotron", async () => {
  const { voice, sent, calls, microphone } = controller({ stt: { provider: "auto", nemotron: { configured: true }, chrome: { language: "de-DE" }, fallbackToChrome: true } });
  voice.start();
  assert.deepEqual(sent, [{ type: "stt.start", preferCloud: false }]);
  await voice.handleTransport({ type: "stt.selected", provider: "nemotron" });
  microphone.onAudio("AAE=");
  await voice.stop();
  assert.deepEqual(calls, ["language:de-DE", "mic.start", "mic.stop"]);
  assert.deepEqual(sent.slice(1), [{ type: "stt.audio", audio: "AAE=" }, { type: "stt.stop" }]);
});

test("streams PCM to Whisper.cpp after server selection and keeps Chrome off", async () => {
  const { voice, sent, calls, microphone } = controller({ stt: { provider: "whispercpp", whispercpp: { configured: true }, chrome: { language: "de-DE" }, fallbackToChrome: false } });
  voice.start();
  await voice.handleTransport({ type: "stt.selected", provider: "whispercpp" });
  microphone.onAudio("AAE=");
  await voice.stop();
  assert.deepEqual(calls, ["language:de-DE", "mic.start", "mic.stop"]);
  assert.deepEqual(sent.slice(1), [{ type: "stt.audio", audio: "AAE=" }, { type: "stt.stop" }]);
});

test("normalizes only final Push-to-Talk technical dictation and retains the raw transcript", () => {
  const { voice, events, chrome } = controller({ stt: { provider: "chrome", chrome: { language: "de-DE" } } });
  voice.start();
  chrome.onEvent({ type: "stt.partial", provider: "chrome", text: "Öffne slash home" });
  chrome.onEvent({ type: "stt.final", provider: "chrome", text: "Öffne slash home slash test punkt txt" });
  assert.equal(events.at(-2).text, "Öffne slash home");
  assert.equal(events.at(-1).text, "Öffne /home/test.txt");
  assert.equal(events.at(-1).rawText, "Öffne slash home slash test punkt txt");
});

test("does not arm batch Whisper.cpp for voice activation", () => {
  const { voice, events } = controller({ voice: { mode: "voice-activation", wakeWords: ["jarvis"], silenceTimeoutMs: 100 }, stt: { provider: "whispercpp", whispercpp: { configured: true }, chrome: { language: "de-DE" } } });
  assert.equal(voice.arm(), false);
  assert.deepEqual(events.at(-1), { type: "stt.error", provider: "whispercpp", error: "push-to-talk-required", fatal: false });
});

test("switches to Chrome when the server selects fallback or Nemotron fails", async () => {
  const { voice, calls } = controller({ stt: { provider: "nemotron", nemotron: { configured: true }, chrome: { language: "en-US" }, fallbackToChrome: true } });
  voice.start();
  await voice.handleTransport({ type: "stt.selected", provider: "chrome", fallback: true });
  assert.ok(calls.includes("chrome.start"));
  await voice.handleTransport({ type: "stt_event", event: { type: "stt.error", provider: "nemotron", error: "disconnected" } });
  assert.equal(calls.filter((value) => value === "chrome.start").length, 2);
});

test("voice activation emits a wake event and Push-to-Talk takes precedence", () => {
  const { voice, events, calls, chrome } = controller({ voice: { mode: "voice-activation", wakeWords: ["jarvis"], silenceTimeoutMs: 100 }, stt: { provider: "chrome", chrome: { language: "en-US" } } });
  voice.arm();
  chrome.onEvent({ type: "stt.partial", provider: "chrome", text: "Jarvis, check CPU" });
  assert.deepEqual(events.at(-1), { type: "voice.wake", wake: "jarvis" });
  voice.start();
  assert.ok(calls.includes("chrome.stop"));
});

test("waits for activation recognition to end before starting Push-to-Talk", async () => {
  const calls = [];
  let releaseStop;
  const chrome = {
    supported: true,
    setLanguage: () => {},
    start: () => { calls.push("start"); return true; },
    stop: () => { calls.push("stop"); return new Promise((resolve) => { releaseStop = resolve; }); },
  };
  const voice = new VoiceController({ chrome, microphone: { stop: async () => {} } });
  voice.configure({ voice: { mode: "voice-activation", wakeWords: ["jarvis"], silenceTimeoutMs: 100 }, stt: { provider: "chrome", chrome: { language: "en-US" } } });
  voice.arm();
  voice.start();
  assert.deepEqual(calls, ["start", "stop"]);
  releaseStop(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["start", "stop", "start"]);
});

test("voice activation dispatches one command after its silence timeout", async () => {
  const timers = [];
  const { voice, events, chrome } = controller(
    { voice: { mode: "voice-activation", wakeWords: ["jarvis"], silenceTimeoutMs: 100 }, stt: { provider: "chrome", chrome: { language: "en-US" } } },
    { setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {} },
  );
  voice.arm();
  chrome.onEvent({ type: "stt.partial", provider: "chrome", text: "Jarvis check CPU usage" });
  timers.at(-1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { type: "voice.command", text: "check cpu usage" });
});

test("voice state machine accepts known states and protects capture while busy", () => {
  const machine = new VoiceStateMachine();
  assert.equal(machine.canCapture(), true);
  machine.set("thinking"); assert.equal(machine.canCapture(), false);
  machine.set("approval"); assert.equal(machine.canCapture(), true);
  assert.throws(() => machine.set("flying"), /Unknown voice state/);
});
