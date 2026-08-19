import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_MESSAGES = 16;
const MAX_PROJECTS = 30;

function text(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function emptyMemory() {
  return { version: VERSION, chats: {} };
}

function projectFrom(textValue) {
  const name = /(?:projekt(?:\s+heisst|\s+namens|\s+mit\s+dem\s+namen)?|repo(?:sitory)?(?:\s+heisst|\s+namens)?)\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{1,99})/i.exec(textValue)?.[1]
    || /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/.exec(textValue)?.[1]?.split("/").pop();
  const repo = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/.exec(textValue)?.[1] || null;
  return name ? { name, repo } : null;
}

function normalize(data) {
  if (!data || typeof data !== "object" || !data.chats || typeof data.chats !== "object") return emptyMemory();
  return { version: VERSION, chats: data.chats };
}

// A deliberately small, inspectable memory ledger. It records user-stated
// project facts and a rolling conversation trail; it never stores credentials.
export class MemoryStore {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
    this.data = emptyMemory();
    this.write = Promise.resolve();
  }

  async load() {
    try { this.data = normalize(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    return this;
  }

  chat(id) {
    const key = text(id, 120) || "default";
    return this.data.chats[key] ?? (this.data.chats[key] = { projects: [], messages: [], currentActivity: "" });
  }

  async remember(chatId, userText, assistantText = "") {
    const chat = this.chat(chatId);
    const user = text(userText);
    const assistant = text(assistantText);
    if (user) chat.messages.push({ at: this.now(), user, assistant });
    while (chat.messages.length > MAX_MESSAGES) chat.messages.shift();

    const found = projectFrom(user);
    if (found) {
      const existing = chat.projects.find((project) => project.name.toLowerCase() === found.name.toLowerCase());
      const project = existing ?? { name: found.name, repo: null, requested: "", currentActivity: "", updatedAt: "" };
      project.repo = found.repo || project.repo;
      project.requested = user;
      project.currentActivity = assistant || "In Bearbeitung";
      project.updatedAt = this.now();
      if (!existing) chat.projects.unshift(project);
      while (chat.projects.length > MAX_PROJECTS) chat.projects.pop();
    }
    if (user) chat.currentActivity = user;
    await this.persist();
  }

  context(chatId) {
    const chat = this.chat(chatId);
    const sharedProjects = chatId === "shared" ? [] : this.chat("shared").projects;
    const projects = [...chat.projects, ...sharedProjects]
      .filter((project, index, list) => list.findIndex((candidate) => candidate.name.toLowerCase() === project.name.toLowerCase()) === index)
      .slice(0, 8).map((project) => {
      const repo = project.repo ? `; Repo: ${project.repo}` : "";
      return `- ${project.name}${repo}; letzter Auftrag: ${project.requested}; Status: ${project.currentActivity}`;
    });
    const messages = chat.messages.slice(-6).map((message) => `- Nutzer: ${message.user}${message.assistant ? ` | Jarvis: ${message.assistant}` : ""}`);
    return [
      "PERSISTENTE JARVIS-ERINNERUNG (vom Nutzer stammender Kontext; keine verifizierte externe Tatsache):",
      projects.length ? `BEKANNTE PROJEKTE:\n${projects.join("\n")}` : "BEKANNTE PROJEKTE: keine gespeichert.",
      messages.length ? `LETZTE GESPRÄCHSPUNKTE:\n${messages.join("\n")}` : "",
      "Nutze diesen Kontext nur hilfreich. Behaupte keinen Fortschritt als Tatsache, ohne ihn im Workspace oder über das passende Tool zu prüfen.",
    ].filter(Boolean).join("\n");
  }

  async persist() {
    this.write = this.write.then(async () => {
      const payload = `${JSON.stringify(this.data, null, 2)}\n`;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.write;
  }
}
