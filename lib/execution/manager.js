export class ExecutionManager {
  constructor({ resolver, registry, policy, events, requestApproval } = {}) {
    this.resolver = resolver;
    this.registry = registry;
    this.policy = policy;
    this.events = events;
    this.requestApproval = requestApproval;
  }

  async execute(request, { requestApproval } = {}) {
    const started = Date.now();
    const definition = this.registry.get(request?.operation);
    if (!definition) throw new Error(`Unknown operation: ${request?.operation}`);
    const target = this.resolver.resolve(request);
    this.events?.emit("execution.requested", { target: target.id, operation: definition.id });
    const decision = this.policy.evaluate({ ...request, target, definition });
    if (decision.decision === "deny") {
      this.events?.emit("execution.denied", { target: target.id, operation: definition.id, reason: decision.reason });
      throw new Error(`Policy denied ${definition.id}: ${decision.reason}`);
    }
    if (decision.decision === "confirm") {
      this.events?.emit("approval.requested", { target: target.id, operation: definition.id, risk: decision.risk });
      const approved = await (requestApproval ?? this.requestApproval)?.(decision);
      if (approved !== true && approved !== "accept") throw new Error(`Approval denied for ${definition.id}`);
    }
    const health = await target.health();
    if (!health?.ok) throw new Error(`Target unavailable: ${target.id}`);
    try {
      const result = await target.execute({ ...request, target: target.id, operation: definition.id });
      const normalized = { ok: true, target: target.id, operation: definition.id, durationMs: Date.now() - started, result };
      this.events?.emit("execution.completed", normalized);
      return normalized;
    } catch (error) {
      this.events?.emit("execution.failed", { target: target.id, operation: definition.id, durationMs: Date.now() - started });
      throw error;
    }
  }
}
