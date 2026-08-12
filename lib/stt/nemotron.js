const MAX_AUDIO_BASE64 = 15 * 1024 * 1024;

function asHttpUrl(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (!value) throw new Error("Nemotron endpoint is not configured");
  return new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
}

// NVIDIA's realtime API is HTTP on port 9000 for health/session setup and a
// websocket at /v1/realtime?intent=transcription. This normalizer accepts the
// config's host:port shorthand while keeping protocol selection explicit.
export function nemotronUrls(endpoint) {
  const base = asHttpUrl(endpoint);
  const health = new URL("/v1/health", base);
  const realtime = new URL("/v1/realtime", base);
  realtime.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  realtime.searchParams.set("intent", "transcription");
  return { health: health.href, realtime: realtime.href };
}

export function nemotronSessionUpdate({ language = "auto", sampleRateHz = 16_000 } = {}) {
  return {
    type: "transcription_session.update",
    session: {
      modalities: ["text"], input_audio_format: "pcm16",
      input_audio_transcription: { language: language === "auto" ? undefined : language, model: "nemotron-asr-streaming", prompt: "" },
      input_audio_params: { sample_rate_hz: sampleRateHz, num_channels: 1 },
      recognition_config: { max_alternatives: 1, enable_automatic_punctuation: true, enable_word_time_offsets: false, enable_profanity_filter: false, enable_verbatim_transcripts: false },
    },
  };
}

function emit(listener, event) {
  try { listener?.(event); } catch { /* events must not alter transport state */ }
}

function parseMessage(raw) {
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// Server-side NIM transport. Browser microphone capture is intentionally a
// separate Phase 7 concern; this class only accepts PCM16 base64 chunks and
// emits the same normalized STT events as the Chrome provider.
export class NemotronStreamingProvider {
  constructor({ endpoint, language = "auto", timeoutMs = 5_000, onEvent, socketFactory } = {}) {
    this.endpoint = endpoint;
    this.language = language;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.socketFactory = socketFactory;
    this.socket = null;
    this.active = false;
    this.finalized = false;
  }

  get supported() { return Boolean(this.endpoint); }

  async health({ fetchImpl = fetch } = {}) {
    if (!this.supported) return false;
    const { health } = nemotronUrls(this.endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetchImpl(health, { signal: controller.signal });
      return response.ok;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  async start() {
    if (!this.supported) throw new Error("Nemotron endpoint is not configured");
    if (this.active) return false;
    const { realtime } = nemotronUrls(this.endpoint);
    // `ws` is already the runtime dependency, but importing it lazily keeps a
    // zero-config/browser-only test run from needing a client socket package.
    const socket = this.socketFactory
      ? await this.socketFactory(realtime)
      : new (await import("ws")).default(realtime);
    this.socket = socket;
    this.active = true;
    this.finalized = false;
    socket.on("open", () => {
      this.#send(nemotronSessionUpdate({ language: this.language }));
      emit(this.onEvent, { type: "stt.started", provider: "nemotron", language: this.language });
    });
    socket.on("message", (raw) => this.#message(raw));
    socket.on("error", () => this.#failure("connection-failed"));
    socket.on("close", () => {
      if (this.active && !this.finalized) this.#failure("disconnected");
      this.active = false;
    });
    return true;
  }

  appendAudio(audio) {
    if (!this.active) throw new Error("Nemotron session is not active");
    if (typeof audio !== "string" || !audio || audio.length > MAX_AUDIO_BASE64) throw new Error("invalid Nemotron PCM16 audio chunk");
    this.#send({ type: "input_audio_buffer.append", audio });
  }

  stop() {
    if (!this.active) return false;
    this.#send({ type: "input_audio_buffer.done" });
    return true;
  }

  close() {
    this.active = false;
    this.socket?.close();
    this.socket = null;
  }

  #send(event) { this.socket?.send(JSON.stringify(event)); }

  #message(raw) {
    const event = parseMessage(raw);
    if (!event) return;
    if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      emit(this.onEvent, { type: "stt.partial", provider: "nemotron", text: event.delta, language: this.language });
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      this.finalized = true;
      this.active = false;
      emit(this.onEvent, { type: "stt.final", provider: "nemotron", text: event.transcript, language: this.language });
    } else if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.#failure("transcription-failed");
    } else if (event.type === "error") {
      this.#failure("service-error");
    }
  }

  #failure(error) {
    if (!this.active && this.finalized) return;
    this.active = false;
    emit(this.onEvent, { type: "stt.error", provider: "nemotron", error, fatal: false });
  }
}
