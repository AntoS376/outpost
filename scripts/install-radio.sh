#!/usr/bin/env bash
# Installs what Outpost's radio uses, from Homebrew: librtlsdr (rtl_fm, rtl_power, rtl_test) for the receiver and
# dump1090-fa for planes, rtl_433 for nearby sensors, direwolf for APRS. Installs only what is missing. Safe to re-run.
#   ./scripts/install-radio.sh
set -euo pipefail

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1 || [ -x "/opt/homebrew/bin/$1" ] || [ -x "/usr/local/bin/$1" ]; }

need=()
have rtl_fm || need+=(librtlsdr)
have dump1090 || need+=(dump1090-fa)
have rtl_433 || need+=(rtl_433)
have direwolf || need+=(direwolf)
if [ ${#need[@]} -eq 0 ]; then
  echo "The radio tools are already installed."
  exit 0
fi
command -v brew >/dev/null 2>&1 || for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
command -v brew >/dev/null 2>&1 || die "The radio tools come from Homebrew, which is not installed. Install Homebrew from https://brew.sh, then try again."
echo "Installing ${need[*]} with Homebrew..."
brew install "${need[@]}"
echo "Done."
