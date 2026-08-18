const API = "https://api.telegram.org";
const MAX_TEXT_LENGTH = 4_000;

function cleanText(value) {
  return String(value ?? "").trim().slice(0, MAX_TEXT_LENGTH);
}

function asChatIds(value) {
  return String(value ?? "").split(",").map((id) => id.trim()).filter((id) => /^-?\d+$/.test(id));
}

// Telegram credentials are deliberately environment-only: runtime config is
// readable by the service account and is often copied alongside deployments.
export function telegramConfig(env = process.env) {
  const token = String(env.JARVIS_TELEGRAM_BOT_TOKEN ?? "").trim();
  const allowedChatIds = asChatIds(env.JARVIS_TELEGRAM_ALLOWED_CHAT_IDS);
  if (token && allowedChatIds.length === 0) {
    throw new Error("JARVIS_TELEGRAM_ALLOWED_CHAT_IDS is required when Telegram is enabled");
  }
  return { enabled: Boolean(token), token, allowedChatIds };
}

export class TelegramBot {
  constructor({ token, allowedChatIds, onText, onApprovalText, onVoice, log = () => {}, fetchImpl = fetch } = {}) {
    this.token = token;
    this.allowed = new Set(allowedChatIds ?? []);
    this.onText = onText; this.onApprovalText = onApprovalText; this.onVoice = onVoice; this.log = log; this.fetch = fetchImpl;
    this.offset = 0; this.stopped = true; this.controller = null; this.queues = new Map();
  }

  async request(method, body) {
    const response = await this.fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(`Telegram ${method} failed`);
    return payload.result;
  }

  async sendMessage(chatId, text) {
    const message = cleanText(text) || "Entschuldigung, sir. Darauf habe ich gerade keine Antwort.";
    return this.request("sendMessage", { chat_id: chatId, text: message });
  }

  async sendTyping(chatId) {
    try { await this.request("sendChatAction", { chat_id: chatId, action: "typing" }); } catch { /* optional UX only */ }
  }

  async downloadVoice(fileId) {
    const file = await this.request("getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("Telegram voice file unavailable");
    const response = await this.fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error("Telegram voice download failed");
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > 20 * 1024 * 1024) throw new Error("Telegram voice file is too large");
    return audio;
  }

  enqueue(chatId, work) {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work).catch((error) => this.log(`telegram message failed: ${error.message}`));
    this.queues.set(chatId, next);
  }

  handle(update) {
    const message = update?.message;
    const chatId = message?.chat?.id;
    if (!Number.isSafeInteger(chatId) || !this.allowed.has(String(chatId))) return;
    const text = cleanText(message.text);
    // Approval replies must bypass the per-chat work queue: the turn which
    // requested approval is intentionally waiting in that queue.
    if (text && this.onApprovalText?.({ chatId: String(chatId), text })) return;
    if (text) this.enqueue(String(chatId), () => this.onText?.({ chatId: String(chatId), text }));
    else if (message.voice?.file_id) this.enqueue(String(chatId), () => this.onVoice?.({ chatId: String(chatId), fileId: message.voice.file_id }));
    else this.enqueue(String(chatId), () => this.sendMessage(String(chatId), "Ich kann Text- und Sprachnachrichten verarbeiten, sir."));
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    while (!this.stopped) {
      try {
        const updates = await this.requestWithSignal("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message"] }, this.controller.signal);
        for (const update of updates) { this.offset = Math.max(this.offset, Number(update.update_id) + 1); this.handle(update); }
      } catch (error) {
        if (!this.stopped) { this.log(`telegram polling error: ${error.message}`); await new Promise((resolve) => setTimeout(resolve, 1_000)); }
      }
    }
  }

  async requestWithSignal(method, body, signal) {
    const response = await this.fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(`Telegram ${method} failed`);
    return payload.result;
  }

  stop() { this.stopped = true; this.controller?.abort(); }
}
