#!/usr/bin/env bash
# Cut a nightly to TestFlight, headless — the same xcodebuild pipeline as
# phone.sh, with archive + upload instead of device install.
#
#   apps/ios/nightly.sh              # tag nightly-YYYYMMDD, archive, upload
#   apps/ios/nightly.sh --no-upload  # archive only (no ASC credentials yet)
#
# Auth is an App Store Connect API key (Users & Access → Integrations):
#   TELAR_ASC_KEY_ID      e.g. ABC123DEF4
#   TELAR_ASC_ISSUER_ID   the UUID shown above the key list
#   TELAR_ASC_KEY_PATH    path to the downloaded AuthKey_ABC123DEF4.p8
#
# TestFlight needs a UNIQUE build number per upload; the minute-stamp is it.
# Internal-tester builds go live minutes after processing, no review.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TEAM="${DEVELOPMENT_TEAM:-MM74W7WGAM}"
BUNDLE="${TELAR_BUNDLE_ID:-com.telar.mobile}"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
TAG="nightly-$(date +%Y%m%d)"
ARCHIVE="$DIR/DerivedData-nightly/Telar-$BUILD_NUMBER.xcarchive"
# The Mac's Xcode beta when present; whatever xcode-select says otherwise
# (the CI runner's image Xcode).
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode-beta.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
fi

git tag "$TAG" 2>/dev/null && echo "tagged $TAG" || echo "tag $TAG already exists — rebuilding it"

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
  -allowProvisioningUpdates \
  -authenticationKeyID "$TELAR_ASC_KEY_ID" \
  -authenticationKeyIssuerID "$TELAR_ASC_ISSUER_ID" \
  -authenticationKeyPath "$TELAR_ASC_KEY_PATH"

echo "uploaded build $BUILD_NUMBER — it appears in TestFlight after processing (minutes)"
