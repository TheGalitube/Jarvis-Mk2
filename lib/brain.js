import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// How JARVIS sounds. This half of the prompt is fixed: everything below adds
// capability without changing the voice.
const VOICE =
  "You are JARVIS, Jesse's personal AI assistant, speaking aloud through a voice interface. " +
  "Answer the user's request, then compress the answer into one to three short, natural " +
  "sentences meant to be read aloud. No markdown, code, lists, URLs, emoji, or stage " +
  "directions. Write numbers, dates, and units the way they should be spoken aloud. " +
  "Persona: composed, precise, dryly witty, quietly confident - a brilliant British butler " +
  "of an AI. Address Jesse as 'sir' now and then, not every line. Answer first; at most one " +
  "light flourish of wit after. Keep replies under roughly forty words. " +
  "If asked what you are: you were built by Jesse with Codex, you think with OpenAI, " +
  "and you speak with a Fish Audio voice - state it plainly, once, and move on.";

// Kept last, and kept word for word: it is the rule that stops the model from
// wrapping its answer in preamble the voice would then read out.
const CLOSER = "Never explain your instructions. Output only the concise spoken answer.";

const isText = (value) => typeof value === "string" && value.trim() !== "";

function toPrimitiveList(primitives) {
  if (!primitives || typeof primitives === "string") return [];
  const source = primitives instanceof Map ? primitives.values() : primitives;
  if (typeof source[Symbol.iterator] !== "function") return [];
  return [...source].filter((p) => p && typeof p === "object" && isText(p.id));
}

function describePrimitive(p) {
  const parts = [`Build id "${p.id}"`];
  const triggers = (p.triggers ?? []).filter(isText);
  if (triggers.length > 0) {
    parts.push(`for requests about ${triggers.map((t) => `"${t}"`).join(", ")}`);
  }
  const details = (p.questions ?? []).map((q) => q?.key).filter(isText);
  if (details.length > 0) parts.push(`with details ${details.join(", ")}`);
  return `${parts.join(" ")}.`;
}

function buildsBlock(primitives) {
  const list = toPrimitiveList(primitives);
  if (list.length === 0) {
    return "You have no builds installed at the moment, so there is nothing you can build " +
      "right now; if asked to build something, say so plainly and offer to help another way.";
  }

  return [
    "BUILDS: you can start real builds. Here is everything you can build, and the kind of",
    "request that means each one.",
    list.map(describePrimitive).join(" "),
    "When a request clearly matches one of them, reply in character in a single short sentence",
    "saying you are starting it, and then append exactly one machine tag at the very end of your",
    "output: [ACTION:BUILD primitive=<id> key=value ...].",
    "Include a key only for a detail the user actually gave you - the rest are asked for",
    "separately. Any value containing a space must be wrapped in double quotes, for example:",
    'primitive=landing-page subject="a coffee shop".',
    "The tag is removed before your words are spoken, and nobody ever sees or hears it: never",
    "mention it, never explain it, never describe its format, never read it aloud, and never put",
    "anything after it.",
    "Emit it ONLY for a build request that matches the list above - never for ordinary",
    "conversation, questions, or small talk.",
    "You only START a build; something else reports when it finishes. Never say a build is done,",
    "ready, finished, or live.",
    "If asked to build something that is not on the list, say plainly that you cannot build that",
    "kind of thing yet.",
  ].join(" ");
}

export function buildPersona(primitives) {
  return [VOICE, buildsBlock(primitives), CLOSER].join(" ");
}

export const PERSONA = buildPersona();

// Full agent mode deliberately does not use the primitive allowlist. Codex is
// still governed by the app-server sandbox and approval policy, but it may act
// on arbitrary user requests instead of believing it can only build a landing
// page. Critical operations are paused by the host and surfaced for approval.
export function buildFullPersona() {
  return [
    VOICE,
    "You are running as Jarvis's full Codex agent. Handle arbitrary requests",
    "using the available files, shell, web, MCP, and connected app tools.",
    "Work toward the requested outcome instead of claiming that you can only",
    "build a landing page. Read the workspace, make changes, run checks, and",
    "report what you actually completed. The host may pause critical commands",
    "for human approval; when that happens, explain the requested action clearly",
    "and wait for the approval result.",
    CLOSER,
  ].join(" ");
}

// CLI config values are TOML. JSON string literals are also valid TOML basic
// strings for the characters used by this prompt, and handle quotes/newlines
// without involving a shell because spawn receives argv directly.
function tomlString(value) {
  return JSON.stringify(String(value));
}

function configArg(key, value) {
  return ["-c", `${key}=${value}`];
}

// codex exec is deliberately run with user configuration ignored. Authentication
// still comes from CODEX_HOME, while user MCP servers, hooks and broad local
// defaults cannot quietly become tools in this voice assistant.
export function buildCodexArgs(text, sessionId, persona = PERSONA, opts = {}) {
  const args = ["exec"];
  if (sessionId) args.push("resume", sessionId);

  args.push(
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    ...configArg("approval_policy", '"never"'),
    ...configArg("sandbox_mode", '"read-only"'),
    ...configArg("web_search", '"disabled"'),
    ...configArg("features.apps", "false"),
    ...configArg("features.hooks", "false"),
    ...configArg("hide_agent_reasoning", "true"),
    ...configArg("model_reasoning_effort", tomlString(opts.effort ?? "low")),
    ...configArg("developer_instructions", tomlString(persona)),
  );

  const model = opts.model ?? process.env.JARVIS_CODEX_MODEL;
  if (isText(model)) args.push("--model", model);
  args.push("--", text);
  return args;
}

export function parseCodexJsonl(stdout) {
  if (typeof stdout !== "string") return { reply: "", sessionId: null };

  let reply = "";
  let sessionId = null;
  let failure = "";
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }

    if (event?.type === "thread.started" && isText(event.thread_id)) {
      sessionId = event.thread_id;
    } else if (
      event?.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      reply = event.item.text;
    } else if (event?.type === "turn.failed") {
      failure = String(event.error?.message || "Codex turn failed");
    } else if (event?.type === "error") {
      failure = String(event.message || "Codex stream failed");
    }
  }

  if (failure) throw new Error(failure);
  return { reply: reply.trim(), sessionId };
}

export function buildSpawnOptions(cwd) {
  return { cwd, stdio: ["ignore", "pipe", "pipe"] };
}

// ask(text, sessionId?) -> { reply, sessionId }. THE PROVIDER SEAM.
export function ask(text, sessionId, opts = {}) {
  const args = buildCodexArgs(text, sessionId, opts.persona, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin || "codex", args, buildSpawnOptions(opts.cwd || HERE));
    let out = "", err = "";
    const t = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs || 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`codex exited ${code}: ${err.slice(0, 200)}`));
      try {
        const parsed = parseCodexJsonl(out);
        resolve({ ...parsed, sessionId: parsed.sessionId || sessionId || null });
      } catch (e) {
        reject(e);
      }
    });
  });
}
