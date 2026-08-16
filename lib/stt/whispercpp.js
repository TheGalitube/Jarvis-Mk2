const MAX_AUDIO_BASE64 = 15 * 1024 * 1024;

function asHttpUrl(endpoint) {
  const value = String(endpoint ?? "").trim();
  if (!value) throw new Error("Whisper.cpp endpoint is not configured");
  return new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
}

export function whisperCppUrls(endpoint) {
  const base = asHttpUrl(endpoint);
  return { health: base.href, inference: new URL("/inference", base).href };
}

// whisper-server accepts WAV uploads. The browser sends PCM16 frames so the
// JARVIS server makes a minimal, trusted WAV container without invoking ffmpeg
// or writing temporary audio to disk.
export function pcm16Wav(pcm) {
  const body = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + body.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

function emit(listener, event) {
  try { listener?.(event); } catch { /* transport events must not break STT */ }
}

export class WhisperCppProvider {
  constructor({ endpoint, language = "de", timeoutMs = 20_000, cloudMode = false, sessionId, onEvent, fetchImpl = fetch } = {}) {
    this.endpoint = endpoint;
    this.language = language;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.fetchImpl = fetchImpl;
    this.cloudMode = cloudMode; this.sessionId = sessionId;
    this.active = false;
    this.chunks = [];
    this.size = 0;
    this.controller = null;
  }

  get supported() { return Boolean(this.endpoint); }

  async health() {
    if (!this.supported) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return (await this.fetchImpl(whisperCppUrls(this.endpoint).health, { signal: controller.signal })).ok; }
    catch { return false; }
    finally { clearTimeout(timer); }
  }

  start() {
    if (!this.supported) throw new Error("Whisper.cpp endpoint is not configured");
    if (this.active) return false;
    this.active = true; this.chunks = []; this.size = 0;
    emit(this.onEvent, { type: "stt.started", provider: "whispercpp", language: this.language });
    return true;
  }

  appendAudio(audio) {
    if (!this.active) throw new Error("Whisper.cpp session is not active");
    if (typeof audio !== "string" || !audio || audio.length > MAX_AUDIO_BASE64) throw new Error("invalid Whisper.cpp PCM16 audio chunk");
    const chunk = Buffer.from(audio, "base64");
    if (chunk.length === 0 || this.size + chunk.length > MAX_AUDIO_BASE64) throw new Error("invalid Whisper.cpp PCM16 audio chunk");
    this.chunks.push(chunk); this.size += chunk.length;
  }

  async stop() {
    if (!this.active) return false;
    this.active = false;
    if (this.size === 0) { emit(this.onEvent, { type: "stt.final", provider: "whispercpp", text: "", language: this.language }); return true; }
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.append("file", new Blob([pcm16Wav(Buffer.concat(this.chunks))], { type: "audio/wav" }), "jarvis.wav");
      form.append("response_format", "json");
      const response = await this.fetchImpl(whisperCppUrls(this.endpoint).inference, { method: "POST", body: form, signal: controller.signal, headers: this.cloudMode ? { "X-Jarvis-STT-Mode": "cloud", "X-Jarvis-STT-Session": this.sessionId || "" } : undefined });
      if (!response.ok) throw new Error("transcription-failed");
      const payload = await response.json();
      if (typeof payload?.text !== "string") throw new Error("transcription-failed");
      const provider = response.headers?.get?.("x-jarvis-stt-provider") || "whispercpp";
      const fallback = response.headers?.get?.("x-jarvis-stt-fallback") || undefined;
      emit(this.onEvent, { type: "stt.final", provider, text: payload.text.trim(), language: this.language, ...(fallback ? { fallback: true, fallbackReason: fallback } : {}) });
      return true;
    } catch (error) {
      emit(this.onEvent, { type: "stt.error", provider: "whispercpp", error: error?.name === "AbortError" ? "timeout" : "transcription-failed", fatal: false });
      return false;
    } finally {
      clearTimeout(timer); this.controller = null; this.chunks = []; this.size = 0;
    }
  }

  close() {
    this.active = false; this.chunks = []; this.size = 0; this.controller?.abort(); this.controller = null;
  }
}
