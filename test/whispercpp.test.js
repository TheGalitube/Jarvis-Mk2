import test from "node:test";
import assert from "node:assert/strict";
import { WhisperCppProvider, pcm16Wav, whisperCppUrls } from "../lib/stt/whispercpp.js";

test("builds Whisper.cpp health and inference URLs", () => {
  assert.deepEqual(whisperCppUrls("stt.internal:8080"), { health: "http://stt.internal:8080/", inference: "http://stt.internal:8080/inference" });
});

test("wraps PCM16 in a valid mono 16kHz WAV", () => {
  const wav = pcm16Wav(Buffer.from([1, 0, 2, 0]));
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(40), 4);
});

test("uploads a buffered microphone utterance and emits its final text", async () => {
  const events = [];
  const calls = [];
  const provider = new WhisperCppProvider({ endpoint: "stt.internal:8080", onEvent: (event) => events.push(event), fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ text: " Hallo Welt " }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  provider.start(); provider.appendAudio("AQACAA==");
  assert.equal(await provider.stop(), true);
  assert.equal(calls[0].url, "http://stt.internal:8080/inference");
  assert.deepEqual(events.map((event) => event.type), ["stt.started", "stt.final"]);
  assert.equal(events.at(-1).text, "Hallo Welt");
});

test("uses the LAN gateway cloud hint and reports a local fallback without a secret", async () => {
  const events = []; let headers;
  const provider = new WhisperCppProvider({ endpoint: "stt.internal:8081", cloudMode: true, sessionId: "session_123456", onEvent: (event) => events.push(event), fetchImpl: async (_url, options) => {
    headers = options.headers;
    return new Response(JSON.stringify({ text: " Hallo " }), { status: 200, headers: { "content-type": "application/json", "x-jarvis-stt-provider": "whispercpp", "x-jarvis-stt-fallback": "quota" } });
  } });
  provider.start(); provider.appendAudio("AQACAA=="); await provider.stop();
  assert.deepEqual(headers, { "X-Jarvis-STT-Mode": "cloud", "X-Jarvis-STT-Session": "session_123456" });
  assert.deepEqual(events.at(-1), { type: "stt.final", provider: "whispercpp", text: "Hallo", language: "de", fallback: true, fallbackReason: "quota" });
});

test("reports a failed Whisper.cpp transcription without exposing the endpoint", async () => {
  const events = [];
  const provider = new WhisperCppProvider({ endpoint: "private-stt.internal:8080", onEvent: (event) => events.push(event), fetchImpl: async () => { throw new Error("private-stt.internal unavailable"); } });
  provider.start(); provider.appendAudio("AQACAA==");
  assert.equal(await provider.stop(), false);
  assert.deepEqual(events.at(-1), { type: "stt.error", provider: "whispercpp", error: "transcription-failed", fatal: false });
});
