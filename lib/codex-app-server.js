import { spawn } from "node:child_process";
import { classifyApproval } from "./approval-policy.js";

const isObject = (value) => value && typeof value === "object";

export class CodexAppSession {
  constructor({ cwd, bin = "codex", persona = "", onApproval, onEvent, env = process.env } = {}) {
    this.cwd = cwd;
    this.bin = bin;
    this.persona = persona;
    this.onApproval = onApproval;
    this.onEvent = onEvent;
    this.env = env;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = null;
    this.turn = null;
    this.turnReply = "";
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try { return await this.startPromise; }
    catch (error) { this.startPromise = null; throw error; }
  }

  async #start() {
    this.child = spawn(this.bin, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.on("data", (chunk) => this.#emit({ type: "stderr", text: String(chunk) }));
    this.child.on("error", (error) => this.#fail(error));
    this.child.on("close", (code) => {
      if (code !== 0) this.#fail(new Error(`codex app-server exited ${code}`));
    });

    await this.#request("initialize", {
      clientInfo: { name: "jarvis", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    const result = await this.#request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      developerInstructions: this.persona || null,
    });
    this.threadId = result?.thread?.id ?? null;
    if (!this.threadId) throw new Error("Codex app-server returned no thread id");
    return this.threadId;
  }

  async ask(text) {
    await this.start();
    if (this.turn) throw new Error("Codex is already handling a request");
    this.turnReply = "";
    const completed = new Promise((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
    const response = await this.#request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: String(text) }],
    });
    this.turn = response?.turn?.id ?? true;
    return await completed;
  }

  async respondToApproval(decision) {
    if (!this.pendingApproval) return false;
    const { id } = this.pendingApproval;
    this.pendingApproval = null;
    this.#send({ jsonrpc: "2.0", id, result: { decision } });
    return true;
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error("Codex session closed"));
    this.pending.clear();
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  #consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.#emit({ type: "protocol-error", text: "Invalid Codex JSON" }); continue; }
      this.#handle(message);
    }
  }

  #handle(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && typeof message.method === "string") {
      this.#handleServerRequest(message).catch((error) => {
        this.#send({ jsonrpc: "2.0", id: message.id, result: { decision: "cancel" } });
        this.#emit({ type: "approval-error", text: error.message });
      });
      return;
    }

    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta") {
      this.turnReply += String(params.delta ?? "");
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      this.turnReply = String(params.item.text ?? this.turnReply);
    } else if (message.method === "thread/tokenUsage/updated") {
      this.#emit({ type: "usage", usage: params.tokenUsage ?? null });
    } else if (message.method === "turn/completed") {
      const resolve = this.turnResolve;
      this.turn = null;
      this.turnResolve = null;
      this.turnReject = null;
      resolve?.({ reply: this.turnReply.trim(), sessionId: this.threadId });
    } else if (message.method === "error") {
      this.turnReject?.(new Error(String(params.message ?? "Codex error")));
    }
    this.#emit({ type: "event", event: message });
  }

  async #handleServerRequest(message) {
    const classification = classifyApproval(message, this.env);
    if (classification.level === "automatic") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: { decision: "accept" } });
      return;
    }
    this.pendingApproval = { id: message.id, message };
    const decision = await this.onApproval?.(message, classification);
    if (this.pendingApproval) {
      this.pendingApproval = null;
      this.#send({ jsonrpc: "2.0", id: message.id, result: { decision: decision || "cancel" } });
    }
  }

  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #emit(event) {
    try { this.onEvent?.(event); } catch { /* telemetry must not break the agent */ }
  }

  #fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turnReject?.(error);
  }
}
