import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressStream, progressLine, progressLines } from "../lib/progress.js";

const event = (type, item) => JSON.stringify({ type, item });
const fileChange = (...changes) => event("item.completed", {
  id: "file-1",
  type: "file_change",
  changes,
  status: "completed",
});

const WRITE = fileChange({ path: "/tmp/build/index.html", kind: "add" });
const EDIT = fileChange({ path: "/tmp/build/app.js", kind: "update" });
const DELETE = fileChange({ path: "/tmp/build/old.css", kind: "delete" });
const COMMAND = event("item.started", {
  id: "cmd-1",
  type: "command_execution",
  command: "node --check app.js",
  status: "in_progress",
});
const MCP = event("item.started", {
  id: "mcp-1",
  type: "mcp_tool_call",
  server: "design",
  tool: "search",
  status: "in_progress",
});
const SEARCH = event("item.started", {
  id: "web-1",
  type: "web_search",
  query: "coffee landing page",
});

test("maps Codex file changes to readable HUD lines", () => {
  assert.equal(progressLine(WRITE), "Writing index.html");
  assert.equal(progressLine(EDIT), "Editing app.js");
  assert.equal(progressLine(DELETE), "Deleting old.css");
});

test("reports commands, MCP calls and web searches without leaking payloads", () => {
  assert.equal(progressLine(COMMAND), "Running command");
  assert.equal(progressLine(MCP), "Using design/search");
  assert.equal(progressLine(SEARCH), "Searching the web");
});

test("one file-change event may report several files", () => {
  const line = fileChange(
    { path: "/b/index.html", kind: "add" },
    { path: "/b/app.js", kind: "update" },
  );
  assert.deepEqual(progressLines(line), ["Writing index.html", "Editing app.js"]);
  assert.equal(progressLine(line), "Writing index.html");
});

test("ignores completed commands, reasoning, messages and terminal events", () => {
  const quiet = [
    event("item.completed", { type: "command_execution", command: "ls", status: "completed" }),
    event("item.completed", { type: "reasoning", text: "summary" }),
    event("item.completed", { type: "agent_message", text: "done" }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
  ];
  for (const line of quiet) assert.equal(progressLine(line), null);
});

test("malformed and non-object lines never throw", () => {
  for (const line of ["", " ", "nope", "{", "[]", "null", "3", undefined, null]) {
    assert.equal(progressLine(line), null);
  }
});

test("a mixed chunk returns readable lines in order", () => {
  const chunk = [JSON.stringify({ type: "turn.started" }), COMMAND, WRITE, MCP].join("\n") + "\n";
  assert.deepEqual(progressLines(chunk), ["Running command", "Writing index.html", "Using design/search"]);
});

test("control characters and bidi overrides are removed from paths and tools", () => {
  const dirtyPath = fileChange({ path: "/b/evil\nforged.html", kind: "add" });
  assert.equal(progressLine(dirtyPath), "Writing evilforged.html");

  const dirtyTool = event("item.started", {
    type: "mcp_tool_call",
    server: "safe\u202e",
    tool: "tool\u001b",
  });
  assert.equal(progressLine(dirtyTool), "Using safe/tool");
});

test("long unicode subjects are truncated by code point", () => {
  const line = fileChange({ path: "/b/" + "😀".repeat(500) + ".html", kind: "add" });
  const output = progressLine(line);
  assert.equal([...output].length, "Writing ".length + 61);
  assert.ok(output.endsWith("…"));
});

test("a JSON line split across chunks is recovered", () => {
  const big = event("item.completed", {
    type: "file_change",
    changes: [{ path: "/b/index.html", kind: "add" }],
    padding: "x".repeat(80000),
  });
  const stream = createProgressStream();
  assert.deepEqual(stream.push(big.slice(0, 65536)), []);
  assert.deepEqual(stream.push(big.slice(65536) + "\n"), ["Writing index.html"]);
});

test("flush emits a final line without a newline exactly once", () => {
  const stream = createProgressStream();
  assert.deepEqual(stream.push(WRITE), []);
  assert.deepEqual(stream.flush(), ["Writing index.html"]);
  assert.deepEqual(stream.flush(), []);
});

test("split utf-8 buffers retain the complete filename", () => {
  const full = Buffer.from(fileChange({ path: "/b/café-日本語.html", kind: "add" }) + "\n");
  const cut = full.indexOf(Buffer.from("日")) + 1;
  const stream = createProgressStream();
  assert.deepEqual(stream.push(full.subarray(0, cut)), []);
  assert.deepEqual(stream.push(full.subarray(cut)), ["Writing café-日本語.html"]);
});
