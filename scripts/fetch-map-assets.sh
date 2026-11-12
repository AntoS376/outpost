#!/usr/bin/env bash
# Downloads Protomaps map fonts so place labels render offline. Pinned version, checksum verified. Safe to re-run.
#   ./scripts/fetch-map-assets.sh
set -euo pipefail

# protomaps/basemaps-assets at this commit (about 6 MB); the SHA-256 was the same on two downloads on 2026-11-12.
COMMIT="028c18f713baecad011301ff7a69acc39bcc2ae7"
SHA256="57e40e8c512bd8042d0a3a251f19d0d1c8523ad963c666c3c6643bada4dc92d0"
URL="https://github.com/protomaps/basemaps-assets/archive/$COMMIT.tar.gz"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

ENV_FILE="$HOME/.config/outpost/env"
if [ -z "${OUTPOST_HOME:-}" ] && [ -f "$ENV_FILE" ]; then OUTPOST_HOME="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-}")"; fi
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/Outpost}"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading map fonts (about 6 MB)..."
curl -fL --progress-bar --connect-timeout 20 -o "$TMP/assets.tar.gz" "$URL" || die "Could not download the map fonts. Check your connection and try again."
GOT="$(shasum -a 256 "$TMP/assets.tar.gz" | cut -d' ' -f1)"
[ "$GOT" = "$SHA256" ] || die "The download's checksum is wrong, so nothing was installed. Try again; if it keeps failing, the file on GitHub has changed."
tar -xzf "$TMP/assets.tar.gz" -C "$TMP" "basemaps-assets-$COMMIT/fonts" || die "The fonts are missing from the download."
mkdir -p "$OUTPOST_HOME/assets/fonts"
cp -R "$TMP/basemaps-assets-$COMMIT/fonts/." "$OUTPOST_HOME/assets/fonts/"
echo "Fonts installed in $OUTPOST_HOME/assets/fonts. Reload the Maps page."
