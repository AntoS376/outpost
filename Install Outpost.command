#!/bin/bash
# Double-click to install Outpost. Installs what it needs (with Homebrew), sets Outpost up as a service that starts
# at login, then opens it in your browser. Safe to run again: it updates an existing install.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Applications/Outpost"
ENV_FILE="$HOME/.config/outpost/env"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
stop() { printf '\n%s\n\nPress Return to close this window.' "$*"; read -r _ || true; exit 1; }
trap 'stop "Something went wrong (see above). Nothing you already had was removed. You can run the installer again."' ERR

[ "$(uname -s)" = Darwin ] || stop "Outpost's installer runs on a Mac only."
say "Installing Outpost"

# Homebrew installs the tools Outpost uses. Its own installer asks for your Mac password; Outpost never sees it.
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
if ! command -v brew >/dev/null; then
  say "Outpost needs Homebrew, a free tool that installs other programs."
  printf 'Install Homebrew now? It will ask for your Mac password. [Y/n] '
  read -r answer || answer=n
  case "$answer" in [nN]*) stop "Outpost wasn't installed. Run the installer again when you're ready." ;; esac
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
  command -v brew >/dev/null || stop "Homebrew didn't install, so Outpost can't continue."
fi

# macOS keeps background services out of Downloads, Desktop and Documents, so Outpost runs from ~/Applications.
# The code also can't live in the data folder (~/Outpost; Mac disks ignore case).
shopt -s nocasematch
case "$SRC/" in
  "$HOME/Downloads/"* | "$HOME/Desktop/"* | "$HOME/Documents/"* | "$HOME/Outpost/"*)
    say "Copying Outpost to $DEST"
    mkdir -p "$DEST"
    rsync -a --delete --exclude node_modules --exclude dist "$SRC/" "$DEST/"
    ROOT="$DEST" ;;
  *) ROOT="$SRC" ;;
esac
shopt -u nocasematch
# A downloaded copy is marked "from the internet"; clear that so the service's scripts can run.
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true

"$ROOT/scripts/setup-mac.sh"

PORT="$( ( [ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE"; printf '%s' "${OUTPOST_PORT:-8080}") )"
say "Starting Outpost…"
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/healthz" && break; sleep 1; done
open "http://localhost:$PORT"
say "Outpost is installed. It starts by itself when you log in."
echo "If you shut it down, double-click \"Start Outpost.command\" in $ROOT."
printf '\nYou can close this window.\n'
