const OPERATIONS = [
  { id: "artifact.build", capability: "artifact-build", risk: "low", preferredTargets: ["sandbox"] },
  { id: "filesystem.read", capability: "filesystem-read", risk: "low", preferredTargets: ["sandbox", "local"] },
  { id: "filesystem.list", capability: "filesystem-read", risk: "low", preferredTargets: ["sandbox", "local"] },
  { id: "filesystem.write", capability: "filesystem-write", risk: "high", preferredTargets: ["local"] },
  { id: "system.info", capability: "system-info", risk: "low" },
  { id: "process.list", capability: "process-list", risk: "low" },
  { id: "service.status", capability: "service-control", risk: "low" },
  { id: "shell.execute", capability: "shell", risk: "high" },
  { id: "service.restart", capability: "service-control", risk: "high" },
  { id: "filesystem.delete", capability: "filesystem-write", risk: "high" },
];

export class OperationRegistry {
  constructor(operations = OPERATIONS) {
    this.operations = new Map();
    for (const operation of operations) this.register(operation);
  }
  register(operation) {
    if (!operation?.id || !operation.capability || !operation.risk) throw new Error("invalid operation registration");
    if (this.operations.has(operation.id)) throw new Error(`duplicate operation: ${operation.id}`);
    this.operations.set(operation.id, Object.freeze({ ...operation, preferredTargets: [...(operation.preferredTargets ?? [])] }));
  }
  get(id) { return this.operations.get(id) ?? null; }
}

export const defaultOperationRegistry = new OperationRegistry();
