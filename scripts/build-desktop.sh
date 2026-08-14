#!/usr/bin/env bash
# Build the Telar desktop .app from a PRISTINE snapshot of an origin git ref.
#
# WHY a snapshot and not the working tree: the owner builds "from github, like
# we do right now" and must never ship uncommitted local changes. We never read
# the working tree for sources. Instead we `git worktree add --detach` the ref
# into a throwaway temp dir — dirty files in the checkout physically cannot leak
# into what we package. All git-worktree operations name ONLY that temp path,
# so the repo's own checkout and its bun.lock are never touched.
#
# Pipeline: fetch -> pristine worktree of ref -> frozen install -> build-app ->
# stamp build-info.json into the desktop resources -> electron-builder --dir ->
# atomically swap the new Telar.app into --out -> run it --smoke (fail unless
# SMOKE_OK) -> clean up the temp worktree/dirs -> echo final path + sha.
set -euo pipefail

# --- args --------------------------------------------------------------------
REF="origin/main"
OUT="apps/desktop/release/from-origin"
TARGETS="dir"
PUBLISH_R2=0
CHANNEL=""
# An explicit version, used by the tag-triggered workflows: when a tag already
# named the version, the build must not re-derive a different one.
VERSION_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --targets) TARGETS="${2:?--targets needs a value}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel needs a value}"; shift 2 ;;
    --version) VERSION_OVERRIDE="${2:?--version needs a value}"; shift 2 ;;
    --version=*) VERSION_OVERRIDE="${1#*=}"; shift ;;
    --publish-r2) PUBLISH_R2=1; shift ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --out=*) OUT="${1#*=}"; shift ;;
    --targets=*) TARGETS="${1#*=}"; shift ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    -h|--help)
      cat <<'HELP'
usage: build-desktop.sh [--ref <git ref, default origin/main>]
                         [--out <dir, default apps/desktop/release/from-origin>]
                         [--targets <csv electron-builder mac targets, default dir>]
                         [--channel beta|nightly]
                         [--publish-r2]

--targets controls what electron-builder produces (e.g. "dir", "zip,dmg").
Signing and notarization are NOT flags here — electron-builder picks them up
automatically: it signs when a "Developer ID Application" cert is discoverable
in Keychain, and notarizes when APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
are set in the environment. With no cert present, --targets zip,dmg still
produces unsigned artifacts.

--channel bumps the snapshot's own apps/desktop/package.json version to the
next beta/nightly prerelease (via scripts/set-desktop-version.mjs, run inside
the pristine snapshot — never the working tree) before packaging. Omit it to
build whatever version is already committed at --ref.

--publish-r2 uploads the produced artifacts (zip/dmg + electron-updater's
<channel>-mac.yml + .blockmap files) to a Cloudflare R2 bucket via the S3-
compatible API, for electron-updater's generic provider to serve from later.
Requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
UPDATE_PROXY_URL, UPDATE_PROXY_KEY in the environment, and the "aws" CLI on PATH.
HELP
      exit 0 ;;
    *) echo "build-desktop: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$PUBLISH_R2" -eq 1 ]; then
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET UPDATE_PROXY_URL UPDATE_PROXY_KEY; do
    [ -n "${!v:-}" ] || { echo "build-desktop: --publish-r2 needs \$$v set" >&2; exit 2; }
  done
  command -v aws >/dev/null 2>&1 || { echo "build-desktop: --publish-r2 needs the aws CLI on PATH" >&2; exit 1; }
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

# Resolve --out to an absolute dir (relative paths are anchored at the repo root
# so the destination is stable no matter where the command is invoked from).
case "$OUT" in
  /*) OUT_DIR="$OUT" ;;
  *)  OUT_DIR="$REPO_ROOT/$OUT" ;;
esac
DEST_APP="$OUT_DIR/Telar.app"

log() { printf '==> %s\n' "$*"; }

# --- fetch + verify the ref exists on origin ---------------------------------
log "git fetch origin (prune)"
git -C "$REPO_ROOT" fetch --prune origin

# Refuse to run unless the ref resolves to a real commit after the fetch. For
# the default origin/main this is exactly "the ref exists on origin".
if ! SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${REF}^{commit}")"; then
  echo "build-desktop: ref '$REF' does not exist on origin (after fetch). Refusing." >&2
  exit 1
fi
# Extra guard: the resolved commit must actually be reachable from an origin
# remote branch, so a stale local-only ref can never sneak through.
if ! git -C "$REPO_ROOT" branch -r --contains "$SHA" 2>/dev/null | grep -q 'origin/'; then
  echo "build-desktop: commit $SHA for '$REF' is not reachable from any origin/* branch. Refusing." >&2
  exit 1
fi
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short "$SHA")"
COMMIT_DATE="$(git -C "$REPO_ROOT" show -s --format=%cI "$SHA")"
log "ref '$REF' -> $SHORT_SHA ($COMMIT_DATE)"

# --- pristine snapshot worktree (temp only) ----------------------------------
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/telar-desktop.XXXXXX")"
SNAP="$TMP_ROOT/snapshot"   # git worktree add requires this path not pre-exist

cleanup() {
  # Only ever names the temp worktree + temp root — never the live checkout.
  if [ -n "${SNAP:-}" ] && [ -e "$SNAP" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$SNAP" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

log "pristine worktree of $SHORT_SHA -> $SNAP"
git -C "$REPO_ROOT" worktree add --detach "$SNAP" "$SHA"

# From here on, sources come ONLY from the snapshot.
cd "$SNAP"

# --- frozen install (snapshot's own bun.lock) --------------------------------
log "bun install --frozen-lockfile (snapshot)"
NODE_OPTIONS= bun install --frozen-lockfile

# --- standalone web build ----------------------------------------------------
log "build-app.sh (standalone Next server)"
NODE_OPTIONS= bash apps/desktop/build-app.sh

# --- stamp build-info.json into the desktop resources (BEFORE packaging) -----
# It lands at the root of the standalone tree, which electron-builder copies to
# <Resources>/standalone/build-info.json, so it is inside the packaged .app.
STANDALONE="$SNAP/apps/web/.next-desktop/standalone"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STANDALONE/build-info.json" <<JSON
{
  "shortSha": "$SHORT_SHA",
  "sha": "$SHA",
  "ref": "$REF",
  "commitDate": "$COMMIT_DATE",
  "builtAt": "$BUILT_AT"
}
JSON
log "stamped build-info.json ($SHORT_SHA)"

# --- bump version for a channel (mutates the SNAPSHOT's package.json only) ---
if [ -n "$CHANNEL" ]; then
  if [ -n "$VERSION_OVERRIDE" ]; then
    VERSION="$(NODE_OPTIONS= node "$SNAP/scripts/set-desktop-version.mjs" --channel "$CHANNEL" --version "$VERSION_OVERRIDE")"
    log "channel '$CHANNEL' -> version $VERSION (from tag)"
  else
    VERSION="$(NODE_OPTIONS= node "$SNAP/scripts/set-desktop-version.mjs" --channel "$CHANNEL")"
    log "channel '$CHANNEL' -> version $VERSION"
  fi
fi

# --- package -----------------------------------------------------------------
# When publishing for real, override the placeholder publish.url with the
# actual update-proxy Worker, and bake the shared auth header secret into the
# packaged package.json (via extraMetadata) so main.js can read it at runtime
# — electron-updater has no way to embed custom request headers into the
# generated app-update.yml itself, so this is how the client learns the key.
#
# publish.channel is deliberately absent from package.json: electron-builder
# only derives the channel from the version's prerelease tag when the field is
# unset, and an explicit value wins over that. Pinning it would make every
# channel publish <channel>-mac.yml under the same name, so beta and nightly
# would clobber each other in one bucket and every client would follow whichever
# ran last. Set it here, from the same --channel that picked the version.
CONFIG_OVERRIDES=()
if [ "$PUBLISH_R2" -eq 1 ]; then
  CONFIG_OVERRIDES+=("-c.publish.url=$UPDATE_PROXY_URL" "-c.extraMetadata.updateProxyKey=$UPDATE_PROXY_KEY")
fi
if [ -n "$CHANNEL" ]; then
  CONFIG_OVERRIDES+=("-c.publish.channel=$CHANNEL")
fi

# shellcheck disable=SC2206 # intentional word-split of a CSV into --mac args
TARGET_ARGS=(${TARGETS//,/ })
log "electron-builder --mac ${TARGET_ARGS[*]}"
cd "$SNAP/apps/desktop"
NODE_OPTIONS= bunx electron-builder --mac "${TARGET_ARGS[@]}" "${CONFIG_OVERRIDES[@]}"

BUILT_APP="$SNAP/apps/desktop/release/mac-arm64/Telar.app"
if [ ! -d "$BUILT_APP" ]; then
  echo "build-desktop: expected app not found at $BUILT_APP" >&2
  exit 1
fi

# --- verify signing (only meaningful once a Developer ID cert is in play) ----
if codesign -dv "$BUILT_APP" >/dev/null 2>&1; then
  log "app is signed — verifying"
  # The SIGNATURE, always. This is the half that must hold for every signed
  # build, notarized or not, and it is what Squirrel checks when it swaps an
  # update into an installed app.
  codesign --verify --deep --strict "$BUILT_APP"
  # GATEKEEPER ACCEPTANCE, only when the build was actually notarized.
  #
  # `spctl --assess` asks "would macOS let a user open this if they downloaded
  # it", and for a Developer ID app the answer is NO until it has been
  # notarized — it exits 3 with `source=Unnotarized Developer ID`. So running it
  # unconditionally asserts a property an un-notarized build cannot have, and
  # the nightly channel deliberately does not notarize (see nightly-desktop.yml:
  # notarization was 57% of the build and is billed at a 10x multiplier).
  #
  # That is exactly how this broke: the nightly signed fine, correctly skipped
  # notarization, produced its zip and blockmap, and then failed here on a check
  # that could never have passed. Notarization is inferred the same way
  # electron-builder infers it — from the App Store Connect credentials being
  # present — so the two can never disagree about whether it happened.
  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    spctl -a -vvv --type execute "$BUILT_APP"
  else
    log "not notarized (no App Store Connect credentials) — skipping the Gatekeeper assessment"
  fi
else
  log "app is unsigned (no Developer ID cert discovered) — skipping signature verification"
fi

# --- atomically swap into --out (build beside, then swap) --------------------
mkdir -p "$OUT_DIR"
STAGE="$OUT_DIR/.Telar.app.staging.$$"
BACKUP="$OUT_DIR/.Telar.app.old.$$"
rm -rf "$STAGE" "$BACKUP"
log "stage new app beside destination"
cp -R "$BUILT_APP" "$STAGE"
if [ -e "$DEST_APP" ]; then
  mv "$DEST_APP" "$BACKUP"
fi
mv "$STAGE" "$DEST_APP"          # atomic rename on the same filesystem
rm -rf "$BACKUP"
log "installed: $DEST_APP"

# --- copy any distributable artifacts (zip/dmg + electron-updater's
# <channel>-mac.yml/.blockmap, when a "publish" config triggered them) out
# before the snapshot is cleaned up, staple notarization tickets where present
#
# Matched narrowly as *-mac.yml, not *.yml: electron-builder also drops a
# builder-debug.yml holding the fully-resolved config, and that config carries
# the injected extraMetadata.updateProxyKey. A blanket *.yml would publish the
# shared update secret into the bucket as a readable file.
ARTIFACTS=()
shopt -s nullglob
for f in "$SNAP/apps/desktop/release/"*.dmg "$SNAP/apps/desktop/release/"*.zip \
         "$SNAP/apps/desktop/release/"*-mac.yml "$SNAP/apps/desktop/release/"*.blockmap; do
  DEST_ARTIFACT="$OUT_DIR/$(basename "$f")"
  cp "$f" "$DEST_ARTIFACT"
  if xcrun stapler validate "$DEST_ARTIFACT" >/dev/null 2>&1; then
    log "stapled notarization ticket verified: $(basename "$DEST_ARTIFACT")"
  fi
  ARTIFACTS+=("$DEST_ARTIFACT")
done
shopt -u nullglob

# --- publish to R2 (opt-in) ---------------------------------------------------
if [ "$PUBLISH_R2" -eq 1 ]; then
  if [ "${#ARTIFACTS[@]}" -eq 0 ]; then
    echo "build-desktop: --publish-r2 requested but no artifacts were produced (check --targets)" >&2
    exit 1
  fi
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  log "publishing ${#ARTIFACTS[@]} artifact(s) to r2://$R2_BUCKET"
  for a in "${ARTIFACTS[@]}"; do
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="auto" \
      aws s3 cp "$a" "s3://$R2_BUCKET/$(basename "$a")" --endpoint-url "$R2_ENDPOINT"
  done
fi

# --- smoke the packaged binary (fail unless SMOKE_OK) ------------------------
log "smoke: $DEST_APP --smoke"
SMOKE_OUT="$TMP_ROOT/smoke.log"
set +e
# See package-desktop.sh: a shell descended from a running Telar carries
# ELECTRON_RUN_AS_NODE=1, which turns the app binary into a bare node and makes
# this exit with "bad option: --smoke" before any Telar code runs.
env -u ELECTRON_RUN_AS_NODE "$DEST_APP/Contents/MacOS/Telar" --smoke >"$SMOKE_OUT" 2>&1
set -e
cat "$SMOKE_OUT"
if ! grep -q '^SMOKE_OK' "$SMOKE_OUT"; then
  echo "build-desktop: smoke did not report SMOKE_OK — failing." >&2
  exit 1
fi

# --- done --------------------------------------------------------------------
echo
echo "BUILD OK"
echo "  app: $DEST_APP"
echo "  sha: $SHORT_SHA ($REF)"
if [ -n "$CHANNEL" ]; then
  echo "$VERSION" > "$OUT_DIR/VERSION"
  echo "  version: $VERSION (channel $CHANNEL)"
fi
if [ "${#ARTIFACTS[@]}" -gt 0 ]; then
  echo "  artifacts:"
  for a in "${ARTIFACTS[@]}"; do
    echo "    $a"
  done
  if [ "$PUBLISH_R2" -eq 1 ]; then
    echo
    echo "  published to r2://$R2_BUCKET"
  else
    echo
    echo "To publish to a private GitHub Release, run e.g.:"
    echo "  gh release create v<version> --repo <owner>/<repo> ${ARTIFACTS[*]}"
  fi
fi
