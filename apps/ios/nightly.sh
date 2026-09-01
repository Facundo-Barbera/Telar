#!/usr/bin/env bash
# Archive and upload a Telar Mobile nightly to TestFlight. CI is the caller
# (.github/workflows/nightly-ios.yml, on an ios-nightly-* tag) — pushing the
# tag is how a nightly is cut. Running locally still works for debugging
# (`--no-upload` to stop before credentials), but a build from this Mac's
# BETA Xcode is refused by App Store Connect; the runner's release Xcode is
# the one Apple accepts.
#
# EXPORT THEN UPLOAD, deliberately two steps: exportArchive with
# `destination: upload` ships the archive's DEVELOPMENT-signed binary and
# Apple refuses it (90035) — the re-sign to Apple Distribution only happens
# on the way to an exported IPA. So the IPA is exported, then pushed with
# altool.
#
# Auth is an App Store Connect API key (Admin — cloud signing needs it):
#   TELAR_ASC_KEY_ID, TELAR_ASC_ISSUER_ID, TELAR_ASC_KEY_PATH (the .p8)
#
# TestFlight needs a UNIQUE build number per upload; the minute-stamp is it.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TEAM="${DEVELOPMENT_TEAM:-MM74W7WGAM}"
BUNDLE="${TELAR_BUNDLE_ID:-com.telar.mobile}"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
ARCHIVE="$DIR/DerivedData-nightly/Telar-$BUILD_NUMBER.xcarchive"
EXPORT_DIR="$DIR/DerivedData-nightly/export-$BUILD_NUMBER"
# The Mac's Xcode beta when present; whatever xcode-select says otherwise
# (the CI runner's image Xcode).
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode-beta.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
fi

xcodebuild \
  -project "$DIR/TelarMobile.xcodeproj" -scheme TelarMobile \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DIR/DerivedData-nightly" \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  ${TELAR_ASC_KEY_ID:+-authenticationKeyID "$TELAR_ASC_KEY_ID"} \
  ${TELAR_ASC_ISSUER_ID:+-authenticationKeyIssuerID "$TELAR_ASC_ISSUER_ID"} \
  ${TELAR_ASC_KEY_PATH:+-authenticationKeyPath "$TELAR_ASC_KEY_PATH"} \
  DEVELOPMENT_TEAM="$TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
  INFOPLIST_KEY_CFBundleDisplayName="Telar" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive

if [[ "${1:-}" == "--no-upload" ]]; then
  echo "archived $ARCHIVE (upload skipped)"
  exit 0
fi

: "${TELAR_ASC_KEY_ID:?set TELAR_ASC_KEY_ID (App Store Connect API key id)}"
: "${TELAR_ASC_ISSUER_ID:?set TELAR_ASC_ISSUER_ID}"
: "${TELAR_ASC_KEY_PATH:?set TELAR_ASC_KEY_PATH (path to the .p8)}"

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$DIR/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyID "$TELAR_ASC_KEY_ID" \
  -authenticationKeyIssuerID "$TELAR_ASC_ISSUER_ID" \
  -authenticationKeyPath "$TELAR_ASC_KEY_PATH"

# altool finds keys by NAME in a directory, not by path — stage the key
# where it looks, under the name it expects.
KEYS_DIR="$(mktemp -d)/private_keys"
mkdir -p "$KEYS_DIR"
cp "$TELAR_ASC_KEY_PATH" "$KEYS_DIR/AuthKey_$TELAR_ASC_KEY_ID.p8"
trap 'rm -rf "$(dirname "$KEYS_DIR")"' EXIT
export API_PRIVATE_KEYS_DIR="$KEYS_DIR"

xcrun altool --upload-app \
  -f "$EXPORT_DIR/TelarMobile.ipa" -t ios \
  --apiKey "$TELAR_ASC_KEY_ID" --apiIssuer "$TELAR_ASC_ISSUER_ID"

echo "uploaded build $BUILD_NUMBER — it appears in TestFlight after processing (minutes)"
