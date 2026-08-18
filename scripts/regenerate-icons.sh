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

# The generated Android project is checked in, so mirror the launcher resources
# that Tauri creates under src-tauri/icons/android.
for dir in mipmap-anydpi-v26 mipmap-mdpi mipmap-hdpi mipmap-xhdpi mipmap-xxhdpi mipmap-xxxhdpi; do
  rm -rf "src-tauri/gen/android/app/src/main/res/$dir"
  cp -R "src-tauri/icons/android/$dir" "src-tauri/gen/android/app/src/main/res/$dir"
done
cp src-tauri/icons/android/values/ic_launcher_background.xml \
  src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml
