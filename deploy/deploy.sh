#!/usr/bin/env bash
# Runs on the server as user rkr (triggered by the GitHub Action over SSH): pull, install, restart.
set -euo pipefail
cd /opt/run-kitty-run/app
git fetch --quiet origin main
git reset --hard --quiet origin/main
npm ci --omit=dev --silent
sudo /usr/bin/systemctl restart run-kitty-run
# Caddy config changes need a root step: if deploy/Caddyfile changed, apply it manually with
#   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
sleep 1
systemctl is-active run-kitty-run
echo "deployed $(git rev-parse --short HEAD)"
