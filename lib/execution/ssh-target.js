import { ExecutionTarget } from "./target.js";
import { platformCommand, runLocalCommand } from "./local-target.js";

const POSIX_SAFE_SERVICE = /^[a-zA-Z0-9@_.-]+$/;

function positiveMilliseconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sshTarget(host) {
  return `${host.username}@${host.hostname}`;
}

// OpenSSH receives the remote command as one string. Quote every argv member
// for the remote POSIX shell rather than interpolating raw operation input.
export function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function buildSshArgs(host, remoteCommand, { connectTimeoutMs } = {}) {
  if (!host?.hostname || !host?.username) throw new Error("SSH host requires hostname and username");
  if (typeof remoteCommand !== "string" || !remoteCommand) throw new Error("SSH remote command is required");
  const timeoutSeconds = Math.max(1, Math.ceil(positiveMilliseconds(connectTimeoutMs, host.connectTimeoutMs) / 1000));
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSeconds}`, "-p", String(host.port ?? 22)];
  // No StrictHostKeyChecking override is ever added: the user's OpenSSH
  // known_hosts policy remains authoritative and cannot be silently weakened.
  if (host.identityFile) args.push("-i", host.identityFile);
  args.push(sshTarget(host), remoteCommand);
  return args;
}

export function normalizeSshPlatform(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (source.includes("linux")) return "linux";
  if (source.includes("darwin") || source.includes("macos")) return "darwin";
  if (source.includes("windows") || source.includes("microsoft")) return "win32";
  return null;
}

function posixCommand(command, args = []) {
  return [command, ...args].map(quotePosix).join(" ");
}

function commandForPlatform(spec, targetPlatform) {
  if (targetPlatform === "win32") {
    // All current Windows structured arguments are fixed or validated service
    // identifiers, so this command cannot include caller-controlled shell text.
    return [spec.command, ...spec.args].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(" ");
  }
  return posixCommand(spec.command, spec.args);
}

export class SSHTarget extends ExecutionTarget {
  constructor({ id, commandRunner, ...host } = {}) {
    super({ id, type: "ssh", platform: host.platform === "auto" ? "unknown" : host.platform, capabilities: host.capabilities ?? [], enabled: host.enabled ?? true });
    if (!host.hostname || !host.username) throw new Error(`SSH target ${id} requires hostname and username`);
    this.host = { ...host, id };
    this.commandRunner = commandRunner ?? ((args, options) => runLocalCommand("ssh", args, options));
    this.discoveredPlatform = host.platform === "auto" ? null : host.platform;
  }

  async health() {
    const result = await this.#run("exit 0", this.host.connectTimeoutMs);
    return { ok: result.ok, target: this.id, platform: await this.#platformIfHealthy(result), timedOut: result.timedOut, code: result.code };
  }

  async inspect() {
    return { ...await super.inspect(), hostname: this.host.hostname, username: this.host.username, port: this.host.port, platform: await this.detectPlatform() };
  }

  async detectPlatform() {
    if (this.discoveredPlatform) return this.discoveredPlatform;
    const posix = await this.#run("uname -s", this.host.commandTimeoutMs);
    const detected = posix.ok ? normalizeSshPlatform(posix.stdout) : null;
    if (detected) return this.#setPlatform(detected);
    const windows = await this.#run("cmd /d /s /c ver", this.host.commandTimeoutMs);
    const fallback = windows.ok ? normalizeSshPlatform(windows.stdout) : null;
    if (!fallback) throw new Error(`Unable to detect platform for SSH target ${this.id}`);
    return this.#setPlatform(fallback);
  }

  async execute(request) {
    const targetPlatform = await this.detectPlatform();
    if (request.operation === "system.info") {
      const command = targetPlatform === "win32"
        ? "powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress\""
        : "uname -srm; uptime";
      return this.#run(command, request.arguments?.timeoutMs);
    }
    if (request.operation === "process.list" || request.operation === "service.status") {
      const spec = platformCommand(request.operation, targetPlatform, request.arguments?.service);
      return this.#run(commandForPlatform(spec, targetPlatform), request.arguments?.timeoutMs);
    }
    throw new Error(`SSH target ${this.id} does not implement ${request.operation}`);
  }

  async #run(remoteCommand, timeoutMs) {
    const args = buildSshArgs(this.host, remoteCommand, { connectTimeoutMs: this.host.connectTimeoutMs });
    return this.commandRunner(args, { timeoutMs: positiveMilliseconds(timeoutMs, this.host.commandTimeoutMs) });
  }

  async #platformIfHealthy(result) {
    if (!result.ok) return this.platform;
    try { return await this.detectPlatform(); } catch { return this.platform; }
  }

  #setPlatform(value) { this.discoveredPlatform = value; this.platform = value; return value; }
}
