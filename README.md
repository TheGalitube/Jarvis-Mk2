# jarvis-demo — Codex prototype

Talk to Codex out loud. Hold a key, speak, release — Chrome transcribes the
sentence, a local Node server sends it to Codex, and the reply comes back through
Fish Audio or OpenAI TTS while an on-screen orb reacts. Fish is preferred by
default; OpenAI automatically takes over when both are configured and Fish is
unavailable.

Ask it to build a landing page and it starts a second, sandboxed Codex turn in a
fresh folder, streams progress to the HUD, verifies the output contract, and
opens the finished artifact.

```text
Chrome mic → Web Speech API → WebSocket → Node server
  → codex exec --json       conversation (read-only, resumable)
  → codex exec --json       build (workspace-write, fresh folder)
  → Fish/OpenAI TTS         voice with automatic fallback
  → canvas orb + build HUD
```

This branch is a working migration prototype of the original Claude Code demo.
It uses the Codex CLI directly, so it keeps the app framework-free with one npm
dependency (`ws`).

## Mk2 Phase 1

The first Mk2 foundation is now in place: structured operation registration,
per-operation target resolution, deterministic target-aware policy decisions,
execution audit events, and a `SandboxTarget` that routes the existing focused
builder without weakening its Codex sandbox. The safe default remains
`sandbox-only`; local and SSH execution are not implemented or enabled yet.

See [the architecture audit and Phase 1 design](docs/MK2_PHASE1.md) for the
current boundary, configuration, migration gaps, and planned Local/SSH/STT work.

Phase 2 adds a disabled-by-default `LocalTarget` for structured system info,
safe-root directory listings, process listing, service status, and explicitly
opt-in shell execution. It never invokes a shell interpreter; see the Mk2
architecture document for the required secure configuration.

Phase 3 adds multiple opt-in SSH targets through the system OpenSSH client.
Host-key verification is left enabled, credentials are referenced rather than
stored, and current remote capabilities are limited to structured inspection.

Phase 4 provides validated runtime configuration for execution targets, voice
mode, wake phrases, Chrome language, OpenAI transcription, and optional
Nemotron ASR. Defaults remain safe: sandbox-only, Push-to-Talk,
`gpt-4o-transcribe`, no local execution, and no remote hosts. See the
architecture document for the JSON schema and environment overrides.

Phase 5 separates Chrome speech recognition from the UI into a normalized STT
provider and manager. Push-to-Talk remains the default and preserves interim
captions, Space-key operation, recoverable-error restart, and fatal-permission
handling.

Phase 7 adds a provider-neutral VoiceController and PCM16 microphone capture.
When Nemotron is configured, audio is relayed only through the JARVIS server;
the browser never learns or selects the NIM endpoint. Push-to-Talk remains
available in every configuration.

Phase 8 completes Voice Activation. Set `JARVIS_VOICE_MODE=voice-activation`
or configure `voice.mode` accordingly; Jarvis then listens for the configured
wake phrases, collects the latest command until the silence timeout, and sends
one normal conversation turn. Approval prompts bypass the wake phrase while
still using the same timeout. Push-to-Talk (button or Space) temporarily takes
precedence over activation listening. Both Chrome and the server-selected
Nemotron path use the same controller.

Phase 9 provides an unprivileged Docker runtime. It has no Docker socket, host
root mount, or privileged mode; remote control continues through explicit SSH
targets only. See [Docker deployment](#docker-deployment).

Phase 10 adds the runtime console (⌘ button): it displays current voice/STT
configuration, allows choosing the persisted OpenAI transcription model, and
shows redacted logical target capabilities, explicit health checks, approval
controls, and the in-memory execution audit trail. It cannot change security
profiles, target configuration, or credentials.

## Requirements

- Chrome — speech recognition uses Chrome's Web Speech API and needs internet.
- Node.js 20 or newer.
- [Codex CLI](https://learn.chatgpt.com/docs/developer-commands#codex-exec), installed and signed in.
- A Fish Audio or OpenAI API key for voice output. With neither, Jarvis still
  runs in text-only mode.
- macOS or Linux. Windows process-tree cancellation still needs follow-up work.

Codex supports ChatGPT sign-in for subscription access, so this local prototype
does not require a separate OpenAI API key when `codex login` uses your ChatGPT
account. OpenAI TTS is a separate API product and does require `OPENAI_API_KEY`
when enabled.

## 1. Configure TTS

### Fish Audio

```bash
mkdir -p ~/.config/fish-audio
```

Create `~/.config/fish-audio/speak.json`:

```json
{
  "apiKey": "YOUR-FISH-KEY-HERE",
  "voiceId": "e13fa398a7f445a685316a3de6089ce7",
  "model": "s2.1-pro-free",
  "format": "mp3",
  "speed": 1.1
}
```

### OpenAI fallback

Set an OpenAI Platform API key in the server environment:

```bash
export OPENAI_API_KEY="YOUR-OPENAI-API-KEY"
```

The defaults use `gpt-4o-mini-tts`, the `cedar` voice, MP3 output, and a short
JARVIS-style delivery instruction. Override them when needed:

```bash
export OPENAI_TTS_MODEL="gpt-4o-mini-tts"
export OPENAI_TTS_VOICE="cedar"
export OPENAI_TTS_FORMAT="mp3"
export OPENAI_TTS_INSTRUCTIONS="Speak as a calm, precise British AI butler."
```

Provider selection is controlled with `JARVIS_TTS_PROVIDER`:

| Value | Behavior |
|---|---|
| `auto` | Fish first, then OpenAI; this is the default |
| `fish` | Fish first, then OpenAI if configured |
| `openai` | OpenAI first, then Fish if configured |
| `off` | Text-only mode |

Each provider gets 15 seconds before fallback. Set
`JARVIS_TTS_TIMEOUT_MS` to change that ceiling. A missing config file, expired
key, or provider outage never stops Codex chat or builds: Jarvis falls back to
the next provider, then to captions only.

## 2. Verify Codex

```bash
codex login
codex login status
codex exec --json --sandbox read-only --skip-git-repo-check "Reply with: ready"
```

The app runs Codex with JSONL output, no interactive approvals, disabled web
search, and user configuration ignored. Authentication is still read from the
normal Codex credential store.

### Full agent mode (optional)

To let Jarvis use the broader Codex CLI toolset, start the app-server mode
explicitly:

```bash
JARVIS_AGENT_MODE=full npm start
```

This keeps a persistent Codex app-server session per browser tab. Ordinary
local actions are approved automatically so Jarvis can work continuously. The
server pauses and asks you by voice before GitHub/remote Git commands,
publishing, destructive deletion, system-level changes, or other configured
critical actions. Say `approve` or `deny`; approvals are not persisted to a
future session automatically.

Add your own always-confirm patterns as a comma-separated regular-expression
list:

```bash
JARVIS_CRITICAL_COMMANDS='calendar-send,deploy-prod' JARVIS_AGENT_MODE=full npm start
```

Full mode loads the Codex user's configured MCP servers and tools. Review those
settings before enabling it on a network-accessible machine. GitHub still
requires valid `gh` authentication for the same OS user that runs Jarvis:

```bash
gh auth status
```

By default the app uses Codex's current built-in default model. Pin one
explicitly only when you need reproducible behavior:

```bash
export JARVIS_CODEX_MODEL=gpt-5.6-sol
```

## 3. Run the app

```bash
npm install
npm start
```

Open [http://localhost:3210](http://localhost:3210) in Chrome, allow the
microphone, hold Space, speak, and release.

Try:

- “What's the weather like on Mars?”
- “Build me a landing page for a coffee shop called Ember.”

The first request starts a persisted Codex thread. Later voice turns resume its
thread ID for as long as that browser tab remains connected.

## Docker deployment

Docker is an isolation boundary, not a shortcut to host control. Create the
operator-owned directories once, copy your existing Codex login into
`.docker/codex`, and place optional SSH configuration (including `known_hosts`)
in `.docker/ssh`. Do not place private credentials in the image or Compose file.

```bash
mkdir -p data .docker/codex .docker/ssh
docker compose up --build
```

The Compose file publishes only `127.0.0.1:3210` by default. For LAN, Tailscale,
or reverse-proxy access, change the published address deliberately and keep the
existing Host/Origin allow-list restrictions configured. `data/runtime-config.json`
is the persistent Mk2 runtime configuration; it can enable only the intended
SSH targets. The optional SSH volume is read-only. No `--privileged`, Docker
socket, or host-root volume is used.

## Linux systemd deployment

For a Raspberry Pi or other Linux server, use the supplied
`deploy/systemd/jarvis.service` unit with a dedicated `jarvis` account. Keep
the repository at `/opt/jarvis`, run `codex login` as that account, and create
the protected environment file from `deploy/systemd/jarvis.env.example`.

```bash
sudo useradd --create-home --shell /bin/bash jarvis
sudo install -d -o jarvis -g jarvis /opt/jarvis /etc/jarvis
# For an existing root-owned checkout on the Pi, migrate it once:
sudo mv /root/Jarvis-Mk2 /opt/jarvis
sudo chown -R jarvis:jarvis /opt/jarvis
# Or clone the repository as the dedicated account into /opt/jarvis.
sudo -u jarvis npm --prefix /opt/jarvis ci
sudo cp /opt/jarvis/deploy/systemd/jarvis.service /etc/systemd/system/jarvis.service
sudo cp /opt/jarvis/deploy/systemd/jarvis.env.example /etc/jarvis/jarvis.env
sudo chmod 600 /etc/jarvis/jarvis.env
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis
```

Edit `/etc/jarvis/jarvis.env` to add the real, rotated `OPENAI_API_KEY` and
your MagicDNS name. Verify with `sudo systemctl status jarvis` and follow logs
with `sudo journalctl -u jarvis -f`.

To deploy an already-pushed Git commit without rebuilding the machine:

```bash
sudo -u jarvis git -C /opt/jarvis pull --ff-only
sudo -u jarvis npm --prefix /opt/jarvis ci
sudo systemctl restart jarvis
```

`npm ci` is safe to run every update; it only changes installed dependencies
when `package-lock.json` requires it. `git pull --ff-only` refuses divergent
server-side edits instead of silently merging them.

## Personalize it

- `lib/brain.js` → `VOICE`: personality, spoken-response length, and identity.
- `~/.config/fish-audio/speak.json`: Fish voice, speed, model, and optional
  non-secret OpenAI defaults.
- TTS environment variables: provider order, OpenAI voice, output format, and
  delivery instruction.
- `primitives/*.mjs`: build types, questions, prompts, timeouts, and output
  contracts.

## Hotkeys

| Key | Action |
|---|---|
| Space (hold) | Push to talk |
| `d` | Toggle diagnostics |
| `t` | Toggle captions |
| `h` | Toggle the surrounding interface |

## Architecture

- `server.js`: static server, WebSocket protocol, conversation state, TTS, and
  build dispatch.
- `lib/brain.js`: builds the JARVIS persona, starts/resumes `codex exec`
  conversations, and extracts the last `agent_message` from JSONL.
- `lib/config.js` and `lib/tts.js`: discover configured TTS providers, construct
  provider-specific requests, enforce timeouts, and fall back safely.
- `lib/builder.js`: creates a fresh build directory, starts a locked-down Codex
  process, streams JSONL, enforces the timeout, and preserves `build.log`.
- `lib/progress.js`: maps Codex `file_change`, `command_execution`,
  `mcp_tool_call`, and `web_search` items to short HUD lines.
- `lib/outcome.js`: combines the process exit, terminal Codex event, and output
  contract into a build result.
- `lib/registry.js` and `primitives/`: auto-discovered build definitions.
- `lib/action.js`: parses and removes the private `[ACTION:BUILD ...]` tag before
  speech synthesis.

Tests are pure local tests and do not call Codex, Fish Audio, OpenAI, or the
network:

```bash
npm test
```

## Build security boundary

Every build gets a new `builds/<timestamp>/` working directory. Codex starts
with these effective restrictions:

- `sandbox_mode="workspace-write"`
- `approval_policy="never"`
- command-network access disabled
- web search disabled
- user config and exec rules ignored
- apps and hooks disabled
- no additional writable directories

The Codex sandbox enforces the write boundary. It replaces the Claude-specific
tool allowlist and path-deny settings from the original demo. The build prompt
also states the boundary, but the prompt is guidance — the sandbox is the
enforcement layer.

Finished model-written HTML is still served with `Content-Security-Policy:
sandbox allow-scripts`, so its scripts cannot connect back to the control socket
or read other builds through the app origin.

The server binds to all interfaces by default (`0.0.0.0`) so it can be opened from
another LAN or Tailscale device. At startup it discovers the machine's IPv4
addresses and allows those addresses for HTTP and WebSocket Origin checks. This
means `192.168.1.75:3210` and a running Tailscale address such as
`100.111.0.8:3210` work without putting either address in the repository.

To bind to one interface only, set `JARVIS_BIND_HOST`:

```bash
JARVIS_BIND_HOST=100.111.0.8 npm start
```

To allow a Tailscale MagicDNS name or another stable hostname, add a comma-
separated list with `JARVIS_ALLOWED_HOSTS`:

```bash
JARVIS_ALLOWED_HOSTS=jarvis.example.ts.net npm start
```

Because this process starts a coding agent with file-writing tools, use a
Tailscale ACL/firewall and do not forward port 3210 directly to the public
internet.

## Add a build primitive

```bash
cp primitives/_template.mjs primitives/readme-writer.mjs
```

Set the new file's `id` to its filename, define its trigger phrases, questions,
prompt, output contract, completion line, and timeout, then restart the server.
The registry automatically adds it to the assistant's advertised capabilities.

`allowedTools` and `mcp` remain in the primitive shape for compatibility with
the upstream demo, but this Codex prototype intentionally ignores both. All
builds currently receive the same central workspace-only, network-off policy.
A future production version should replace those fields with an explicit,
validated Codex capability policy before enabling per-primitive MCP access.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `spawn codex ENOENT` | Start the server from a shell where `command -v codex` works. |
| `codex exited 1` with an auth error | Run `codex login` and then `codex login status`. |
| Model access error | Unset `JARVIS_CODEX_MODEL` to use the CLI default, or choose a model available to your account. |
| Fish Audio `402` / `403` | Add credits or select a Fish model covered by your account. |
| OpenAI TTS `401` / `429` | Check `OPENAI_API_KEY`, API billing, and project limits. Fish or text-only fallback remains available. |
| Jarvis starts with `tts: off (text only)` | Configure `FISH_API_KEY`, a Fish config file, or `OPENAI_API_KEY`. |
| No microphone prompt | Enable Chrome under system microphone permissions. |
| `stt error: network` | Chrome speech recognition needs internet access. |
| Build timed out | Increase the primitive's `timeoutMs` or request a smaller artifact. |
| Build finished without its artifact | Inspect the generated `build.log` path shown by the UI. |
| Port `3210` already in use | Stop the previous server process or set a different `PORT`. |

## Prototype limitations

- The model-written action tag is kept for migration compatibility. Structured
  output would be a good next hardening step.
- Per-primitive MCP and tool grants are intentionally disabled.
- The automated tests validate command construction and event handling with fake
  CLIs; a real Codex smoke test spends subscription usage and is opt-in.
- `codex exec` loads the full coding-agent runtime even for short voice replies,
  so latency and subscription usage are higher than with a purpose-built chat or
  realtime API.
- TTS providers may stream their HTTP responses, but this prototype currently
  sends one complete audio clip to the browser per utterance.
- Windows can run the app, but POSIX process-group timeout behavior has not been
  ported to native Windows yet.

## License

MIT
