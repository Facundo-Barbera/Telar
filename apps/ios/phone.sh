#!/usr/bin/env bash
# Build Telar Mobile onto a connected iPhone, headless.
#
#   apps/ios/phone.sh nightly    # "Telar" — com.telar.mobile, Release
#   apps/ios/phone.sh dev        # "Telar Dev" — com.telar.mobile.dev, Debug,
#                                #   amber icon; installs BESIDE the nightly
#
# Two bundle ids is the whole trick: iOS treats them as unrelated apps, so a
# stable nightly and the moving dev build coexist. Each keeps its own
# pairing (Keychain and UserDefaults are per-app) — pair the dev app once
# and it stays paired across dev installs.
set -euo pipefail

MODE="${1:-dev}"
DEVICE="${TELAR_IPHONE_UDID:-00008150-001A7DC2367B401C}"
TEAM="${DEVELOPMENT_TEAM:-MM74W7WGAM}"
DIR="$(cd "$(dirname "$0")" && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"

case "$MODE" in
  nightly)
    CONFIG=Release
    BUNDLE=com.telar.mobile
    NAME="Telar"
    ICON=AppIcon
    ;;
  dev)
    CONFIG=Debug
    BUNDLE=com.telar.mobile.dev
    NAME="Telar Dev"
    ICON=AppIconDev
    ;;
  *)
    echo "usage: phone.sh [nightly|dev]" >&2
    exit 2
    ;;
esac

xcodebuild \
  -project "$DIR/TelarMobile.xcodeproj" -scheme TelarMobile \
  -configuration "$CONFIG" \
  -destination "platform=iOS,id=$DEVICE" \
  -derivedDataPath "$DIR/DerivedData-$MODE" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
  INFOPLIST_KEY_CFBundleDisplayName="$NAME" \
  ASSETCATALOG_COMPILER_APPICON_NAME="$ICON" \
  build

APP="$DIR/DerivedData-$MODE/Build/Products/$CONFIG-iphoneos/TelarMobile.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" || true
echo "installed $NAME ($BUNDLE, $CONFIG)"
