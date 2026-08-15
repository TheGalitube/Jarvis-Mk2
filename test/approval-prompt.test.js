import test from "node:test";
import assert from "node:assert/strict";
import { approvalPrompt } from "../lib/approval-prompt.js";

test("keeps an approval prompt concise and does not include the command", () => {
  const command = "/bin/bash -lc 'very long and sensitive command'";
  const prompt = approvalPrompt("potentially destructive or external action");
  assert.equal(prompt, "Codex needs approval for potentially destructive or external action. Say approve or deny.");
  assert.equal(prompt.includes(command), false);
});
