import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "fish-audio", "speak.json");
const PROVIDERS = new Set(["auto", "fish", "openai", "off"]);

function optionalJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read TTS config at ${path}: ${error.message}`);
  }
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadTtsConfig(path = DEFAULT_PATH, env = process.env) {
  const file = optionalJson(path);
  const preferred = text(env.JARVIS_TTS_PROVIDER, text(file.provider, "auto")).toLowerCase();
  if (!PROVIDERS.has(preferred)) {
    throw new Error("JARVIS_TTS_PROVIDER must be auto, fish, openai, or off");
  }

  const fishKey = text(env.FISH_API_KEY, text(file.apiKey));
  const openaiKey = text(env.OPENAI_API_KEY);
  const providers = {};

  if (fishKey) {
    providers.fish = {
      provider: "fish",
      apiKey: fishKey,
      voiceId: text(env.FISH_VOICE_ID, text(file.voiceId)),
      model: text(env.FISH_TTS_MODEL, text(file.model, "s2.1-pro-free")),
      format: text(env.FISH_TTS_FORMAT, text(file.format, "mp3")),
      speed: positiveNumber(env.FISH_TTS_SPEED ?? file.speed, 1),
    };
  }

  if (openaiKey) {
    const openai = file.openai && typeof file.openai === "object" ? file.openai : {};
    providers.openai = {
      provider: "openai",
      apiKey: openaiKey,
      model: text(env.OPENAI_TTS_MODEL, text(openai.model, "gpt-4o-mini-tts")),
      voice: text(env.OPENAI_TTS_VOICE, text(openai.voice, "cedar")),
      format: text(env.OPENAI_TTS_FORMAT, text(openai.format, "mp3")),
      instructions: text(
        env.OPENAI_TTS_INSTRUCTIONS,
        text(openai.instructions, "Speak as a calm, precise British AI butler."),
      ),
    };
  }

  const available = Object.keys(providers);
  let order = [];
  if (preferred !== "off") {
    const first = preferred === "auto" ? "fish" : preferred;
    order = [first, ...available.filter((name) => name !== first)].filter(
      (name) => providers[name],
    );
  }

  return {
    preferred,
    order,
    providers,
    timeoutMs: positiveNumber(env.JARVIS_TTS_TIMEOUT_MS, 15000),
  };
}

// Compatibility helper for callers that still need the legacy Fish-only shape.
export function loadFishConfig(path = DEFAULT_PATH, env = process.env) {
  const cfg = loadTtsConfig(path, { ...env, JARVIS_TTS_PROVIDER: "fish" });
  if (!cfg.providers.fish) {
    throw new Error("No Fish API key (FISH_API_KEY or apiKey in speak.json)");
  }
  return cfg.providers.fish;
}
