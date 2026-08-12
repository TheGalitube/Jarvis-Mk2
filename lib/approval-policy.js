const DEFAULT_CRITICAL = [
  /\bgh\s+(auth|repo|pr|issue|release|workflow|gist)\b/i,
  /\bgit\s+(push|remote|clone|fetch|pull)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\b(curl|wget)\b[^\n]*(github\.com|api\.)/i,
  /\b(rm|rmdir)\b[^\n]*\s-rf?\b/i,
  /\b(sudo|systemctl|shutdown|reboot|mkfs|dd)\b/i,
  /\b(docker|podman)\s+(push|login|system)\b/i,
  /\b(terraform|pulumi)\s+(apply|destroy)\b/i,
  /\b(aws|gcloud|az)\s+(create|delete|update|deploy|put|publish)\b/i,
  /\b(api\.)?github\.com\b/i,
];

function configuredPatterns(env = process.env) {
  const extra = String(env.JARVIS_CRITICAL_COMMANDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try { return new RegExp(value, "i"); }
      catch { return null; }
    })
    .filter(Boolean);
  return [...DEFAULT_CRITICAL, ...extra];
}

export function classifyApproval(request, env = process.env) {
  const method = String(request?.method ?? "");
  const params = request?.params ?? {};
  const command = String(params.command ?? params.reason ?? "");
  const lower = command.toLowerCase();

  if (method.includes("permissions")) {
    const reason = /network|internet|external/i.test(String(params.reason ?? ""))
      ? "network or external access"
      : "additional permissions";
    return { level: "critical", reason };
  }
  if (method.includes("fileChange") && params.grantRoot) {
    return { level: "critical", reason: "additional write access" };
  }
  if (configuredPatterns(env).some((pattern) => pattern.test(command))) {
    const reason = /\bgh\b|github|git\s+(push|remote|clone|fetch|pull)/i.test(lower)
      ? "GitHub or remote Git action"
      : "potentially destructive or external action";
    return { level: "critical", reason };
  }
  return { level: "automatic", reason: "local, non-critical action" };
}

export function approvalPrompt(request, classification) {
  const params = request?.params ?? {};
  const command = params.command ? ` Command: ${params.command}.` : "";
  return `Sir, Codex requests approval for ${classification.reason}.${command} Say approve or deny.`;
}
