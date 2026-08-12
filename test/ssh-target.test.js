import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../lib/core/config.js";
import { OperationRegistry } from "../lib/execution/registry.js";
import { TargetResolver } from "../lib/execution/resolver.js";
import { SSHTarget, buildSshArgs, normalizeSshPlatform, quotePosix } from "../lib/execution/ssh-target.js";
import { PolicyEngine } from "../lib/policy/policy-engine.js";

const host = {
  id: "minecraft", type: "ssh", enabled: true, hostname: "minecraft.internal", username: "jarvis",
  port: 2202, platform: "auto", capabilities: ["system-info", "process-list", "service-control"],
  connectTimeoutMs: 2_000, commandTimeoutMs: 4_000,
};

test("builds OpenSSH argv without weakening host-key verification", () => {
  const args = buildSshArgs({ ...host, identityFile: "C:/keys/jarvis" }, "uname -s");
  assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "-p", "2202", "-i", "C:/keys/jarvis", "jarvis@minecraft.internal", "uname -s"]);
  assert.equal(args.some((value) => /StrictHostKeyChecking/i.test(value)), false);
});

test("quotes POSIX remote argv and recognizes supported platforms", () => {
  assert.equal(quotePosix("it's fine"), "'it'\"'\"'s fine'");
  assert.equal(normalizeSshPlatform("Linux"), "linux");
  assert.equal(normalizeSshPlatform("Darwin Kernel Version"), "darwin");
  assert.equal(normalizeSshPlatform("Microsoft Windows"), "win32");
  assert.equal(normalizeSshPlatform("plan9"), null);
});

test("detects the remote platform, caches it, and returns structured status", async () => {
  const calls = [];
  const target = new SSHTarget({
    ...host,
    commandRunner: async (args, options) => {
      calls.push({ args, options });
      const command = args.at(-1);
      return { ok: true, code: 0, timedOut: false, stdout: command === "uname -s" ? "Linux\n" : "active", stderr: "", truncated: false };
    },
  });
  const health = await target.health();
  assert.deepEqual(health, { ok: true, target: "minecraft", platform: "linux", timedOut: false, code: 0 });
  const result = await target.execute({ operation: "service.status", arguments: { service: "nginx" } });
  assert.equal(result.ok, true);
  assert.equal(calls.filter(({ args }) => args.at(-1) === "uname -s").length, 1);
  assert.equal(calls.at(-1).args.at(-1), "'systemctl' 'show' 'nginx' '--no-page' '--property' 'LoadState,ActiveState,SubState'");
});

test("uses Windows platform adapters when configured and does not need discovery", async () => {
  const calls = [];
  const target = new SSHTarget({
    ...host, id: "gaming-pc", platform: "win32",
    commandRunner: async (args) => { calls.push(args); return { ok: true, code: 0, timedOut: false, stdout: "", stderr: "", truncated: false }; },
  });
  await target.execute({ operation: "process.list", arguments: {} });
  assert.equal(calls[0].at(-1), '"tasklist.exe" "/FO" "CSV" "/NH"');
});

test("validates SSH host configuration and allows multiple logical hosts", () => {
  const config = loadRuntimeConfig({ overrides: {
    execution: { securityProfile: "standard" },
    hosts: {
      minecraft: { type: "ssh", hostname: "10.0.0.30", username: "jarvis" },
      macbook: { type: "ssh", hostname: "macbook.local", username: "max", platform: "darwin" },
    },
  } });
  assert.equal(config.hosts.minecraft.enabled, true);
  assert.deepEqual(config.hosts.minecraft.capabilities, ["system-info", "process-list", "service-control"]);
  assert.equal(config.hosts.macbook.platform, "darwin");
  assert.throws(() => loadRuntimeConfig({ overrides: { hosts: { bad: { type: "ssh", hostname: "host -o ProxyCommand=x", username: "jarvis" } } } }), /invalid SSH host/);
});

test("policy denies SSH in sandbox-only and requires confirmation for remote high risk work", () => {
  const registry = new OperationRegistry([{ id: "shell.execute", capability: "shell", risk: "high" }]);
  const target = new SSHTarget({ ...host, capabilities: ["shell"] });
  const sandboxOnly = loadRuntimeConfig();
  const resolver = new TargetResolver({ targets: [target], config: sandboxOnly, registry });
  const policy = new PolicyEngine({ config: sandboxOnly });
  const decision = policy.evaluate({ operation: "shell.execute", target: resolver.resolve({ operation: "shell.execute", target: "minecraft" }), definition: registry.get("shell.execute") });
  assert.equal(decision.decision, "deny");
  const standard = loadRuntimeConfig({ overrides: { execution: { securityProfile: "standard" } } });
  assert.equal(new PolicyEngine({ config: standard }).evaluate({ operation: "shell.execute", target, definition: registry.get("shell.execute") }).decision, "confirm");
});
