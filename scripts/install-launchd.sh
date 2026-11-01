#!/usr/bin/env bash
# Installs Outpost as a per-user launch agent (starts at login, restarts if it crashes, stays off after Shutdown).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.outpost.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/Outpost"
ENV_FILE="$HOME/.config/outpost/env"
OUTPOST_HOME="$( ( [ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-$HOME/Outpost}") )"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/run.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$OUTPOST_HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/outpost.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/outpost.log</string>
</dict>
</plist>
P
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is fully gone; loading again too soon fails with "Input/output error".
for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "$DOMAIN" "$PLIST"; }
echo "Outpost is running and will start at login. After Shutdown, double-click \"Start Outpost.command\" to start it again. Logs: $LOGDIR/outpost.log"
