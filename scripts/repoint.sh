#!/usr/bin/env bash
# Restores the public address when a Cloudflare quick tunnel dies: new tunnel, PUBLIC_BASE_URL in .env, pages rebuilt,
# server restarted, Vapi assistant and Stripe webhook pointed at the new address. Prints the new address; never a secret.
# Run from the project folder: bash scripts/repoint.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime
v() { grep "^$1=" .env | head -1 | cut -d= -f2-; }

pkill -f 'cloudflared tunnel --url http://127.0.0.1:8080' || true
log=".runtime/tunnel-$(date +%Y%m%d-%H%M%S).log"
nohup cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate >"$log" 2>&1 &
url=""
for _ in $(seq 1 40); do
  url=$(grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | grep -v '//api\.' | tail -1 || true)
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "no tunnel address after 40 s; see $log" >&2; exit 1; }
sed -i '' "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$url#" .env

npm run -s reskin -- briefs/brightside-dental.json --phone "$(v VAPI_PHONE_NUMBER)" --live-since "7 Nov 2026" >/dev/null
npm run -s reskin -- briefs/rapid-rooter-plumbing.json >/dev/null
npm run -s build:public

if [ -f .runtime/server.pid ]; then kill "$(cat .runtime/server.pid)" 2>/dev/null || true; sleep 1.5; fi
nohup node scripts/serve.ts >>.runtime/server.log 2>&1 &
echo $! >.runtime/server.pid
nohup caffeinate -ims -w "$(cat .runtime/server.pid)" >/dev/null 2>&1 &

npm run -s vapi:setup
code=$(curl -s -o /dev/null -w '%{http_code}' -u "$(v STRIPE_SECRET_KEY):" -X POST "https://api.stripe.com/v1/webhook_endpoints/$(v STRIPE_WEBHOOK_ID)" --data-urlencode "url=$url/webhooks/stripe")
echo "stripe webhook -> $url/webhooks/stripe ($code)"

for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/healthz")" = 200 ] && break
  sleep 2
done
echo "demo page: $url/  (healthz $(curl -s -o /dev/null -w '%{http_code}' "$url/healthz"))"
