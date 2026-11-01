#!/usr/bin/env bash
# Downloads CyberChef (GCHQ's data toolkit) into ~/Outpost/assets/cyberchef so Outpost serves it offline at
# /tools/cyberchef/. Pinned release, checksum verified. Safe to re-run.
#   ./scripts/fetch-cyberchef.sh
set -euo pipefail

VERSION="v11.5.0"
ASSET="CyberChef_8cd426dd4f40f1423912d5fad91b578a86a65112.zip"
# From GitHub's release metadata for this asset, and checked against a download on 2026-10-30.
SHA256="f6478925d3eaa16ec08626a85f5b85eed10d531a5e18700615fed7ecb024cccf"
URL="https://github.com/gchq/CyberChef/releases/download/$VERSION/$ASSET"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

ENV_FILE="$HOME/.config/outpost/env"
if [ -z "${OUTPOST_HOME:-}" ] && [ -f "$ENV_FILE" ]; then OUTPOST_HOME="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-}")"; fi
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/Outpost}"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"
DEST="$OUTPOST_HOME/assets/cyberchef"

if [ -f "$DEST/VERSION" ] && [ "$(cat "$DEST/VERSION")" = "$VERSION" ]; then
  echo "CyberChef $VERSION is already installed in $DEST."
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading CyberChef $VERSION (about 80 MB)..."
curl -fL --progress-bar -o "$TMP/cyberchef.zip" "$URL" || die "Could not download $URL. Check your connection and try again."
GOT="$(shasum -a 256 "$TMP/cyberchef.zip" | cut -d' ' -f1)"
[ "$GOT" = "$SHA256" ] || die "The download's checksum is wrong (got $GOT, expected $SHA256). Nothing was installed. Try again; if it keeps failing, the file on GitHub has changed."

mkdir -p "$TMP/unpacked"
unzip -q "$TMP/cyberchef.zip" -d "$TMP/unpacked"
PAGE="$TMP/unpacked/CyberChef_$VERSION.html"
[ -f "$PAGE" ] || die "CyberChef_$VERSION.html is missing from the download."
cp "$PAGE" "$TMP/unpacked/index.html"
echo "$VERSION" > "$TMP/unpacked/VERSION"

# Swap in the new copy only once it is complete.
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.new" "$DEST.old"
mv "$TMP/unpacked" "$DEST.new"
[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
echo "CyberChef $VERSION installed in $DEST. Open Tools in Outpost, or go to /tools/cyberchef/."
