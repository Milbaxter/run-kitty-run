#!/usr/bin/env bash
# Deploy main to the server right now, without waiting for the box's 5-minute poll (deploy/rkr-autodeploy.timer).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(git branch --show-current)" = main ] || { echo "switch to main first" >&2; exit 1; }
git push origin main
ssh lab@80.47.225.25 'sudo systemctl start rkr-autodeploy.service; sudo journalctl -u rkr-autodeploy -o cat --since -3min --no-pager'
