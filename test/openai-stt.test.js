import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiTranscriptionProvider, transcribeAudioFile } from "../lib/stt/openai.js";

test("uploads the selected OpenAI STT model without exposing its API key", async () => {
  const events = []; const calls = [];
  const provider = new OpenAiTranscriptionProvider({ apiKey: "test-secret", model: "whisper-1", language: "de", onEvent: (event) => events.push(event), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ text: " Hallo Max " }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  provider.start(); provider.appendAudio("AQACAA==");
  assert.equal(await provider.stop(), true);
  assert.equal(calls[0].url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.deepEqual(events.at(-1), { type: "stt.final", provider: "openai", model: "whisper-1", text: "Hallo Max", language: "de" });
});

test("reports a generic failure without exposing an OpenAI API key", async () => {
  const events = [];
  const provider = new OpenAiTranscriptionProvider({ apiKey: "private-key", onEvent: (event) => events.push(event), fetchImpl: async () => { throw new Error("private-key rejected"); } });
  provider.start(); provider.appendAudio("AQACAA==");
  assert.equal(await provider.stop(), false);
  assert.deepEqual(events.at(-1), { type: "stt.error", provider: "openai", model: "gpt-4o-transcribe", error: "transcription-failed", fatal: false });
});

test("transcribes an encoded voice file for Telegram", async () => {
  const calls = [];
  const text = await transcribeAudioFile({ apiKey: "test-secret", model: "whisper-1", language: "de", audio: Buffer.from([1, 2, 3]), filename: "voice.ogg", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ text: " Guten Morgen " }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  assert.equal(text, "Guten Morgen");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
});
