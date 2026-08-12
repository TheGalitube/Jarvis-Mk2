import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFishConfig, loadTtsConfig } from "../lib/config.js";

const fixture = fileURLToPath(new URL("./fixtures/speak.json", import.meta.url));

test("loads the legacy fish config and keeps Fish first", () => {
  const cfg = loadTtsConfig(fixture, {});
  assert.deepEqual(cfg.order, ["fish"]);
  assert.equal(cfg.providers.fish.apiKey, "test-key");
  assert.equal(cfg.providers.fish.voiceId, "test-voice-id");
  assert.equal(cfg.providers.fish.model, "s2.1-pro-free");
  assert.equal(cfg.providers.fish.speed, 1.1);
});

test("uses OpenAI when the Fish file is absent", () => {
  const cfg = loadTtsConfig("/nonexistent/speak.json", { OPENAI_API_KEY: "openai-key" });
  assert.deepEqual(cfg.order, ["openai"]);
  assert.equal(cfg.providers.openai.model, "gpt-4o-mini-tts");
  assert.equal(cfg.providers.openai.voice, "cedar");
  assert.equal(cfg.providers.openai.format, "mp3");
});

test("auto prefers Fish and keeps OpenAI as fallback", () => {
  const cfg = loadTtsConfig(fixture, { OPENAI_API_KEY: "openai-key" });
  assert.deepEqual(cfg.order, ["fish", "openai"]);
});

test("an explicit OpenAI preference reverses the fallback order", () => {
  const cfg = loadTtsConfig(fixture, {
    OPENAI_API_KEY: "openai-key",
    JARVIS_TTS_PROVIDER: "openai",
  });
  assert.deepEqual(cfg.order, ["openai", "fish"]);
});

test("starts in text-only mode when no provider is configured", () => {
  const cfg = loadTtsConfig("/nonexistent/speak.json", {});
  assert.deepEqual(cfg.order, []);
  assert.deepEqual(cfg.providers, {});
});

test("off disables audio even when provider keys exist", () => {
  const cfg = loadTtsConfig(fixture, {
    OPENAI_API_KEY: "openai-key",
    JARVIS_TTS_PROVIDER: "off",
  });
  assert.deepEqual(cfg.order, []);
  assert.ok(cfg.providers.fish);
  assert.ok(cfg.providers.openai);
});

test("environment fields override provider defaults", () => {
  const cfg = loadTtsConfig("/nonexistent/speak.json", {
    OPENAI_API_KEY: "openai-key",
    OPENAI_TTS_MODEL: "custom-model",
    OPENAI_TTS_VOICE: "marin",
    OPENAI_TTS_FORMAT: "wav",
    OPENAI_TTS_INSTRUCTIONS: "Speak softly.",
    JARVIS_TTS_TIMEOUT_MS: "4321",
  });
  assert.equal(cfg.providers.openai.model, "custom-model");
  assert.equal(cfg.providers.openai.voice, "marin");
  assert.equal(cfg.providers.openai.format, "wav");
  assert.equal(cfg.providers.openai.instructions, "Speak softly.");
  assert.equal(cfg.timeoutMs, 4321);
});

test("rejects an unknown provider name", () => {
  assert.throws(
    () => loadTtsConfig("/nonexistent/speak.json", { JARVIS_TTS_PROVIDER: "other" }),
    /auto, fish, openai, or off/,
  );
});

test("rejects a config whose root is not an object", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-config-"));
  const path = join(dir, "speak.json");
  writeFileSync(path, "null");
  assert.throws(() => loadTtsConfig(path, {}), /configuration must be a JSON object/);
});

test("the legacy Fish helper still returns its old shape", () => {
  const cfg = loadFishConfig(fixture, {});
  assert.equal(cfg.provider, "fish");
  assert.equal(cfg.apiKey, "test-key");
});

test("the legacy Fish helper still rejects a missing Fish key", () => {
  assert.throws(
    () => loadFishConfig("/nonexistent/speak.json", {}),
    /No Fish API key/,
  );
});
