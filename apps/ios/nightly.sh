#!/usr/bin/env bash
# Archive and upload a Telar Mobile nightly to TestFlight. CI is the caller
# (.github/workflows/nightly-ios.yml, on an ios-nightly-* tag) — pushing the
# tag is how a nightly is cut. The runner is GitHub-hosted (macos-latest)
# since 2026-09-20; before that it was the maintainer's Mac mini. Either way
# the Xcode must be a RELEASE build — App Store Connect refuses a beta's
# uploads — which is why DEVELOPER_DIR is named rather than inherited.
#
# Three modes, and the middle one exists because of #757:
#   (no argument)   archive → export → upload to TestFlight.
#   --no-upload     archive only. Stops before credentials, so it runs by hand.
#   --export-only   archive → export, stops before altool. Needs credentials.
#
# `--export-only` IS THE ONE A FIX FOR #757 CAN BE TESTED WITH. That bug lived
# in the export and nowhere else, and until this mode existed the only way to
# reach the export was a run that also PUBLISHED to real TestFlight testers —
# so a candidate fix could not be tried without shipping a build to people.
# Four red nights went out before anyone could test anything. A step that
# breaks must be reachable without an audience.
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
#
# AFTER A SUCCESSFUL UPLOAD the build goes to the EXTERNAL group too:
# testflight-external.sh waits for processing, adds the build to the external
# "Nightly" group and submits it for Beta App Review. Internal testers get it
# regardless; that step only decides whether external ones do.
set -euo pipefail

# REJECT WHAT IT DOES NOT UNDERSTAND, because the default is to publish. A
# silently-ignored `--no-uplaod` would not stop the upload, it would ship a
# build to every internal tester; refusing an unknown word costs a typo and
# saves that.
MODE="${1:-}"
case "$MODE" in
  "" | --no-upload | --export-only) ;;
  *) echo "usage: $(basename "$0") [--no-upload | --export-only]" >&2; exit 2 ;;
esac

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

if [[ "$MODE" == "--no-upload" ]]; then
  echo "archived $ARCHIVE (export and upload skipped)"
  exit 0
fi

: "${TELAR_ASC_KEY_ID:?set TELAR_ASC_KEY_ID (App Store Connect API key id)}"
: "${TELAR_ASC_ISSUER_ID:?set TELAR_ASC_ISSUER_ID}"
: "${TELAR_ASC_KEY_PATH:?set TELAR_ASC_KEY_PATH (path to the .p8)}"

# SYSTEM rsync AHEAD OF HOMEBREW, and the export is why. Its last step stages
# the IPA with `/usr/bin/rsync -8aPhhE` — openrsync, which spells `-E` out as
# `--extended-attributes` for the SERVER half of the copy and resolves that
# half from PATH rather than by absolute path. A Homebrew rsync answers there
# instead, and 3.5.0 calls the flag `--xattrs`, so the copy dies and xcodebuild
# reports only `error: exportArchive Copy failed` with exit 70 — no mention of
# rsync, the archive having already succeeded.
#
# Measured: `rsync 3.5.0` landed in /opt/homebrew on the mini at 2026-09-18
# 20:07 and the next nightly was the first of four straight reds; the last
# green ran 15:43 the same day. Pinning /usr/bin first keeps the two halves of
# the copy speaking the same dialect whatever else gets brewed on later, which
# is the point — unlinking the brew rsync would fix today and break again on
# the next install.
PATH="/usr/bin:/bin:$PATH" xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$DIR/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyID "$TELAR_ASC_KEY_ID" \
  -authenticationKeyIssuerID "$TELAR_ASC_ISSUER_ID" \
  -authenticationKeyPath "$TELAR_ASC_KEY_PATH"

if [[ "$MODE" == "--export-only" ]]; then
  # Name the IPA the upload would have taken, so the check is that the file
  # the next step needs exists — not merely that xcodebuild exited 0.
  ls -l "$EXPORT_DIR/TelarMobile.ipa"
  echo "exported $EXPORT_DIR/TelarMobile.ipa (upload skipped)"
  exit 0
fi

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

echo "uploaded build $BUILD_NUMBER — internal testers get it after processing (minutes)"

# The external group needs the processed build added and reviewed; that is
# its own script so it can be re-run by hand against an upload that already
# happened. It is only reached in the default mode: --no-upload and
# --export-only exited above, before any credentials were used for publishing.
"$DIR/testflight-external.sh" "$BUILD_NUMBER"
