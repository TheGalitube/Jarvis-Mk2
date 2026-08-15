import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeConfig, publicRuntimeConfig } from "../lib/core/config.js";

test("keeps safe voice and STT defaults for a zero-config installation", () => {
  const config = loadRuntimeConfig();
  assert.deepEqual(config.voice, { mode: "push-to-talk", wakeWords: ["jarvis", "hey jarvis"], silenceTimeoutMs: 1400 });
  assert.equal(config.stt.provider, "openai");
  assert.equal(config.stt.openai.model, "gpt-4o-transcribe");
  assert.equal(config.stt.fallbackToChrome, true);
  assert.equal(config.stt.nemotron.endpoint, null);
});

test("ships a valid, conservative Linux runtime example", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const example = JSON.parse(await readFile(join(here, "..", "data", "runtime-config.example.json"), "utf8"));
  const config = loadRuntimeConfig({ overrides: example });
  assert.equal(config.execution.securityProfile, "sandbox-only");
  assert.equal(config.targets.local.enabled, false);
  assert.deepEqual(config.targets.local.safeRoots, ["/home/jarvis"]);
});

test("loads voice and Nemotron configuration from a JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-runtime-config-"));
  const path = join(dir, "jarvis.json");
  try {
    await writeFile(path, JSON.stringify({
      execution: { securityProfile: "standard", defaultTarget: "local" },
      targets: { local: { enabled: true } },
      voice: { mode: "voice-activation", wakeWords: ["hey jarvis"], silenceTimeoutMs: 900 },
      stt: { provider: "auto", chrome: { language: "de-DE" }, nemotron: { endpoint: "asr.internal:50051", language: "auto", timeoutMs: 3000 } },
    }));
    const config = loadRuntimeConfig({ path });
    assert.equal(config.voice.mode, "voice-activation");
    assert.equal(config.stt.chrome.language, "de-DE");
    assert.equal(config.stt.nemotron.endpoint, "asr.internal:50051");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("environment values override config values without allowing malformed values", () => {
  const config = loadRuntimeConfig({ env: {
    JARVIS_VOICE_MODE: "voice-activation",
    JARVIS_WAKE_WORDS: "jarvis, hey jarvis",
    JARVIS_SILENCE_TIMEOUT_MS: "750",
    JARVIS_STT_PROVIDER: "auto",
    JARVIS_NEMOTRON_ENDPOINT: "gpu.internal:50051",
    JARVIS_NEMOTRON_LANGUAGE: "de-DE",
  } });
  assert.deepEqual(config.voice.wakeWords, ["jarvis", "hey jarvis"]);
  assert.equal(config.stt.nemotron.language, "de-DE");
  assert.throws(() => loadRuntimeConfig({ env: { JARVIS_STT_PROVIDER: "nemotron" } }), /requires an endpoint/);
  assert.throws(() => loadRuntimeConfig({ overrides: { voice: { silenceTimeoutMs: 10 } } }), /silenceTimeoutMs/);
});

test("public runtime settings never expose transport or endpoint details", () => {
  const config = loadRuntimeConfig({ overrides: {
    hosts: { minecraft: { type: "ssh", hostname: "10.0.0.30", username: "jarvis", identityFile: "C:/secret/id" } },
    stt: { provider: "auto", nemotron: { endpoint: "gpu.internal:50051" }, whispercpp: { endpoint: "whisper.internal:8080" } },
  } });
  const exposed = publicRuntimeConfig(config);
  assert.equal(exposed.stt.nemotron.configured, true);
  assert.equal(JSON.stringify(exposed).includes("gpu.internal"), false);
  assert.equal(JSON.stringify(exposed).includes("whisper.internal"), false);
  assert.equal(JSON.stringify(exposed).includes("10.0.0.30"), false);
  assert.equal(JSON.stringify(exposed).includes("C:/secret"), false);
});

test("allows only the selectable OpenAI transcription models", () => {
  const config = loadRuntimeConfig({ overrides: { stt: { openai: { model: "whisper-1" } } } });
  assert.equal(config.stt.openai.model, "whisper-1");
  assert.throws(() => loadRuntimeConfig({ overrides: { stt: { openai: { model: "other" } } } }), /invalid OpenAI STT/);
});
