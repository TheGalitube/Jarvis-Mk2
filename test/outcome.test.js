import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseResultEvent, buildSucceeded, describeFailure } from "../lib/outcome.js";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "outcome-"));
  dirs.push(dir);
  return dir;
}
test.after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const COMPLETED = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
});
const FAILED = JSON.stringify({ type: "turn.failed", error: { message: "model stopped" } });

test("parses Codex terminal turn and error events", () => {
  assert.equal(parseResultEvent(COMPLETED).type, "turn.completed");
  assert.equal(parseResultEvent(FAILED).error.message, "model stopped");
  assert.equal(parseResultEvent(JSON.stringify({ type: "error", message: "stream broke" })).type, "error");
});

test("ignores non-terminal and malformed events", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({ type: "item.completed", item: { type: "file_change" } }),
    "", "{", "null", "42", undefined, null, { type: "turn.completed" },
  ];
  for (const line of lines) assert.equal(parseResultEvent(line), null);
});

test("succeeds when Codex exits cleanly and the artifact exists", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  assert.equal(buildSucceeded({
    code: 0,
    dir,
    outputContract: "index.html",
    result: parseResultEvent(COMPLETED),
  }), true);
});

test("a clean exit can still succeed without a terminal event", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "ok");
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html" }), true);
});

test("fails on a failed turn even when exit and artifact look successful", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "partial");
  const result = parseResultEvent(FAILED);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html", result }), false);
  assert.match(describeFailure({ code: 0, dir, outputContract: "index.html", result }), /error/i);
});

test("fails on non-zero exit or missing artifact", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "partial");
  assert.equal(buildSucceeded({ code: 2, dir, outputContract: "index.html" }), false);
  assert.match(describeFailure({ code: 2, dir, outputContract: "index.html" }), /2/);

  const empty = tempDir();
  assert.equal(buildSucceeded({ code: 0, dir: empty, outputContract: "index.html" }), false);
  assert.match(describeFailure({ code: 0, dir: empty, outputContract: "index.html" }), /index\.html/);
});

test("a directory does not satisfy the output contract", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "index.html"));
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "index.html" }), false);
});

test("timeout takes precedence over secondary symptoms", () => {
  const message = describeFailure({
    code: 143,
    dir: tempDir(),
    outputContract: "index.html",
    result: parseResultEvent(FAILED),
    timedOut: true,
  });
  assert.match(message, /time/i);
  assert.equal(message.includes("143"), false);
});

test("signal exits are described without saying exit code null", () => {
  const message = describeFailure({ code: null, dir: tempDir(), outputContract: "index.html" });
  assert.match(message, /stopped/i);
  assert.equal(message.includes("null"), false);
});

test("absolute and escaping output contracts can never succeed", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "ok");
  const escaping = join("..", basename(dir), "index.html");
  for (const contract of ["/etc/hosts", escaping, "a/../../index.html"]) {
    assert.equal(buildSucceeded({ code: 0, dir, outputContract: contract }), false);
  }
  assert.match(describeFailure({ code: 0, dir, outputContract: "/etc/hosts" }), /relative path/i);
});

test("valid nested and leading-dot contracts work", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "ok");
  writeFileSync(join(dir, "..hidden.html"), "ok");
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "dist/index.html" }), true);
  assert.equal(buildSucceeded({ code: 0, dir, outputContract: "..hidden.html" }), true);
});

test("malformed contracts and directories are safe failures", () => {
  const dir = tempDir();
  for (const contract of [123, ["index.html"], "index\0.html", ".", "..", "a".repeat(5000)]) {
    assert.equal(buildSucceeded({ code: 0, dir, outputContract: contract }), false);
    assert.ok(describeFailure({ code: 0, dir, outputContract: contract }).length > 0);
  }
  assert.equal(buildSucceeded({ code: 0, dir: 42, outputContract: "index.html" }), false);
});

test("requires the options-object calling convention", () => {
  assert.equal(buildSucceeded(), false);
  assert.ok(describeFailure().length > 0);
  assert.throws(() => buildSucceeded(0, "/tmp", "index.html"), /takes one options object/);
  assert.throws(() => describeFailure(0, "/tmp", "index.html"), /takes one options object/);
});

test("success has no failure sentence", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "index.html"), "ok");
  assert.equal(describeFailure({
    code: 0,
    dir,
    outputContract: "index.html",
    result: parseResultEvent(COMPLETED),
  }), "");
});
