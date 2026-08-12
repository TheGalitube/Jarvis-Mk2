export class ExecutionTarget {
  constructor({ id, type, platform = process.platform, capabilities = [], enabled = true } = {}) {
    if (typeof id !== "string" || !id) throw new Error("execution target requires an id");
    if (typeof type !== "string" || !type) throw new Error("execution target requires a type");
    this.id = id;
    this.type = type;
    this.platform = platform;
    this.capabilities = new Set(capabilities);
    this.enabled = enabled;
  }

  supports(capability) { return this.capabilities.has(capability); }
  async health() { return { ok: this.enabled, target: this.id, platform: this.platform }; }
  async inspect() { return { id: this.id, type: this.type, platform: this.platform, capabilities: [...this.capabilities] }; }
  async execute() { throw new Error(`Target ${this.id} does not implement execution`); }
}
