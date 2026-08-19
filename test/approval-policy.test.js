import test from "node:test";
import assert from "node:assert/strict";
import { approvalPrompt, classifyApproval } from "../lib/approval-policy.js";

test("automatically approves ordinary local commands", () => {
  const result = classifyApproval({
    method: "item/commandExecution/requestApproval",
    params: { command: "rg -n Jarvis ." },
  });
  assert.equal(result.level, "automatic");
});

test("requires approval for GitHub and remote Git actions in supervised mode", () => {
  for (const command of ["gh repo create demo", "git push origin main", "git clone https://github.com/example/demo"]) {
    assert.equal(classifyApproval({ params: { command } }).level, "critical", command);
  }
});

test("autonomous mode permits ordinary GitHub work but protects destructive commands", () => {
  assert.equal(classifyApproval({ params: { command: "git push origin main" } }, process.env, { autonomyMode: "autonomous" }).level, "automatic");
  for (const command of ["gh repo delete demo", "git push --force origin main", "rm -rf /tmp/demo", "sudo systemctl restart jarvis"]) {
    assert.equal(classifyApproval({ params: { command } }, process.env, { autonomyMode: "autonomous" }).level, "critical", command);
  }
  assert.equal(classifyApproval({ method: "item/permissions/requestApproval", params: { reason: "privilege escalation" } }, process.env, { autonomyMode: "autonomous" }).level, "critical");
});

test("requires approval for extra write roots and supports custom patterns", () => {
  assert.equal(classifyApproval({
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  }).level, "critical");
  assert.equal(classifyApproval({ params: { command: "calendar-send invite" } }, {
    JARVIS_CRITICAL_COMMANDS: "calendar-send",
  }).level, "critical");
});

test("approval prompts contain the action and reason", () => {
  const prompt = approvalPrompt({ params: { command: "gh repo create demo" } }, {
    reason: "GitHub or remote Git action",
  });
  assert.match(prompt, /GitHub/);
  assert.match(prompt, /gh repo create demo/);
});
