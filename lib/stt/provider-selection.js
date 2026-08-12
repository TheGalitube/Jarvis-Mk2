// Provider selection is deterministic and independent of an AI response. It
// is intentionally async because a Nemotron health probe is a network check.
export async function selectSttProvider(config, { nemotronHealth } = {}) {
  const stt = config?.stt;
  if (!stt) throw new Error("STT configuration is required");
  const chromeAvailable = Boolean(stt.chrome?.enabled);
  const configuredNemotron = Boolean(stt.nemotron?.endpoint);
  const healthyNemotron = configuredNemotron && typeof nemotronHealth === "function" && await nemotronHealth();

  if (stt.provider === "chrome") return { provider: "chrome", fallback: false };
  if (healthyNemotron) return { provider: "nemotron", fallback: false };
  if (chromeAvailable && stt.fallbackToChrome) return { provider: "chrome", fallback: configuredNemotron };
  if (stt.provider === "auto" && chromeAvailable) return { provider: "chrome", fallback: false };
  throw new Error("Configured STT provider is unavailable and Chrome fallback is disabled");
}
