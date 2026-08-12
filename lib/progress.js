import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

// Codex emits JSONL item events. This adapter turns only user-relevant activity
// into compact HUD lines and deliberately ignores reasoning and agent messages.

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_SUBJECT = 60;

function cleanText(value, fallback = "") {
  if (typeof value !== "string" || value === "") return fallback;
  const chars = [...value.replace(UNPRINTABLE, "")];
  return chars.length > MAX_SUBJECT ? chars.slice(0, MAX_SUBJECT).join("") + "…" : chars.join("");
}

function pathSubject(path) {
  if (typeof path !== "string" || path === "") return "file";
  return cleanText(basename(path), "file");
}

function parseEvent(rawLine) {
  if (typeof rawLine !== "string" || rawLine.trim() === "") return null;
  try {
    const event = JSON.parse(rawLine);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

function fileChangeLines(item) {
  if (!Array.isArray(item?.changes)) return [];
  const verbs = { add: "Writing", update: "Editing", delete: "Deleting" };
  return item.changes
    .filter((change) => change && typeof change === "object")
    .map((change) => `${verbs[change.kind] || "Changing"} ${pathSubject(change.path)}`);
}

function linesForEvent(event) {
  const item = event?.item;
  if (!item || typeof item !== "object") return [];

  if (item.type === "file_change" && event.type === "item.completed") {
    return fileChangeLines(item);
  }
  if (item.type === "command_execution" && event.type === "item.started") {
    return ["Running command"];
  }
  if (item.type === "mcp_tool_call" && event.type === "item.started") {
    const target = cleanText([item.server, item.tool].filter(Boolean).join("/"), "tool");
    return [`Using ${target}`];
  }
  if (item.type === "web_search" && event.type === "item.started") {
    return ["Searching the web"];
  }
  return [];
}

function linesFrom(rawLines) {
  const out = [];
  for (const raw of rawLines) {
    const event = parseEvent(raw);
    if (event) out.push(...linesForEvent(event));
  }
  return out;
}

export function progressLine(rawLine) {
  const event = parseEvent(rawLine);
  return event ? linesForEvent(event)[0] ?? null : null;
}

export function progressLines(chunk) {
  if (typeof chunk !== "string" || chunk === "") return [];
  return linesFrom(chunk.split("\n"));
}

export function createProgressStream() {
  let carry = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return [];
      const text = carry + (typeof chunk === "string" ? chunk : decoder.write(chunk));
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      return linesFrom(parts);
    },
    flush() {
      const raw = carry + decoder.end();
      carry = "";
      const event = parseEvent(raw);
      return event ? linesForEvent(event) : [];
    },
  };
}
