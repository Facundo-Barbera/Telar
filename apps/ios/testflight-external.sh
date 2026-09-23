#!/usr/bin/env bash
# Offer an uploaded nightly to TestFlight's EXTERNAL group "Nightly".
# nightly.sh calls this after `altool --upload-app` has said UPLOAD SUCCEEDED;
# by then the internal group already has the build (no review, live once
# processing ends). External testers need three more things, and Apple does
# none of them on its own:
#
#   1. wait until App Store Connect has PROCESSED the build (VALID),
#   2. add the build to the external group,
#   3. submit it for Beta App Review.
#
# The first build of each new marketing version sits in Beta App Review for
# hours, sometimes a day; later builds of the SAME version are re-approved in
# minutes. That is Apple's rule, not this script's, so a nightly right after a
# version bump reaches external testers late and the next one is fast again.
#
# Usage: testflight-external.sh <build-number>
#   (the CURRENT_PROJECT_VERSION nightly.sh minted — the minute-stamp)
#
# Reads the same credentials as nightly.sh — TELAR_ASC_KEY_ID,
# TELAR_ASC_ISSUER_ID, TELAR_ASC_KEY_PATH (the .p8; Admin role) — and talks to
# App Store Connect API v1 directly, with an ES256 JWT minted here. NOTHING IS
# INSTALLED: python3 (stdlib) builds the token and `openssl dgst` signs it,
# both of which every macOS runner image carries. One signing path rather than
# "cryptography if present, openssl otherwise", because a branch that only runs
# on machines with an optional package is a branch nobody has run.
#
# NEVER PRINT THE TOKEN. The Authorization header is built inside `set +x` and
# passed to curl from a variable; what this script prints is the HTTP status
# of each call and Apple's own `errors[].detail`, never a request.
#
# Exit codes: 0 when the build is offered (or already was); 0 with a
# `::warning::` when processing outran the wait — the upload itself succeeded
# and internal testers have the build, so a slow Apple is not a red nightly;
# non-zero when Apple REFUSED something (INVALID/FAILED processing, no
# external group, any other 4xx).
#
# Overridable for tests and for hand runs, all optional:
#   TELAR_ASC_APP_ID                  App Store Connect app id (6807300090)
#   TELAR_TESTFLIGHT_EXTERNAL_GROUP   the external group's name (Nightly)
#   TELAR_ASC_POLL_SECONDS            seconds between processing polls (30)
#   TELAR_ASC_POLL_TIMEOUT_SECONDS    how long to wait for VALID (1800)
set -euo pipefail

BUILD_NUMBER="${1:-}"
if [[ -z "$BUILD_NUMBER" ]]; then
  echo "usage: $(basename "$0") <build-number>" >&2
  exit 2
fi
: "${TELAR_ASC_KEY_ID:?set TELAR_ASC_KEY_ID (App Store Connect API key id)}"
: "${TELAR_ASC_ISSUER_ID:?set TELAR_ASC_ISSUER_ID}"
: "${TELAR_ASC_KEY_PATH:?set TELAR_ASC_KEY_PATH (path to the .p8)}"

APP_ID="${TELAR_ASC_APP_ID:-6807300090}"
GROUP_NAME="${TELAR_TESTFLIGHT_EXTERNAL_GROUP:-Nightly}"
POLL_SECONDS="${TELAR_ASC_POLL_SECONDS:-30}"
POLL_TIMEOUT_SECONDS="${TELAR_ASC_POLL_TIMEOUT_SECONDS:-1800}"
API="https://api.appstoreconnect.apple.com"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BODY="$WORK/body.json"

# ES256 JWT, per Apple's "Generating Tokens for API Requests": header
# {alg, kid, typ}, payload {iss, iat, exp ≤ iat+20min, aud}. Minted fresh for
# EVERY call — a token is good for 20 minutes and the processing wait can run
# 30, so caching one would expire mid-poll. `openssl dgst -sign` returns the
# signature as DER (SEQUENCE of two INTEGERs); a JWS wants the raw 64-byte
# r||s, which is what the small DER walk below produces.
mint_jwt() {
  python3 - "$TELAR_ASC_KEY_ID" "$TELAR_ASC_ISSUER_ID" "$TELAR_ASC_KEY_PATH" <<'PYTHON'
import base64, json, subprocess, sys, time

key_id, issuer_id, key_path = sys.argv[1:4]
b64 = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
compact = lambda obj: json.dumps(obj, separators=(",", ":")).encode()

now = int(time.time())
header = b64(compact({"alg": "ES256", "kid": key_id, "typ": "JWT"}))
payload = b64(compact({"iss": issuer_id, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"}))
signing_input = f"{header}.{payload}".encode()

der = subprocess.run(
    ["openssl", "dgst", "-sha256", "-sign", key_path],
    input=signing_input, capture_output=True, check=True,
).stdout

# DER ECDSA-Sig-Value: 0x30 <len> 0x02 <rlen> r 0x02 <slen> s. Each INTEGER
# may carry a leading 0x00 (sign byte) or be short; to_bytes(32) normalises.
if der[0] != 0x30:
    sys.exit("openssl did not return a DER SEQUENCE")
at = 2 + (der[1] & 0x7F if der[1] & 0x80 else 0)
parts = []
for _ in range(2):
    if der[at] != 0x02:
        sys.exit("openssl signature is not two DER INTEGERs")
    length = der[at + 1]
    parts.append(int.from_bytes(der[at + 2:at + 2 + length], "big"))
    at += 2 + length
signature = b"".join(part.to_bytes(32, "big") for part in parts)

print(f"{header}.{payload}.{b64(signature)}")
PYTHON
}

# One App Store Connect call: asc METHOD PATH [JSON-BODY]. Leaves the HTTP
# status in STATUS ("000" when no response came back at all) and the response
# body in $BODY, and prints the status. It does not decide what a status
# means — each step below does, because 409 is success for one of them.
#
# `--globoff`: the query strings carry literal `[` `]` (filter[app]) and curl
# would otherwise read those as a range to expand. `--fail-with-body`: a 4xx
# still writes Apple's error body, which is the only diagnostic worth having.
asc() {
  local method="$1" path="$2" data="${3:-}"
  local tracing=0
  case $- in *x*) tracing=1 ;; esac
  # The token exists only between these two lines, and never in a trace.
  set +x
  local auth
  auth="Authorization: Bearer $(mint_jwt)"
  local rc=0
  STATUS="$(curl --globoff --fail-with-body -sS --max-time 30 \
    -X "$method" \
    -H "$auth" \
    -H "Content-Type: application/json" \
    ${data:+--data "$data"} \
    -o "$BODY" -w '%{http_code}' \
    "$API$path" 2>"$WORK/curl.err")" || rc=$?
  unset auth
  if (( tracing )); then set -x; fi
  if [[ -z "$STATUS" || "$STATUS" == "000" ]]; then
    STATUS="000"
    # A transport failure (no route, timeout): curl's own message names the
    # host and the reason, nothing more.
    echo "$method $path -> no response (curl exit $rc): $(cat "$WORK/curl.err")" >&2
  else
    echo "$method $path -> $STATUS"
  fi
}

# Apple's `errors[].detail`, one per line, from the last response.
apple_errors() {
  python3 - "$BODY" <<'PYTHON'
import json, sys
try:
    with open(sys.argv[1]) as body:
        errors = json.load(body).get("errors", [])
except (OSError, ValueError):
    sys.exit()
for error in errors:
    print(f"{error.get('code', '?')}: {error.get('detail') or error.get('title') or ''}")
PYTHON
}

fail_with_apple_errors() {
  echo "::error::$1 (HTTP $STATUS)" >&2
  apple_errors >&2
  exit 1
}

# ---- 1. Wait for processing ------------------------------------------------
#
# The upload returns before App Store Connect has even registered the build,
# so the first polls may find nothing at all (`data: []`), then PROCESSING,
# then VALID. INVALID and FAILED are terminal and mean the build will never
# reach anyone, internal testers included — that is an error. Outrunning the
# wait is not: Apple is sometimes slow for an hour and the build still lands.
build_id=""
started="$(date +%s)"
while :; do
  asc GET "/v1/builds?filter[app]=$APP_ID&filter[version]=$BUILD_NUMBER&fields[builds]=processingState"
  case "$STATUS" in
    200)
      read -r state build_id <<<"$(python3 - "$BODY" <<'PYTHON'
import json, sys
try:
    with open(sys.argv[1]) as body:
        builds = json.load(body).get("data", [])
except (OSError, ValueError):
    builds = None
if builds is None:
    print("UNPARSEABLE -")
elif builds:
    print(builds[0]["attributes"].get("processingState", "UNKNOWN"), builds[0]["id"])
else:
    print("ABSENT -")
PYTHON
)"
      case "$state" in
        VALID)
          echo "build $BUILD_NUMBER ($build_id) is processed"
          break
          ;;
        INVALID | FAILED)
          echo "::error::build $BUILD_NUMBER finished processing as $state; App Store Connect will not distribute it to anyone" >&2
          exit 1
          ;;
        ABSENT) echo "build $BUILD_NUMBER is not visible to App Store Connect yet" ;;
        *) echo "build $BUILD_NUMBER is $state" ;;
      esac
      ;;
    000 | 429 | 5??)
      # Transient: Apple's side or the network. Keep polling.
      apple_errors >&2
      ;;
    *)
      # A 401/403/404 on the poll will not fix itself in thirty seconds.
      fail_with_apple_errors "could not read build $BUILD_NUMBER's processing state"
      ;;
  esac
  if (( $(date +%s) - started >= POLL_TIMEOUT_SECONDS )); then
    echo "::warning::build $BUILD_NUMBER was still not processed after ${POLL_TIMEOUT_SECONDS}s; the upload succeeded and internal testers get it when Apple finishes, but it was NOT offered to the external group '$GROUP_NAME' — add it by hand in App Store Connect"
    exit 0
  fi
  sleep "$POLL_SECONDS"
done

# ---- 2. Find the external group --------------------------------------------
#
# An INTERNAL group of the same name exists, so the name alone is not enough:
# `filter[isInternalGroup]=false` picks the external one, and the answer is
# re-checked here rather than trusted, because a filter Apple quietly stopped
# honouring would otherwise send the build to the wrong group without a word.
encoded_group="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$GROUP_NAME")"
asc GET "/v1/apps/$APP_ID/betaGroups?filter[name]=$encoded_group&filter[isInternalGroup]=false&fields[betaGroups]=name,isInternalGroup"
if [[ "$STATUS" != "200" ]]; then
  fail_with_apple_errors "could not list the beta groups of app $APP_ID"
fi
group_report="$(python3 - "$BODY" "$GROUP_NAME" <<'PYTHON'
import json, sys
with open(sys.argv[1]) as body:
    groups = json.load(body).get("data", [])
wanted = sys.argv[2]
matching = [
    group for group in groups
    if group["attributes"].get("name") == wanted and group["attributes"].get("isInternalGroup") is False
]
if len(matching) == 1:
    print("OK", matching[0]["id"])
else:
    found = ", ".join(
        f"'{g['attributes'].get('name')}' ({'internal' if g['attributes'].get('isInternalGroup') else 'external'}, id {g['id']})"
        for g in groups
    ) or "no groups at all"
    print("NONE" if not matching else "MANY", found)
PYTHON
)"
read -r group_verdict group_detail <<<"$group_report"
case "$group_verdict" in
  OK) group_id="$group_detail" ;;
  NONE)
    echo "::error::app $APP_ID has no EXTERNAL beta group named '$GROUP_NAME'; the query found: $group_detail. Create the external group in App Store Connect → TestFlight, or set TELAR_TESTFLIGHT_EXTERNAL_GROUP." >&2
    exit 1
    ;;
  *)
    echo "::error::app $APP_ID has more than one external beta group named '$GROUP_NAME', so there is no one group to add the build to; found: $group_detail" >&2
    exit 1
    ;;
esac
echo "external group '$GROUP_NAME' is $group_id"

# Does the last response say the work is ALREADY done? A 409, or an
# ENTITY_ERROR of any status, whose detail says "already ...". Both remaining
# calls treat that as success: a re-run after a dead step must not fail
# because the earlier attempt got halfway.
already_done() {
  python3 - "$BODY" "$STATUS" <<'PYTHON'
import json, sys
try:
    with open(sys.argv[1]) as body:
        errors = json.load(body).get("errors", [])
except (OSError, ValueError):
    sys.exit(1)
conflict = sys.argv[2] == "409"
for error in errors:
    text = f"{error.get('detail') or ''} {error.get('title') or ''}".lower()
    if (conflict or "ENTITY_ERROR" in str(error.get("code", ""))) and "already" in text:
        sys.exit(0)
sys.exit(1)
PYTHON
}

# ---- 3. Add the build to the group -----------------------------------------
asc POST "/v1/betaGroups/$group_id/relationships/builds" "{\"data\":[{\"type\":\"builds\",\"id\":\"$build_id\"}]}"
case "$STATUS" in
  204) echo "build $BUILD_NUMBER added to '$GROUP_NAME'" ;;
  409)
    if already_done; then
      echo "build $BUILD_NUMBER was already in '$GROUP_NAME':"
      apple_errors
    else
      fail_with_apple_errors "App Store Connect refused to add build $BUILD_NUMBER to '$GROUP_NAME'"
    fi
    ;;
  *) fail_with_apple_errors "App Store Connect refused to add build $BUILD_NUMBER to '$GROUP_NAME'" ;;
esac

# ---- 4. Submit for Beta App Review -----------------------------------------
#
# A build that is already submitted, or already approved (a later build of a
# version whose first build passed), answers 409 / ENTITY_ERROR with an
# "already ..." detail. That is the state this step wants, so it is success.
asc POST "/v1/betaAppReviewSubmissions" "{\"data\":{\"type\":\"betaAppReviewSubmissions\",\"relationships\":{\"build\":{\"data\":{\"type\":\"builds\",\"id\":\"$build_id\"}}}}}"
case "$STATUS" in
  201) echo "build $BUILD_NUMBER submitted for Beta App Review; external testers in '$GROUP_NAME' get it when Apple approves it" ;;
  4??)
    if already_done; then
      echo "build $BUILD_NUMBER needs no new Beta App Review submission:"
      apple_errors
    else
      fail_with_apple_errors "App Store Connect refused the Beta App Review submission for build $BUILD_NUMBER"
    fi
    ;;
  *) fail_with_apple_errors "App Store Connect refused the Beta App Review submission for build $BUILD_NUMBER" ;;
esac
