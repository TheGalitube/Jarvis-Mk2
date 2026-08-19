import test from "node:test";
import assert from "node:assert/strict";
import { agentProgress } from "../lib/agent-progress.js";

test("turns app-server command events into a human-readable live status", () => {
  assert.equal(agentProgress({ method: "item/started", params: { item: { type: "command_execution", command: "git push origin main" } } }), "Führe aus: git push origin main");
});
