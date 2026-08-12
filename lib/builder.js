import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { buildSucceeded, parseResultEvent } from "./outcome.js";
import { progressLines } from "./progress.js";

// This is the only module that lets Codex write files. Each build receives a
// new workspace, no command-network access, no user config, no rules, no apps,
// no hooks and no interactive approval path. The Codex sandbox, rather than a
// prompt or a path blocklist, enforces the writable boundary.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OWN_PROCESS_GROUP = process.platform !== "win32";
const KILL_GRACE_MS = 2000;

const isText = (value) => typeof value === "string" && value.trim() !== "";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function configArg(key, value) {
  return ["-c", `${key}=${value}`];
}

export function buildPrompt(primitive, params) {
  return [
    primitive.systemPrompt(params),
    "",
    "Runtime boundary:",
    "- Work only inside the current working directory.",
    "- Do not access the network or external services.",
    "- Do not modify configuration, credentials, Git metadata, or parent directories.",
    `- Success requires writing ${primitive.outputContract} as a regular file in this workspace.`,
    "- Validate the artifact locally, then stop without a prose explanation.",
  ].join("\n");
}

// Pure command construction keeps the security boundary reviewable and makes
// the prototype testable without invoking Codex or spending subscription usage.
export function buildSpawnArgs(primitive, params, opts = {}) {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    ...configArg("approval_policy", '"never"'),
    ...configArg("sandbox_mode", '"workspace-write"'),
    ...configArg("sandbox_workspace_write.network_access", "false"),
    ...configArg("web_search", '"disabled"'),
    ...configArg("features.apps", "false"),
    ...configArg("features.hooks", "false"),
    ...configArg("hide_agent_reasoning", "true"),
    ...configArg("model_reasoning_effort", tomlString(opts.effort ?? "high")),
  ];

  const model = opts.model ?? process.env.JARVIS_CODEX_MODEL;
  if (isText(model)) args.push("--model", model);
  args.push("--", opts.prompt ?? buildPrompt(primitive, params));
  return args;
}

// Windows does not execute a shebang-bearing .js fixture as a program. Keeping
// this adapter here also makes local test doubles portable without changing the
// real `codex` invocation.
export function buildCommand(bin, args) {
  return [".js", ".cjs", ".mjs"].includes(extname(bin).toLowerCase())
    ? { command: process.execPath, args: [bin, ...args] }
    : { command: bin, args };
}

function lineSplitter() {
  let carry = "";
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      const parts = (carry + decoder.write(chunk)).split("\n");
      carry = parts.pop() ?? "";
      return parts;
    },
    flush() {
      const last = carry + decoder.end();
      carry = "";
      return last === "" ? [] : [last];
    },
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function freshBuildDir(root) {
  await mkdir(root, { recursive: true });
  const base = timestamp();
  for (let attempt = 1; ; attempt++) {
    const dir = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      await mkdir(dir);
      return dir;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

function safely(onProgress, line) {
  if (typeof onProgress !== "function") return;
  try { onProgress(line); }
  catch { /* the HUD must never take down the build */ }
}

function signalBuild(child, signal) {
  try {
    if (OWN_PROCESS_GROUP && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); }
    catch { /* already gone */ }
  }
}

function closeLog(stream) {
  return new Promise((done) => {
    if (stream.destroyed) return done();
    stream.once("close", done);
    stream.end();
  });
}

// run(primitive, params, onProgress?, opts?)
// Resolves for completed and failed turns. It rejects only when the CLI cannot
// be started, which is an installation problem rather than a build outcome.
export async function run(primitive, params, onProgress, opts = {}) {
  const dir = await freshBuildDir(opts.root ?? join(REPO, "builds"));
  const log = join(dir, "build.log");
  const args = buildSpawnArgs(primitive, params, opts);
  const command = buildCommand(opts.bin ?? "codex", args);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: OWN_PROCESS_GROUP,
    });

    const logStream = createWriteStream(log);
    logStream.on("error", () => {});

    const splitter = lineSplitter();
    let result = null;
    let timedOut = false;
    let exited = false;

    const handleLine = (line) => {
      for (const text of progressLines(line)) safely(onProgress, text);
      result = parseResultEvent(line) ?? result;
    };

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr.on("data", (chunk) => logStream.write(chunk));

    let killTimer = null;
    const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
    const deadline = Number.isFinite(primitive.timeoutMs) && primitive.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          signalBuild(child, "SIGTERM");
          killTimer = setTimeout(() => {
            if (!exited) signalBuild(child, "SIGKILL");
          }, graceMs);
          killTimer.unref();
        }, primitive.timeoutMs)
      : null;

    const clearTimers = () => {
      if (deadline) clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
    };

    let spawnFailed = false;
    child.on("error", (err) => {
      exited = true;
      spawnFailed = true;
      clearTimers();
      closeLog(logStream).then(() => reject(err));
    });

    child.on("close", async (code) => {
      exited = true;
      clearTimers();
      if (spawnFailed) return;

      for (const line of splitter.flush()) handleLine(line);
      await closeLog(logStream);

      const ok = buildSucceeded({ code, dir, outputContract: primitive.outputContract, result });
      resolvePromise({
        ok,
        code,
        dir,
        artifact: ok ? resolve(dir, primitive.outputContract) : null,
        result,
        log: existsSync(log) ? log : null,
        timedOut,
      });
    });
  });
}
