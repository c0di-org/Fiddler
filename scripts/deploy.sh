#!/usr/bin/env bash
#
# Build Fiddler and put it on this Mac and/or an attached Android device.
#
#   ./scripts/deploy.sh            both, macOS as a release build
#   ./scripts/deploy.sh mac        macOS only
#   ./scripts/deploy.sh android    Android only
#   ./scripts/deploy.sh mac --debug    a debug build: ~5x faster to compile
#
# Environment:
#   ANDROID_SERIAL   pick a specific adb device when several are attached
#   NDK_VERSION      override the NDK picked out of ~/Library/Android/sdk/ndk
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
step() { printf '\n%s==>%s %s%s\n' "$BOLD" "$OFF" "$1" "$OFF"; }
info() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

TARGET=both
PROFILE=release
for arg in "$@"; do
  case "$arg" in
    mac|macos)  TARGET=mac ;;
    android)    TARGET=android ;;
    both)       TARGET=both ;;
    --debug)    PROFILE=debug ;;
    --release)  PROFILE=release ;;
    -h|--help)  sed -n '2,13p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
    *)          die "unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------- macOS

build_mac() {
  step "Building Fiddler for macOS ($PROFILE)"
  local bundle_args=(--bundles app)
  [ "$PROFILE" = debug ] && bundle_args+=(--debug)
  # The release profile uses lto + codegen-units=1, so a cold build is minutes.
  npx tauri build "${bundle_args[@]}"

  local built="$ROOT/src-tauri/target/$PROFILE/bundle/macos/Fiddler.app"
  [ -d "$built" ] || die "expected a bundle at $built"

  step "Installing to /Applications"
  # Quit the running copy first. It holds the USB device exclusively — MTP
  # allows one connection per device — so a new instance would come up unable
  # to reach a phone that is plugged in and perfectly fine.
  #
  # Matching on the process *name* rather than -f on its path matters: a -f
  # pattern containing "/Applications/Fiddler.app" also matches this script's
  # own command line, and pkill would take the deploy down with the app.
  if pkill -x fiddler 2>/dev/null; then
    ok "quit the running Fiddler"
    sleep 1
  fi

  rm -rf /Applications/Fiddler.app
  cp -R "$built" /Applications/
  ok "installed $(du -sh /Applications/Fiddler.app | cut -f1) to /Applications/Fiddler.app"

  open /Applications/Fiddler.app
  ok "launched"
}

# -------------------------------------------------------------------- Android

android_env() {
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  [ -d "$ANDROID_HOME" ] || die "no Android SDK at $ANDROID_HOME (set ANDROID_HOME)"

  if [ -z "${NDK_HOME:-}" ]; then
    local version="${NDK_VERSION:-}"
    if [ -z "$version" ]; then
      # Newest installed NDK, unless one was named explicitly.
      version=$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)
    fi
    [ -n "$version" ] || die "no NDK under $ANDROID_HOME/ndk (install one in Android Studio)"
    export NDK_HOME="$ANDROID_HOME/ndk/$version"
  fi
  [ -d "$NDK_HOME" ] || die "NDK_HOME does not exist: $NDK_HOME"
  info "NDK $(basename "$NDK_HOME")"
}

# The device to install onto: a physical one on USB, by preference.
#
# `adb devices` lists a wirelessly-paired phone a second time as
# `adb-SERIAL-xxxx._adb-tls-connect._tcp`, and an emulator as `emulator-NNNN`.
# Installing over the wireless entry works but is slow, and the emulator is
# almost never what you meant, so both are a last resort.
pick_device() {
  local lines usb any
  lines=$(adb devices -l 2>/dev/null | tail -n +2 | grep -w device || true)
  [ -n "$lines" ] || return 1

  if [ -n "${ANDROID_SERIAL:-}" ]; then
    echo "$ANDROID_SERIAL"
    return 0
  fi

  usb=$(echo "$lines" | grep " usb:" | grep -v "^emulator-" | awk '{print $1}' | head -1)
  if [ -n "$usb" ]; then echo "$usb"; return 0; fi

  any=$(echo "$lines" | awk '{print $1}' | head -1)
  [ -n "$any" ] && echo "$any"
}

build_android() {
  android_env
  step "Building the Android APK (arm64, debug)"
  npm run tauri -- android build --debug --target aarch64

  local apk="$ROOT/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
  [ -f "$apk" ] || die "expected an APK at $apk"
  info "$(du -h "$apk" | cut -f1) $(basename "$apk")"

  step "Installing to the phone"
  local serial
  serial=$(pick_device) || {
    warn "no device visible to adb — the APK is built but not installed"
    warn "on the phone: Settings > About phone > Software information,"
    warn "tap 'Build number' 7 times, then Developer options > USB debugging,"
    warn "and approve this Mac when it asks"
    return 0
  }
  info "device $serial"

  case "$serial" in
    emulator-*)          warn "this is an emulator, not a phone" ;;
    *_adb-tls-connect*)  warn "installing over wireless adb; plug in USB for a faster copy" ;;
  esac

  adb -s "$serial" install -r "$apk"
  ok "installed"

  local pkg
  pkg=$(adb -s "$serial" shell pm list packages 2>/dev/null | grep -i fiddler | head -1 | sed 's/package://' | tr -d '\r')
  if [ -n "$pkg" ]; then
    adb -s "$serial" shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    ok "launched $pkg"
  fi
}

# ------------------------------------------------------------------------ run

# Written as plain `if`s rather than `[ x ] || [ y ] && cmd`: under `set -e`
# that form exits the script when both tests fail, so asking for one target
# would kill the run instead of skipping the other.
if [ "$TARGET" = mac ] || [ "$TARGET" = both ]; then
  build_mac
fi
if [ "$TARGET" = android ] || [ "$TARGET" = both ]; then
  build_android
fi

step "Done"
if [ "$TARGET" != android ]; then
  # Worth saying out loud, because it looks like a bug otherwise: none of the
  # USB/MTP work compiles into the Android app. The Mac is the USB host, so the
  # module is cfg'd out for android and the phone build is unchanged by it.
  info "USB device browsing is macOS-only — the Android build does not include it"
fi
