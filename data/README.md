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
