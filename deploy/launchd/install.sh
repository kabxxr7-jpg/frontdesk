#!/usr/bin/env bash
# Makes the front desk start by itself: at login, and again within 10 s if the server or the tunnel crashes.
# Installs two LaunchAgents for the current user (no password needed). Undo with: bash deploy/launchd/uninstall.sh
# Run from the project folder: bash deploy/launchd/install.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
here="$(pwd)"
node_bin="$(command -v node)"
cf_bin="$(command -v cloudflared)"
la="$HOME/Library/LaunchAgents"
uid="$(id -u)"
mkdir -p "$la" .runtime
[ -f "$HOME/.cloudflared/frontdesk.yml" ] || { echo "no named tunnel config at ~/.cloudflared/frontdesk.yml" >&2; exit 1; }

write() { # label, then the program and its arguments
  local label="$1" log="$2"; shift 2
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key><array>'
    for a in "$@"; do echo "    <string>$a</string>"; done
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$here</string>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ThrottleInterval</key><integer>10</integer>'
    echo "  <key>StandardOutPath</key><string>$here/.runtime/$log</string>"
    echo "  <key>StandardErrorPath</key><string>$here/.runtime/$log</string>"
    echo '</dict></plist>'
  } >"$la/$label.plist"
  plutil -lint "$la/$label.plist" >/dev/null
}

write com.kabiirlabs.frontdesk.server server.log /usr/bin/caffeinate -ims "$node_bin" scripts/serve.ts
write com.kabiirlabs.frontdesk.tunnel named-tunnel.log "$cf_bin" tunnel --config "$HOME/.cloudflared/frontdesk.yml" --no-autoupdate run frontdesk

# Stop the copies started by hand, then hand both over to launchd.
[ -f .runtime/server.pid ] && kill "$(cat .runtime/server.pid)" 2>/dev/null || true
pkill -f 'node scripts/serve.ts' || true
pkill -f 'cloudflared tunnel --config' || true
sleep 2
for n in server tunnel; do
  launchctl bootout "gui/$uid/com.kabiirlabs.frontdesk.$n" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$la/com.kabiirlabs.frontdesk.$n.plist"
done
rm -f .runtime/server.pid
sleep 10
echo "local:  $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz)"
echo "public: $(curl -s -o /dev/null -w '%{http_code}' https://desk.kabiirlabs.com/healthz)"
echo "Installed. The line now starts at login and restarts itself after a crash."
echo "Keep the Mac plugged in with the lid open: macOS sleeps on lid close whatever this does."
