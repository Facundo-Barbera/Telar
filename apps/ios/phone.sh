#!/usr/bin/env bash
# Build and install "Telar Dev" on a cable-connected iPhone. Its own bundle id
# keeps it beside the TestFlight app, with its own pairing.
set -euo pipefail

DEVICE="${TELAR_IPHONE_UDID:-00008150-001A7DC2367B401C}"
TEAM="${DEVELOPMENT_TEAM:-MM74W7WGAM}"
DIR="$(cd "$(dirname "$0")" && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

MODE=dev
CONFIG=Debug
BUNDLE=io.github.novarix.telar.dev
NAME="Telar Dev"
ICON=AppIconDev

xcodebuild \
  -project "$DIR/TelarMobile.xcodeproj" -scheme TelarMobile \
  -configuration "$CONFIG" \
  -destination "platform=iOS,id=$DEVICE" \
  -derivedDataPath "$DIR/DerivedData-$MODE" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" \
  TELAR_APP_BUNDLE_ID="$BUNDLE" \
  INFOPLIST_KEY_CFBundleDisplayName="$NAME" \
  ASSETCATALOG_COMPILER_APPICON_NAME="$ICON" \
  build

APP="$DIR/DerivedData-$MODE/Build/Products/$CONFIG-iphoneos/TelarMobile.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE" || true
echo "installed $NAME ($BUNDLE, $CONFIG)"
