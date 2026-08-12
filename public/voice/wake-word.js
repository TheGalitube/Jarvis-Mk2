function normalize(value) { return String(value ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); }

export function detectWakeWord(transcript, wakeWords) {
  const text = normalize(transcript);
  for (const phrase of wakeWords ?? []) {
    const wake = normalize(phrase);
    const index = wake ? text.indexOf(wake) : -1;
    if (index >= 0) return { wake, command: text.slice(index + wake.length).trim() };
  }
  return null;
}

// Pure wake-word/silence controller. STT can call observe() with progressively
// refined transcripts; only the latest command is emitted on silence.
export class WakeWordController {
  constructor({ wakeWords = ["jarvis"], silenceTimeoutMs = 1400, onEvent, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.wakeWords = wakeWords; this.silenceTimeoutMs = silenceTimeoutMs; this.onEvent = onEvent;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.armed = false; this.awake = false; this.command = ""; this.timer = null;
  }
  arm() { this.armed = true; this.awake = false; this.command = ""; this.#emit({ type: "voice.armed" }); }
  disarm() { this.armed = false; this.awake = false; this.command = ""; this.#clear(); }
  observe(transcript, { approval = false } = {}) {
    if (approval) { this.command = normalize(transcript); this.#schedule(); return { matched: true, command: this.command }; }
    if (this.awake) {
      const repeated = detectWakeWord(transcript, this.wakeWords);
      this.command = repeated ? repeated.command : normalize(transcript); this.#schedule();
      return { matched: true, command: this.command };
    }
    if (!this.armed) return null;
    const found = detectWakeWord(transcript, this.wakeWords);
    if (!found) return null;
    this.armed = false; this.awake = true; this.command = found.command; this.#emit({ type: "voice.wake", wake: found.wake }); this.#schedule();
    return { matched: true, command: this.command };
  }
  #schedule() { this.#clear(); this.timer = this.setTimer(() => { const command = this.command; this.command = ""; this.awake = false; if (command) this.#emit({ type: "voice.command", text: command }); else this.arm(); }, this.silenceTimeoutMs); }
  #clear() { if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  #emit(event) { try { this.onEvent?.(event); } catch {} }
}
