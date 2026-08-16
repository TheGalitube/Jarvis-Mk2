#!/usr/bin/env bash
# Read-only capacity gate for the optional Whisper large-v3 upgrade.
# It never downloads a model, changes the active service, or restarts anything.
set -euo pipefail

MODEL_DIR=${MODEL_DIR:-/opt/whisper.cpp/models}
MIN_TOTAL_RAM_MIB=12288
MIN_AVAILABLE_RAM_MIB=6144
MIN_FREE_DISK_MIB=6144

mib() { awk -v value="$1" 'BEGIN { printf "%d", value / 1024 }'; }
total_ram=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)
available_ram=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)
total_swap=$(awk '/SwapTotal:/ { print $2 }' /proc/meminfo)
free_swap=$(awk '/SwapFree:/ { print $2 }' /proc/meminfo)
free_disk=$(df -Pk "$MODEL_DIR" | awk 'NR == 2 { print $4 }')

printf 'Whisper.cpp large-v3 capacity report\n'
printf '  RAM total:      %s MiB\n' "$(mib "$total_ram")"
printf '  RAM available:  %s MiB\n' "$(mib "$available_ram")"
printf '  Swap total/free:%s / %s MiB\n' "$(mib "$total_swap")" "$(mib "$free_swap")"
printf '  Disk free (%s): %s MiB\n' "$MODEL_DIR" "$(mib "$free_disk")"

if (( total_ram < MIN_TOTAL_RAM_MIB || available_ram < MIN_AVAILABLE_RAM_MIB || free_disk < MIN_FREE_DISK_MIB )); then
  cat <<'EOF'

DECISION: Do not install or activate the full ggml-large-v3.bin on this host.
The conservative full-model gate is 12 GiB total RAM, 6 GiB currently available
RAM, and 6 GiB free model disk. Keep the current model active. On an 8 GiB host,
large-v3-q5_0 is the preferred candidate, but download and service changes still
require a separate controlled test window.
EOF
  exit 2
fi

cat <<'EOF'

DECISION: Capacity gate passed. This is not an installation action. Before any
switch, download the model beside the current model, run a one-shot test on a
different port, observe RAM/swap and transcription quality, then change systemd.
EOF
