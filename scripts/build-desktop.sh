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
# Pipeline: fetch -> pristine worktree of ref -> frozen install -> build-web ->
# stamp build-info.json into the desktop resources -> electron-builder --dir ->
# atomically swap the new Telar.app into --out -> run it --smoke (fail unless
# SMOKE_OK) -> clean up the temp worktree/dirs -> echo final path + sha.
set -euo pipefail

# --- args --------------------------------------------------------------------
REF="origin/main"
OUT="apps/desktop/release/from-origin"
TARGETS="dir"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --targets) TARGETS="${2:?--targets needs a value}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --out=*) OUT="${1#*=}"; shift ;;
    --targets=*) TARGETS="${1#*=}"; shift ;;
    -h|--help)
      cat <<'HELP'
usage: build-desktop.sh [--ref <git ref, default origin/main>]
                         [--out <dir, default apps/desktop/release/from-origin>]
                         [--targets <csv electron-builder mac targets, default dir>]

--targets controls what electron-builder produces (e.g. "dir", "zip,dmg").
Signing and notarization are NOT flags here — electron-builder picks them up
automatically: it signs when a "Developer ID Application" cert is discoverable
in Keychain, and notarizes when APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
are set in the environment. With no cert present, --targets zip,dmg still
produces unsigned artifacts.
HELP
      exit 0 ;;
    *) echo "build-desktop: unknown arg: $1" >&2; exit 2 ;;
  esac
done

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
log "build-web.sh (standalone Next server)"
NODE_OPTIONS= bash apps/desktop/build-web.sh

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

# --- package -----------------------------------------------------------------
# shellcheck disable=SC2206 # intentional word-split of a CSV into --mac args
TARGET_ARGS=(${TARGETS//,/ })
log "electron-builder --mac ${TARGET_ARGS[*]}"
cd "$SNAP/apps/desktop"
NODE_OPTIONS= bunx electron-builder --mac "${TARGET_ARGS[@]}"

BUILT_APP="$SNAP/apps/desktop/release/mac-arm64/Telar.app"
if [ ! -d "$BUILT_APP" ]; then
  echo "build-desktop: expected app not found at $BUILT_APP" >&2
  exit 1
fi

# --- verify signing (only meaningful once a Developer ID cert is in play) ----
if codesign -dv "$BUILT_APP" >/dev/null 2>&1; then
  log "app is signed — verifying"
  codesign --verify --deep --strict "$BUILT_APP"
  spctl -a -vvv --type execute "$BUILT_APP"
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

# --- copy any distributable artifacts (zip/dmg) out before the snapshot is
# cleaned up, staple their notarization ticket if they carry one -------------
ARTIFACTS=()
shopt -s nullglob
for f in "$SNAP/apps/desktop/release/"*.dmg "$SNAP/apps/desktop/release/"*.zip; do
  DEST_ARTIFACT="$OUT_DIR/$(basename "$f")"
  cp "$f" "$DEST_ARTIFACT"
  if xcrun stapler validate "$DEST_ARTIFACT" >/dev/null 2>&1; then
    log "stapled notarization ticket verified: $(basename "$DEST_ARTIFACT")"
  fi
  ARTIFACTS+=("$DEST_ARTIFACT")
done
shopt -u nullglob

# --- smoke the packaged binary (fail unless SMOKE_OK) ------------------------
log "smoke: $DEST_APP --smoke"
SMOKE_OUT="$TMP_ROOT/smoke.log"
set +e
"$DEST_APP/Contents/MacOS/Telar" --smoke >"$SMOKE_OUT" 2>&1
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
if [ "${#ARTIFACTS[@]}" -gt 0 ]; then
  echo "  artifacts:"
  for a in "${ARTIFACTS[@]}"; do
    echo "    $a"
  done
  echo
  echo "To publish to a private GitHub Release, run e.g.:"
  echo "  gh release create v<version> --repo <owner>/<repo> ${ARTIFACTS[*]}"
fi
