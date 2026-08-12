import { spawn } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem, uptime } from "node:os";
import { delimiter, resolve, sep } from "node:path";
import { ExecutionTarget } from "./target.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const SERVICE_NAME = /^[a-zA-Z0-9@_.-]+$/;

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function collect(stream, limit = MAX_OUTPUT_BYTES) {
  let output = "";
  let truncated = false;
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    const remaining = limit - Buffer.byteLength(output);
    if (remaining <= 0) { truncated = true; return; }
    const value = String(chunk);
    output += value.slice(0, remaining);
    if (Buffer.byteLength(value) > remaining) truncated = true;
  });
  return { read: () => ({ output, truncated }) };
}

// Commands are always executable plus argv, never a shell expression. This is
// intentionally reusable by SSH later, where string interpolation is equally
// unsafe.
export function runLocalCommand(command, args = [], { timeoutMs, spawnImpl = spawn } = {}) {
  text(command, "command");
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("command arguments must be an array of strings");
  }
  const timeout = boundedTimeout(timeoutMs);
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const out = stdout.read();
      const err = stderr.read();
      resolvePromise({ ok: !timedOut && code === 0, code, signal, timedOut, stdout: out.output, stderr: err.output, truncated: out.truncated || err.truncated });
    });
  });
}

export function platformCommand(operation, targetPlatform = process.platform, service) {
  if (operation === "process.list") {
    if (targetPlatform === "win32") return { command: "tasklist.exe", args: ["/FO", "CSV", "/NH"] };
    return { command: "ps", args: ["-axo", "pid=,comm=,rss="] };
  }
  if (operation === "service.status") {
    if (!SERVICE_NAME.test(text(service, "service"))) throw new Error("service contains unsupported characters");
    if (targetPlatform === "win32") return { command: "sc.exe", args: ["query", service] };
    if (targetPlatform === "darwin") return { command: "launchctl", args: ["print", `system/${service}`] };
    return { command: "systemctl", args: ["show", service, "--no-page", "--property", "LoadState,ActiveState,SubState"] };
  }
  throw new Error(`No platform command for ${operation}`);
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export class LocalTarget extends ExecutionTarget {
  constructor({ enabled = false, safeRoots = [], shellEnabled = false, platform: targetPlatform = process.platform, commandRunner = runLocalCommand } = {}) {
    super({ id: "local", type: "local", platform: targetPlatform, enabled, capabilities: ["system-info", "filesystem-read", "process-list", "service-control", "shell"] });
    if (!Array.isArray(safeRoots) || !safeRoots.every((path) => typeof path === "string" && path.trim())) {
      throw new Error("LocalTarget safeRoots must be an array of non-empty paths");
    }
    this.safeRoots = safeRoots.map((path) => resolve(path));
    this.shellEnabled = shellEnabled;
    this.commandRunner = commandRunner;
  }

  async health() {
    return { ok: this.enabled, target: this.id, platform: this.platform, shellEnabled: this.shellEnabled };
  }

  async inspect() {
    return { ...await super.inspect(), safeRoots: [...this.safeRoots], shellEnabled: this.shellEnabled };
  }

  async execute(request) {
    switch (request.operation) {
      case "system.info": return this.#systemInfo();
      case "filesystem.list": return this.#list(request.arguments ?? {});
      case "process.list": return this.#command("process.list", request.arguments ?? {});
      case "service.status": return this.#command("service.status", request.arguments ?? {});
      case "shell.execute": return this.#shell(request.arguments ?? {});
      default: throw new Error(`Local target does not implement ${request.operation}`);
    }
  }

  #systemInfo() {
    return {
      platform: this.platform,
      runtimePlatform: platform(),
      release: release(), arch: arch(), hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
      uptimeSeconds: Math.floor(uptime()), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), cpuCount: cpus().length,
      homeDirectory: homedir(), pathDelimiter: delimiter,
    };
  }

  async #list({ path }) {
    const directory = await this.#safeDirectory(path);
    const entries = await readdir(directory, { withFileTypes: true });
    return {
      path: directory,
      truncated: entries.length > MAX_LIST_ENTRIES,
      entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })),
    };
  }

  async #safeDirectory(path) {
    const requested = text(path, "path");
    const directory = await realpath(resolve(requested));
    const roots = await Promise.all(this.safeRoots.map(async (root) => realpath(root).catch(() => null)));
    if (!roots.some((root) => root && inside(root, directory))) throw new Error("Path is outside LocalTarget safe roots");
    return directory;
  }

  async #command(operation, args) {
    const spec = platformCommand(operation, this.platform, args.service);
    return this.commandRunner(spec.command, spec.args, { timeoutMs: args.timeoutMs });
  }

  async #shell({ command, args = [], timeoutMs }) {
    if (!this.shellEnabled) throw new Error("Local shell execution is disabled");
    return this.commandRunner(command, args, { timeoutMs });
  }
}
