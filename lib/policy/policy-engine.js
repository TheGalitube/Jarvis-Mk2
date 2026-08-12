const CONFIRM_OPERATIONS = new Set(["shell.execute", "service.restart", "filesystem.delete"]);
const DENY_OPERATIONS = new Set(["security.policy.change", "sandbox.escape", "privilege.escalate", "secret.read"]);

export class PolicyEngine {
  constructor({ config } = {}) { this.config = config; }

  evaluate({ operation, target, definition, arguments: args = {} }) {
    const context = { operation, target: target.id, targetType: target.type, platform: target.platform, capability: definition.capability, arguments: args };
    if (DENY_OPERATIONS.has(operation)) return { decision: "deny", risk: "critical", reason: "Operation is never enabled by the default policy", ...context };
    if (this.config.execution.securityProfile === "sandbox-only" && target.type !== "sandbox") {
      return { decision: "deny", risk: "high", reason: "Security profile permits sandbox targets only", ...context };
    }
    if (CONFIRM_OPERATIONS.has(operation) || definition.risk === "high" || definition.risk === "critical") {
      return { decision: "confirm", risk: definition.risk, reason: "High-impact operation requires confirmation", ...context };
    }
    return { decision: "allow", risk: definition.risk, reason: "Low-risk operation permitted by policy", ...context };
  }
}
