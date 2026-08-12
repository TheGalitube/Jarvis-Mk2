import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../lib/core/config.js";
import { EventBus } from "../lib/core/events.js";
import { ExecutionTarget } from "../lib/execution/target.js";
import { SandboxTarget } from "../lib/execution/sandbox-target.js";
import { OperationRegistry } from "../lib/execution/registry.js";
import { TargetResolver } from "../lib/execution/resolver.js";
import { ExecutionManager } from "../lib/execution/manager.js";
import { PolicyEngine } from "../lib/policy/policy-engine.js";

class FakeTarget extends ExecutionTarget {
  constructor(options) { super(options); this.calls = []; }
  async execute(request) { this.calls.push(request); return { value: "done" }; }
}

function setup({ config = loadRuntimeConfig(), targets } = {}) {
  const registry = new OperationRegistry([
    { id: "workspace.read", capability: "filesystem-read", risk: "low", preferredTargets: ["sandbox"] },
    { id: "service.restart", capability: "service-control", risk: "high" },
  ]);
  const available = targets ?? [
    new FakeTarget({ id: "sandbox", type: "sandbox", capabilities: ["filesystem-read"] }),
    new FakeTarget({ id: "local", type: "local", capabilities: ["filesystem-read", "service-control"] }),
  ];
  const resolver = new TargetResolver({ targets: available, config, registry });
  return { registry, available, resolver, config };
}

test("safe defaults enable only sandbox execution", () => {
  const config = loadRuntimeConfig();
  assert.equal(config.execution.securityProfile, "sandbox-only");
  assert.equal(config.execution.defaultTarget, "sandbox");
  assert.equal(config.targets.sandbox.enabled, true);
  assert.equal(config.targets.local.enabled, false);
});

test("runtime configuration validates security-sensitive overrides", () => {
  assert.throws(() => loadRuntimeConfig({ overrides: { execution: { securityProfile: "wide-open" } } }), /securityProfile/);
  assert.throws(() => loadRuntimeConfig({ overrides: { targets: { sandbox: { enabled: "yes" } } } }), /invalid target/);
  assert.throws(() => loadRuntimeConfig({ overrides: { targets: { local: { shellEnabled: "yes" } } } }), /shellEnabled/);
});

test("resolver prefers sandbox for compatible work and honors an explicit target", () => {
  const { resolver } = setup({ config: loadRuntimeConfig({ overrides: { execution: { securityProfile: "standard" }, targets: { local: { enabled: true } } } }) });
  assert.equal(resolver.resolve({ operation: "workspace.read" }).id, "sandbox");
  assert.equal(resolver.resolve({ operation: "workspace.read", target: "local" }).id, "local");
});

test("resolver rejects unknown targets, missing capabilities, and never substitutes silently", () => {
  const { resolver } = setup();
  assert.throws(() => resolver.resolve({ operation: "workspace.read", target: "missing" }), /Unknown or disabled target/);
  assert.throws(() => resolver.resolve({ operation: "service.restart", target: "sandbox" }), /does not support/);
});

test("manager allows low risk execution and records structured events", async () => {
  const { registry, available, resolver, config } = setup();
  const events = new EventBus();
  const seen = [];
  events.on("*", (event) => seen.push(event.event));
  const manager = new ExecutionManager({ resolver, registry, policy: new PolicyEngine({ config }), events });
  const result = await manager.execute({ operation: "workspace.read" });
  assert.equal(result.ok, true);
  assert.equal(result.target, "sandbox");
  assert.equal(available[0].calls.length, 1);
  assert.deepEqual(seen, ["execution.requested", "execution.completed"]);
});

test("manager requires approval for high risk operations and denial prevents execution", async () => {
  const config = loadRuntimeConfig({ overrides: { execution: { securityProfile: "standard" }, targets: { local: { enabled: true } } } });
  const { registry, available, resolver } = setup({ config });
  const manager = new ExecutionManager({
    resolver, registry, policy: new PolicyEngine({ config }), requestApproval: async () => false,
  });
  await assert.rejects(manager.execute({ operation: "service.restart", target: "local" }), /Approval denied/);
  assert.equal(available[1].calls.length, 0);
});

test("manager accepts the voice approval decision string for a high-risk operation", async () => {
  const config = loadRuntimeConfig({ overrides: { execution: { securityProfile: "standard" }, targets: { local: { enabled: true } } } });
  const { registry, available, resolver } = setup({ config });
  const manager = new ExecutionManager({ resolver, registry, policy: new PolicyEngine({ config }) });
  const result = await manager.execute({ operation: "service.restart", target: "local" }, { requestApproval: async () => "accept" });
  assert.equal(result.ok, true);
  assert.equal(available[1].calls.length, 1);
});

test("sandbox target keeps execution behind its explicitly supplied executor", async () => {
  const target = new SandboxTarget({ execute: async (request) => ({ operation: request.operation }) });
  assert.deepEqual(await target.execute({ operation: "artifact.build" }), { operation: "artifact.build" });
  await assert.rejects(new SandboxTarget().execute({}), /no configured executor/);
});
