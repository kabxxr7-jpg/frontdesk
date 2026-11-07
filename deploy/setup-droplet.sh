#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 droplet. Run as root over SSH:  ssh root@IP 'bash -s' < deploy/setup-droplet.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl ufw unattended-upgrades rsync
# Docker from Docker's own repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
# 2 GB swap: n8n plus the server fit in 2 GB RAM, swap absorbs build spikes
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Firewall: SSH and web only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw --force enable
# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd || true
mkdir -p /opt/frontdesk/secrets && chmod 700 /opt/frontdesk/secrets
timedatectl set-ntp true || true
echo "droplet ready: docker $(docker --version | cut -d' ' -f3) compose $(docker compose version --short)"
