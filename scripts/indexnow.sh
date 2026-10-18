#!/usr/bin/env bash
# Tells Bing, Yandex, Seznam, Naver (and the AI search tools built on Bing's index) that pages changed, via IndexNow.
# Usage: scripts/indexnow.sh [path ...]   e.g. scripts/indexnow.sh / /about   (no paths: every page in public/sitemap.xml)
# Run by deploy/deploy.sh after a healthy deploy that touched the text pages. The key file is public/d7a1bfb11d19eda8d125653160d88983.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=https://runkittyrun.fun
KEY=d7a1bfb11d19eda8d125653160d88983
if [ $# -gt 0 ]; then URLS=$(printf '%s\n' "$@" | sed "s|^|$SITE|"); else URLS=$(grep -oE '<loc>[^<]+' public/sitemap.xml | sed 's/<loc>//'); fi
LIST=$(printf '%s\n' "$URLS" | sed 's/.*/"&"/' | paste -sd, -)
curl -sS --max-time 10 -o /dev/null -w "indexnow %{http_code}\n" -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"host\":\"runkittyrun.fun\",\"key\":\"$KEY\",\"keyLocation\":\"$SITE/$KEY.txt\",\"urlList\":[$LIST]}" \
  https://api.indexnow.org/indexnow
