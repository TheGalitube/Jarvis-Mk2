import { pcm16Wav } from "./whispercpp.js";

const MAX_AUDIO_BASE64 = 15 * 1024 * 1024;
const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

function emit(listener, event) {
  try { listener?.(event); } catch { /* transport events must not break STT */ }
}

// The browser continues to send the same PCM16 frames it uses for the other
// server-side STT providers. OpenAI receives one WAV per Push-to-Talk utterance.
export class OpenAiTranscriptionProvider {
  constructor({ apiKey, model = "gpt-4o-transcribe", language = "de", timeoutMs = 20_000, onEvent, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey; this.model = model; this.language = language; this.timeoutMs = timeoutMs;
    this.onEvent = onEvent; this.fetchImpl = fetchImpl; this.active = false; this.chunks = []; this.size = 0; this.controller = null;
  }
  get supported() { return Boolean(this.apiKey); }
  start() {
    if (!this.supported) throw new Error("OpenAI API key is not configured");
    if (this.active) return false;
    this.active = true; this.chunks = []; this.size = 0;
    emit(this.onEvent, { type: "stt.started", provider: "openai", model: this.model, language: this.language });
    return true;
  }
  appendAudio(audio) {
    if (!this.active) throw new Error("OpenAI transcription session is not active");
    if (typeof audio !== "string" || !audio || audio.length > MAX_AUDIO_BASE64) throw new Error("invalid OpenAI PCM16 audio chunk");
    const chunk = Buffer.from(audio, "base64");
    if (chunk.length === 0 || this.size + chunk.length > MAX_AUDIO_BASE64) throw new Error("invalid OpenAI PCM16 audio chunk");
    this.chunks.push(chunk); this.size += chunk.length;
  }
  async stop() {
    if (!this.active) return false;
    this.active = false;
    if (this.size === 0) { emit(this.onEvent, { type: "stt.final", provider: "openai", model: this.model, text: "", language: this.language }); return true; }
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.append("file", new Blob([pcm16Wav(Buffer.concat(this.chunks))], { type: "audio/wav" }), "jarvis.wav");
      form.append("model", this.model); form.append("language", this.language); form.append("response_format", "json");
      const response = await this.fetchImpl(TRANSCRIPTIONS_URL, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: controller.signal });
      if (!response.ok) throw new Error("transcription-failed");
      const payload = await response.json();
      if (typeof payload?.text !== "string") throw new Error("transcription-failed");
      emit(this.onEvent, { type: "stt.final", provider: "openai", model: this.model, text: payload.text.trim(), language: this.language });
      return true;
    } catch (error) {
      emit(this.onEvent, { type: "stt.error", provider: "openai", model: this.model, error: error?.name === "AbortError" ? "timeout" : "transcription-failed", fatal: false });
      return false;
    } finally { clearTimeout(timer); this.controller = null; this.chunks = []; this.size = 0; }
  }
  close() { this.active = false; this.chunks = []; this.size = 0; this.controller?.abort(); this.controller = null; }
}
