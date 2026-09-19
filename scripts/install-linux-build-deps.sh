#!/usr/bin/env bash
# Install Fiddler Linux/Tauri build packages. On nucchuck the packages are
# preinstalled and there is no passwordless sudo, so this is a no-op when
# everything is already present.
set -euo pipefail

packages=(
  libwebkit2gtk-4.1-dev
  build-essential
  curl
  wget
  file
  libxdo-dev
  libssl-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libudev-dev
  desktop-file-utils
  appstream
  dbus
  dbus-x11
)

missing=()
for package in "${packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    missing+=("$package")
  fi
done

if ((${#missing[@]} == 0)); then
  echo "Linux build dependencies already installed."
  exit 0
fi

if sudo -n true 2>/dev/null; then
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  exit 0
fi

echo "Missing packages and no passwordless sudo: ${missing[*]}" >&2
echo "Install them on the runner host, then re-run." >&2
exit 1
