// Small synchronous event seam. Observers are deliberately isolated: audit or
// UI telemetry must never change the result of an execution request.
export class EventBus {
  #listeners = new Map();

  on(name, listener) {
    if (typeof listener !== "function") throw new TypeError("event listener must be a function");
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    const event = { event: name, timestamp: new Date().toISOString(), ...payload };
    for (const listener of this.#listeners.get(name) ?? []) {
      try { listener(event); } catch { /* observers are non-authoritative */ }
    }
    for (const listener of this.#listeners.get("*") ?? []) {
      try { listener(event); } catch { /* observers are non-authoritative */ }
    }
    return event;
  }
}
