#!/usr/bin/env bash
# Copies the code, .env and the Google key to the droplet and (re)starts the stack.
#   deploy/push.sh root@203.0.113.10
set -euo pipefail
HOST="${1:?usage: deploy/push.sh root@<droplet ip>}"
cd "$(dirname "$0")/.."
node scripts/build-public.ts
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .runtime --exclude secrets --exclude .env --exclude 'tests' \
  ./ "$HOST:/opt/frontdesk/"
rsync -az --chmod=F600 .env "$HOST:/opt/frontdesk/.env"
if [ -f secrets/google-service-account.json ]; then
  rsync -az --chmod=F644 secrets/google-service-account.json "$HOST:/opt/frontdesk/secrets/google-service-account.json"
fi
ssh "$HOST" 'cd /opt/frontdesk && docker compose up -d --build --remove-orphans && sleep 3 && docker compose ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"'
