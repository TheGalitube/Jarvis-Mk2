// LAN-only STT gateway for the Whisper.cpp host. It keeps OPENAI_API_KEY on
// this machine, forwards local requests to Whisper.cpp, and uses OpenAI only
// for an explicit per-request Cloud opt-in. No audio is written to disk.
import { createServer } from "node:http";
import { Readable } from "node:stream";

const host = process.env.JARVIS_STT_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.JARVIS_STT_GATEWAY_PORT || 8081);
const localEndpoint = process.env.JARVIS_WHISPERCPP_UPSTREAM || "http://127.0.0.1:8080/inference";
const cloudEnabled = process.env.JARVIS_OPENAI_STT_ENABLED === "true";
const apiKey = process.env.OPENAI_API_KEY || "";
const timeoutMs = Number(process.env.JARVIS_OPENAI_STT_TIMEOUT_MS || 30_000);
const maxAudioSeconds = Number(process.env.JARVIS_OPENAI_STT_MAX_AUDIO_SECONDS || 45);
const maxRequestsPerSession = Number(process.env.JARVIS_OPENAI_STT_MAX_REQUESTS_PER_SESSION || 20);
const maxBytes = 16 * 1024 * 1024;
const sessions = new Map();

function send(res, status, body, headers = {}) { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body); }
function safeSession(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : null; }
async function localHealth() {
  // Jarvis probes the configured endpoint with GET /. Keep the gateway's
  // health result tied to its actual local Whisper.cpp dependency instead of
  // merely reporting that the Node process has a listening socket.
  const response = await fetch(new URL("/", localEndpoint), { signal: AbortSignal.timeout(timeoutMs) });
  return response.ok;
}
function audioSeconds(file) {
  if (file.type !== "audio/wav") return null;
  return file.arrayBuffer().then((data) => {
    const view = new DataView(data); const rate = view.byteLength >= 32 ? view.getUint32(28, true) : 0;
    return rate > 0 && view.byteLength >= 44 ? (view.byteLength - 44) / rate : null;
  });
}
async function forwardLocal(rawBody, contentType, reason) {
  const response = await fetch(localEndpoint, { method: "POST", body: rawBody, headers: { "content-type": contentType }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await response.arrayBuffer(), provider: "whispercpp", fallback: reason };
}
async function transcribeCloud(form) {
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new Error("invalid-audio");
  const seconds = await audioSeconds(file);
  if (seconds !== null && seconds > maxAudioSeconds) throw new Error("audio-duration-limit");
  const request = new FormData();
  request.append("file", file, "jarvis.wav"); request.append("model", "gpt-4o-transcribe"); request.append("language", "de"); request.append("response_format", "json");
  request.append("prompt", "German commands may include English code, file names, extensions and literal paths.");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: request, headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(response.status === 429 ? "quota" : "cloud-request-failed");
  return { status: 200, body: await response.arrayBuffer(), provider: "openai" };
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.split("?")[0] === "/") {
    try { return send(res, (await localHealth()) ? 200 : 503, JSON.stringify({ ok: true, provider: "whispercpp" })); }
    catch { return send(res, 503, JSON.stringify({ ok: false, provider: "whispercpp" })); }
  }
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/inference") return send(res, 404, JSON.stringify({ error: "not-found" }));
  const contentType = req.headers["content-type"];
  const size = Number(req.headers["content-length"] || 0);
  if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data") || !Number.isFinite(size) || size <= 0 || size > maxBytes) return send(res, 413, JSON.stringify({ error: "audio-rejected" }));
  const chunks = []; let received = 0;
  try {
    for await (const chunk of req) { received += chunk.length; if (received > maxBytes) throw new Error("audio-rejected"); chunks.push(chunk); }
    const rawBody = Buffer.concat(chunks);
    const wantsCloud = req.headers["x-jarvis-stt-mode"] === "cloud";
    const session = safeSession(req.headers["x-jarvis-stt-session"]);
    let result;
    if (wantsCloud && cloudEnabled && apiKey && session && (sessions.get(session) || 0) < maxRequestsPerSession) {
      sessions.set(session, (sessions.get(session) || 0) + 1);
      const request = new Request("http://gateway/inference", { method: "POST", headers: { "content-type": contentType }, body: Readable.toWeb(Readable.from(rawBody)), duplex: "half" });
      try { result = await transcribeCloud(await request.formData()); }
      catch (error) { result = await forwardLocal(rawBody, contentType, error?.message || "cloud-request-failed"); }
    } else {
      const reason = wantsCloud ? (!cloudEnabled || !apiKey ? "cloud-disabled" : !session ? "invalid-session" : "session-limit") : undefined;
      result = await forwardLocal(rawBody, contentType, reason);
    }
    res.writeHead(result.status, { "content-type": "application/json", "x-jarvis-stt-provider": result.provider, ...(result.fallback ? { "x-jarvis-stt-fallback": result.fallback } : {}) });
    res.end(Buffer.from(result.body));
  } catch { send(res, 502, JSON.stringify({ error: "gateway-failed" }), { "x-jarvis-stt-provider": "whispercpp" }); }
}).listen(port, host, () => console.log(`JARVIS STT gateway listening on http://${host}:${port}`));
