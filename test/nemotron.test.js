import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NemotronStreamingProvider, nemotronSessionUpdate, nemotronUrls } from "../lib/stt/nemotron.js";

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.closed = true; this.emit("close"); }
}

test("builds the documented Nemotron health and realtime URLs", () => {
  assert.deepEqual(nemotronUrls("asr.internal:9000"), {
    health: "http://asr.internal:9000/v1/health",
    realtime: "ws://asr.internal:9000/v1/realtime?intent=transcription",
  });
  assert.equal(nemotronUrls("https://asr.example").realtime, "wss://asr.example/v1/realtime?intent=transcription");
});

test("creates PCM16 sessions with language and automatic punctuation", () => {
  const update = nemotronSessionUpdate({ language: "de-DE" });
  assert.equal(update.type, "transcription_session.update");
  assert.equal(update.session.input_audio_format, "pcm16");
  assert.equal(update.session.input_audio_transcription.language, "de-DE");
  assert.equal(update.session.recognition_config.enable_automatic_punctuation, true);
});

test("streams audio and normalizes partial and final NIM events", async () => {
  const socket = new FakeSocket();
  const events = [];
  const provider = new NemotronStreamingProvider({ endpoint: "asr.internal:9000", language: "de-DE", onEvent: (event) => events.push(event), socketFactory: () => socket });
  assert.equal(await provider.start(), true);
  socket.emit("open");
  provider.appendAudio("AAE=");
  provider.stop();
  socket.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Hallo" }));
  socket.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hallo Welt" }));
  assert.equal(socket.sent[0].type, "transcription_session.update");
  assert.equal(socket.sent[1].type, "input_audio_buffer.append");
  assert.equal(socket.sent[2].type, "input_audio_buffer.done");
  assert.deepEqual(events.map((event) => event.type), ["stt.started", "stt.partial", "stt.final"]);
  assert.equal(events.at(-1).text, "Hallo Welt");
});

test("reports health, unavailable endpoints, malformed audio, and disconnects without leaking endpoint details", async () => {
  const provider = new NemotronStreamingProvider({ endpoint: "asr.internal:9000", timeoutMs: 50 });
  assert.equal(await provider.health({ fetchImpl: async () => ({ ok: true }) }), true);
  assert.equal(await provider.health({ fetchImpl: async () => { throw new Error("private endpoint unavailable"); } }), false);
  const unavailable = new NemotronStreamingProvider();
  assert.equal(await unavailable.health(), false);
  const socket = new FakeSocket();
  const events = [];
  const active = new NemotronStreamingProvider({ endpoint: "asr.internal:9000", onEvent: (event) => events.push(event), socketFactory: () => socket });
  await active.start();
  assert.throws(() => active.appendAudio(""), /invalid Nemotron PCM16 audio/);
  socket.emit("error", new Error("connection refused"));
  assert.deepEqual(events.at(-1), { type: "stt.error", provider: "nemotron", error: "connection-failed", fatal: false });
});
