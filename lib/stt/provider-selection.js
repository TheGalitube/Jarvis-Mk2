// Provider selection is deterministic and independent of an AI response. It
// is intentionally async because a Nemotron health probe is a network check.
export async function selectSttProvider(config, { openAiAvailable = false, nemotronHealth, whisperCppHealth, preferCloud = false, cloudAvailable = false } = {}) {
  const stt = config?.stt;
  if (!stt) throw new Error("STT configuration is required");
  const chromeAvailable = Boolean(stt.chrome?.enabled);
  const configuredNemotron = Boolean(stt.nemotron?.endpoint);
  const configuredWhisperCpp = Boolean(stt.whispercpp?.endpoint);
  const healthyNemotron = configuredNemotron && typeof nemotronHealth === "function" && await nemotronHealth();
  const healthyWhisperCpp = configuredWhisperCpp && typeof whisperCppHealth === "function" && await whisperCppHealth();
  if (preferCloud && cloudAvailable) return { provider: "openai", fallback: false };

  if (stt.provider === "chrome") return { provider: "chrome", fallback: false };
  if (stt.provider === "openai" && openAiAvailable) return { provider: "openai", fallback: false };
  if (stt.provider === "whispercpp" && healthyWhisperCpp) return { provider: "whispercpp", fallback: Boolean(preferCloud), fallbackReason: preferCloud ? "cloud-unavailable" : undefined };
  if (stt.provider === "nemotron" && healthyNemotron) return { provider: "nemotron", fallback: false };
  if (stt.provider === "openai" && stt.fallbackToChrome && chromeAvailable) return { provider: "chrome", fallback: true };
  if (stt.provider === "whispercpp" && stt.fallbackToChrome && chromeAvailable) return { provider: "chrome", fallback: true };
  if (stt.provider === "nemotron" && stt.fallbackToChrome && chromeAvailable) return { provider: "chrome", fallback: true };
  if (stt.provider !== "auto") throw new Error("Configured STT provider is unavailable and Chrome fallback is disabled");
  if (healthyWhisperCpp) return { provider: "whispercpp", fallback: Boolean(preferCloud), fallbackReason: preferCloud ? "cloud-unavailable" : undefined };
  if (healthyNemotron) return { provider: "nemotron", fallback: false };
  if (chromeAvailable && stt.fallbackToChrome) return { provider: "chrome", fallback: configuredNemotron };
  if (stt.provider === "auto" && chromeAvailable) return { provider: "chrome", fallback: false };
  throw new Error("Configured STT provider is unavailable and Chrome fallback is disabled");
}
