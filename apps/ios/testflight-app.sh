#!/usr/bin/env bash
# Make an App Store Connect app ready for TestFlight nightlies. nightly.sh runs
# it before every upload; it is idempotent, so a set-up app costs a few GETs.
#
# A brand-new app record (io.github.novarix.telar, #1042) has no beta groups,
# no testers and no Beta App Review information, and Apple creates none of
# them. So, in order of how much the morning depends on it:
#
#   1. find the app by bundle id (an error if there is none: nothing else can run),
#   2. an INTERNAL group with access to every build, holding the account
#      holder. Internal builds need no Beta App Review, so this alone makes a
#      nightly installable once processing ends,
#   3. the beta app description, feedback email and privacy URL, and the Beta
#      App Review contact, copied from the template app (the old "Telar Mobile")
#      where the new one has none, since Beta App Review refuses a submission
#      without them,
#   4. the EXTERNAL group testflight-external.sh submits builds to.
#
# Only step 1 fails the script. Steps 2 to 4 warn and carry on: the upload is
# worth having even if one of them needs a hand in App Store Connect.
#
# The template's demo-account credentials are never copied or read: Telar
# needs none, and a password has no business in a CI log.
#
# Usage: testflight-app.sh
#   Same credentials as nightly.sh (TELAR_ASC_KEY_ID, TELAR_ASC_ISSUER_ID,
#   TELAR_ASC_KEY_PATH; Admin role, which listing users needs). Optional:
#   TELAR_BUNDLE_ID                   the app (io.github.novarix.telar)
#   TELAR_ASC_TEMPLATE_APP_ID         app to copy beta info from (6807300090)
#   TELAR_TESTFLIGHT_INTERNAL_GROUP   internal group's name (Internal)
#   TELAR_TESTFLIGHT_EXTERNAL_GROUP   external group's name (Nightly)
set -euo pipefail

: "${TELAR_ASC_KEY_ID:?set TELAR_ASC_KEY_ID (App Store Connect API key id)}"
: "${TELAR_ASC_ISSUER_ID:?set TELAR_ASC_ISSUER_ID}"
: "${TELAR_ASC_KEY_PATH:?set TELAR_ASC_KEY_PATH (path to the .p8)}"

BUNDLE="${TELAR_BUNDLE_ID:-io.github.novarix.telar}"
TEMPLATE_APP_ID="${TELAR_ASC_TEMPLATE_APP_ID:-6807300090}"
INTERNAL_GROUP="${TELAR_TESTFLIGHT_INTERNAL_GROUP:-Internal}"
EXTERNAL_GROUP="${TELAR_TESTFLIGHT_EXTERNAL_GROUP:-Nightly}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
source "$(dirname "$0")/asc.sh"

warn() {
  echo "::warning::$1 (HTTP $STATUS)"
  apple_errors
}

# Reads $BODY with a python snippet that gets the remaining arguments.
json() {
  local code="$1"; shift
  python3 -c "$code" "$BODY" "$@"
}

# ---- 1. The app --------------------------------------------------------------
APP_ID=""
resolve_app "$BUNDLE"
if [[ "$APP_ID" == "$TEMPLATE_APP_ID" ]]; then TEMPLATE_APP_ID=""; fi

# ---- 2. The internal group, and the account holder in it ---------------------
#
# `hasAccessToAllBuilds` is what puts every processed build in front of the
# group without an explicit add, which is how the old app's internal testers
# always got nightlies.
setup_internal() {
  asc GET "/v1/betaGroups?filter[app]=$APP_ID&filter[isInternalGroup]=true&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds"
  [[ "$STATUS" == "200" ]] || { warn "could not list the internal beta groups of app $APP_ID"; return; }
  local verdict group_id
  read -r verdict group_id <<<"$(json '
import json, sys
groups = [g for g in json.load(open(sys.argv[1])).get("data", []) if g["attributes"].get("isInternalGroup")]
named = [g for g in groups if g["attributes"].get("name") == sys.argv[2]] or groups
if not named: print("NONE -")
else: print("ALL" if named[0]["attributes"].get("hasAccessToAllBuilds") else "SOME", named[0]["id"])
' "$INTERNAL_GROUP")"
  case "$verdict" in
    NONE)
      asc POST "/v1/betaGroups" "$(python3 -c '
import json, sys
print(json.dumps({"data": {"type": "betaGroups", "attributes": {"name": sys.argv[1], "isInternalGroup": True, "hasAccessToAllBuilds": True}, "relationships": {"app": {"data": {"type": "apps", "id": sys.argv[2]}}}}}))
' "$INTERNAL_GROUP" "$APP_ID")"
      [[ "$STATUS" == "201" ]] || { warn "could not create the internal group '$INTERNAL_GROUP'"; return; }
      group_id="$(json 'import json, sys; print(json.load(open(sys.argv[1]))["data"]["id"])')"
      echo "created internal group '$INTERNAL_GROUP' ($group_id)"
      ;;
    SOME)
      asc PATCH "/v1/betaGroups/$group_id" "{\"data\":{\"type\":\"betaGroups\",\"id\":\"$group_id\",\"attributes\":{\"hasAccessToAllBuilds\":true}}}"
      [[ "$STATUS" == "200" ]] || warn "could not give internal group $group_id access to every build"
      ;;
    *) echo "internal group $group_id gets every build" ;;
  esac

  # The account holder, by the email their App Store Connect user carries.
  # Printed never: a public log gets the tester's presence, not their address.
  asc GET "/v1/users?filter[roles]=ACCOUNT_HOLDER&fields[users]=username,firstName,lastName"
  [[ "$STATUS" == "200" ]] || { warn "could not find the account holder"; return; }
  local holder
  holder="$(json '
import json, sys
users = json.load(open(sys.argv[1])).get("data", [])
if users:
    a = users[0]["attributes"]
    print(json.dumps({"email": a.get("username"), "firstName": a.get("firstName"), "lastName": a.get("lastName")}))
')"
  [[ -n "$holder" ]] || { warn "App Store Connect listed no account holder"; return; }
  local email
  email="$(python3 -c 'import json, sys, urllib.parse; print(urllib.parse.quote(json.loads(sys.argv[1])["email"]))' "$holder")"
  asc GET "/v1/betaTesters?filter[email]=$email&filter[apps]=$APP_ID&fields[betaTesters]=email"
  local tester=""
  if [[ "$STATUS" == "200" ]]; then
    tester="$(json 'import json, sys; d = json.load(open(sys.argv[1])).get("data", []); print(d[0]["id"] if d else "")')"
  fi
  if [[ -n "$tester" ]]; then
    asc POST "/v1/betaGroups/$group_id/relationships/betaTesters" "{\"data\":[{\"type\":\"betaTesters\",\"id\":\"$tester\"}]}"
    [[ "$STATUS" == "204" ]] || already_done || warn "could not add the account holder to '$INTERNAL_GROUP'"
  else
    asc POST "/v1/betaTesters" "$(python3 -c '
import json, sys
holder = {k: v for k, v in json.loads(sys.argv[1]).items() if v}
print(json.dumps({"data": {"type": "betaTesters", "attributes": holder, "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": sys.argv[2]}]}}}}))
' "$holder" "$group_id")"
    [[ "$STATUS" == "201" ]] || already_done || { warn "could not add the account holder to '$INTERNAL_GROUP'"; return; }
  fi
  echo "the account holder is an internal tester in '$INTERNAL_GROUP'"
}

# ---- 3. Beta App Review information -----------------------------------------
setup_review_info() {
  [[ -n "$TEMPLATE_APP_ID" ]] || return 0
  asc GET "/v1/apps/$APP_ID/betaAppLocalizations"
  [[ "$STATUS" == "200" ]] || { warn "could not read the beta app localizations of app $APP_ID"; return; }
  cp "$BODY" "$WORK/own-localizations.json"
  asc GET "/v1/apps/$TEMPLATE_APP_ID/betaAppLocalizations"
  [[ "$STATUS" == "200" ]] || { warn "could not read the template app's beta app localizations"; return; }
  local payload
  while IFS= read -r payload; do
    [[ -n "$payload" ]] || continue
    asc POST "/v1/betaAppLocalizations" "$payload"
    [[ "$STATUS" == "201" ]] || already_done || warn "could not copy a beta app localization"
  done < <(json '
import json, sys
own = {l["attributes"].get("locale") for l in json.load(open(sys.argv[2])).get("data", [])}
for l in json.load(open(sys.argv[1])).get("data", []):
    a = {k: v for k, v in l["attributes"].items() if v is not None and k in ("locale", "description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl", "tvOsPrivacyPolicy")}
    if a.get("locale") not in own:
        print(json.dumps({"data": {"type": "betaAppLocalizations", "attributes": a, "relationships": {"app": {"data": {"type": "apps", "id": sys.argv[3]}}}}}))
' "$WORK/own-localizations.json" "$APP_ID")
  echo "beta app localizations match the template app"

  asc GET "/v1/apps/$APP_ID/betaAppReviewDetail?fields[betaAppReviewDetails]=contactEmail"
  [[ "$STATUS" == "200" ]] || { warn "could not read the Beta App Review contact of app $APP_ID"; return; }
  local detail_id
  detail_id="$(json 'import json, sys; d = json.load(open(sys.argv[1]))["data"]; print("" if d["attributes"].get("contactEmail") else d["id"])')"
  if [[ -z "$detail_id" ]]; then echo "Beta App Review contact is set"; return; fi
  asc GET "/v1/apps/$TEMPLATE_APP_ID/betaAppReviewDetail?fields[betaAppReviewDetails]=contactFirstName,contactLastName,contactPhone,contactEmail,notes,demoAccountRequired"
  [[ "$STATUS" == "200" ]] || { warn "could not read the template app's Beta App Review contact"; return; }
  payload="$(json '
import json, sys
a = json.load(open(sys.argv[1]))["data"]["attributes"]
if a.get("demoAccountRequired"): sys.exit()
keep = {k: v for k, v in a.items() if v is not None and k in ("contactFirstName", "contactLastName", "contactPhone", "contactEmail", "notes")}
print(json.dumps({"data": {"type": "betaAppReviewDetails", "id": sys.argv[2], "attributes": {**keep, "demoAccountRequired": False}}}))
' "$detail_id")"
  if [[ -z "$payload" ]]; then
    echo "::warning::the template app's Beta App Review needs a demo account, which is not copied; set the new app's review contact in App Store Connect"
    return
  fi
  asc PATCH "/v1/betaAppReviewDetails/$detail_id" "$payload"
  [[ "$STATUS" == "200" ]] || { warn "could not set the Beta App Review contact"; return; }
  echo "Beta App Review contact copied from the template app"
}

# ---- 4. The external group ---------------------------------------------------
#
# Created empty: inviting the old app's external testers emails people, which
# is a decision for a person, not a nightly.
setup_external() {
  local encoded
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$EXTERNAL_GROUP")"
  asc GET "/v1/betaGroups?filter[app]=$APP_ID&filter[name]=$encoded&filter[isInternalGroup]=false&fields[betaGroups]=name,isInternalGroup"
  [[ "$STATUS" == "200" ]] || { warn "could not list the external beta groups of app $APP_ID"; return; }
  local found
  found="$(json '
import json, sys
print(sum(1 for g in json.load(open(sys.argv[1])).get("data", []) if g["attributes"].get("name") == sys.argv[2] and g["attributes"].get("isInternalGroup") is False))
' "$EXTERNAL_GROUP")"
  if [[ "$found" != "0" ]]; then echo "external group '$EXTERNAL_GROUP' exists"; return; fi
  asc POST "/v1/betaGroups" "$(python3 -c '
import json, sys
print(json.dumps({"data": {"type": "betaGroups", "attributes": {"name": sys.argv[1], "isInternalGroup": False}, "relationships": {"app": {"data": {"type": "apps", "id": sys.argv[2]}}}}}))
' "$EXTERNAL_GROUP" "$APP_ID")"
  [[ "$STATUS" == "201" ]] || { warn "could not create the external group '$EXTERNAL_GROUP'"; return; }
  echo "created external group '$EXTERNAL_GROUP' (no testers yet)"
}

setup_internal
setup_review_info
setup_external
