#!/usr/bin/env bash
# Stops Outpost and removes the login item. Your data in ~/Outpost is kept.
set -euo pipefail
LABEL=com.outpost.server
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Outpost service removed. Your files in ~/Outpost were not touched."
