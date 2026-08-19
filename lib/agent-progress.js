const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function clean(value, fallback = "") {
  const text = String(value ?? "").replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 220) : fallback;
}

// App-server events differ slightly from `codex exec --json`; this keeps the
// human-facing status stream independent of either transport.
export function agentProgress(event) {
  const item = event?.params?.item;
  if (!item || typeof item !== "object") return null;
  if (event.method === "item/started" && item.type === "command_execution") {
    return `Führe aus: ${clean(item.command, "einen Befehl")}`;
  }
  if (event.method === "item/started" && item.type === "web_search") return "Durchsuche das Web";
  if (event.method === "item/started" && item.type === "mcp_tool_call") {
    return `Nutze ${clean([item.server, item.tool].filter(Boolean).join("/"), "ein Tool")}`;
  }
  if (event.method === "item/completed" && item.type === "file_change" && Array.isArray(item.changes)) {
    const changed = item.changes.map((change) => clean(change?.path)).filter(Boolean).slice(0, 3);
    return changed.length ? `Ändere: ${changed.join(", ")}` : "Ändere Dateien";
  }
  return null;
}
