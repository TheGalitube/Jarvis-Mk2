import { createServer } from "node:http";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { loadTtsConfig } from "./lib/config.js";
import { ask, buildFullPersona, buildPersona } from "./lib/brain.js";
import { speak } from "./lib/tts.js";
import { parseAction } from "./lib/action.js";
import { loadRegistry } from "./lib/registry.js";
import { describeFailure } from "./lib/outcome.js";
import { run as runBuild } from "./lib/builder.js";
import { buildNetworkAccess, getBindHost } from "./lib/network.js";
import { CodexAppSession } from "./lib/codex-app-server.js";
import { loadRuntimeConfig, OPENAI_STT_MODELS, publicRuntimeConfig } from "./lib/core/config.js";
import { EventBus } from "./lib/core/events.js";
import { SandboxTarget } from "./lib/execution/sandbox-target.js";
import { LocalTarget } from "./lib/execution/local-target.js";
import { SSHTarget } from "./lib/execution/ssh-target.js";
import { defaultOperationRegistry } from "./lib/execution/registry.js";
import { TargetResolver } from "./lib/execution/resolver.js";
import { ExecutionManager } from "./lib/execution/manager.js";
import { parseLocalWriteRequest } from "./lib/execution/local-write-request.js";
import { PolicyEngine } from "./lib/policy/policy-engine.js";
import { approvalPrompt } from "./lib/approval-prompt.js";
import { NemotronStreamingProvider } from "./lib/stt/nemotron.js";
import { WhisperCppProvider } from "./lib/stt/whispercpp.js";
import { OpenAiTranscriptionProvider, transcribeAudioFile } from "./lib/stt/openai.js";
import { selectSttProvider } from "./lib/stt/provider-selection.js";
import { TelegramBot, telegramConfig } from "./lib/telegram.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const BUILDS = join(HERE, "builds"); // one folder per build, created by lib/builder.js
const BUILDS_URL = "/builds/";
const PORT = Number(process.env.PORT) || 3210;
const AGENT_MODE = process.env.JARVIS_AGENT_MODE === "full" ? "full" : "legacy";

// Discover the machine's own addresses at startup, including a Tailscale IPv4
// address when Tailscale is running. Extra DNS names can be supplied through
// JARVIS_ALLOWED_HOSTS without putting machine-specific values in the repo.
const { allowedHosts: ALLOWED_HOSTS, allowedOrigins: ALLOWED_ORIGINS } = buildNetworkAccess({ port: PORT });
const BIND_HOST = getBindHost();

const tts = loadTtsConfig();
const configuredRuntimeConfigPath = process.env.JARVIS_CONFIG_FILE;
const defaultRuntimeConfigPath = join(HERE, "data", "runtime-config.json");
async function existingRuntimeConfigPath() {
  const path = configuredRuntimeConfigPath || defaultRuntimeConfigPath;
  try { await access(path); return path; } catch { return configuredRuntimeConfigPath ? path : null; }
}
const runtimeConfigPath = await existingRuntimeConfigPath();
let runtimeConfig = loadRuntimeConfig(runtimeConfigPath ? { path: runtimeConfigPath } : undefined);
const events = new EventBus();
const runtimeClients = new Set();
const executionHistory = [];

async function persistSttModel(model) {
  if (!OPENAI_STT_MODELS.has(model)) throw new Error("unsupported STT model");
  runtimeConfig = loadRuntimeConfig({ overrides: { ...runtimeConfig, stt: { ...runtimeConfig.stt, provider: "openai", openai: { ...runtimeConfig.stt.openai, model } } } });
  const path = runtimeConfigPath || defaultRuntimeConfigPath;
  const pending = `${path}.tmp`;
  await writeFile(pending, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
  await rename(pending, path);
  for (const send of runtimeClients) send({ type: "runtime_config", config: publicRuntimeConfig(runtimeConfig) });
}

// Phase 1 routes the existing builder through the target abstraction without
// changing its Codex sandbox. Local and SSH targets are deliberately absent
// until their platform adapters exist in later phases.
const sandboxTarget = new SandboxTarget({
  enabled: runtimeConfig.targets.sandbox.enabled,
  execute: ({ arguments: args }) => runBuild(args.primitive, args.params, args.onProgress),
});
const localTarget = new LocalTarget(runtimeConfig.targets.local);
const sshTargets = Object.entries(runtimeConfig.hosts).map(([id, host]) => new SSHTarget({ id, ...host }));
const targetResolver = new TargetResolver({
  targets: [sandboxTarget, localTarget, ...sshTargets],
  config: runtimeConfig,
  registry: defaultOperationRegistry,
});
const executionManager = new ExecutionManager({
  resolver: targetResolver,
  registry: defaultOperationRegistry,
  policy: new PolicyEngine({ config: runtimeConfig }),
  events,
});
events.on("execution.completed", (event) => {
  log(`execution complete target=${event.target} operation=${event.operation} ${event.durationMs}ms`);
});
events.on("*", (event) => {
  if (!/^(execution\.|approval\.)/.test(event.event)) return;
  const entry = { event: event.event, timestamp: event.timestamp, target: event.target ?? null, operation: event.operation ?? null, risk: event.risk ?? null, durationMs: event.durationMs ?? null };
  executionHistory.push(entry);
  while (executionHistory.length > 40) executionHistory.shift();
  for (const send of runtimeClients) send({ type: "execution_event", entry });
});

// Browser clients receive logical target metadata only. Host names, SSH users,
// identity paths, and safe roots remain server-side configuration details.
function publicTargets() {
  return [...targetResolver.targets.values()].map((target) => ({
    id: target.id, type: target.type, platform: target.platform,
    enabled: target.enabled, capabilities: [...target.capabilities],
  }));
}

// Read once, at startup. A primitive is a file on disk, so re-reading the folder
// per request would let a half-saved edit break a live conversation. Loading it
// here also turns a typo in someone's brand-new primitive into a startup error
// naming the file, rather than a silence in the middle of a conversation.
const registry = await loadRegistry();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// The assistant can only ask for a build it has been told exists, so the persona
// is derived from the registry that was just loaded rather than written by hand.
// Without this the chat model runs on the no-builds default and politely refuses
// every build request, which looks like a broken model rather than a miswiring.
const persona = buildPersona(registry);
const fullPersona = buildFullPersona();
const telegramAgents = new Map();

function telegramApprovalDecision(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (/^(approve|approved|yes|ja|freigeben|genehmigen)\b/.test(normalized)) return "accept";
  if (/^(deny|denied|no|nein|ablehnen|verweigern)\b/.test(normalized)) return "decline";
  return null;
}

function telegramAgent(bot, chatId) {
  let agent = telegramAgents.get(chatId);
  if (agent) return agent;
  agent = new CodexAppSession({
    cwd: HERE,
    persona: fullPersona,
    onApproval: async (request, classification) => {
      const command = request.params?.command || request.params?.reason || null;
      await bot.sendMessage(chatId, `${approvalPrompt(classification.reason)} Reply approve or deny.${command ? ` Command: ${command}` : ""}`);
      return await new Promise((resolve) => { agent.telegramApproval = { resolve }; });
    },
  });
  telegramAgents.set(chatId, agent);
  return agent;
}

// Telegram uses the same full Codex agent as the browser. Critical actions
// remain paused until the allowed Telegram chat explicitly approves them.
async function telegramTurn(bot, chatId, text) {
  await bot.sendTyping(chatId);
  const result = await telegramAgent(bot, chatId).ask(text);
  const { reply } = parseAction(result.reply);
  await bot.sendMessage(chatId, reply);
}

const telegramSettings = telegramConfig();
const telegram = telegramSettings.enabled
  ? new TelegramBot({
      ...telegramSettings,
      log,
      onText: ({ chatId, text }) => telegramTurn(telegram, chatId, text),
      onApprovalText: ({ chatId, text }) => {
        const agent = telegramAgents.get(chatId);
        const decision = telegramApprovalDecision(text);
        if (!agent?.telegramApproval || !decision) return false;
        const { resolve } = agent.telegramApproval;
        agent.telegramApproval = null;
        resolve(decision);
        return true;
      },
      onVoice: async ({ chatId, fileId }) => {
        await telegram.sendTyping(chatId);
        try {
          const audio = await telegram.downloadVoice(fileId);
          const transcript = await transcribeAudioFile({ apiKey: process.env.OPENAI_API_KEY, ...runtimeConfig.stt.openai, audio });
          if (!transcript) { await telegram.sendMessage(chatId, "Ich konnte das leider nicht verstehen, sir."); return; }
          await telegramTurn(telegram, chatId, transcript);
        } catch (error) {
          log(`telegram voice failed: ${error.message}`);
          await telegram.sendMessage(chatId, "Die Sprachnachricht konnte leider nicht verarbeitet werden, sir.");
        }
      },
    })
  : null;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

// Serving files by path is where a static server gets broken into: "/../lib/x"
// and its percent-encoded twin both mean "read something above the folder I am
// allowed to read from". join() walks out of the root quite happily, so the
// resolved path is checked against the root before anything is opened. Returns
// null for anything that escapes, which the caller answers with 403.
function fileWithin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent escape
  }
  if (decoded.includes("\0")) return null; // fs throws on these rather than reporting them
  const full = resolve(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

// Listening on 127.0.0.1 keeps other machines out; it does not keep other NAMES
// out. Anyone can point a hostname they own at 127.0.0.1, and a page served from
// that name would then be talking to this server from inside the reader's own
// browser — reading public/ and builds/ across what the browser believes is a
// same-origin boundary. The Host header carries the name that was asked for, so
// checking it is what closes that door.
function hostAllowed(host) {
  return typeof host === "string" && ALLOWED_HOSTS.has(host.toLowerCase());
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    log(`http refused host=${JSON.stringify(req.headers.host ?? null)}`);
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  const urlPath = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Two roots, one containment rule: the app's own files, and the read-only
  // artifacts a build wrote, so a finished page can be opened in the browser.
  const isBuild = urlPath.startsWith(BUILDS_URL);
  const root = isBuild ? BUILDS : PUBLIC;
  const rel = isBuild
    ? urlPath.slice(BUILDS_URL.length - 1) // keep the leading slash
    : urlPath === "/" ? "/index.html" : urlPath;

  const file = fileWithin(root, rel);
  if (!file) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    const headers = { "Content-Type": MIME[extname(file)] || "application/octet-stream" };
    if (isBuild) {
      // A built page is model-written HTML with model-written inline script,
      // served from the same origin as this app. `sandbox allow-scripts` drops
      // it into an opaque origin: the page still renders and its script still
      // runs, but it can no longer reach back into this origin to open the
      // control socket or read what another build wrote.
      headers["Content-Security-Policy"] = "sandbox allow-scripts";
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch { res.writeHead(404); res.end("not found"); }
});

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

// Every voice the assistant has goes through here, so a build question and a
// build result sound like the same character as a chat reply: caption first,
// then the audio the browser plays.
// `nextState` is where the orb should land once this clip finishes playing.
// Without it the client falls back to idle. It exists because a spoken line can
// hand off to a state rather than end a turn: the build confirmation is followed
// by the HUD, and sending `working` alongside the audio would race playback --
// the clip's own end would then fire idle and tear the HUD down mid-build.
async function say(send, text, nextState) {
  send({ type: "reply_text", text });
  const t = Date.now();
  try {
    const result = await speak(text, tts, {
      onProviderError: ({ provider, message }) => log(`tts ${provider} failed: ${message}`),
    });
    const ms = Date.now() - t;
    if (!result.audio) {
      log("tts disabled; continuing text-only");
      send({ type: "debug", stage: "tts", ms, msg: "audio disabled; text only" });
      send({ type: "state", value: nextState || "idle" });
      return;
    }
    log(`tts ${result.provider} ok ${ms}ms ${result.audio.length}b`);
    send({
      type: "debug",
      stage: "tts",
      ms,
      msg: `${result.provider} ${result.audio.length} bytes`,
    });
    send({ type: "state", value: "speaking" });
    send({
      type: "audio",
      format: result.format,
      data: result.audio.toString("base64"),
      nextState,
    });
  } catch (error) {
    const ms = Date.now() - t;
    log(`tts unavailable: ${error.message || error}`);
    send({ type: "debug", stage: "tts", ms, msg: "audio unavailable; text only" });
    send({ type: "state", value: nextState || "idle" });
  }
}

// Two things the assistant has to say in one breath sound like conversation;
// two separate clips with a synthesis gap between them sound like a machine
// reading a list. Used to fuse an acknowledgement onto the question that
// follows it.
function joinSpoken(...parts) {
  return parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean).join(" ");
}

// A primitive name arrives from the chat model, and an unknown one gets read
// aloud and written to the log. Keep it short and printable so a garbled tag
// cannot forge a log line or hand the voice a page of noise to pronounce.
const MAX_NAME = 40;
function readableName(text) {
  const clean = String(text).replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return clean.slice(0, MAX_NAME);
}

// ---------------------------------------------------------------------------
// Build dispatch
// ---------------------------------------------------------------------------

// A build is a model with file-writing tools on, so the ceiling has to count
// every build on this machine rather than every build in one tab. Held at module
// scope for that reason: two open tabs are two sockets, and a per-socket guard
// would let each of them start one.
const MAX_BUILDS = 1;
let running = 0;

const slotFree = () => running < MAX_BUILDS;

// Check and claim in the same tick. Anything awaited between the two would let a
// second socket see the slot that a first one is already on its way to taking.
function claimSlot() {
  if (!slotFree()) return false;
  running++;
  return true;
}

function releaseSlot() {
  running = Math.max(0, running - 1);
}

const BUSY_LINE = "One build at a time, sir. Ask me again once this one lands.";

// "Unanswered" is generous on purpose. A tag can arrive as `subject=` with an
// empty value, and building a landing page about nothing is a worse outcome
// than one more spoken question.
function firstUnanswered(primitive, params) {
  return primitive.questions.find(
    (q) => typeof params[q.key] !== "string" || params[q.key].trim() === "",
  );
}

// Entry point from a chat turn that carried an action tag. `preamble` is what
// the model already said out loud about the request; it is fused onto whatever
// comes next so the turn is one utterance instead of two. The corrective paths
// below drop it deliberately -- an acknowledgement contradicts the correction.
async function dispatchAction(send, conv, action, preamble = "") {
  log(`action primitive=${JSON.stringify(action.primitive)} params=${JSON.stringify(action.params)}`);

  const primitive = registry.get(action.primitive);
  if (!primitive) {
    // A model can invent a primitive that was never installed. That is a thing
    // to say in character, not a thing to crash on.
    const name = readableName(action.primitive);
    log(`action unknown primitive=${JSON.stringify(action.primitive)}`);
    await say(send, name
      ? `I don't know how to build a ${name} yet, sir.`
      : "I'm not sure what you'd like me to build, sir.");
    return;
  }

  // Said early so nobody sits through a round of questions only to be turned
  // away at the end. The slot is not claimed here — the claim happens at the
  // moment the build actually starts, which is the only place it is safe.
  if (!slotFree()) {
    log(`build deferred primitive=${primitive.id} (one already running)`);
    await say(send, BUSY_LINE);
    return;
  }

  await advance(send, conv, primitive, { ...action.params }, preamble);
}

// Ask for the next missing answer, or start the build once nothing is missing.
// One question per turn: the answer arrives as the next thing the person says.
async function advance(send, conv, primitive, params, preamble = "") {
  const question = firstUnanswered(primitive, params);
  if (question) {
    conv.pending = { primitive, params, key: question.key };
    send({ type: "ask", text: question.ask });
    // Spoken as well as sent, because the person is listening rather than
    // reading the screen -- and fused to the acknowledgement so "of course,
    // sir" and the question arrive as one sentence.
    await say(send, joinSpoken(preamble, question.ask));
    return;
  }
  await build(send, primitive, params, preamble);
}

async function build(send, primitive, params, preamble = "") {
  // The real guard. Answering a question takes as long as the person takes, so
  // the check in dispatchAction can be minutes stale by the time a build starts
  // and another tab may have taken the slot in between.
  if (!claimSlot()) {
    log(`build refused primitive=${primitive.id} (one already running)`);
    await say(send, joinSpoken(preamble, BUSY_LINE));
    return;
  }

  let started = Date.now();
  let outcome;
  try {
    // Confirm out loud BEFORE the HUD takes over. Someone who just answered a
    // question needs to hear that the answer landed; a silent jump to the build
    // readout reads as the assistant ignoring them. `nextState` hands the orb to
    // the HUD when this line finishes rather than racing it.
    const kickoff = typeof primitive.startLine === "function"
      ? primitive.startLine(params)
      : "Starting now, sir.";
    await say(send, joinSpoken(preamble, kickoff), "working");

    started = Date.now();
    log(`build start primitive=${primitive.id} params=${JSON.stringify(params)}`);
    const execution = await executionManager.execute({
      operation: "artifact.build",
      arguments: { primitive, params, onProgress: (line) => send({ type: "progress", line }) },
    });
    outcome = execution.result;
  } finally {
    // Released the moment the CLI is done and before a word is spoken about it,
    // so a Fish outage — while announcing the start or while reporting the
    // result — cannot leave the slot claimed and lock the machine out of ever
    // building again.
    releaseSlot();
  }

  const ms = Date.now() - started;
  const dir = basename(outcome.dir);
  log(`build finish primitive=${primitive.id} ok=${outcome.ok} ${ms}ms dir=${dir}`);

  if (outcome.ok) {
    await say(send, primitive.doneLine(params));
    // Served by the /builds/ route above. Encoded because a primitive's output
    // contract is a filename, and filenames are allowed to contain spaces.
    send({ type: "open", url: encodeURI(`${BUILDS_URL}${dir}/${primitive.outputContract}`) });
    // No "idle" here. say() returns once the audio has been SENT, not once it has
    // been heard, and the browser handles each message as it arrives — so an idle
    // sent now lands while the done-line is still playing and drops the orb dead
    // mid-sentence. Playback ending is what returns it to idle.
    return;
  }

  // builder.run() preserves the real Codex process exit code. Combined with the
  // terminal turn event this distinguishes a CLI failure from a clean turn that
  // simply forgot to write the promised artifact.
  const code = outcome.code;
  const trouble = describeFailure({
    code,
    dir: outcome.dir,
    outputContract: primitive.outputContract,
    result: outcome.result,
    timedOut: outcome.timedOut,
  }) || "The build did not finish.";

  await say(send, `${trouble} Nothing is broken, sir. Say the word and I'll try again.`);
  // The log path is the one thing worth reading afterwards, so it goes on screen
  // rather than into the spoken line.
  send({ type: "error", message: outcome.log ? `${trouble} Full log: ${outcome.log}` : trouble });
  send({ type: "state", value: "idle" });
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

// A WebSocket is exempt from the same-origin policy: any page, in any tab, can
// open a socket to a port on this machine and start talking. With no check on
// who opened it, a page the reader merely visits could start a build here — a
// model with file-writing tools, on their machine, with no click and nothing
// visible — and read the whole conversation back, absolute paths included.
// Origin is the one header a page cannot forge, because the browser sets it, so
// it is the check. A MISSING Origin is refused as well: a browser always sends
// one, so its absence means the request did not come from a page at all.
function originAllowed(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin.toLowerCase());
}

const wss = new WebSocketServer({
  noServer: true, // the upgrade is accepted below, after the origin is checked
  // The default ceiling is 100MB per message, and a message's text is handed to
  // a subprocess. Speech is short; this is far more room than a sentence needs.
  maxPayload: 64 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    log(`ws refused origin=${JSON.stringify(req.headers.origin ?? null)}`);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const sessions = new Map(); // ws -> sessionId

function approvalDecision(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (/^(yes|ja|approve|approved|allow|erlauben|bestätigen|bestatigen|go|mach)\b/.test(value)) return "accept";
  if (/^(no|nein|deny|denied|decline|ablehnen|stop|stopp|abbrechen)\b/.test(value)) return "decline";
  return null;
}

wss.on("connection", (ws) => {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  runtimeClients.add(send);
  send({ type: "runtime_config", config: publicRuntimeConfig(runtimeConfig) });
  send({ type: "runtime_targets", targets: publicTargets() });
  send({ type: "execution_history", entries: executionHistory });
  // Per-tab state, held in this connection's closure rather than a global map,
  // so it cannot outlive the socket. `pending` is the question waiting on an
  // answer. The one-build-at-a-time guard is deliberately NOT here: it counts
  // builds on the machine, and two tabs are two of these closures.
  const conv = { pending: null, approval: null };
  let nemotron = null;
  let whispercpp = null;
  let openai = null;
  let sttRequest = 0;
  const sendSttEvent = (event) => send({ type: "stt_event", event });
  const startStt = async (preferCloud = false) => {
    const request = ++sttRequest;
    const probe = new NemotronStreamingProvider(runtimeConfig.stt.nemotron);
    const whisperProbe = new WhisperCppProvider(runtimeConfig.stt.whispercpp);
    const openAiProbe = new OpenAiTranscriptionProvider({ apiKey: process.env.OPENAI_API_KEY, ...runtimeConfig.stt.openai });
    let selected;
    try {
      selected = await selectSttProvider(runtimeConfig, { openAiAvailable: openAiProbe.supported, cloudAvailable: openAiProbe.supported, preferCloud, nemotronHealth: () => probe.health(), whisperCppHealth: () => whisperProbe.health() });
    } catch {
      sendSttEvent({ type: "stt.error", provider: "remote", error: "provider-unavailable", fatal: false });
      return;
    }
    if (request !== sttRequest) return;
    send({ type: "stt.selected", provider: selected.provider, fallback: selected.fallback });
    if (selected.provider === "openai") {
      nemotron?.close(); whispercpp?.close(); openai?.close();
      openai = new OpenAiTranscriptionProvider({ apiKey: process.env.OPENAI_API_KEY, ...runtimeConfig.stt.openai, onEvent: sendSttEvent });
      try { openai.start(); }
      catch { sendSttEvent({ type: "stt.error", provider: "openai", error: "connection-failed", fatal: false }); }
      return;
    }
    if (selected.provider === "whispercpp") {
      nemotron?.close(); whispercpp?.close(); openai?.close(); openai = null;
      whispercpp = new WhisperCppProvider({ ...runtimeConfig.stt.whispercpp, cloudMode: Boolean(preferCloud && runtimeConfig.stt.gateway.cloudOptInEnabled), sessionId: randomUUID(), onEvent: sendSttEvent });
      try { whispercpp.start(); }
      catch { sendSttEvent({ type: "stt.error", provider: "whispercpp", error: "connection-failed", fatal: false }); }
      return;
    }
    if (selected.provider !== "nemotron") return;
    whispercpp?.close(); whispercpp = null; openai?.close(); openai = null;
    nemotron?.close();
    nemotron = new NemotronStreamingProvider({
      ...runtimeConfig.stt.nemotron,
      onEvent: sendSttEvent,
    });
    try { await nemotron.start(); }
    catch { sendSttEvent({ type: "stt.error", provider: "nemotron", error: "connection-failed", fatal: false }); }
  };
  const agent = AGENT_MODE === "full"
    ? new CodexAppSession({
        cwd: HERE,
        persona: fullPersona,
        onEvent: (event) => {
          if (event.type === "usage") send({ type: "usage", usage: event.usage });
        },
        onApproval: async (request, classification) => {
          const command = request.params?.command || request.params?.reason || classification.reason;
          const prompt = approvalPrompt(classification.reason);
          send({ type: "approval", reason: classification.reason, command: command || null });
          // Keep the microphone available after the prompt finishes so the user
          // can answer while Codex remains paused on this approval request.
          await say(send, prompt, "approval");
          return await new Promise((resolve) => {
            conv.approval = { resolve };
          });
        },
      })
    : null;
  log("client connected");
  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "approval") {
      const decision = msg.decision === "approve" ? "accept" : msg.decision === "deny" ? "decline" : null;
      if (decision && conv.approval) {
        const resolve = conv.approval.resolve;
        conv.approval = null;
        resolve(decision);
      }
      return;
    }
    if (msg.type === "target.health" && typeof msg.target === "string") {
      const target = targetResolver.targets.get(msg.target);
      if (!target) { send({ type: "target.health", target: msg.target, ok: false, error: "unknown-target" }); return; }
      try {
        const health = await target.health();
        send({ type: "target.health", target: target.id, ...health });
      } catch {
        send({ type: "target.health", target: target.id, ok: false, error: "unavailable" });
      }
      return;
    }
    if (msg.type === "stt.model.update") {
      try { await persistSttModel(msg.model); }
      catch { send({ type: "stt.model.update", ok: false }); }
      return;
    }
    if (msg.type === "stt.start") { await startStt(msg.preferCloud === true); return; }
    if (msg.type === "stt.cancel") { sttRequest++; nemotron?.close(); nemotron = null; whispercpp?.close(); whispercpp = null; openai?.close(); openai = null; return; }
    if (msg.type === "stt.audio") {
      try { (nemotron ?? whispercpp ?? openai)?.appendAudio(msg.audio); }
      catch { sendSttEvent({ type: "stt.error", provider: nemotron ? "nemotron" : whispercpp ? "whispercpp" : "openai", error: "audio-rejected", fatal: false }); }
      return;
    }
    if (msg.type === "stt.stop") { nemotron?.stop(); await whispercpp?.stop(); await openai?.stop(); return; }
    if (msg.type !== "say" || !msg.text?.trim()) return;
    log("say:", JSON.stringify(msg.text));
    send({ type: "debug", stage: "stt", msg: `heard "${msg.text}"` });
    try {
      if (conv.approval) {
        const decision = approvalDecision(msg.text);
        if (!decision) {
          await say(send, "Please say approve or deny, sir.", "thinking");
          return;
        }
        const resolve = conv.approval.resolve;
        conv.approval = null;
        resolve(decision);
        send({ type: "debug", stage: "approval", msg: decision });
        return;
      }
      // An outstanding question owns the next thing said: it is an answer, not a
      // new turn, so it goes to the build rather than to the chat model.
      if (conv.pending) {
        const { primitive, params, key } = conv.pending;
        conv.pending = null;
        const answer = msg.text.trim();
        log(`answer ${primitive.id} ${key}=${JSON.stringify(answer)}`);
        send({ type: "debug", stage: "ask", msg: `${key} = "${answer}"` });
        await advance(send, conv, primitive, { ...params, [key]: answer });
        return;
      }

      const localWrite = parseLocalWriteRequest(msg.text);
      if (localWrite) {
        send({ type: "state", value: "thinking" });
        const execution = await executionManager.execute({
          operation: "filesystem.write",
          target: "local",
          arguments: localWrite,
        }, {
          requestApproval: async () => {
            send({ type: "approval", reason: "creating a local file", command: localWrite.path });
            await say(send, approvalPrompt("creating a local file"), "approval");
            return await new Promise((resolve) => { conv.approval = { resolve }; });
          },
        });
        await say(send, `Created ${execution.result.path}, sir.`);
        return;
      }

      send({ type: "state", value: "thinking" });
      const tb = Date.now();
      const result = agent
        ? await agent.ask(msg.text)
        : await ask(msg.text, sessions.get(ws), { persona });
      const { reply: spoken, sessionId } = result;
      const bms = Date.now() - tb;
      if (!agent) sessions.set(ws, sessionId);
      // The model may append a machine-readable tag asking for a build. Split it
      // off first: the tag is for dispatch, never for the voice.
      const { reply, action } = parseAction(spoken);
      log(`brain ok ${bms}ms session=${sessionId} reply=${JSON.stringify(reply)}` +
          (action ? ` action=${JSON.stringify(action.primitive)}` : ""));
      send({ type: "debug", stage: "brain", ms: bms, msg: `codex: "${reply}"` });
      // With a build to dispatch, the reply is not spoken on its own: it is
      // handed down as a preamble and fused onto the question (or the kickoff)
      // so the whole turn is one utterance. Speaking it here would add a second
      // clip and a synthesis gap to every build request.
      if (action && !agent) {
        await dispatchAction(send, conv, action, reply);
      } else if (reply) {
        await say(send, reply);
      } else {
        log("brain returned no speakable text");
      }
    } catch (e) {
      log("ERROR:", e.message || e);
      send({ type: "debug", stage: "error", msg: String(e.message || e) });
      send({ type: "error", message: String(e.message || e) });
      send({ type: "state", value: "idle" });
    }
  });
  ws.on("close", () => {
    runtimeClients.delete(send);
    sessions.delete(ws);
    if (conv.approval) conv.approval.resolve("cancel");
    agent?.close();
    sttRequest++; nemotron?.close(); whispercpp?.close(); openai?.close();
    conv.pending = null;
    // A build already running is left to finish: it has been paid for and its
    // artifact still lands on disk. Nothing here points back at this socket
    // afterwards, and send() is a no-op once the socket is gone, so a progress
    // update arriving late has nowhere to go rather than something to break.
    log("client disconnected");
  });
});

// A port already in use is the single most common way starting this fails, and
// an unhandled EADDRINUSE prints a stack trace that says nothing about what to
// do next.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — stop the other server or run PORT=${PORT + 1} node server.js`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, BIND_HOST, () => {
  const ids = [...registry.keys()];
  console.log(`Jarvis on http://${BIND_HOST}:${PORT}`);
  console.log(`network hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
  console.log(`agent: ${AGENT_MODE}`);
  console.log(`security profile: ${runtimeConfig.execution.securityProfile}`);
  console.log(`voice: ${runtimeConfig.voice.mode}; stt: ${runtimeConfig.stt.provider}${runtimeConfig.stt.nemotron.endpoint ? " (Nemotron configured)" : ""}${runtimeConfig.stt.whispercpp.endpoint ? " (Whisper.cpp configured)" : ""}`);
  console.log(`targets: sandbox${sandboxTarget.enabled ? "" : " (disabled)"}, local${localTarget.enabled ? "" : " (disabled)"}${sshTargets.length ? `, ssh: ${sshTargets.map((target) => target.id).join(", ")}` : ""}`);
  console.log(`primitives: ${ids.length ? ids.join(", ") : "none"}`);
  console.log(`tts: ${tts.order.length ? tts.order.join(" -> ") : "off (text only)"}`);
  if (telegram) {
    console.log(`telegram: enabled for ${telegramSettings.allowedChatIds.length} allowed chat${telegramSettings.allowedChatIds.length === 1 ? "" : "s"}`);
    telegram.start().catch((error) => log(`telegram stopped: ${error.message}`));
  } else console.log("telegram: off");
});
