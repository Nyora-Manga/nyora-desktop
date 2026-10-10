#!/usr/bin/env bash
set -euo pipefail
# Native account persistence is tested against a real, disposable Secret Service.
export XDG_CURRENT_DESKTOP=GNOME
export GNOME_KEYRING_CONTROL="$(mktemp -d)"
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL"
node scripts/package-electron.mjs "--$TARGET_PLATFORM" "--$TARGET_ARCH"
