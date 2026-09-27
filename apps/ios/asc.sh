# App Store Connect API v1 helpers shared by testflight-app.sh and
# testflight-external.sh. Sourced, not run: the caller sets `set -euo pipefail`,
# the TELAR_ASC_* credentials, and WORK (a scratch dir it cleans up). Each call
# leaves the HTTP status in STATUS and the response body in $BODY.
API="https://api.appstoreconnect.apple.com"
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

# The App Store Connect app id for a bundle id, into APP_ID. Exits when there
# is no such app: every later call is scoped to it, so nothing else can run.
resolve_app() {
  local bundle="$1"
  asc GET "/v1/apps?filter[bundleId]=$bundle&fields[apps]=bundleId"
  if [[ "$STATUS" != "200" ]]; then
    fail_with_apple_errors "could not look up the App Store Connect app for $bundle"
  fi
  APP_ID="$(python3 - "$BODY" "$bundle" <<'PYTHON'
import json, sys
with open(sys.argv[1]) as body:
    apps = json.load(body).get("data", [])
matching = [a["id"] for a in apps if a.get("attributes", {}).get("bundleId") == sys.argv[2]]
print(matching[0] if len(matching) == 1 else "")
PYTHON
)"
  if [[ -z "$APP_ID" ]]; then
    echo "::error::App Store Connect has no single app with bundle id $bundle; create its app record first" >&2
    exit 1
  fi
  echo "app $bundle is $APP_ID"
}
