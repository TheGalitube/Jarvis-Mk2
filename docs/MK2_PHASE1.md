# JARVIS Mk2: audit and Phase 1

## Current architecture audit

The server is a small Node 20 ESM HTTP/WebSocket runtime. `server.js` owns the
socket protocol, per-tab conversation and approval state, speech replies,
static artifact delivery, and build dispatch. `lib/brain.js` supplies either a
read-only resumable `codex exec` chat or, in opt-in full-agent mode, a persistent
Codex app-server session (`lib/codex-app-server.js`).

The focused builder is already a strong, reusable boundary: each build has a
fresh directory, `workspace-write` is limited to that directory, network/search,
apps, hooks, user config and interactive approvals are disabled, and a result
requires both a successful Codex turn and the promised artifact. `registry`,
`action`, `outcome`, and `progress` are likewise reusable as-is. Fish/OpenAI
TTS fallback, the WebSocket protocol, browser orb/HUD, captions, diagnostics,
host/origin checks, Chrome Push-to-Talk STT, and voice approval handling remain
unchanged in Phase 1.

The principal couplings to refactor later are `server.js` owning several runtime
concerns and `public/app.js` owning microphone, Chrome recognition, visibility
keys, state and rendering. Full-agent Codex approvals are currently command
classification rather than structured target operations. This is a documented
migration gap, not a new host-access path.

Current security boundaries are the Codex sandbox, artifact path/CSP containment,
Host and Origin validation, disabled build-network access, and confirmation for
classified full-agent commands. Mk2 adds an independent deterministic operation
policy before a target can execute. Codex may supply intent, but it does not
choose whether policy permits it.

Cross-platform risks found: POSIX process groups/signals are already conditional
in the builder, but Windows does not execute shebang-only JavaScript files. The
builder now invokes `.js`, `.cjs`, and `.mjs` test adapters through Node. Later
LocalTarget work must avoid assuming Bash, `/tmp`, `systemd`, POSIX signals or
path separators. Browser OS remains intentionally independent of runtime OS.

## Phase 1 architecture

```text
request -> OperationRegistry -> TargetResolver -> PolicyEngine
        -> optional approval -> ExecutionTarget -> normalized result
                                 -> EventBus audit events
```

`OperationRegistry` defines structured operations and required capabilities.
`TargetResolver` uses an explicitly requested target without substitution; for
implicit requests it first uses an operation's preferred targets, then only the
configured default target. This gives sandbox-compatible work priority over a
broader target. `ExecutionManager` validates, evaluates policy, checks target
health and emits structured success/failure events.

The only live target in Phase 1 is `SandboxTarget`; it delegates artifact builds
to the unchanged builder. There is no LocalTarget or SSHTarget implementation
yet, hence no new host or remote execution capability. Defaults are
`sandbox-only`, enabled sandbox, disabled local target, and no hosts.

Runtime configuration is intentionally JSON-only in this phase to avoid adding a
YAML parser to the trusted startup path. Set `JARVIS_CONFIG_FILE` to a JSON file,
or use `JARVIS_SECURITY_PROFILE` and `JARVIS_DEFAULT_TARGET`. Invalid security
profiles and malformed target enablement fail closed at startup.

## Flows and migration plan

- Normal chat stays Browser -> WebSocket -> Codex -> TTS/captions. Persistent
  app-server sessions remain available in full-agent mode.
- Sandbox build is Browser -> Codex build tag -> `artifact.build` -> resolver
  selects `sandbox` -> policy allows -> existing sandboxed builder.
- Local and SSH flows are intentionally pending: Phase 2 will add a restricted,
  platform-adapted LocalTarget; Phase 3 will add host-key-verifying SSHTargets.
  Both will use the same manager and target-aware policy.
- Nemotron, Chrome STT fallback, voice activation and Docker are not implemented
  in Phase 1. Chrome Push-to-Talk remains the active STT path. Future STT
  providers will normalize events behind a browser voice controller, and Docker
  should run the runtime without privileged host mounts.

Required later tests include LocalTarget command/path/timeout behavior on all
platforms, SSH host configuration and host-key/timeouts, target-aware protected
paths, approval UX integration, fake Nemotron health/fallback events, voice state
transitions, and Docker isolation. Existing network, sandbox and browser STT
tests remain regression coverage.

## Phase 2: LocalTarget

Phase 2 adds `LocalTarget` for the host on which the JARVIS runtime runs. It
implements `system.info`, `filesystem.list`, `process.list`, `service.status`,
and `shell.execute`. `system.info` uses Node's OS APIs. Process and service
status use fixed platform command adapters: `ps`/`systemctl` on Linux,
`launchctl` on macOS, and `tasklist.exe`/`sc.exe` on Windows. Commands are
spawned with `shell: false`, an executable and a string argv array, bounded
output, and a capped timeout.

Local execution remains disabled by default. To enable the target deliberately,
use an explicit JSON configuration such as:

```json
{
  "execution": { "securityProfile": "standard", "defaultTarget": "local" },
  "targets": {
    "local": {
      "enabled": true,
      "safeRoots": ["C:/Users/max/projects"],
      "shellEnabled": false
    }
  }
}
```

Set `JARVIS_CONFIG_FILE` to that file. `filesystem.list` rejects any resolved
path outside `safeRoots`, including a symlink resolving outside them. Shell
execution is unavailable until `shellEnabled` is true and remains a high-risk
operation requiring the ExecutionManager approval path. Local operations are
not yet offered as free-form Codex shell access; the next integration step must
map intentional agent requests to structured operations and the existing voice
approval UX.

## Phase 3: SSH targets

Phase 3 adds `SSHTarget` using the user's installed OpenSSH client rather than
embedding credentials or a second SSH stack. Each configured host becomes an
independent logical target; several hosts coexist with sandbox and local
targets. Supported structured remote operations are `system.info`,
`process.list`, and `service.status`. Health checks, connection timeouts,
command timeouts, platform detection, and normalized command results are part
of the target contract.

OpenSSH runs with `BatchMode=yes` and a bounded `ConnectTimeout`. JARVIS does
not add a `StrictHostKeyChecking` override, so the normal user/system
`known_hosts` policy remains in force. Authentication uses ssh-agent or an
`identityFile` reference; key contents, passwords, and tokens are never read
from configuration or logged.

```json
{
  "execution": { "securityProfile": "standard" },
  "hosts": {
    "minecraft": {
      "type": "ssh",
      "hostname": "192.168.1.30",
      "username": "jarvis",
      "identityFile": "C:/Users/max/.ssh/jarvis_ed25519",
      "platform": "auto",
      "connectTimeoutMs": 5000,
      "commandTimeoutMs": 10000
    },
    "macbook": {
      "type": "ssh",
      "hostname": "macbook.local",
      "username": "max",
      "platform": "darwin"
    }
  }
}
```

`platform: "auto"` probes `uname -s` and falls back to Windows detection;
setting the known platform avoids that probe. Host names, user names, ports,
capabilities and timeouts are validated at startup. Existing policy still
rejects non-sandbox targets under `sandbox-only`, and high-risk operations on
SSH targets require confirmation. Remote free-form shell execution and remote
write operations are intentionally not implemented yet.

## Phase 4: runtime configuration

The central JSON configuration now covers security profile, default target,
target enablement, local Safe Roots, SSH hosts, voice mode, wake phrases,
silence timeout, STT provider, Chrome language, and optional Nemotron endpoint
and timeout. The merge order is defaults, `JARVIS_CONFIG_FILE`, environment
overrides, then explicitly supplied programmatic overrides. Invalid or unsafe
values abort startup rather than being coerced.

```json
{
  "voice": {
    "mode": "voice-activation",
    "wakeWords": ["jarvis", "hey jarvis"],
    "silenceTimeoutMs": 1400
  },
  "stt": {
    "provider": "auto",
    "chrome": { "enabled": true, "language": "de-DE" },
    "nemotron": {
      "endpoint": "http://asr.internal:9000",
      "language": "auto",
      "timeoutMs": 5000
    }
  }
}
```

Supported environment overrides are `JARVIS_SECURITY_PROFILE`,
`JARVIS_DEFAULT_TARGET`, `JARVIS_VOICE_MODE`, `JARVIS_WAKE_WORDS`,
`JARVIS_SILENCE_TIMEOUT_MS`, `JARVIS_STT_PROVIDER`,
`JARVIS_CHROME_STT_LANGUAGE`, `JARVIS_CHROME_STT_ENABLED`,
`JARVIS_NEMOTRON_ENDPOINT`, `JARVIS_NEMOTRON_LANGUAGE`, and
`JARVIS_NEMOTRON_TIMEOUT_MS`.

On WebSocket connection, the server publishes a deliberately redacted runtime
configuration event for a future settings view. It contains voice/STT display
state only; SSH identities and hosts, TTS credentials, and the Nemotron endpoint
are omitted. The browser cannot choose an arbitrary ASR endpoint.

## Phase 5: Chrome STT provider

Chrome's Web Speech API has been extracted from `public/app.js` into
`public/stt/chrome-speech-provider.js`. It normalizes browser-specific callbacks
into provider-neutral events: `stt.started`, `stt.partial`, `stt.final`,
`stt.resumed`, `stt.error`, and `stt.unavailable`. `public/stt/manager.js` is
the narrow lifecycle seam (`start`, `stop`, `setLanguage`) that Phase 6 will use
to select an additional provider.

The application remains responsible for Push-to-Talk input, captions, visual
state, and WebSocket dispatch. Existing behavior is retained: Chrome receives
continuous/interim recognition, partial text appears in the caption, an end
while the button is held resumes recognition, and release sends the final text.
Fatal microphone permission failures discard a partial transcript rather than
submitting it. The server-provided Chrome language setting is applied without
exposing any Nemotron endpoint to the browser.

## Phase 6: Nemotron ASR Streaming

`lib/stt/nemotron.js` implements the server-side Nemotron Streaming adapter.
It checks `/v1/health`, opens the documented realtime WebSocket session, sends
PCM16 base64 chunks, and normalizes NIM delta, completed, failed, disconnect,
and transport-error messages into the same partial/final/error STT event model.
It enables automatic punctuation and supports a specific language or `auto`.

The optional endpoint must identify the NIM HTTP/realtime service, normally
`http://host:9000` (not the gRPC port). The adapter keeps it server-side and
does not publish it to the browser. It lazy-loads the declared WebSocket client
only when a real NIM session is used, keeping zero-config operation dependency
free at test time.

`lib/stt/provider-selection.js` implements deterministic selection:

- `chrome` uses Chrome directly.
- `auto` uses a configured, healthy Nemotron service; otherwise Chrome.
- `nemotron` also falls back to Chrome by default when temporarily unhealthy.
- `stt.fallbackToChrome: false` makes an unavailable explicit Nemotron provider
  fail clearly instead of silently substituting it.

The Phase 7 microphone controller will feed captured PCM16 frames into this
adapter. Until then the existing Chrome Push-to-Talk route remains live, so an
ASR configuration alone cannot disrupt current voice operation.

## Phase 7: voice controller and microphone capture

`public/voice/` now separates voice state, microphone capture, and provider
coordination from rendering. `MicrophoneCapture` obtains a mono browser stream,
converts samples to PCM16 base64, and releases tracks and audio resources on
stop. `VoiceController` preserves Push-to-Talk and Space-key behavior, but can
ask the server to select STT before starting a configured Nemotron path.

The browser sends only `stt.start`, PCM16 chunks, and `stt.stop` on its existing
authenticated-origin WebSocket. It never supplies an ASR URL. The server health
checks and selects Nemotron or Chrome, relays normalized events, and closes a
NIM session when the browser disconnects. A mid-stream Nemotron failure moves
the held turn to Chrome when fallback is enabled. `VoiceStateMachine` makes
capture unavailable while Jarvis is thinking, speaking, or building, while
leaving approval input available.

## Phase 8: Voice Activation

`WakeWordController` is now part of the live `VoiceController` path rather
than a UI-only helper. In `voice-activation` mode it arms the selected STT
provider, waits for a configured wake phrase, collects the latest normalized
partial transcript until the configured silence timeout, then emits exactly one
`voice.command` to the existing conversation WebSocket flow. A wake phrase
without a command simply rearms. While an approval is pending, activation
listening accepts `approve`/`deny` without requiring a wake phrase.

Push-to-Talk always remains usable. Pressing the button or Space disarms the
continuous session, suppresses its trailing provider final, and begins the
held utterance normally. When Jarvis returns to idle or approval state, voice
activation re-arms. The controller shares the Chrome and server-selected
Nemotron capture paths, including the established Nemotron-to-Chrome fallback.

## Phase 9: Docker runtime

`Dockerfile`, `.dockerignore`, and `docker-compose.yml` add a Node 20 runtime
image with OpenSSH client and Codex CLI. It runs as the unprivileged `node`
user, exposes only port 3210, and includes a same-container `/healthz` check.
Compose persists runtime configuration and operator-supplied Codex state, and
optionally mounts SSH configuration read-only. Credentials are neither copied
into the image nor present in configuration defaults.

The container is deliberately not privileged and does not mount the Docker
socket or host root. Its execution boundary is therefore the sandbox target
plus any explicitly configured SSH target, not implicit access to the Docker
host.

## Phase 10: Runtime UX

The browser now provides a compact runtime console opened with the ⌘ control.
It shows the active voice/STT configuration, logical target IDs, capabilities,
and an explicit health-check focus selector. Target metadata is deliberately
redacted: SSH hostnames, users, key paths, safe roots, and ASR endpoints never
leave the runtime. A health check happens only after the user selects it.

Approval requests also render an explicit approve/deny card in the console;
the existing spoken approval remains intact. The execution manager's
requested/denied/approved/completed/failed audit events are kept in a bounded,
in-memory history and streamed to connected runtime consoles. This view never
offers controls for security profiles, target enablement, or credentials.
