const STATES = new Set(["idle", "listening", "thinking", "working", "speaking", "approval"]);

export class VoiceStateMachine {
  constructor(initial = "idle") { this.set(initial); }
  set(next) {
    if (!STATES.has(next)) throw new Error(`Unknown voice state: ${next}`);
    const previous = this.value;
    this.value = next;
    return { previous, value: next };
  }
  canCapture() { return this.value !== "thinking" && this.value !== "speaking" && this.value !== "working"; }
}
