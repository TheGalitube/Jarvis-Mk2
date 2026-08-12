import { WakeWordController } from "./wake-word.js";

// Coordinates Push-to-Talk and voice activation without giving the renderer
// knowledge of STT provider selection, microphone frames, or wake-word state.
export class VoiceController {
  constructor({ chrome, microphone, sendTransport, onEvent, setTimer, clearTimer } = {}) {
    this.chrome = chrome; this.microphone = microphone; this.sendTransport = sendTransport; this.onEvent = onEvent;
    this.holding = false; this.mode = "chrome"; this.config = null; this.waitingForSelection = false;
    this.activationActive = false; this.approvalMode = false; this.pendingPushToTalk = false; this.suppressFinal = false;
    this.wake = new WakeWordController({ onEvent: (event) => this.#handleWake(event), setTimer, clearTimer });
    chrome.onEvent = (event) => this.#handleProviderEvent(event);
  }

  configure(config) {
    this.config = config;
    this.chrome.setLanguage?.(config?.stt?.chrome?.language || "en-US");
    const voice = config?.voice;
    this.wake.disarm();
    this.wake.wakeWords = voice?.wakeWords || ["jarvis"];
    this.wake.silenceTimeoutMs = voice?.silenceTimeoutMs || 1_400;
  }
  get supported() { return this.chrome.supported; }
  get voiceActivationEnabled() { return this.config?.voice?.mode === "voice-activation"; }
  setApprovalMode(active) { this.approvalMode = Boolean(active); }

  // Starts continuous listening only in the explicitly configured activation
  // mode. Push-to-Talk remains available and takes ownership when pressed.
  arm() {
    if (!this.voiceActivationEnabled || this.holding || this.activationActive || this.waitingForSelection) return false;
    this.activationActive = true;
    this.wake.arm();
    return this.#startCapture();
  }

  async disarm() {
    if (!this.activationActive && !this.waitingForSelection) return false;
    this.activationActive = false; this.wake.disarm(); this.suppressFinal = true;
    if (this.mode === "nemotron") {
      await this.microphone.stop();
      this.sendTransport?.({ type: "stt.stop" });
    } else if (this.waitingForSelection) {
      this.waitingForSelection = false;
      this.sendTransport?.({ type: "stt.cancel" });
    } else this.chrome.stop();
    return true;
  }

  start() {
    if (this.holding || this.pendingPushToTalk) return false;
    if (this.activationActive || this.waitingForSelection) {
      this.pendingPushToTalk = true; this.holding = true;
      void this.disarm().then(() => {
        this.pendingPushToTalk = false;
        if (this.holding) this.#startCapture();
      });
      return true;
    }
    return this.#beginPushToTalk();
  }

  async stop() {
    if (!this.holding) return false;
    this.holding = false;
    if (this.mode === "nemotron") {
      await this.microphone.stop();
      this.sendTransport?.({ type: "stt.stop" });
    } else if (this.waitingForSelection) {
      this.waitingForSelection = false;
      this.sendTransport?.({ type: "stt.cancel" });
    } else this.chrome.stop();
    return true;
  }

  async handleTransport(message) {
    if (message.type === "stt.selected") {
      this.waitingForSelection = false;
      if (!this.holding && !this.activationActive) return;
      this.mode = message.provider;
      if (message.provider === "chrome") return this.chrome.start();
      try {
        await this.microphone.start((audio) => this.sendTransport?.({ type: "stt.audio", audio }));
      } catch (error) { this.#emit({ type: "stt.error", provider: "nemotron", error: error.message || "microphone-unavailable", fatal: false }); }
      return;
    }
    if (message.type === "stt_event") {
      if (message.event?.type === "stt.error" && message.event.provider === "nemotron" && (this.holding || this.activationActive) && this.config?.stt?.fallbackToChrome) {
        this.mode = "chrome"; await this.microphone.stop(); this.chrome.start();
      }
      this.#handleProviderEvent(message.event);
    }
  }

  #beginPushToTalk() {
    this.pendingPushToTalk = false;
    if (this.holding) return false;
    this.holding = true;
    return this.#startCapture();
  }

  #startCapture() {
    const stt = this.config?.stt;
    const wantsNemotron = stt?.provider === "nemotron" || (stt?.provider === "auto" && stt?.nemotron?.configured);
    if (!wantsNemotron) { this.mode = "chrome"; return this.chrome.start(); }
    this.mode = "pending"; this.waitingForSelection = true;
    this.sendTransport?.({ type: "stt.start" });
    return true;
  }

  #handleProviderEvent(event) {
    if (!event) return;
    if (this.activationActive) {
      if (event.type === "stt.partial" || event.type === "stt.final") this.wake.observe(event.text, { approval: this.approvalMode });
      if (event.type === "stt.error" || event.type === "stt.unavailable") this.#emit(event);
      return;
    }
    if (event.type === "stt.final" && this.suppressFinal) {
      this.suppressFinal = false;
      if (this.pendingPushToTalk) this.#beginPushToTalk();
      return;
    }
    this.#emit(event);
  }

  #handleWake(event) {
    if (event.type === "voice.command") {
      void this.disarm().then(() => this.#emit(event));
      return;
    }
    this.#emit(event);
  }

  #emit(event) { try { this.onEvent?.(event); } catch { /* app observer isolation */ } }
}
