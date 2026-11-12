#!/usr/bin/env bash
# Outpost setup for macOS. Safe to re-run.
#   ./scripts/setup-mac.sh [--lan] [--pull-models] [--no-service]
set -euo pipefail

LAN=0; PULL=0; SERVICE=1
for a in "$@"; do
  case "$a" in
    --lan) LAN=1 ;;
    --pull-models) PULL=1 ;;
    --no-service) SERVICE=0 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS."
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_DIR="$HOME/.config/outpost"
ENV_FILE="$CONF_DIR/env"
# Saved settings win over the default, so re-runs keep using the same data folder.
if [ -z "${OUTPOST_HOME:-}" ] && [ -f "$ENV_FILE" ]; then
  OUTPOST_HOME="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_HOME:-}")"
fi
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/Outpost}"
OUTPOST_HOME="${OUTPOST_HOME/#\~/$HOME}"

# macOS disks ignore case, so ~/outpost and ~/Outpost are the same folder. Keep code and data apart.
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
R="$(lc "$ROOT")/"; H="$(lc "$OUTPOST_HOME")/"
case "$R" in "$H"*) die "The Outpost code ($ROOT) is inside the data folder ($OUTPOST_HOME). Move the code to a folder outside it (for example ~/Developer/outpost), or set OUTPOST_HOME to another folder." ;; esac
case "$H" in "$R"*) die "The data folder ($OUTPOST_HOME) is inside the Outpost code folder ($ROOT). Set OUTPOST_HOME to a folder outside it." ;; esac

say "1/6 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
fi
command -v brew >/dev/null 2>&1 || die "Homebrew is not installed. Install it from https://brew.sh, then run this script again."

say "2/6 Node, Ollama, pmtiles, OSRM and osmium (offline directions)"
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
node_ok || brew install node
node_ok || die "Node 22 or newer is required."
command -v ollama >/dev/null 2>&1 || brew install ollama
command -v pmtiles >/dev/null 2>&1 || brew install pmtiles
command -v osrm-routed >/dev/null 2>&1 || brew install osrm-backend
command -v osmium >/dev/null 2>&1 || brew install osmium-tool

say "3/6 Kiwix reader (kiwix-serve)"
mkdir -p "$OUTPOST_HOME/bin"
if [ -x "$OUTPOST_HOME/bin/kiwix-serve" ] || command -v kiwix-serve >/dev/null 2>&1; then
  echo "kiwix-serve already installed."
else
  # Homebrew has no kiwix-tools formula, so the official macOS build is the only route. Kiwix's own server can be
  # very slow from some networks, so official mirrors go first; any that crawls below 50 KB/s is dropped for the next.
  # SHA-256 of the files Kiwix publishes (they match its .md5 files).
  case "$(uname -m)" in
    arm64) ARCH=arm64; SHA=5c64d43176627e558a117146b02ea36b7da2b0cd3a332cbff075cde05d9585f9 ;;
    *) ARCH=x86_64; SHA=ae341280e97ad5902e7a4282a24340eac7d7061c267661c0ef2a88a34547f247 ;;
  esac
  FILE="release/kiwix-tools/kiwix-tools_macos-$ARCH-3.8.2.tar.gz"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  GOT=""
  for MIRROR in https://ftp.fau.de/kiwix https://mirrors.dotsrc.org/kiwix https://download.kiwix.org; do
    echo "Downloading from $MIRROR"
    if curl -fL --progress-bar --connect-timeout 15 --speed-limit 50000 --speed-time 20 -o "$TMP/kt.tar.gz" "$MIRROR/$FILE" &&
      [ "$(shasum -a 256 "$TMP/kt.tar.gz" | cut -d' ' -f1)" = "$SHA" ]; then
      GOT="$MIRROR/$FILE"; break
    fi
    echo "That didn't work; trying the next mirror."
  done
  [ -n "$GOT" ] && tar -xzf "$TMP/kt.tar.gz" -C "$TMP" ||
    die "Could not download kiwix-serve. Check your connection, or download kiwix-tools 3.8.2 for macOS from https://download.kiwix.org/release/kiwix-tools/ and put kiwix-serve in $OUTPOST_HOME/bin/"
  BIN="$(find "$TMP" -type f -name kiwix-serve | head -1)"
  [ -n "$BIN" ] || die "kiwix-serve was not found in the download from $GOT"
  cp "$BIN" "$OUTPOST_HOME/bin/kiwix-serve"; chmod +x "$OUTPOST_HOME/bin/kiwix-serve"
  # In case the file was quarantined (e.g. copied from a browser download), clear the flag so it can run.
  xattr -d com.apple.quarantine "$OUTPOST_HOME/bin/kiwix-serve" 2>/dev/null || true
  "$OUTPOST_HOME/bin/kiwix-serve" --version >/dev/null 2>&1 || die "kiwix-serve was installed but does not run on this Mac. Check System Settings > Privacy & Security."
fi

say "4/6 Build Outpost"
cd "$ROOT"
npm install
npm run build

say "5/6 Settings"
mkdir -p "$OUTPOST_HOME" "$CONF_DIR"; chmod 700 "$CONF_DIR"
if [ ! -f "$ENV_FILE" ]; then
  : > "$ENV_FILE"; chmod 600 "$ENV_FILE"
  echo "OUTPOST_HOME=\"$OUTPOST_HOME\"" >> "$ENV_FILE"
fi
if [ "$LAN" = 1 ]; then
  PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  sed -i '' -e '/^OUTPOST_HOST=/d' -e '/^OUTPOST_USER=/d' -e '/^OUTPOST_PASSWORD=/d' "$ENV_FILE"
  { echo 'OUTPOST_HOST="0.0.0.0"'; echo 'OUTPOST_USER="outpost"'; echo "OUTPOST_PASSWORD=\"$PASS\""; } >> "$ENV_FILE"
  echo "Sharing on your network. Sign in as user 'outpost' with password: $PASS"
  echo "(Saved in $ENV_FILE. Phones can also use the HTTPS address shown on Home after setting it up at /join. Use it on a network you trust.)"
fi

if [ "$PULL" = 1 ]; then
  say "Downloading starter AI models"
  (pgrep -x ollama >/dev/null || (ollama serve >/dev/null 2>&1 &) ) ; sleep 3
  ollama pull nomic-embed-text
  ollama pull llama3.2:3b
fi

say "6/6 Start at login"
if [ "$SERVICE" = 1 ]; then
  brew services start ollama >/dev/null 2>&1 || true
  "$ROOT/scripts/install-launchd.sh"
else
  echo "Skipped. Start manually with: ./scripts/run.sh"
fi

PORT="$(set -a; . "$ENV_FILE"; printf '%s' "${OUTPOST_PORT:-}")"
say "Done. Open http://localhost:${PORT:-8080}"
echo "Optional: ./scripts/fetch-map-assets.sh adds place labels to offline maps."
