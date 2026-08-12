import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../lib/core/config.js";
import { selectSttProvider } from "../lib/stt/provider-selection.js";

test("uses Chrome when it is explicitly selected", async () => {
  const config = loadRuntimeConfig();
  assert.deepEqual(await selectSttProvider(config), { provider: "chrome", fallback: false });
});

test("auto uses healthy Nemotron and falls back to Chrome on an outage", async () => {
  const config = loadRuntimeConfig({ overrides: { stt: { provider: "auto", nemotron: { endpoint: "asr.internal:9000" } } } });
  assert.deepEqual(await selectSttProvider(config, { nemotronHealth: async () => true }), { provider: "nemotron", fallback: false });
  assert.deepEqual(await selectSttProvider(config, { nemotronHealth: async () => false }), { provider: "chrome", fallback: true });
});

test("explicit Nemotron also falls back only when configured to do so", async () => {
  const config = loadRuntimeConfig({ overrides: { stt: { provider: "nemotron", nemotron: { endpoint: "asr.internal:9000" } } } });
  assert.deepEqual(await selectSttProvider(config, { nemotronHealth: async () => false }), { provider: "chrome", fallback: true });
  const noFallback = loadRuntimeConfig({ overrides: { stt: { provider: "nemotron", fallbackToChrome: false, nemotron: { endpoint: "asr.internal:9000" } } } });
  await assert.rejects(selectSttProvider(noFallback, { nemotronHealth: async () => false }), /fallback is disabled/);
});
