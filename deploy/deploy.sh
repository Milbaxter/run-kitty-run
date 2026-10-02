#!/usr/bin/env bash
# Runs on the server as user rkr (triggered by the GitHub Action over SSH): pull, install, restart, health check.
# If the new version doesn't answer /healthz, it rolls back to the previous commit and exits 1 (the Action fails).
# (The deploy SSH key is pinned to this script's path in authorized_keys: don't rename or move it.)
set -euo pipefail
cd /opt/run-kitty-run/app
PREV=$(git rev-parse HEAD)

install_and_restart() {
  # only `ws` is needed at runtime and it has no install scripts (its native addons are optional)
  npm ci --omit=dev --ignore-scripts --silent
  sudo /usr/bin/systemctl restart run-kitty-run
}

healthy() {
  # port: run-kitty-run.service (PORT=8080, behind Caddy)
  for _ in $(seq 1 20); do
    sleep 0.5
    curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && return 0
  done
  return 1
}

git fetch --quiet origin main
git reset --hard --quiet origin/main
install_and_restart
# Caddy config changes need a root step: if deploy/Caddyfile changed, apply it manually with
#   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy

if healthy; then
  echo "deployed $(git rev-parse --short HEAD)"
  exit 0
fi

echo "health check failed for $(git rev-parse --short HEAD); rolling back to ${PREV:0:7}" >&2
journalctl -u run-kitty-run -n 30 --no-pager >&2 2>/dev/null || true # may show nothing without journal access
git reset --hard --quiet "$PREV"
install_and_restart
if healthy; then echo "rolled back to ${PREV:0:7}" >&2; else echo "rollback to ${PREV:0:7} is unhealthy too" >&2; fi
exit 1
