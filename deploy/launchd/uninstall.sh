#!/usr/bin/env bash
# Removes the two LaunchAgents installed by install.sh. The line stops until you start it again (bash scripts/repoint.sh).
set -uo pipefail
uid="$(id -u)"
for n in server tunnel; do
  launchctl bootout "gui/$uid/com.kabiirlabs.frontdesk.$n" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.kabiirlabs.frontdesk.$n.plist"
done
echo "Removed. Nothing of the front desk starts at login any more."
