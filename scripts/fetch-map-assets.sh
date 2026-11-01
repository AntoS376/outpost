#!/usr/bin/env bash
# Downloads Protomaps map fonts so place labels render offline.
set -euo pipefail
ENV_FILE="$HOME/.config/outpost/env"
if [ -z "${OUTPOST_HOME:-}" ] && [ -f "$ENV_FILE" ]; then OUTPOST_HOME="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-}")"; fi
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/Outpost}"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 https://github.com/protomaps/basemaps-assets "$TMP/a"
mkdir -p "$OUTPOST_HOME/assets/fonts"
cp -R "$TMP/a/fonts/." "$OUTPOST_HOME/assets/fonts/"
echo "Fonts installed in $OUTPOST_HOME/assets/fonts. Reload the Maps page."
