#!/bin/bash
# Builds the ZIP to attach to a GitHub Release: dist-release/Outpost.zip, holding an "Outpost" folder with
# "Install Outpost.command" at the top. It packs the last commit, so commit first. The file name stays the same
# for every version so the one-line installer can always fetch releases/latest/download/Outpost.zip.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p 'require("./package.json").version')"
OUT="$ROOT/dist-release/Outpost.zip"

[ -z "$(git status --porcelain)" ] || echo "Note: you have uncommitted changes; they won't be in the ZIP."
grep -q 'OWNER/outpost' scripts/install.sh && echo "Note: set OUTPOST_REPO's default in scripts/install.sh to your GitHub repo."

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
git archive --format=zip --prefix=Outpost/ -o "$OUT" HEAD
echo "Built $OUT (version $VERSION, $(du -h "$OUT" | cut -f1 | tr -d ' '))."
echo "Make a GitHub Release tagged v$VERSION and attach it as Outpost.zip."
