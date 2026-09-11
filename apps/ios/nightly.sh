#!/usr/bin/env bash
# Archive and upload a Telar Mobile nightly to TestFlight. CI is the caller
# (.github/workflows/nightly-ios.yml, on an ios-nightly-* tag) — pushing the
# tag is how a nightly is cut. The runner is the Mac mini itself, with its
# one release Xcode (a BETA's build is refused by App Store Connect).
# Running by hand still works for debugging: `--no-upload` stops before
# credentials.
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
# The Mac's one Xcode. Named here so a bare `xcode-select` pointing at the
# Command Line Tools (which cannot archive an iOS app) never gets a chance.
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
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
  TELAR_APP_BUNDLE_ID="$BUNDLE" \
  CODE_SIGNING_ALLOWED=NO \
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

# altool can print a validation ERROR and still exit 0 (measured: run
# 33480175173 went green on a refused build) — the OUTPUT is the verdict.
UPLOAD_LOG=$(mktemp)
xcrun altool --upload-app \
  -f "$EXPORT_DIR/TelarMobile.ipa" -t ios \
  --apiKey "$TELAR_ASC_KEY_ID" --apiIssuer "$TELAR_ASC_ISSUER_ID" 2>&1 | tee "$UPLOAD_LOG"
if grep -q "ERROR" "$UPLOAD_LOG" || ! grep -q "UPLOAD SUCCEEDED" "$UPLOAD_LOG"; then
  echo "upload FAILED — see altool output above" >&2
  exit 1
fi

echo "uploaded build $BUILD_NUMBER — it appears in TestFlight after processing (minutes)"
