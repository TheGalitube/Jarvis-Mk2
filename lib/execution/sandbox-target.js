import { ExecutionTarget } from "./target.js";

// This target is a routing seam, not a relaxation of builder.js. Its executor
// must remain the existing Codex workspace sandbox implementation.
export class SandboxTarget extends ExecutionTarget {
  constructor({ enabled = true, execute } = {}) {
    super({ id: "sandbox", type: "sandbox", capabilities: ["artifact-build", "filesystem-read"], enabled });
    this.executor = execute;
  }
  async execute(request) {
    if (typeof this.executor !== "function") throw new Error("Sandbox target has no configured executor");
    return this.executor(request);
  }
}
