// This is deliberately a small, deterministic transcription repair layer. It
// only turns explicitly spoken technical symbols into their literal form; it
// never guesses missing path components or asks a model to "fix" a command.
const SLASH = "(?:slash|schr(?:ä|ae)gstrich)";
const BACKSLASH = "(?:backslash|r(?:ü|ue)ckw(?:ä|ae)rtsschr(?:ä|ae)gstrich)";
const EXTENSION = "(?:txt|text|md|markdown|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|css|html?|htm|xml|py|sh|bash|ps1|bat|cmd|exe|zip|tar|gz|log|csv|sql|env|toml|ini|conf|config)";

function clean(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extension(value) {
  const aliases = { text: "txt", markdown: "md", yml: "yaml", htm: "html" };
  return aliases[value.toLowerCase()] ?? value.toLowerCase();
}

function spokenPathPattern(separator) {
  // Every component must be introduced by an explicit spoken separator. That
  // prevents normal prose after a path from being absorbed into the path.
  return new RegExp(`(?:${separator})\\s+[A-Za-z0-9_.-]+(?:\\s+(?:${separator})\\s+[A-Za-z0-9_.-]+)*`, "giu");
}

function compactPath(raw, separator, literal) {
  const words = raw.trim().split(/\s+/u);
  const marker = new RegExp(`^${separator}$`, "iu");
  return words.reduce((out, word) => marker.test(word) ? out + literal : out + word, "");
}

/**
 * Returns the transcript sent to the assistant plus an auditable record of
 * every deterministic repair. `rawText` is retained so no recognition result
 * is silently or irreversibly rewritten.
 */
export function normalizeTechnicalTranscript(input) {
  const rawText = clean(input);
  let text = rawText;
  const technicalTokens = [];
  const replacePaths = (pattern, separator, literal, type) => {
    text = text.replace(pattern, (raw) => {
      const value = compactPath(raw, separator, literal);
      technicalTokens.push({ type, raw, value });
      return value;
    });
  };

  // "C colon backslash Users" is common when dictating Windows paths. The
  // drive letter and colon are preserved literally; no drive is invented.
  text = text.replace(new RegExp(`\\b([A-Za-z])\\s+(?:colon|doppelpunkt)\\s+(${BACKSLASH}\\s+[A-Za-z0-9_.-]+(?:\\s+${BACKSLASH}\\s+[A-Za-z0-9_.-]+)*)`, "giu"), (raw, drive, tail) => {
    const value = `${drive.toUpperCase()}:\\${compactPath(tail, BACKSLASH, "\\").replace(/^\\/, "")}`;
    technicalTokens.push({ type: "path", raw, value });
    return value;
  });

  replacePaths(spokenPathPattern(SLASH), SLASH, "/", "path");
  replacePaths(spokenPathPattern(BACKSLASH), BACKSLASH, "\\", "path");

  // A dot is repaired only when the following word is a known file extension.
  // This keeps ordinary German punctuation such as "Punkt, weiter" intact.
  text = text.replace(new RegExp(`([A-Za-z0-9_./\\\\-]+)\\s+(?:punkt|dot)\\s+(${EXTENSION})\\b`, "giu"), (raw, stem, suffix) => {
    const value = `${stem}.${extension(suffix)}`;
    technicalTokens.push({ type: "file", raw, value });
    return value;
  });

  return { rawText, text: clean(text), changed: text !== rawText, technicalTokens };
}
