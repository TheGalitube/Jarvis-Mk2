# JARVIS runtime configuration

Copy `runtime-config.example.json` to `runtime-config.json` and set the
`JARVIS_CONFIG_FILE` environment variable before starting the server. The real
file is ignored by Git so a machine-specific configuration cannot be committed
accidentally.

```powershell
Copy-Item .\data\runtime-config.example.json .\data\runtime-config.json
$env:JARVIS_CONFIG_FILE = "$PWD\data\runtime-config.json"
npm start
```

The example is ready to run: Voice Activation is enabled, Chrome understands
German, and Chrome remains the fallback when Nemotron is unavailable.

## Nemotron

For a self-hosted NIM realtime ASR service, set the endpoint to its HTTP
service, normally port 9000. Do not use its gRPC port.

```json
"nemotron": {
  "endpoint": "http://asr.example.internal:9000",
  "language": "auto",
  "timeoutMs": 5000
}
```

`provider: "auto"` uses Nemotron only when its health check succeeds; Chrome
continues as the fallback. The endpoint is never sent to the browser.

## Whisper.cpp

For a fully local Whisper.cpp HTTP server, use Push-to-Talk and configure the
server's base URL. Whisper.cpp's standard server accepts a WAV upload at
`/inference`; JARVIS creates that WAV in memory and never stores microphone
audio on disk.

```json
"voice": { "mode": "push-to-talk" },
"stt": {
  "provider": "whispercpp",
  "fallbackToChrome": false,
  "chrome": { "enabled": false, "language": "de-DE" },
  "whispercpp": {
    "endpoint": "http://192.168.1.182:8080",
    "language": "de",
    "timeoutMs": 20000
  }
}
```

The standard Whisper.cpp HTTP server is batch-based, so it is deliberately
used with Push-to-Talk rather than wake-word activation. A failed service is
shown as an STT error; Chrome is used only if `fallbackToChrome` is `true`.

Final Push-to-Talk transcripts pass through a deterministic technical-dictation
layer before they are sent to Jarvis. It converts only explicit phrases such as
`slash home slash test punkt txt` to `/home/test.txt` and `C colon backslash
Users` to `C:\\Users`; it keeps the raw transcript with the event and never uses
an AI model to invent missing path components. Execution policy and safe-root
checks still run after transcription exactly as before.

### large-v3 capacity gate (required)

Do **not** replace the running base model blindly. On the STT host first run the
included read-only gate:

```bash
bash /opt/jarvis/deploy/whispercpp/assess-large-v3.sh
```

It reports current total/available RAM, swap and free disk without downloading,
restarting, or changing the service. The full `ggml-large-v3.bin` gate is
conservatively 12 GiB total RAM, 6 GiB currently available RAM and 6 GiB free
model disk. An 8 GiB DDR3 host will normally be rejected: retain the active base
model as the safe fallback, or test multilingual `large-v3-q5_0` in a separate
maintenance window. Quantization costs a little recognition fidelity, but is
substantially more likely to remain stable on 8 GiB; CPU-only latency can still
be high. Do not alter the service unit until a test on a separate port has shown
stable RAM/swap and acceptable German, English code-switching, and path results.

## Optional Cloud STT through the STT-server gateway

`gpt-4o-transcribe` is used only by `openai-stt-gateway.mjs` on the Linux STT
server. Jarvis itself continues to upload Push-to-Talk WAV data only to the LAN
gateway; the browser never receives an API key. The gateway falls back to the
existing local Whisper.cpp endpoint for missing configuration, timeout, quota,
duration/session limits, or cloud errors. The existing deterministic path and
filename normalization runs in Jarvis after either transcription path.

1. On the Jarvis app server, point `stt.whispercpp.endpoint` at the gateway
   (for example `http://192.168.1.182:8081`) and set
   `stt.gateway.cloudOptInEnabled` to `true`. It remains off by default.
2. On the STT server, install the included `jarvis-stt-gateway.service`, then
   create `/etc/jarvis/stt-gateway.env` with mode `600`, owned by `root:root`:

```bash
sudo install -d -m 700 /etc/jarvis
sudoedit /etc/jarvis/stt-gateway.env
sudo chmod 600 /etc/jarvis/stt-gateway.env
sudo install -m 644 /opt/jarvis/deploy/whispercpp/jarvis-stt-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-stt-gateway
```

The EnvironmentFile contains `OPENAI_API_KEY` plus safe defaults from
`.env.example`: `JARVIS_OPENAI_STT_ENABLED=false`, a 30-second timeout, maximum
45 seconds audio, and 20 cloud requests per session. Set the cloud flag to true
only after adding the key. Bind the gateway to the LAN address deliberately and
firewall it so only Jarvis can reach port 8081; Whisper.cpp itself remains on
its current local endpoint. The browser Runtime Console exposes a persisted
per-browser **Cloud STT** checkbox. It sends no secret and must be enabled in
addition to the server flag.

The same `OPENAI_API_KEY` name is already used by the server-side OpenAI TTS
configuration. Keep real `.env`/EnvironmentFile secrets out of Git.

### Ubuntu STT server setup

On the STT server (`192.168.1.182`), install the CPU version first. It is fully
local and reliable on the existing hardware; GPU acceleration can be added
later only after the NVIDIA driver is healthy.

```bash
sudo apt update
sudo apt install -y build-essential cmake git
sudo git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp
sudo chown -R admin:admin /opt/whisper.cpp
sudo -u admin -H bash -lc 'cd /opt/whisper.cpp && ./models/download-ggml-model.sh base'
sudo -u admin -H bash -lc 'cd /opt/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j4'
```

Copy the included service unit from the Raspberry Pi to the STT server (replace
`admin` if that is not the SSH user), then start it and verify its endpoint:

```bash
# Run this on the Raspberry Pi after updating JARVIS:
scp /opt/jarvis/deploy/whispercpp/whisper-stt.service admin@192.168.1.182:/tmp/whisper-stt.service

# Run these on the STT server:
sudo install -m 644 /tmp/whisper-stt.service /etc/systemd/system/whisper-stt.service
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-stt
sudo systemctl status whisper-stt --no-pager
curl -fsS http://192.168.1.182:8080/ >/dev/null && echo 'Whisper.cpp OK'
```

If UFW is enabled, allow only the Raspberry Pi to reach the service:

```bash
sudo ufw allow from 192.168.1.75 to any port 8080 proto tcp
```

The unit uses the multilingual `base` model, four CPU threads, and German
language mode. It does not require Docker, an NVIDIA driver, or an API key.

## Local target

To allow structured inspection and explicit text-file creation on the JARVIS
host, change the security profile to `standard`, set `targets.local.enabled` to
`true`, and restrict `safeRoots` to folders that JARVIS may access. File writes
always require a voice approval and never overwrite an existing file. Leave
`shellEnabled` as `false` unless the high-risk shell operation is intentionally
required. A Linux server configuration looks like this:

```json
"execution": {
  "securityProfile": "standard",
  "defaultTarget": "local"
},
"targets": {
  "local": {
    "enabled": true,
    "safeRoots": ["/home/jarvis"],
    "shellEnabled": false
  }
}
```

Use an absolute path in the voice request, for example: `Jarvis, erstelle
Textdatei /home/jarvis/note.txt mit dem Inhalt Hallo Welt`. Replace
`/home/jarvis` with a narrower folder where possible; `"/"` grants access to
the entire filesystem that the `jarvis` service account can write to.

## SSH targets

Add only logical target names. Passwords and key contents do not belong here;
use SSH agent or an `identityFile` path, and keep normal host-key verification.

```json
"hosts": {
  "minecraft": {
    "type": "ssh",
    "hostname": "minecraft.example.internal",
    "username": "jarvis",
    "identityFile": "C:/Users/galit/.ssh/jarvis_ed25519",
    "platform": "linux",
    "capabilities": ["system-info", "process-list", "service-control"],
    "connectTimeoutMs": 5000,
    "commandTimeoutMs": 10000
  }
}
```

SSH targets also require `securityProfile: "standard"` or a stricter custom
policy that explicitly allows them.

## Secrets and authentication

Do not put API keys in `runtime-config.json`.

- Codex: run `codex login` once for the account that starts Jarvis.
- OpenAI TTS: set `OPENAI_API_KEY` as a Windows environment variable.
- Fish Audio: use `C:\Users\galit\.config\fish-audio\speak.json`.

The server does not automatically load a `.env` file.
