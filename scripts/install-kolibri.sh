#!/usr/bin/env bash
# Installs Kolibri (offline courses and exercises) into ~/Outpost/kolibri-venv. No sudo. Safe to re-run.
#   ./scripts/install-kolibri.sh
set -euo pipefail

KOLIBRI_VERSION="0.19.5" # pinned; Kolibri 0.19 runs on Python 3.6 to 3.14
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

ENV_FILE="$HOME/.config/outpost/env"
if [ -z "${OUTPOST_HOME:-}" ] && [ -f "$ENV_FILE" ]; then OUTPOST_HOME="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-}")"; fi
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/Outpost}"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"
VENV="$OUTPOST_HOME/kolibri-venv"
# Kolibri's own data (accounts, channels) goes here; without this it would use ~/.kolibri.
export KOLIBRI_HOME="$OUTPOST_HOME/kolibri"

# A Python Kolibri supports. macOS's newest Python is often too new, so look for an older one first.
find_python() {
  for v in 3.13 3.12 3.11 3.10 3.14; do
    for p in "/opt/homebrew/bin/python$v" "/usr/local/bin/python$v" "/Library/Frameworks/Python.framework/Versions/$v/bin/python3"; do
      if [ -x "$p" ]; then echo "$p"; return 0; fi
    done
  done
  return 0
}
PY="$(find_python)"
if [ -z "$PY" ]; then
  command -v brew >/dev/null 2>&1 || for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
  command -v brew >/dev/null 2>&1 || die "Kolibri needs Python 3.10 to 3.14, and Homebrew is not installed to get one. Install Homebrew from https://brew.sh, then run this again."
  echo "Kolibri needs Python 3.10 to 3.14; installing Python 3.13 with Homebrew..."
  brew install python@3.13
  PY="$(find_python)"
  [ -n "$PY" ] || die "Python 3.13 was installed but not found. Run: brew link python@3.13, then try again."
fi
echo "Using $PY ($("$PY" --version))"

if [ -x "$VENV/bin/kolibri" ] && [ "$("$VENV/bin/python" -c 'import kolibri; print(kolibri.__version__)' 2>/dev/null)" = "$KOLIBRI_VERSION" ]; then
  echo "Kolibri $KOLIBRI_VERSION is already installed in $VENV."
  exit 0
fi

mkdir -p "$OUTPOST_HOME"
[ -d "$VENV" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
echo "Downloading Kolibri $KOLIBRI_VERSION (about 100 MB)..."
"$VENV/bin/python" -m pip install --quiet "kolibri==$KOLIBRI_VERSION"
"$VENV/bin/kolibri" --version >/dev/null || die "Kolibri installed but does not start. See the messages above."
echo "Kolibri $KOLIBRI_VERSION installed in $VENV. Start it from Outpost's Education page."
