#!/bin/zsh
# Run by the per-user LaunchAgent. Starting after a full reboot requires signing in/unlocking FileVault.
set -eu
cd "${0:A:h:h}"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
/usr/bin/open -gj -a Docker
until docker info >/dev/null 2>&1; do /bin/sleep 5; done
/usr/bin/caffeinate -s &
awake_pid=$!
trap 'kill "$awake_pid" 2>/dev/null || true' EXIT INT TERM
if [[ -s .secrets/ngrok.yml ]]; then
  export TRUST_PROXY=ngrok
  docker compose --profile ngrok up -d --wait
elif [[ -s .secrets/cloudflare-tunnel-token ]]; then
  export TRUST_PROXY=cloudflare
  docker compose --profile public up -d --wait
else
  docker compose up -d --wait
fi
while true; do /bin/sleep 60; done
