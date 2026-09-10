// THE DECIDABLE HALF OF THE DEV SELF-UPDATE (DEV-005).
//
// "Update from local checkout" for a --dev packaged Telar Dev: rebuild from the
// configured repo's CURRENT branch (uncommitted edits included), validate the
// candidate, then swap the running bundle for it. This file holds everything
// that can be unit-tested without Electron: env hygiene, git identity, swap
// planning and refusals, candidate validation, and the detached helper that
// performs the swap after the app has exited. dev-update.js wires it to the
// running app.
//
// The builder IS scripts/package-desktop.sh --dev — it already smokes the
// packaged server, verifies the bundle identity and the LSUIElement helper.
// Nothing here re-invents validation; a candidate is only swappable because
// that script exited 0 and validateCandidate re-checked the artefact.
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEV_BUNDLE_ID = "com.telar.desktop.dev";

/**
 * The env a build child may see. A Telar-descended process carries variables
 * that redirect children into the LIVE app — ELECTRON_RUN_AS_NODE turns the
 * next Electron binary into bare node (the silent-open failure), TELAR_HOME /
 * TELAR_DESKTOP_URL / the browser-control pair point at the running engine and
 * its credentials. Strip the whole families rather than a list that goes
 * stale; keep everything else so PATH, HOME and the toolchain still work.
 */
function cleanBuildEnv(env) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS") continue;
    if (key.startsWith("ELECTRON_")) continue;
    if (key.startsWith("TELAR_")) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** A GUI app's PATH has no bun; find one and hand back the dir to prepend. */
function resolveBunDir(env = process.env, exists = fs.existsSync) {
  const home = env.HOME || os.homedir();
  const candidates = [
    ...(env.PATH || "").split(":").filter(Boolean),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of candidates) if (exists(path.join(dir, "bun"))) return dir;
  return null;
}

/** Default git runner; injectable so identity logic is testable without a repo. */
function runGit(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** What the update window shows BEFORE the user commits to anything: which
 *  branch, which SHA, and whether uncommitted edits ride along. */
function readSourceInfo(repo, run = runGit) {
  const head = run(repo, ["rev-parse", "--short", "HEAD"]);
  if (head.status !== 0) {
    return { ok: false, error: `${repo} is not a readable git checkout: ${head.stderr.trim() || "git failed"}` };
  }
  const branch = run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = run(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    ok: true,
    repo,
    sha: head.stdout.trim(),
    branch: branch.status === 0 ? branch.stdout.trim() : "(unknown)",
    dirty: dirty.status === 0 ? dirty.stdout.trim() !== "" : true,
  };
}

/**
 * Which checkout to build from. The --dev package bakes the repo that built it
 * into its metadata (telarDevRepo); a file in the Dev home overrides it, for
 * the day the checkout moves without wanting a rebuild first:
 *   ~/Library/Application Support/Telar Dev/dev-update.json  { "repo": "..." }
 */
function configuredRepo({ packagedRepo, devHome, fsImpl = fs }) {
  let repo = typeof packagedRepo === "string" && packagedRepo.trim() ? packagedRepo.trim() : null;
  const overridePath = devHome ? path.join(devHome, "dev-update.json") : null;
  if (overridePath && fsImpl.existsSync(overridePath)) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(overridePath, "utf8"));
      if (typeof parsed.repo === "string" && parsed.repo.trim()) repo = parsed.repo.trim();
    } catch {
      return { ok: false, error: `${overridePath} exists but is not readable JSON with a "repo" string.` };
    }
  }
  if (!repo) return { ok: false, error: "No source checkout is configured for this build." };
  if (!fsImpl.existsSync(path.join(repo, "scripts", "package-desktop.sh"))) {
    return { ok: false, error: `${repo} has no scripts/package-desktop.sh — not a Telar checkout.` };
  }
  return { ok: true, repo, overridden: overridePath ? fsImpl.existsSync(overridePath) : false };
}

/** The .app bundle a mach-o path executes from, or null when there is none
 *  (an unpackaged checkout run has nothing swappable). */
function runningBundlePath(execPath) {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.lastIndexOf(marker);
  return index === -1 ? null : execPath.slice(0, index + ".app".length);
}

/**
 * Refusals BEFORE any build starts. The one that matters most: if the running
 * bundle IS the staging output, the rebuild would overwrite the running app —
 * the exact thing this design exists to prevent. Update only a copy that
 * lives elsewhere (normally /Applications/Telar Dev.app).
 */
function planSwap({ execPath, stagedApp }) {
  const target = runningBundlePath(execPath);
  if (!target) {
    return { ok: false, error: "This process is not running from a .app bundle; there is nothing to swap. Package and install Telar Dev first." };
  }
  const stagingRoot = path.dirname(stagedApp);
  if (target === stagedApp || target.startsWith(stagingRoot + path.sep)) {
    return { ok: false, error: `Running from the build staging area (${target}). Copy Telar Dev.app somewhere else (e.g. /Applications) and run it from there — rebuilding would overwrite the running app.` };
  }
  return { ok: true, target, stagedApp };
}

/**
 * The candidate re-checked off disk, not trusted from the builder's exit code:
 * identity, executable, the LSUIElement helper (the duplicate-Dock regression),
 * and a "dev"-channel stamp. Binary plists store their strings verbatim, so a
 * buffer scan is enough to pin the bundle id without spawning plutil.
 */
function validateCandidate(stagedApp, fsImpl = fs) {
  const problems = [];
  const mainBin = path.join(stagedApp, "Contents", "MacOS", "Telar Dev");
  const helperBin = path.join(stagedApp, "Contents", "Frameworks", "Telar Dev Helper.app", "Contents", "MacOS", "Telar Dev Helper");
  const plist = path.join(stagedApp, "Contents", "Info.plist");
  const stamp = path.join(stagedApp, "Contents", "Resources", "standalone", "build-info.json");
  if (!fsImpl.existsSync(mainBin)) problems.push("main executable missing");
  if (!fsImpl.existsSync(helperBin)) problems.push("Telar Dev Helper missing (children would land in the Dock)");
  try {
    if (!fsImpl.readFileSync(plist).includes(DEV_BUNDLE_ID)) problems.push(`Info.plist does not carry ${DEV_BUNDLE_ID}`);
  } catch {
    problems.push("Info.plist unreadable");
  }
  let info = null;
  try {
    info = JSON.parse(fsImpl.readFileSync(stamp, "utf8"));
    if (info.channel !== "dev") problems.push(`stamped channel is "${info.channel}", not "dev"`);
  } catch {
    problems.push("build-info.json unreadable");
  }
  return problems.length === 0 ? { ok: true, info } : { ok: false, error: `candidate failed validation: ${problems.join("; ")}` };
}

/**
 * THE SWAP HELPER. A bash script written to the updates dir and spawned
 * detached, because the app cannot replace its own bundle while running from
 * it. Order is chosen so every failure leaves a working app at TARGET:
 *
 *   1. copy the staged candidate BESIDE the target (while the app still runs —
 *      the slow part happens before anything is touched);
 *   2. wait for the app process to exit;
 *   3. one rename sets the current app aside as last-good, one rename installs
 *      the candidate — both cheap, both reversible;
 *   4. relaunch whatever ends up at TARGET, with this helper's already-clean
 *      environment (no ELECTRON_RUN_AS_NODE to inherit).
 *
 * The launcher command is a parameter so tests can swap real `open` for a
 * recording stub.
 */
function helperScript() {
  return `#!/bin/bash
# Telar Dev self-update swap helper — generated by dev-update-core.js.
set -u
PARENT_PID="$1"; STAGED="$2"; TARGET="$3"; WORK_DIR="$4"; LOG="$5"; LAUNCHER="$6"
exec >>"$LOG" 2>&1
echo "[swap $(date -u +%FT%TZ)] staging candidate beside target"
INCOMING="$WORK_DIR/incoming.app"
rm -rf "$INCOMING"
if ! ditto "$STAGED" "$INCOMING"; then
  echo "[swap] copy of candidate failed; current app untouched"
  "$LAUNCHER" "$TARGET"
  exit 1
fi
echo "[swap] waiting for pid $PARENT_PID to exit"
while kill -0 "$PARENT_PID" 2>/dev/null; do sleep 0.2; done
BACKUP="$WORK_DIR/last-good.app"
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  echo "[swap] could not set the current app aside; leaving it in place"
  rm -rf "$INCOMING"
  "$LAUNCHER" "$TARGET"
  exit 1
fi
if ! mv "$INCOMING" "$TARGET"; then
  echo "[swap] install failed; restoring last-good"
  mv "$BACKUP" "$TARGET"
  "$LAUNCHER" "$TARGET"
  exit 1
fi
echo "[swap] installed; relaunching"
"$LAUNCHER" "$TARGET"
exit 0
`;
}

module.exports = {
  DEV_BUNDLE_ID,
  cleanBuildEnv,
  resolveBunDir,
  runGit,
  readSourceInfo,
  configuredRepo,
  runningBundlePath,
  planSwap,
  validateCandidate,
  helperScript,
};
