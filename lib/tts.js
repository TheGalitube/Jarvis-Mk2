const FISH_URL = "https://api.fish.audio/v1/tts";
const OPENAI_URL = "https://api.openai.com/v1/audio/speech";

export function buildFishRequest(text, cfg) {
  const body = { text, format: cfg.format, latency: "normal" };
  if (cfg.voiceId) body.reference_id = cfg.voiceId;
  if (cfg.speed && cfg.speed !== 1) body.prosody = { speed: cfg.speed };
  return {
    provider: "fish",
    format: cfg.format,
    url: FISH_URL,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      model: cfg.model,
    },
    body,
  };
}

export function buildOpenAiRequest(text, cfg) {
  return {
    provider: "openai",
    format: cfg.format,
    url: OPENAI_URL,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: {
      model: cfg.model,
      voice: cfg.voice,
      input: text,
      instructions: cfg.instructions,
      response_format: cfg.format,
    },
  };
}

export function buildTtsRequest(text, cfg) {
  if (cfg?.provider === "fish") return buildFishRequest(text, cfg);
  if (cfg?.provider === "openai") return buildOpenAiRequest(text, cfg);
  throw new Error(`Unknown TTS provider: ${cfg?.provider ?? "missing"}`);
}

async function requestAudio(text, cfg, fetchImpl, timeoutMs) {
  const request = buildTtsRequest(text, cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new Error("empty audio response");
    return {
      audio,
      format: request.format,
      provider: request.provider,
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Tries providers in configured order. A provider outage or bad credential does
// not take down the conversation; callers may continue in text-only mode after
// every configured provider has failed.
export async function speak(text, cfg, options = {}) {
  const order = Array.isArray(cfg?.order) ? cfg.order : [];
  if (order.length === 0) {
    return { audio: null, format: null, provider: "off", failures: [] };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const failures = [];
  for (const name of order) {
    const provider = cfg.providers?.[name];
    if (!provider) continue;
    try {
      const result = await requestAudio(text, provider, fetchImpl, cfg.timeoutMs ?? 15000);
      return { ...result, failures };
    } catch (error) {
      const failure = { provider: name, message: String(error?.message || error) };
      failures.push(failure);
      if (typeof options.onProviderError === "function") {
        try { options.onProviderError(failure); }
        catch { /* observability must not prevent provider fallback */ }
      }
    }
  }

  const summary = failures.map(({ provider, message }) => `${provider}: ${message}`).join("; ");
  throw new Error(`TTS providers failed${summary ? ` (${summary})` : ""}`);
}
