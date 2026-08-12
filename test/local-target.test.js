import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTarget, platformCommand, runLocalCommand } from "../lib/execution/local-target.js";

test("reports portable local system information without shelling out", async () => {
  const result = await new LocalTarget({ enabled: true }).execute({ operation: "system.info" });
  assert.equal(result.runtimePlatform, process.platform);
  assert.equal(typeof result.totalMemoryBytes, "number");
  assert.ok(result.cpuCount > 0);
});

test("lists only real paths below configured safe roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-local-"));
  try {
    await writeFile(join(root, "readme.txt"), "safe");
    const target = new LocalTarget({ enabled: true, safeRoots: [root] });
    const result = await target.execute({ operation: "filesystem.list", arguments: { path: root } });
    assert.deepEqual(result.entries, [{ name: "readme.txt", type: "file" }]);
    await assert.rejects(
      target.execute({ operation: "filesystem.list", arguments: { path: tmpdir() } }),
      /outside LocalTarget safe roots/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates a new text file only inside configured safe roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-local-write-"));
  const outside = await mkdtemp(join(tmpdir(), "jarvis-local-outside-"));
  try {
    const target = new LocalTarget({ enabled: true, safeRoots: [root] });
    const result = await target.execute({ operation: "filesystem.write", arguments: { path: join(root, "note.txt"), content: "hello" } });
    assert.equal(result.bytes, 5);
    await assert.rejects(target.execute({ operation: "filesystem.write", arguments: { path: join(root, "note.txt"), content: "again" } }), /EEXIST/);
    await assert.rejects(target.execute({ operation: "filesystem.write", arguments: { path: join(outside, "nope.txt"), content: "no" } }), /outside LocalTarget safe roots/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("uses fixed platform adapter commands for process and service status", async () => {
  assert.deepEqual(platformCommand("process.list", "win32"), { command: "tasklist.exe", args: ["/FO", "CSV", "/NH"] });
  assert.deepEqual(platformCommand("process.list", "linux"), { command: "ps", args: ["-axo", "pid=,comm=,rss="] });
  assert.deepEqual(platformCommand("service.status", "win32", "Spooler"), { command: "sc.exe", args: ["query", "Spooler"] });
  assert.throws(() => platformCommand("service.status", "linux", "nginx; rm -rf /"), /unsupported characters/);
});

test("delegates process and service status through argv, never a shell string", async () => {
  const calls = [];
  const target = new LocalTarget({
    enabled: true,
    platform: "linux",
    commandRunner: async (command, args, options) => { calls.push({ command, args, options }); return { ok: true }; },
  });
  await target.execute({ operation: "process.list", arguments: { timeoutMs: 1200 } });
  await target.execute({ operation: "service.status", arguments: { service: "nginx" } });
  assert.deepEqual(calls[0], { command: "ps", args: ["-axo", "pid=,comm=,rss="], options: { timeoutMs: 1200 } });
  assert.deepEqual(calls[1], { command: "systemctl", args: ["show", "nginx", "--no-page", "--property", "LoadState,ActiveState,SubState"], options: { timeoutMs: undefined } });
});

test("shell execution is opt-in and uses an executable plus an argument array", async () => {
  const disabled = new LocalTarget({ enabled: true });
  await assert.rejects(
    disabled.execute({ operation: "shell.execute", arguments: { command: process.execPath, args: ["-e", ""] } }),
    /disabled/,
  );

  const target = new LocalTarget({ enabled: true, shellEnabled: true });
  const result = await target.execute({
    operation: "shell.execute",
    arguments: { command: process.execPath, args: ["-e", "process.stdout.write('ready')"] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ready");
});

test("local command runner bounds timeouts and rejects non-string argv", async () => {
  assert.throws(() => runLocalCommand(process.execPath, [1]), /array of strings/);
  const result = await runLocalCommand(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { timeoutMs: 1 });
  assert.equal(result.timedOut, true);
});
