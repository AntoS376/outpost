#!/bin/bash
# Double-click to start Outpost again after Shutdown (or after it was stopped), then open it in the browser.
LABEL=com.outpost.server
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$HOME/.config/outpost/env" ] && . "$HOME/.config/outpost/env"
PORT="${OUTPOST_PORT:-8080}"
if ! launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null; then
  if [ -f "$PLIST" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST"
  else
    echo "Outpost isn't installed as a service yet. Double-click \"Install Outpost.command\" in the Outpost folder first."
    exit 1
  fi
fi
echo "Starting Outpost…"
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$PORT/healthz" && break
  sleep 1
done
open "http://localhost:$PORT"
echo "Outpost is running. You can close this window."
