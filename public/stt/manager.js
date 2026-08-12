// Provider-neutral lifecycle seam. Phase 6 can choose Nemotron or Chrome here
// without changing microphone controls or any UI rendering code.
export class SttManager {
  constructor({ provider, onEvent } = {}) {
    if (!provider || typeof provider.start !== "function" || typeof provider.stop !== "function") {
      throw new Error("STT manager requires a provider with start and stop methods");
    }
    this.provider = provider;
    this.onEvent = onEvent;
    provider.onEvent = (event) => {
      try { this.onEvent?.(event); } catch { /* consumer isolation */ }
    };
  }

  get supported() { return Boolean(this.provider.supported); }
  start() { return this.provider.start(); }
  stop() { return this.provider.stop(); }
  setLanguage(language) { return this.provider.setLanguage?.(language); }
}
