import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, buildPrompt, buildSpawnArgs, run } from "../lib/builder.js";

const primitive = {
  id: "test-thing",
  systemPrompt: (p) => `make ${p.subject}`,
  allowedTools: ["Write", "Edit", "Read"],
  mcp: [],
  outputContract: "index.html",
  doneLine: () => "done",
  timeoutMs: 5000,
};

test("renders the primitive prompt with an explicit runtime boundary", () => {
  const prompt = buildPrompt(primitive, { subject: "coffee" });
  assert.match(prompt, /^make coffee/);
  assert.match(prompt, /current working directory/);
  assert.match(prompt, /index\.html/);
  assert.match(prompt, /Do not access the network/);
});

test("runs Codex as JSONL in an unattended workspace sandbox", () => {
  const args = buildSpawnArgs(primitive, { subject: "coffee" });
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("features.apps=false"));
  assert.ok(args.includes("features.hooks=false"));
});

test("uses high reasoning for builds without pinning a model", () => {
  const args = buildSpawnArgs(primitive, {});
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(args.includes("--model"), false);
});

test("accepts explicit effort, model and prompt overrides", () => {
  const args = buildSpawnArgs(primitive, {}, {
    effort: "medium",
    model: "gpt-5.6-sol",
    prompt: "Build the fixture.",
  });
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.deepEqual(args.slice(-2), ["--", "Build the fixture."]);
});

test("does not pass Claude-specific tool or permission flags", () => {
  const args = buildSpawnArgs(primitive, {});
  for (const flag of ["--allowedTools", "--disallowedTools", "--permission-mode", "--settings"]) {
    assert.equal(args.includes(flag), false);
  }
});

test("runs JavaScript test doubles through Node on Windows and Unix", () => {
  const command = buildCommand("C:/tmp/fake.cjs", ["exec", "--json"]);
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, ["C:/tmp/fake.cjs", "exec", "--json"]);
});

let workspace;
const fake = {};

const FILE_CHANGE_LINE =
  'JSON.stringify({ type: "item.completed", item: { id: "file-1", type: "file_change", ' +
  'changes: [{ path: "index.html", kind: "add" }], status: "completed", padding: BIG } })';
const COMMAND_LINE =
  'JSON.stringify({ type: "item.started", item: { id: "cmd-1", type: "command_execution", ' +
  'command: "generate", status: "in_progress" } })';
const TURN_COMPLETED =
  'JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })';

async function writeFake(name, body) {
  const path = join(workspace, name);
  await writeFile(
    path,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const BIG = "x".repeat(200000);',
      body,
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jarvis-builder-"));
  fake.success = await writeFake("codex-success.cjs", [
    `console.log(${FILE_CHANGE_LINE});`,
    'fs.writeFileSync("index.html", "<!doctype html><title>ok</title>");',
    `console.log(${TURN_COMPLETED});`,
  ].join("\n"));

  fake.exitTwo = await writeFake("codex-exit-two.cjs", [
    'fs.writeFileSync("index.html", "half a page");',
    'console.error("boom");',
    "process.exitCode = 2;",
  ].join("\n"));

  fake.noArtifact = await writeFake("codex-no-artifact.cjs", `console.log(${TURN_COMPLETED});`);
  fake.failedTurn = await writeFake("codex-failed-turn.cjs", [
    'fs.writeFileSync("index.html", "not trustworthy");',
    'console.log(JSON.stringify({ type: "turn.failed", error: { message: "model stopped" } }));',
  ].join("\n"));
  fake.hang = await writeFake("codex-hang.cjs", [
    `console.log(${COMMAND_LINE});`,
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const root = () => join(workspace, "builds");

test("success requires exit zero, a completed turn and the artifact", async () => {
  const seen = [];
  const r = await run(primitive, { subject: "coffee" }, (line) => seen.push(line), {
    bin: fake.success,
    root: root(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.artifact, join(r.dir, "index.html"));
  assert.equal(r.result.type, "turn.completed");
  assert.deepEqual(seen, ["Writing index.html"]);
});

test("every build gets its own directory", async () => {
  const opts = { bin: fake.success, root: root() };
  const first = await run(primitive, { subject: "a" }, null, opts);
  const second = await run(primitive, { subject: "b" }, null, opts);
  assert.notEqual(first.dir, second.dir);
});

test("writes the raw Codex stream to build.log", async () => {
  const r = await run(primitive, {}, null, { bin: fake.success, root: root() });
  const log = await readFile(r.log, "utf8");
  assert.ok(log.includes('"file_change"'));
  assert.ok(log.includes('"turn.completed"'));
});

test("a non-zero exit fails even with an artifact", async () => {
  const r = await run(primitive, {}, null, { bin: fake.exitTwo, root: root() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.equal(r.artifact, null);
  assert.ok(existsSync(join(r.dir, "index.html")));
  assert.ok((await readFile(r.log, "utf8")).includes("boom"));
});

test("a failed turn fails even with exit zero and an artifact", async () => {
  const r = await run(primitive, {}, null, { bin: fake.failedTurn, root: root() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 0);
  assert.equal(r.result.type, "turn.failed");
});

test("a completed turn without the output contract fails", async () => {
  const r = await run(primitive, {}, null, { bin: fake.noArtifact, root: root() });
  assert.equal(r.ok, false);
  assert.equal(r.result.type, "turn.completed");
});

test("timeout kills the process group and returns an outcome", async () => {
  const impatient = { ...primitive, timeoutMs: 1500 };
  const started = Date.now();
  const r = await run(impatient, {}, null, {
    bin: fake.hang,
    root: root(),
    killGraceMs: 150,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 5000);
  assert.ok((await readFile(r.log, "utf8")).includes('"command_execution"'));
});

test("a progress callback that throws does not take down the build", async () => {
  let calls = 0;
  const r = await run(primitive, {}, () => { calls++; throw new Error("HUD failed"); }, {
    bin: fake.success,
    root: root(),
  });
  assert.equal(calls, 1);
  assert.equal(r.ok, true);
});

test("rejects only when the Codex CLI cannot be started", async () => {
  await assert.rejects(
    run(primitive, {}, null, { bin: join(workspace, "missing-codex"), root: root() }),
    (err) => err.code === "ENOENT",
  );
});
