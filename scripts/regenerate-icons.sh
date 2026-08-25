#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Tauri owns the platform matrix; the manifest keeps Android adaptive layers
# separate so the desktop tile is not merely shrunk into the launcher mask.
npm run tauri icon src-tauri/icons/icon-manifest.json

# Keep Fiddler's one extra 64px desktop asset in sync without suppressing the
# default Tauri outputs.
rm -rf /tmp/fiddler-icon-64
npm run tauri icon -- -p 64 -o /tmp/fiddler-icon-64 src-tauri/icons/icon.svg
cp /tmp/fiddler-icon-64/64x64.png src-tauri/icons/64x64.png

cp src-tauri/icons/ios/AppIcon-60x60@3x.png public/apple-touch-icon.png
cp src-tauri/icons/icon.ico public/favicon.ico
cp src-tauri/icons/icon.svg public/favicon.svg

# Nothing to mirror for Android: because the generated project is checked in,
# `tauri icon` writes the launcher resources straight into
# src-tauri/gen/android/app/src/main/res — the mipmaps, the adaptive-icon XML
# and the monochrome layer for themed icons — and they are committed from
# there.
#
# There used to be a copy step here that mirrored a second, checked-in set from
# src-tauri/icons/android into the generated project. It ran *after* the
# generation above, so every run of this script quietly restored whatever
# artwork that stale directory happened to hold, and the Android launcher icon
# could never change. That is why 0.1.5's icon refresh reached the Mac, iOS and
# the favicon while the phone kept the old blue folder for two versions. The
# directory it copied from is gone with it.
