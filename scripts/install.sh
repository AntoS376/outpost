#!/bin/bash
# One-line install, for people happy to paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/outpost/main/scripts/install.sh | bash
# Downloads the latest release into ~/Applications/Outpost and runs its installer. Run it again to update.
set -euo pipefail

# Everything sits in main, so a download cut short runs nothing.
main() {
  local repo="${OUTPOST_REPO:-OWNER/outpost}" dest="$HOME/Applications/Outpost" tmp
  [ "$(uname -s)" = Darwin ] || { echo "Outpost's installer runs on a Mac only."; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading Outpost…"
  curl -fL --progress-bar -o "$tmp/Outpost.zip" "https://github.com/$repo/releases/latest/download/Outpost.zip"
  ditto -x -k "$tmp/Outpost.zip" "$tmp"
  mkdir -p "$dest"
  # Keeps installed packages and the build; the installer brings them up to date.
  rsync -a --delete --exclude node_modules --exclude dist "$tmp/Outpost/" "$dest/"
  # The installer asks questions, so it reads the keyboard rather than this piped script.
  "$dest/Install Outpost.command" </dev/tty
}
main "$@"
