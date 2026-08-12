export class TargetResolver {
  constructor({ targets = [], config, registry } = {}) {
    this.targets = new Map(targets.map((target) => [target.id, target]));
    this.config = config;
    this.registry = registry;
  }

  resolve({ target: requestedTarget, operation }) {
    const definition = this.registry.get(operation);
    if (!definition) throw new Error(`Unknown operation: ${operation}`);
    if (requestedTarget) return this.#validate(this.targets.get(requestedTarget), definition, requestedTarget);

    for (const id of definition.preferredTargets ?? []) {
      const target = this.targets.get(id);
      if (target?.enabled && target.supports(definition.capability)) return target;
    }
    return this.#validate(this.targets.get(this.config.execution.defaultTarget), definition, this.config.execution.defaultTarget);
  }

  #validate(target, definition, requestedId) {
    if (!target || !target.enabled) throw new Error(`Unknown or disabled target: ${requestedId}`);
    if (!target.supports(definition.capability)) {
      throw new Error(`Target ${target.id} does not support ${definition.capability}`);
    }
    return target;
  }
}
