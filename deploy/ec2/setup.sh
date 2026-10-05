#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 instance for Owl Bot.
#   curl/scp this file to the server, then:  bash setup.sh
# Safe to re-run.
set -euo pipefail

echo "==> Swap (2 GB) — a t3.small has 2 GB RAM; image builds need more"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
# Prefer RAM; use swap only under pressure.
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-owlbot.conf >/dev/null
sudo sysctl -q --system

echo "==> Docker Engine + Compose plugin"
if ! command -v docker >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

echo "==> Keep container logs from filling the disk"
sudo mkdir -p /etc/docker
echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' | sudo tee /etc/docker/daemon.json >/dev/null
sudo systemctl restart docker

echo "==> Automatic security updates"
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

mkdir -p ~/apps
echo
echo "Done. Log out and back in (so 'docker' works without sudo), then follow README step 5."
