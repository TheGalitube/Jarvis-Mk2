# JARVIS Mk2

JARVIS Mk2 is a self-hosted voice interface for Codex. Hold push-to-talk, speak, release, review what JARVIS heard, and continue the conversation from a browser.

It is designed to run on a Linux server under a dedicated `jarvis` system user. The recommended setup uses OpenAI cloud speech-to-text with `whisper-1` and keeps the OpenAI API key on the server.

> JARVIS is powerful software. Keep it on a private network, behind SSH/Tailscale, or behind an authenticated reverse proxy. Do not expose its control port directly to the public internet.

## Installation video

[![Watch the JARVIS installation video on YouTube](https://img.youtube.com/vi/UNlDFCsmyAk/hqdefault.jpg)](https://www.youtube.com/watch?v=UNlDFCsmyAk)

Watch the [JARVIS Linux installation video](https://www.youtube.com/watch?v=UNlDFCsmyAk) for a guided setup. For the exact commands, configuration files, API-key handling, validation, and troubleshooting, use the complete [installation guide](INSTALL.md).

## What it does

- Voice conversations with Codex from a browser.
- Push-to-talk input and a visible **You said** transcript for every completed request.
- OpenAI cloud transcription with either `whisper-1` or `gpt-4o-transcribe`.
- Optional OpenAI text-to-speech responses.
- Persistent runtime settings, execution targets, approval prompts, and an audit trail.
- GitHub access through the `jarvis` Linux account's authenticated `gh` CLI.
- A systemd deployment unit for a Raspberry Pi or other Linux server.

## Recommended architecture

```text
Browser microphone
  → JARVIS web server (Linux / systemd / jarvis user)
  → OpenAI Transcriptions API (whisper-1)
  → Codex CLI (signed in as jarvis)
  → optional OpenAI Text-to-Speech API
  → browser speaker
```

`whisper-1` runs in the OpenAI API, not on the server. It transcribes an audio recording after you release push-to-talk; it does not provide live partial transcription. No Whisper.cpp binary or local model is needed for the recommended setup.

## Quick start

For a new Linux server, follow [INSTALL.md](INSTALL.md) from top to bottom. It covers Node.js, npm, Codex, the optional GitHub CLI, OpenAI API keys, cloud `whisper-1`, systemd, SSH tunnelling, and updates.

The core steps are:

```bash
# Run as root on the server.
useradd --create-home --shell /bin/bash jarvis
install -d -o jarvis -g jarvis /opt/jarvis /etc/jarvis
runuser -u jarvis -- git clone https://github.com/TheGalitube/Jarvis-Mk2.git /opt/jarvis
runuser -u jarvis -- npm --prefix /opt/jarvis ci

# Sign in as the exact user used by the service.
sudo -iu jarvis
codex login
codex login status
exit
```

Create `/opt/jarvis/data/runtime-config.json` with OpenAI `whisper-1` selected:

```json
{
  "stt": {
    "provider": "openai",
    "fallbackToChrome": false,
    "chrome": { "enabled": false, "language": "de-DE" },
    "openai": { "model": "whisper-1", "language": "de", "timeoutMs": 30000 },
    "nemotron": { "endpoint": null, "language": "auto", "timeoutMs": 5000 },
    "whispercpp": { "endpoint": null, "language": "de", "timeoutMs": 20000 },
    "gateway": { "cloudOptInEnabled": false }
  }
}
```

Then create `/etc/jarvis/jarvis.env` and insert a real OpenAI Platform API key:

```dotenv
NODE_ENV=production
HOME=/home/jarvis
CODEX_HOME=/home/jarvis/.codex
GH_CONFIG_DIR=/home/jarvis/.config/gh
JARVIS_BIND_HOST=127.0.0.1
JARVIS_ALLOWED_HOSTS=localhost
JARVIS_CONFIG_FILE=/opt/jarvis/data/runtime-config.json
JARVIS_AGENT_MODE=full
OPENAI_API_KEY=sk-proj-REPLACE_WITH_REAL_KEY

# Optional spoken replies; set to off for text-only replies.
JARVIS_TTS_PROVIDER=openai
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
```

Protect the secret file and start the service:

```bash
chown root:root /etc/jarvis/jarvis.env
chmod 600 /etc/jarvis/jarvis.env
install -m 644 /opt/jarvis/deploy/systemd/jarvis.service /etc/systemd/system/jarvis.service
systemctl daemon-reload
systemctl enable --now jarvis
systemctl is-active jarvis
```

Open JARVIS securely from your computer:

```bash
ssh -L 3210:127.0.0.1:3210 jarvis@SERVER-IP
```

Then visit [http://localhost:3210](http://localhost:3210), allow microphone access, hold push-to-talk, speak, and release.

## OpenAI API key versus Codex login

These are separate credentials:

| Credential | Used for | Where it belongs |
|---|---|---|
| `codex login` | Codex conversations and agent operations | `/home/jarvis/.codex/`, owned by `jarvis` |
| `OPENAI_API_KEY` | Cloud `whisper-1` transcription and optional OpenAI TTS | `/etc/jarvis/jarvis.env`, root-owned, mode `600` |
| `gh auth login` | Optional GitHub repository operations | `/home/jarvis/.config/gh/`, owned by `jarvis` |

Create OpenAI API keys at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Never commit a key, put it in browser code, or paste it into an issue, screenshot, or log.

## GitHub access and network sandbox

If JARVIS should use GitHub, log in as the service account:

```bash
sudo -iu jarvis
gh auth login
gh auth status
exit
```

Codex's workspace sandbox also needs network access. In `/home/jarvis/.codex/config.toml`:

```toml
[projects."/opt/jarvis"]
trust_level = "trusted"

[sandbox_workspace_write]
network_access = true
```

This is separate from the JARVIS `local` target setting. Verify the actual service user's connectivity before diagnosing DNS:

```bash
runuser -u jarvis -- getent ahostsv4 github.com
runuser -u jarvis -- gh api user --jq .login
```

## Updating an existing server

Run updates as the service user, then restart the service:

```bash
runuser -u jarvis -- git -C /opt/jarvis pull --ff-only origin main
runuser -u jarvis -- npm --prefix /opt/jarvis ci
systemctl restart jarvis
systemctl is-active jarvis
```

If the pull refuses because the server has local changes, inspect them first. Do not discard them blindly:

```bash
runuser -u jarvis -- git -C /opt/jarvis status --short
runuser -u jarvis -- git -C /opt/jarvis log --oneline --left-right --graph origin/main...main
```

## Configuration reference

The persistent runtime configuration is normally stored in `/opt/jarvis/data/runtime-config.json`. It controls:

- STT provider and model (`openai` + `whisper-1` recommended).
- Push-to-talk or voice-activation mode.
- Sandbox, local, and approved SSH execution targets.
- Safe roots and allowed hosts.

Environment settings such as `OPENAI_API_KEY`, server binding, Codex home, GitHub home, and TTS settings belong in `/etc/jarvis/jarvis.env`. Use [deploy/systemd/jarvis.env.example](deploy/systemd/jarvis.env.example) as a minimal reference, never as a place to store a real key.

## Development

Requirements:

- Node.js 20 or newer.
- npm.
- Codex CLI for actual conversations.

```bash
npm ci
npm test
npm start
```

The test suite is local and does not call Codex, OpenAI, GitHub, or another network service.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `Missing optional dependency @openai/codex-linux-x64` | Reinstall Codex with `npm install -g @openai/codex@latest --include=optional`; see [INSTALL.md](INSTALL.md). |
| `gh auth status` reports no configuration | Run it as `jarvis`, and verify `HOME` and `GH_CONFIG_DIR` in `/etc/jarvis/jarvis.env`. |
| JARVIS reports GitHub DNS failure but `getent` works | Enable `[sandbox_workspace_write] network_access = true` in the service user's Codex config and restart JARVIS. |
| OpenAI STT fails | Check API billing, project limits, `OPENAI_API_KEY`, and `journalctl -u jarvis -n 100 --no-pager`. Never print the key. |
| Browser cannot open JARVIS | Use the SSH tunnel above and visit `http://localhost:3210`; keep port 3210 private. |
| No transcript appears | Complete a push-to-talk request by releasing the button; `whisper-1` returns after the audio upload completes. |

## License

MIT
