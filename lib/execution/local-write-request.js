// A deliberately narrow voice-command parser. General file editing remains a
// Codex-agent task; this route exists for an explicit, reviewable text-file
// creation request and never turns arbitrary spoken text into a shell command.
const REQUEST = /^(?:jarvis[,.]?\s*)?(?:erstelle|schreibe|lege an|create|write)(?:\s+(?:eine?|die))?(?:\s+(?:text[- ]?datei|datei|file))?\s+(?:unter\s+|in\s+|to\s+|at\s+)?(\S+)\s+(?:mit\s+(?:dem\s+)?inhalt|with\s+(?:the\s+)?content)\s+(.+)$/i;

export function parseLocalWriteRequest(value) {
  if (typeof value !== "string") return null;
  const match = REQUEST.exec(value.trim());
  if (!match) return null;
  const [, path, content] = match;
  return path && content ? { path, content } : null;
}
