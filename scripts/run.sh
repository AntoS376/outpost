#!/usr/bin/env bash
# Starts Outpost in the foreground using ~/.config/outpost/env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.config/outpost/env"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
export PATH="${OUTPOST_HOME:-$HOME/Outpost}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$ROOT/dist/main.js" ] || { echo "Not built yet. Run: npm run build" >&2; exit 1; }
cd "$ROOT"
# Trust the certificates in the macOS keychain, as Safari and curl do. Without this, Node uses only its own
# bundled list, and HTTPS fails behind networks that inspect traffic with their own certificate authority.
export NODE_USE_SYSTEM_CA=1
exec node dist/main.js
