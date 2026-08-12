import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFishRequest, buildOpenAiRequest, buildTtsRequest, speak } from "../lib/tts.js";

const fish = {
  provider: "fish",
  apiKey: "fish-key",
  voiceId: "voice-id",
  model: "s2.1-pro-free",
  format: "mp3",
  speed: 1.1,
};

const openai = {
  provider: "openai",
  apiKey: "openai-key",
  model: "gpt-4o-mini-tts",
  voice: "cedar",
  format: "mp3",
  instructions: "Speak calmly.",
};

test("builds a Fish TTS request", () => {
  const request = buildFishRequest("hello", fish);
  assert.equal(request.url, "https://api.fish.audio/v1/tts");
  assert.equal(request.headers.model, "s2.1-pro-free");
  assert.equal(request.headers.Authorization, "Bearer fish-key");
  assert.equal(request.body.reference_id, "voice-id");
  assert.equal(request.body.text, "hello");
  assert.deepEqual(request.body.prosody, { speed: 1.1 });
});

test("omits Fish prosody at speed 1", () => {
  const request = buildFishRequest("hi", { ...fish, speed: 1 });
  assert.equal(request.body.prosody, undefined);
});

test("builds an OpenAI speech request", () => {
  const request = buildOpenAiRequest("hello", openai);
  assert.equal(request.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(request.headers.Authorization, "Bearer openai-key");
  assert.deepEqual(request.body, {
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    input: "hello",
    instructions: "Speak calmly.",
    response_format: "mp3",
  });
});

test("the request dispatcher rejects unknown providers", () => {
  assert.throws(() => buildTtsRequest("hello", { provider: "other" }), /Unknown TTS/);
});

test("returns text-only mode without configured providers", async () => {
  const result = await speak("hello", { order: [], providers: {} });
  assert.deepEqual(result, { audio: null, format: null, provider: "off", failures: [] });
});

test("returns audio from the preferred provider", async () => {
  const calls = [];
  const result = await speak("hello", {
    order: ["fish", "openai"],
    providers: { fish, openai },
    timeoutMs: 1000,
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(Buffer.from("fish-audio"), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.provider, "fish");
  assert.equal(result.format, "mp3");
  assert.equal(result.audio.toString(), "fish-audio");
  assert.deepEqual(result.failures, []);
});

test("falls back from Fish to OpenAI", async () => {
  const calls = [];
  const failures = [];
  const result = await speak("hello", {
    order: ["fish", "openai"],
    providers: { fish, openai },
    timeoutMs: 1000,
  }, {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("fish.audio")) return new Response("outage", { status: 503 });
      return new Response(Buffer.from("openai-audio"), { status: 200 });
    },
    onProviderError: (failure) => failures.push(failure),
  });

  assert.deepEqual(calls, [
    "https://api.fish.audio/v1/tts",
    "https://api.openai.com/v1/audio/speech",
  ]);
  assert.equal(result.provider, "openai");
  assert.equal(result.audio.toString(), "openai-audio");
  assert.equal(result.failures[0].provider, "fish");
  assert.deepEqual(failures, result.failures);
});

test("an empty successful response also triggers fallback", async () => {
  let calls = 0;
  const result = await speak("hello", {
    order: ["fish", "openai"],
    providers: { fish, openai },
    timeoutMs: 1000,
  }, {
    fetchImpl: async () => {
      calls++;
      return new Response(calls === 1 ? Buffer.alloc(0) : Buffer.from("audio"), { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.provider, "openai");
  assert.equal(result.failures[0].message, "empty audio response");
});

test("a failing observer cannot prevent provider fallback", async () => {
  let calls = 0;
  const result = await speak("hello", {
    order: ["fish", "openai"],
    providers: { fish, openai },
    timeoutMs: 1000,
  }, {
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("outage", { status: 503 })
        : new Response(Buffer.from("audio"), { status: 200 });
    },
    onProviderError: () => { throw new Error("observer failed"); },
  });
  assert.equal(result.provider, "openai");
});

test("reports every provider failure without exposing credentials", async () => {
  await assert.rejects(
    speak("hello", {
      order: ["fish", "openai"],
      providers: { fish, openai },
      timeoutMs: 1000,
    }, {
      fetchImpl: async () => new Response("denied", { status: 401 }),
    }),
    (error) => {
      assert.match(error.message, /fish: 401: denied/);
      assert.match(error.message, /openai: 401: denied/);
      assert.doesNotMatch(error.message, /fish-key|openai-key/);
      return true;
    },
  );
});
