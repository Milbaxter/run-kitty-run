#!/usr/bin/env bash
# One-time server setup (run as a sudoer on the box). Idempotent.
set -euo pipefail
REPO=git@github.com:Milbaxter/run-kitty-run.git
APP=/opt/run-kitty-run

# service user, isolated from other users on the box
id rkr &>/dev/null || sudo useradd --system --home-dir $APP --create-home --shell /bin/bash rkr
sudo -u rkr mkdir -p $APP/.ssh
sudo -u rkr chmod 700 $APP/.ssh
# GitHub over port 443 (outbound 22 to GitHub is blocked here)
sudo -u rkr tee $APP/.ssh/config >/dev/null <<CFG
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile $APP/.ssh/deploy_key
CFG
[ -f $APP/.ssh/deploy_key ] || sudo -u rkr ssh-keygen -q -t ed25519 -N '' -C rkr-deploy -f $APP/.ssh/deploy_key
sudo -u rkr bash -c "ssh-keyscan -p 443 ssh.github.com 2>/dev/null > $APP/.ssh/known_hosts"

# sudo rule: rkr may only restart its own service
echo 'rkr ALL=(root) NOPASSWD: /usr/bin/systemctl restart run-kitty-run' | sudo tee /etc/sudoers.d/rkr >/dev/null
sudo chmod 440 /etc/sudoers.d/rkr

# Caddy (HTTPS reverse proxy)
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q >/dev/null
  sudo apt-get install -y -q caddy >/dev/null
fi
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
echo "setup done. deploy key (add to GitHub as read-only deploy key):"
sudo cat $APP/.ssh/deploy_key.pub
