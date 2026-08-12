import { isFatalSpeechError } from "../stt-policy.js";

function emit(listener, event) {
  try { listener?.(event); } catch { /* UI observers must not break STT */ }
}

export function browserRecognition(windowRef = globalThis.window) {
  return windowRef?.SpeechRecognition || windowRef?.webkitSpeechRecognition || null;
}

// Normalizes Chrome's stateful Web Speech API. It deliberately has no DOM,
// WebSocket, voice-mode or rendering knowledge, so future local/streaming STT
// providers can produce the same events.
export class ChromeSpeechProvider {
  constructor({ Recognition = browserRecognition(), language = "en-US", onEvent } = {}) {
    this.Recognition = Recognition;
    this.language = language;
    this.onEvent = onEvent;
    this.recognition = null;
    this.active = false;
    this.finalText = "";
    this.listening = false;
    this.discardFinal = false;
    this.stopWaiters = [];
  }

  get supported() { return typeof this.Recognition === "function"; }

  setLanguage(language) {
    if (typeof language !== "string" || !language.trim()) throw new Error("STT language must be a non-empty string");
    this.language = language;
    if (this.recognition && !this.listening) this.recognition.lang = language;
  }

  start() {
    if (!this.supported) {
      emit(this.onEvent, { type: "stt.unavailable", provider: "chrome" });
      return false;
    }
    if (this.active) return false;
    this.active = true;
    this.finalText = "";
    this.discardFinal = false;
    this.#recognizer().start();
    return true;
  }

  stop() {
    if (!this.active && !this.listening) return Promise.resolve(false);
    this.active = false;
    // `SpeechRecognition.stop()` is asynchronous. A new `start()` before its
    // `onend` causes Chrome's InvalidStateError, so callers that hand capture
    // from wake listening to Push-to-Talk can await this lifecycle boundary.
    const stopped = new Promise((resolve) => this.stopWaiters.push(resolve));
    try { this.recognition?.stop(); }
    catch { this.#settleStops(false); }
    return stopped;
  }

  #recognizer() {
    if (this.recognition) return this.recognition;
    const recognition = new this.Recognition();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      this.listening = true;
      emit(this.onEvent, { type: "stt.started", provider: "chrome" });
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) this.finalText += result[0].transcript + " ";
        else interim += result[0].transcript;
      }
      const text = (this.finalText + interim).trim();
      if (text) emit(this.onEvent, { type: "stt.partial", provider: "chrome", text });
    };
    recognition.onerror = (event) => {
      const error = event?.error || "unknown";
      if (isFatalSpeechError(error)) {
        this.active = false;
        this.discardFinal = true;
      }
      emit(this.onEvent, { type: "stt.error", provider: "chrome", error, fatal: isFatalSpeechError(error) });
    };
    recognition.onend = () => {
      this.listening = false;
      if (this.active) {
        try {
          recognition.start();
          emit(this.onEvent, { type: "stt.resumed", provider: "chrome" });
        } catch (error) {
          emit(this.onEvent, { type: "stt.error", provider: "chrome", error: error?.message || "restart-failed", fatal: false });
        }
        return;
      }
      const discarded = this.discardFinal;
      const text = discarded ? "" : this.finalText.trim();
      this.finalText = "";
      this.discardFinal = false;
      emit(this.onEvent, { type: "stt.final", provider: "chrome", text, discarded });
      this.#settleStops(true);
    };
    this.recognition = recognition;
    return recognition;
  }

  #settleStops(value) {
    for (const resolve of this.stopWaiters.splice(0)) resolve(value);
  }
}
