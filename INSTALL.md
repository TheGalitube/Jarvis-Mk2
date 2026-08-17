# Install JARVIS Mk2 on a Linux Server

This guide installs JARVIS Mk2 on one Linux server, with speech-to-text provided by OpenAI's cloud-hosted `whisper-1` model. It does **not** install Whisper.cpp or any local transcription model.

The browser records your push-to-talk audio, JARVIS sends the completed recording to the OpenAI Transcriptions API, and the resulting transcript is shown in the interface. `whisper-1` is a batch transcription model: transcription starts after you release the push-to-talk button.

> Keep the server behind SSH, a VPN, or a reverse proxy with authentication. The default configuration below binds JARVIS only to `127.0.0.1`, so it is not publicly exposed.

## What you need

- A supported Linux server (Ubuntu or Debian recommended) with internet access.
- A regular user account that can become `root` or use `sudo`.
- A GitHub account with access to this repository.
- An OpenAI API account with billing enabled and an API key. A ChatGPT/Codex login is **not** an OpenAI API key.
- A second device with a browser and microphone, used to access the JARVIS web interface.

All commands in sections 1--5 are run as `root`. Commands explicitly starting with `runuser -u jarvis` run as the dedicated service account.

## 1. Update the server and install Node.js

JARVIS needs a current Node.js installation with npm. The following removes distribution-provided Node packages first, then installs the current NodeSource LTS release.

```bash
apt update
apt upgrade -y

apt remove -y nodejs npm libnode-dev || true
apt --fix-broken install -y

apt install -y git curl ca-certificates build-essential cmake

curl -fsSL https://deb.nodesource.com/setup_lts.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh

apt install -y nodejs
rm -f /tmp/nodesource_setup.sh

node -v
npm -v
```

Both version commands must print a version. If `npm -v` does not work, stop here and repair the Node.js installation before continuing.

## 2. Install Codex and optional GitHub CLI

Install Codex with optional dependencies enabled. This avoids the common error `Missing optional dependency @openai/codex-linux-x64`.

```bash
npm config get omit
npm config get optional
npm install -g @openai/codex@latest --include=optional
codex --version
```

If Codex still reports a missing optional platform dependency, reinstall it:

```bash
npm uninstall -g @openai/codex
env npm_config_optional=true npm install -g @openai/codex@latest --include=optional
codex --version
```

The GitHub CLI is optional, but recommended if JARVIS should work with GitHub repositories:

```bash
apt install -y gh
gh --version
```

If your distribution has no `gh` package, install it using the [official GitHub CLI installation instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). GitHub CLI is not required for the initial JARVIS startup.

## 3. Create the dedicated service user and install JARVIS

Never run the JARVIS service as `root`.

```bash
useradd --create-home --shell /bin/bash jarvis
install -d -o jarvis -g jarvis /opt/jarvis /etc/jarvis

runuser -u jarvis -- git clone https://github.com/TheGalitube/Jarvis-Mk2.git /opt/jarvis
runuser -u jarvis -- npm --prefix /opt/jarvis ci
```

For a fork or private copy, replace the repository URL in the `git clone` command with your own URL. Ensure that the `jarvis` user has access before cloning a private repository.

## 4. Sign in as the `jarvis` user

Codex and GitHub credentials must belong to the same Linux account that runs the service. Signing in as `root` does not sign in JARVIS.

```bash
sudo -iu jarvis
codex login
codex login status

# Optional, required only for GitHub CLI features:
gh auth login
gh auth status
exit
```

`codex login` opens a browser-based sign-in flow. Complete it from a browser that can reach the displayed URL. Do not paste credentials into the repository or an environment file.

## 5. Create an OpenAI API key

1. Open [OpenAI API keys](https://platform.openai.com/api-keys) and create a new project API key.
2. Copy it once and store it in a password manager.
3. Add it only to `/etc/jarvis/jarvis.env` in the next section.

The key is used by the server for `POST /v1/audio/transcriptions` with the `whisper-1` model. Never put it in browser JavaScript, `runtime-config.json`, Git, screenshots, or logs. See the [OpenAI API quickstart](https://platform.openai.com/docs/quickstart) and [Audio Transcriptions API reference](https://platform.openai.com/docs/api-reference/audio/createTranscription).

## 6. Configure cloud speech-to-text

Create JARVIS's persistent runtime configuration:

```bash
install -d -o jarvis -g jarvis /opt/jarvis/data
nano /opt/jarvis/data/runtime-config.json
```

Paste the following JSON. It explicitly selects OpenAI `whisper-1` and disables both browser and local Whisper.cpp fallback paths.

```json
{
  "jarvis": {
    "name": "Jarvis"
  },
  "execution": {
    "securityProfile": "sandbox-only",
    "defaultTarget": "sandbox"
  },
  "targets": {
    "sandbox": {
      "enabled": true
    },
    "local": {
      "enabled": false,
      "safeRoots": ["/home/jarvis"],
      "shellEnabled": false
    }
  },
  "hosts": {},
  "voice": {
    "mode": "push-to-talk",
    "wakeWords": ["jarvis", "hey jarvis"],
    "silenceTimeoutMs": 1400
  },
  "stt": {
    "provider": "openai",
    "fallbackToChrome": false,
    "chrome": {
      "enabled": false,
      "language": "de-DE"
    },
    "openai": {
      "model": "whisper-1",
      "language": "de",
      "timeoutMs": 30000
    },
    "nemotron": {
      "endpoint": null,
      "language": "auto",
      "timeoutMs": 5000
    },
    "whispercpp": {
      "endpoint": null,
      "language": "de",
      "timeoutMs": 20000
    },
    "gateway": {
      "cloudOptInEnabled": false
    }
  }
}
```

The `whispercpp` block is inactive configuration only; no Whisper.cpp process, binary, or model is installed or used.

## 7. Create the protected environment file

Create the file that contains secrets and service-level settings:

```bash
nano /etc/jarvis/jarvis.env
```

Paste this configuration and replace `sk-proj-REPLACE_WITH_REAL_KEY` with your real API key:

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

# Optional OpenAI text-to-speech. Set JARVIS_TTS_PROVIDER=off to disable speech output.
JARVIS_TTS_PROVIDER=openai
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=cedar
OPENAI_TTS_FORMAT=mp3
OPENAI_TTS_INSTRUCTIONS=Speak calmly, precisely, and confidently in German.
```

Protect the file. It must not be readable by the `jarvis` account or other users:

```bash
chown root:root /etc/jarvis/jarvis.env
chmod 600 /etc/jarvis/jarvis.env
```

## 8. Allow Codex network access for the trusted project

The `local` execution target and Codex's own sandbox are separate settings. GitHub and the OpenAI API require network access from Codex's workspace sandbox.

```bash
install -d -o jarvis -g jarvis /home/jarvis/.codex
nano /home/jarvis/.codex/config.toml
```

Paste:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "medium"

[projects."/opt/jarvis"]
trust_level = "trusted"

[projects."/home/jarvis"]
trust_level = "trusted"

[sandbox_workspace_write]
network_access = true
```

Then protect it:

```bash
chown jarvis:jarvis /home/jarvis/.codex/config.toml
chmod 600 /home/jarvis/.codex/config.toml
```

This grants network access to Codex's workspace sandbox. It does not automatically approve actions; JARVIS should still ask for approval before external or consequential operations.

## 9. Install and start the systemd service

The repository contains the service unit:

```bash
install -m 644 /opt/jarvis/deploy/systemd/jarvis.service /etc/systemd/system/jarvis.service
systemctl daemon-reload
systemctl enable --now jarvis

systemctl status jarvis --no-pager
curl -fsS -H "Host: localhost:3210" http://127.0.0.1:3210/healthz
```

The last command should return a health response. For diagnostics:

```bash
systemctl is-active jarvis
journalctl -u jarvis -n 100 --no-pager
```

## 10. Open the interface securely

Because JARVIS listens only on `127.0.0.1`, create an SSH tunnel from your desktop computer:

```bash
ssh -L 3210:127.0.0.1:3210 jarvis@SERVER-IP
```

Keep that terminal open and visit [http://localhost:3210](http://localhost:3210) in your browser. Allow microphone access when prompted.

Use push-to-talk, speak, and release the button. The UI should show a separate **You said** transcript after the request has been transcribed. Audio is sent to OpenAI only for the transcription request; it is not processed by Whisper.cpp on this server.

## 11. Verify GitHub and OpenAI connectivity

Run these checks as the service user:

```bash
runuser -u jarvis -- getent ahostsv4 github.com
runuser -u jarvis -- gh auth status
runuser -u jarvis -- gh api user --jq .login
```

For OpenAI, make one short push-to-talk request in the browser and inspect the service logs:

```bash
journalctl -u jarvis -n 100 --no-pager
```

Do not print `OPENAI_API_KEY` for troubleshooting. If a key was accidentally exposed, revoke it immediately and create a new one.

## Updating JARVIS

When the working tree has no local changes, update the server with:

```bash
runuser -u jarvis -- git -C /opt/jarvis pull --ff-only origin main
runuser -u jarvis -- npm --prefix /opt/jarvis ci
systemctl restart jarvis
systemctl is-active jarvis
```

If `git pull --ff-only` refuses to run, inspect the repository first instead of discarding anything:

```bash
runuser -u jarvis -- git -C /opt/jarvis status --short
runuser -u jarvis -- git -C /opt/jarvis log --oneline --left-right --graph origin/main...main
```

## Common problems

### `Missing optional dependency @openai/codex-linux-x64`

Reinstall Codex using the recovery commands in section 2. This is usually an npm optional-dependency installation issue, not a JARVIS issue.

### JARVIS says it cannot resolve `github.com`

First test the operating system network as the actual service user:

```bash
runuser -u jarvis -- getent ahostsv4 github.com
runuser -u jarvis -- gh api user --jq .login
```

If both work, the server network and GitHub login are healthy. Check `/home/jarvis/.codex/config.toml` for `[sandbox_workspace_write] network_access = true`, then restart JARVIS.

### `gh auth status` says no configuration file

Ensure the command runs as `jarvis`, and ensure `HOME=/home/jarvis` and `GH_CONFIG_DIR=/home/jarvis/.config/gh` are present in `/etc/jarvis/jarvis.env`.

### The browser cannot reach JARVIS

Use the SSH tunnel from section 10 and browse to `http://localhost:3210`. Do not expose port 3210 to the internet merely to avoid the tunnel; that would be a remarkably efficient way to invite strangers into the control room.
