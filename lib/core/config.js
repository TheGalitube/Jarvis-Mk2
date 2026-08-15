import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROFILES = new Set(["sandbox-only", "standard", "trusted", "custom"]);
const TARGET_IDS = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TARGET_CAPABILITIES = new Set(["system-info", "filesystem-read", "filesystem-write", "process-list", "service-control", "shell"]);
const SSH_HOSTNAME = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:-]*|\[[a-fA-F0-9:]+\])$/;
const SSH_USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const VOICE_MODES = new Set(["push-to-talk", "voice-activation"]);
const STT_PROVIDERS = new Set(["auto", "chrome", "nemotron", "whispercpp"]);
const LANGUAGE = /^(?:auto|[a-z]{2,3}(?:-[A-Z]{2})?)$/;

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  execution: {
    securityProfile: "sandbox-only",
    defaultTarget: "sandbox",
  },
  targets: {
    sandbox: { enabled: true },
    local: { enabled: false, safeRoots: [], shellEnabled: false },
  },
  hosts: {},
  jarvis: { name: "Jarvis" },
  voice: {
    mode: "push-to-talk",
    wakeWords: ["jarvis", "hey jarvis"],
    silenceTimeoutMs: 1_400,
  },
  stt: {
    provider: "chrome", fallbackToChrome: true,
    chrome: { enabled: true, language: "en-US" },
    nemotron: { endpoint: null, language: "auto", timeoutMs: 5_000 },
    whispercpp: { endpoint: null, language: "de", timeoutMs: 20_000 },
    gateway: { cloudOptInEnabled: false },
  },
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, override) {
  const out = clone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = plainObject(value) && plainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

function readConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!plainObject(parsed)) throw new Error("configuration must be a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(`Cannot read JARVIS runtime config at ${path}: ${error.message}`);
  }
}

export function validateRuntimeConfig(config) {
  if (!plainObject(config)) throw new Error("runtime configuration must be an object");
  const execution = config.execution;
  if (!plainObject(execution)) throw new Error("runtime configuration requires execution");
  if (!PROFILES.has(execution.securityProfile)) {
    throw new Error("execution.securityProfile must be sandbox-only, standard, trusted, or custom");
  }
  if (typeof execution.defaultTarget !== "string" || !TARGET_IDS.test(execution.defaultTarget)) {
    throw new Error("execution.defaultTarget must be a valid target id");
  }
  if (!plainObject(config.targets) || !plainObject(config.targets.sandbox)) {
    throw new Error("runtime configuration requires targets.sandbox");
  }
  for (const [id, target] of Object.entries({ ...config.targets, ...config.hosts })) {
    if (!TARGET_IDS.test(id) || !plainObject(target) || typeof target.enabled !== "boolean") {
      throw new Error(`invalid target configuration: ${id}`);
    }
  }
  const local = config.targets.local;
  if (!plainObject(local) || !Array.isArray(local.safeRoots) || !local.safeRoots.every((path) => typeof path === "string" && path.trim())) {
    throw new Error("targets.local.safeRoots must be an array of non-empty paths");
  }
  if (typeof local.shellEnabled !== "boolean") throw new Error("targets.local.shellEnabled must be a boolean");
  if (!plainObject(config.hosts)) throw new Error("hosts must be an object");
  for (const [id, host] of Object.entries(config.hosts)) {
    if (!TARGET_IDS.test(id) || host.type !== "ssh" || typeof host.hostname !== "string" || !SSH_HOSTNAME.test(host.hostname) || typeof host.username !== "string" || !SSH_USERNAME.test(host.username)) {
      throw new Error(`invalid SSH host configuration: ${id}`);
    }
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error(`invalid SSH port: ${id}`);
    if (!["auto", "linux", "darwin", "win32"].includes(host.platform)) throw new Error(`invalid SSH platform: ${id}`);
    if (!Array.isArray(host.capabilities) || !host.capabilities.every((capability) => TARGET_CAPABILITIES.has(capability))) {
      throw new Error(`invalid SSH capabilities: ${id}`);
    }
    if (host.identityFile !== undefined && (typeof host.identityFile !== "string" || !host.identityFile.trim())) throw new Error(`invalid SSH identity file: ${id}`);
    for (const field of ["connectTimeoutMs", "commandTimeoutMs"]) {
      if (!Number.isFinite(host[field]) || host[field] <= 0) throw new Error(`invalid SSH ${field}: ${id}`);
    }
  }
  if (!plainObject(config.jarvis) || typeof config.jarvis.name !== "string" || !config.jarvis.name.trim() || config.jarvis.name.length > 80) {
    throw new Error("jarvis.name must be a non-empty value up to 80 characters");
  }
  const voice = config.voice;
  if (!plainObject(voice) || !VOICE_MODES.has(voice.mode)) throw new Error("voice.mode must be push-to-talk or voice-activation");
  if (!Array.isArray(voice.wakeWords) || voice.wakeWords.length === 0 || !voice.wakeWords.every((word) => typeof word === "string" && word.trim() && word.length <= 80)) {
    throw new Error("voice.wakeWords must contain non-empty phrases up to 80 characters");
  }
  if (!Number.isInteger(voice.silenceTimeoutMs) || voice.silenceTimeoutMs < 250 || voice.silenceTimeoutMs > 120_000) {
    throw new Error("voice.silenceTimeoutMs must be between 250 and 120000 milliseconds");
  }
  const stt = config.stt;
  if (!plainObject(stt) || !STT_PROVIDERS.has(stt.provider) || typeof stt.fallbackToChrome !== "boolean" || !plainObject(stt.chrome) || !plainObject(stt.nemotron) || !plainObject(stt.whispercpp) || !plainObject(stt.gateway)) {
    throw new Error("invalid STT configuration");
  }
  if (typeof stt.chrome.enabled !== "boolean" || typeof stt.chrome.language !== "string" || !LANGUAGE.test(stt.chrome.language)) {
    throw new Error("invalid Chrome STT configuration");
  }
  if (stt.nemotron.endpoint !== null && (typeof stt.nemotron.endpoint !== "string" || !stt.nemotron.endpoint.trim() || /\s/.test(stt.nemotron.endpoint))) {
    throw new Error("invalid Nemotron endpoint");
  }
  if (typeof stt.nemotron.language !== "string" || !LANGUAGE.test(stt.nemotron.language) || !Number.isInteger(stt.nemotron.timeoutMs) || stt.nemotron.timeoutMs < 100 || stt.nemotron.timeoutMs > 60_000) {
    throw new Error("invalid Nemotron STT configuration");
  }
  if (stt.whispercpp.endpoint !== null && (typeof stt.whispercpp.endpoint !== "string" || !stt.whispercpp.endpoint.trim() || /\s/.test(stt.whispercpp.endpoint))) {
    throw new Error("invalid Whisper.cpp endpoint");
  }
  if (typeof stt.whispercpp.language !== "string" || !LANGUAGE.test(stt.whispercpp.language) || !Number.isInteger(stt.whispercpp.timeoutMs) || stt.whispercpp.timeoutMs < 100 || stt.whispercpp.timeoutMs > 60_000) {
    throw new Error("invalid Whisper.cpp STT configuration");
  }
  if (typeof stt.gateway.cloudOptInEnabled !== "boolean") throw new Error("invalid STT gateway configuration");
  if (stt.provider === "chrome" && !stt.chrome.enabled) throw new Error("Chrome STT provider is disabled");
  if (stt.provider === "nemotron" && !stt.nemotron.endpoint) throw new Error("Nemotron STT provider requires an endpoint");
  if (stt.provider === "whispercpp" && !stt.whispercpp.endpoint) throw new Error("Whisper.cpp STT provider requires an endpoint");
  if (stt.provider === "auto" && !stt.chrome.enabled && !stt.nemotron.endpoint && !stt.whispercpp.endpoint) throw new Error("STT auto requires Chrome, Nemotron, or Whisper.cpp");
  return config;
}

function csv(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

// A browser may receive only display-safe runtime state. In particular this
// never contains SSH identities, remote hostnames, TTS credentials or a raw
// Nemotron endpoint that a page could substitute at will.
export function publicRuntimeConfig(config) {
  return {
    jarvis: { name: config.jarvis.name },
    voice: { mode: config.voice.mode, wakeWords: [...config.voice.wakeWords], silenceTimeoutMs: config.voice.silenceTimeoutMs },
    stt: { provider: config.stt.provider, fallbackToChrome: config.stt.fallbackToChrome, chrome: { enabled: config.stt.chrome.enabled, language: config.stt.chrome.language }, nemotron: { configured: Boolean(config.stt.nemotron.endpoint), language: config.stt.nemotron.language }, whispercpp: { configured: Boolean(config.stt.whispercpp.endpoint), language: config.stt.whispercpp.language }, gateway: { cloudOptInEnabled: config.stt.gateway.cloudOptInEnabled } },
  };
}

// Phase 1 deliberately accepts JSON only. YAML is a deployment convenience,
// not a reason to add a parser to the trusted server start path yet.
export function loadRuntimeConfig({ env = process.env, path, overrides } = {}) {
  const configuredPath = path ?? env.JARVIS_CONFIG_FILE;
  let config = clone(DEFAULT_RUNTIME_CONFIG);
  if (configuredPath) config = merge(config, readConfig(resolve(configuredPath)));
  const envOverrides = { execution: {}, voice: {}, stt: { chrome: {}, nemotron: {}, whispercpp: {}, gateway: {} } };
  if (env.JARVIS_SECURITY_PROFILE) envOverrides.execution.securityProfile = env.JARVIS_SECURITY_PROFILE;
  if (env.JARVIS_DEFAULT_TARGET) envOverrides.execution.defaultTarget = env.JARVIS_DEFAULT_TARGET;
  if (env.JARVIS_VOICE_MODE) envOverrides.voice.mode = env.JARVIS_VOICE_MODE;
  if (env.JARVIS_WAKE_WORDS) envOverrides.voice.wakeWords = csv(env.JARVIS_WAKE_WORDS);
  if (env.JARVIS_SILENCE_TIMEOUT_MS) envOverrides.voice.silenceTimeoutMs = Number(env.JARVIS_SILENCE_TIMEOUT_MS);
  if (env.JARVIS_STT_PROVIDER) envOverrides.stt.provider = env.JARVIS_STT_PROVIDER;
  if (env.JARVIS_STT_FALLBACK_TO_CHROME) envOverrides.stt.fallbackToChrome = env.JARVIS_STT_FALLBACK_TO_CHROME === "true";
  if (env.JARVIS_CHROME_STT_LANGUAGE) envOverrides.stt.chrome.language = env.JARVIS_CHROME_STT_LANGUAGE;
  if (env.JARVIS_CHROME_STT_ENABLED) envOverrides.stt.chrome.enabled = env.JARVIS_CHROME_STT_ENABLED === "true";
  if (env.JARVIS_NEMOTRON_ENDPOINT) envOverrides.stt.nemotron.endpoint = env.JARVIS_NEMOTRON_ENDPOINT;
  if (env.JARVIS_NEMOTRON_LANGUAGE) envOverrides.stt.nemotron.language = env.JARVIS_NEMOTRON_LANGUAGE;
  if (env.JARVIS_NEMOTRON_TIMEOUT_MS) envOverrides.stt.nemotron.timeoutMs = Number(env.JARVIS_NEMOTRON_TIMEOUT_MS);
  if (env.JARVIS_WHISPERCPP_ENDPOINT) envOverrides.stt.whispercpp.endpoint = env.JARVIS_WHISPERCPP_ENDPOINT;
  if (env.JARVIS_WHISPERCPP_LANGUAGE) envOverrides.stt.whispercpp.language = env.JARVIS_WHISPERCPP_LANGUAGE;
  if (env.JARVIS_WHISPERCPP_TIMEOUT_MS) envOverrides.stt.whispercpp.timeoutMs = Number(env.JARVIS_WHISPERCPP_TIMEOUT_MS);
  if (env.JARVIS_STT_GATEWAY_CLOUD_OPT_IN_ENABLED) envOverrides.stt.gateway.cloudOptInEnabled = env.JARVIS_STT_GATEWAY_CLOUD_OPT_IN_ENABLED === "true";
  config = merge(config, envOverrides);
  config = merge(config, overrides);
  // Hosts are opt-in simply by appearing in configuration. Defaults here are
  // deliberately transport-only; they never carry private-key contents.
  config.hosts = Object.fromEntries(Object.entries(config.hosts ?? {}).map(([id, host]) => [id, {
    enabled: true,
    type: "ssh",
    port: 22,
    platform: "auto",
    capabilities: ["system-info", "process-list", "service-control"],
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 10_000,
    ...host,
  }]));
  return validateRuntimeConfig(config);
}
