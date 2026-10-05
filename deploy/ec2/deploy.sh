#!/usr/bin/env bash
# Pull the latest code of all three apps, rebuild, and restart.
#   cd ~/apps/owlbot/deploy/ec2 && ./deploy.sh
#   ./deploy.sh --no-pull     rebuild what's on disk
set -euo pipefail
cd "$(dirname "$0")"

APPS="$(cd ../../.. && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-$APPS/owlbot_frontend}"
PYTHON_DIR="${PYTHON_DIR:-$APPS/owlbot_python}"
export FRONTEND_DIR PYTHON_DIR

[ -f .env ] || { echo "Missing deploy/ec2/.env — copy .env.example and fill it in."; exit 1; }

if [ "${1:-}" != "--no-pull" ]; then
  for repo in "$APPS/owlbot" "$FRONTEND_DIR" "$PYTHON_DIR"; do
    echo "==> git pull $(basename "$repo")"
    git -C "$repo" pull --ff-only
  done
fi

# One image at a time: building all three together can exhaust 2 GB of RAM.
for svc in converter api web; do
  echo "==> build $svc"
  docker compose build "$svc"
done

echo "==> start"
docker compose up -d --remove-orphans

echo "==> clean up old images"
docker image prune -f >/dev/null

echo "==> waiting for the API to be healthy"
for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 2
done
docker compose ps
echo
echo "API status: $status   (logs: docker compose logs -f api)"
