// THE DECIDABLE HALF OF THE IDENTITY HAND-OFF (#1042).
//
// Telar's bundle id moves from com.telar.desktop to io.github.novarix.telar.
// Squirrel only installs an update whose signature satisfies the RUNNING app's
// designated requirement, and that requirement names the old id — so no feed
// can carry an install across. The last old-id release (H) carries this module
// instead: it fetches the new build (N), checks it against a requirement it
// builds itself, and swaps it in place with a detached helper that restores
// the old app if N never confirms a boot. N runs the same module to confirm.
//
// Everything testable without Electron lives here; desktop-handoff.js wires it.
"use strict";
const { execFile, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LEGACY_BUNDLE_ID = "com.telar.desktop";
const NEW_BUNDLE_ID = "io.github.novarix.telar";
// N's feed lives under its own id in the bucket (scripts/feed-prefix.sh).
const FEED_PREFIX = NEW_BUNDLE_ID;
const CHANNELS = ["beta", "nightly"];
const CONFIRM_SECONDS = 180;
// The old id's leftovers N deletes once it has booted, relative to ~/Library.
// Exact names: com.telar.desktop.computer-use state is never touched.
const LEGACY_LEFTOVERS = [
  ["Caches", `${LEGACY_BUNDLE_ID}.ShipIt`],
  ["Saved Application State", `${LEGACY_BUNDLE_ID}.savedState`],
  ["HTTPStorages", LEGACY_BUNDLE_ID],
  ["Preferences", `${LEGACY_BUNDLE_ID}.plist`],
];
// Exact-match on one id: the helper's grants live under its own id.
const TCC_RESET_ARGS = ["reset", "All", LEGACY_BUNDLE_ID];

const MAX_ZIP_BYTES = 2 * 1024 ** 3;

/** The feed URL electron-builder baked into Resources/app-update.yml. */
function readFeedUrl(appUpdateYml) {
  const match = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(appUpdateYml || "");
  return match ? match[1].replace(/\/+$/, "") : null;
}

/** Where the hand-off manifest for a channel lives, under N's prefix. */
function manifestUrl(feedUrl, channel) {
  return `${feedUrl}/${FEED_PREFIX}/handoff-${channel}-mac.json`;
}

function zipUrl(feedUrl, manifest) {
  return `${feedUrl}/${FEED_PREFIX}/${encodeURIComponent(manifest.zip)}`;
}

/**
 * The manifest is data from the network: every field is checked, and one that
 * names any bundle id but N's is refused outright. Its teamId is only a
 * cross-check; the team that matters is read off H's own signature.
 */
function validateManifest(raw, { channel }) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { ok: false, error: "manifest is not an object" };
  if (raw.bundleId !== NEW_BUNDLE_ID) problems.push(`bundleId is ${JSON.stringify(raw.bundleId)}, not ${NEW_BUNDLE_ID}`);
  if (raw.channel !== channel) problems.push(`channel is ${JSON.stringify(raw.channel)}, not ${channel}`);
  if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(raw.version)) problems.push("version is not a semver");
  if (typeof raw.zip !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/.test(raw.zip)) problems.push("zip is not a plain file name");
  if (typeof raw.sha512 !== "string" || Buffer.from(raw.sha512, "base64").length !== 64) problems.push("sha512 is not a base64 SHA-512");
  if (!Number.isInteger(raw.size) || raw.size <= 0 || raw.size > MAX_ZIP_BYTES) problems.push("size is not a plausible byte count");
  if (typeof raw.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(raw.teamId)) problems.push("teamId is not a team identifier");
  if (problems.length) return { ok: false, error: `hand-off manifest refused: ${problems.join("; ")}` };
  const { version, zip, sha512, size, bundleId, teamId } = raw;
  return { ok: true, manifest: { version, channel, zip, sha512, size, bundleId, teamId } };
}

/** The requirement N must satisfy: N's id, a Developer ID leaf, and H's team. */
function designatedRequirement(bundleId, team) {
  return (
    `identifier "${bundleId}" and anchor apple generic` +
    " and certificate 1[field.1.2.840.113635.100.6.2.6]" +
    " and certificate leaf[field.1.2.840.113635.100.6.1.13]" +
    ` and certificate leaf[subject.OU] = "${team}"`
  );
}

/** TeamIdentifier out of `codesign -dv` (which writes to stderr). */
function parseTeam(codesignOutput) {
  const team = /^TeamIdentifier=(\S+)$/m.exec(codesignOutput || "")?.[1];
  return team && /^[A-Z0-9]{10}$/.test(team) ? team : null;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function readBundleId(appPath, exec = run) {
  const result = exec("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The team the running app is signed by, or null for an unsigned build. */
function runningTeam(appPath, exec = run) {
  return parseTeam(exec("codesign", ["-dv", appPath]).stderr);
}

/** The async twin of `run`: a deep codesign check must not block the main process. */
function runAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 300_000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * Every check a staged N passes before it is allowed near /Applications.
 * `team` is H's own; `helperAppName` comes from computer-use-helper.json.
 */
async function verifyCandidate(appPath, { team, helperAppName, helperBundleId, exec = runAsync }) {
  const id = (await exec("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")])).stdout.trim();
  if (id !== NEW_BUNDLE_ID) return { ok: false, error: `the new app answers to ${id || "no bundle id"}, not ${NEW_BUNDLE_ID}` };
  const checks = [
    ["signature", "codesign", ["--verify", "--deep", "--strict", appPath]],
    ["team requirement", "codesign", ["--verify", "--test-requirement", `=${designatedRequirement(NEW_BUNDLE_ID, team)}`, appPath]],
    ["Gatekeeper", "spctl", ["--assess", "--type", "execute", appPath]],
  ];
  for (const [label, cmd, args] of checks) {
    const result = await exec(cmd, args);
    if (result.status !== 0) return { ok: false, error: `${label} check failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}` };
  }
  const helper = path.join(appPath, "Contents", "Helpers", `${helperAppName}.app`);
  const signed = (await exec("codesign", ["-dv", helper])).stderr;
  const helperId = /^Identifier=(\S+)$/m.exec(signed)?.[1];
  if (helperId !== helperBundleId) return { ok: false, error: `the computer-use helper answers to ${helperId ?? "nothing"}, not ${helperBundleId}` };
  if (parseTeam(signed) !== team) return { ok: false, error: "the computer-use helper is signed by another team" };
  return { ok: true };
}

/**
 * Where the swap would happen, or why it can't. The app is replaced at its own
 * path; a translocated copy or a folder the user can't write gets manual steps.
 */
function planHandoff({ execPath, canWrite }) {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.lastIndexOf(marker);
  if (index === -1) return { ok: false, reason: "not-bundle" };
  const target = execPath.slice(0, index + ".app".length);
  if (target.includes("/AppTranslocation/")) return { ok: false, reason: "translocated", target };
  const dir = path.dirname(target);
  if (!canWrite(dir)) return { ok: false, reason: "not-writable", target, dir };
  return {
    ok: true,
    target,
    // Beside the target, so the helper's final rename stays on one volume.
    incoming: path.join(dir, ".Telar.handoff.app"),
    execName: path.basename(execPath),
  };
}

/** Stream a download to disk, hashing as it goes. `fetchImpl` is injectable. */
async function download({ url, headers, dest, expect, fetchImpl, stallMs = 60_000, onProgress }) {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), stallMs);
  const reset = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(), stallMs);
  };
  const partial = `${dest}.part`;
  // Opened now, not by the stream later: a failure must find the file to delete.
  const out = fs.createWriteStream(null, { fd: fs.openSync(partial, "w") });
  const hash = crypto.createHash("sha512");
  let received = 0;
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`download answered ${response.status}`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reset();
      received += value.length;
      if (received > expect.size) throw new Error("download is larger than the manifest says");
      hash.update(value);
      if (!out.write(value)) await new Promise((resolve) => out.once("drain", resolve));
      onProgress?.(received / expect.size);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (received !== expect.size) throw new Error(`download is ${received} bytes, the manifest says ${expect.size}`);
    if (hash.digest("base64") !== expect.sha512) throw new Error("download does not match the manifest's sha512");
    fs.renameSync(partial, dest);
  } catch (err) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw controller.signal.aborted ? new Error(`download stalled for ${stallMs / 1000}s`) : err;
  } finally {
    clearTimeout(stall);
  }
}

/** A zip already on disk from an earlier launch is reused only if it still matches. */
function zipMatches(file, expect) {
  try {
    if (fs.statSync(file).size !== expect.size) return false;
    return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64") === expect.sha512;
  } catch {
    return false;
  }
}

// --- State in <userData>/handoff ---------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

const paths = (workDir) => ({
  pending: path.join(workDir, "pending.json"),
  confirmed: path.join(workDir, "confirmed.json"),
  failed: path.join(workDir, "failed.json"),
  lastGood: path.join(workDir, "last-good.app"),
  staged: path.join(workDir, "staged"),
  script: path.join(workDir, "handoff.sh"),
  // An empty bundle carrying the old id, so tccutil can still resolve it.
  legacyStub: path.join(workDir, "legacy-id.app"),
});

/**
 * What H should do with a manifest, given what happened last time. A version
 * that failed to boot is not offered again; a newer manifest clears the block.
 * The failure is reported once.
 */
function offerDecision(workDir, manifest) {
  const file = paths(workDir).failed;
  const failed = readJson(file);
  if (!failed) return { action: "offer" };
  if (failed.version !== manifest.version) {
    fs.rmSync(file, { force: true });
    return { action: "offer" };
  }
  if (failed.noticeShown) return { action: "blocked" };
  writeJson(file, { ...failed, noticeShown: true });
  return { action: "notify-failed", failed };
}

/**
 * Run by every packaged launch once the engine has a worker. On the first N
 * boot after a swap it writes confirmed.json, which is what the helper waits
 * for, and asks for the old identity to be cleaned up. A launch that finds a
 * confirmed swap not yet cleaned up (an earlier attempt was cut short, or the
 * swap predates this rule) asks again.
 *
 * WHY THE FIRST BOOT AND NOT A ROLLBACK WINDOW: last-good.app is only ever
 * restored by the helper, and only while it waits for this confirmation. Once
 * the helper has seen it and exited, nothing can bring last-good back, so
 * keeping it only leaves an old-id Telar on disk for System Settings to list.
 */
function confirmBoot(workDir, { bundleId, version, now = Date.now() }) {
  const p = paths(workDir);
  const pending = readJson(p.pending);
  if (pending && pending.bundleId === bundleId) {
    writeJson(p.confirmed, { version, bundleId, confirmedAt: now });
    fs.rmSync(p.pending, { force: true });
    return { action: "confirmed" };
  }
  const confirmed = readJson(p.confirmed);
  if (!confirmed || confirmed.bundleId !== bundleId || confirmed.cleanedUp) return { action: "none" };
  return { action: "clean-up" };
}

function markCleanedUp(workDir) {
  const file = paths(workDir).confirmed;
  const confirmed = readJson(file);
  if (confirmed) writeJson(file, { ...confirmed, cleanedUp: true });
}

/** Whether the swap helper is still running, from `ps -axo command=`. */
function helperRunning(psOutput, script) {
  return (psOutput || "").split("\n").some((line) => line.includes(script));
}

/**
 * Everything the old identity left that N deletes, as absolute paths: the
 * rollback copy, the stub, and the exact old-id names in ~/Library. Never the
 * hand-off folder itself, userData, or the helper's state.
 */
function legacyLeftovers(workDir, home) {
  const p = paths(workDir);
  return [p.lastGood, p.legacyStub, p.staged, ...LEGACY_LEFTOVERS.map((parts) => path.join(home, "Library", ...parts))];
}

/** LaunchServices only registers a bundle with an executable, so it gets one that does nothing. */
function writeLegacyStub(workDir) {
  const stub = paths(workDir).legacyStub;
  fs.mkdirSync(path.join(stub, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(stub, "Contents", "MacOS", "stub"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(stub, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${LEGACY_BUNDLE_ID}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>stub</string>
</dict></plist>
`,
  );
  return stub;
}

/**
 * THE SWAP HELPER. A bash script spawned detached, because an app cannot
 * replace its own bundle while it runs. H has already copied the verified N to
 * INCOMING beside the target. Every failure leaves a working app at TARGET:
 *
 *   1. wait for H to exit (bounded; H not quitting abandons the swap);
 *   2. rename H aside to last-good, rename N in, launch it;
 *   3. wait for N to write confirmed.json;
 *   4. if it never does: stop the process running TARGET's own executable (by
 *      pid, nothing else), move N aside, put H back, launch it, and write
 *      failed.json for H to report.
 *
 * The launcher is a parameter so tests can replace `open` with a stub.
 */
function helperScript() {
  return `#!/bin/bash
# Telar identity hand-off swap helper — generated by desktop-handoff-core.js.
set -u
PARENT_PID="$1"; INCOMING="$2"; TARGET="$3"; WORK_DIR="$4"; LOG="$5"; LAUNCHER="$6"
VERSION="$7"; CONFIRM_SECONDS="$8"; EXEC_NAME="$9"; KILL_GRACE="\${10}"; PARENT_SECONDS="\${11}"
exec >>"$LOG" 2>&1
say() { echo "[handoff $(date -u +%FT%TZ)] $*"; }
BACKUP="$WORK_DIR/last-good.app"
CONFIRMED="$WORK_DIR/confirmed.json"
EXE="$TARGET/Contents/MacOS/$EXEC_NAME"
fail() {
  rm -f "$WORK_DIR/pending.json"
  printf '{"version":"%s","reason":"%s"}\\n' "$VERSION" "$1" > "$WORK_DIR/failed.json.tmp"
  mv "$WORK_DIR/failed.json.tmp" "$WORK_DIR/failed.json"
}
# Pids whose executable is exactly TARGET's, whatever else is running.
pids() { ps -axo pid=,comm= | while read -r pid comm; do [ "$comm" = "$EXE" ] && echo "$pid"; done; return 0; }

rm -f "$CONFIRMED"
say "waiting for pid $PARENT_PID to exit"
ticks=0
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if [ "$ticks" -ge $((PARENT_SECONDS * 5)) ]; then
    say "the old app did not quit; abandoning the swap"
    rm -rf "$INCOMING"
    fail "old-app-did-not-quit"
    exit 1
  fi
  sleep 0.2; ticks=$((ticks + 1))
done
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  say "could not set the current app aside; leaving it in place"
  rm -rf "$INCOMING"
  fail "could-not-set-aside"
  "$LAUNCHER" "$TARGET"
  exit 1
fi
if ! mv "$INCOMING" "$TARGET"; then
  say "install failed; restoring last-good"
  mv "$BACKUP" "$TARGET"
  fail "install-failed"
  "$LAUNCHER" "$TARGET"
  exit 1
fi
say "installed $VERSION; launching"
"$LAUNCHER" "$TARGET"
waited=0
while [ ! -f "$CONFIRMED" ] && [ "$waited" -lt "$CONFIRM_SECONDS" ]; do
  sleep 1; waited=$((waited + 1))
done
if [ -f "$CONFIRMED" ]; then
  say "the new app confirmed its boot"
  exit 0
fi
say "no confirmation in \${CONFIRM_SECONDS}s; rolling back"
for pid in $(pids); do say "SIGTERM $pid"; kill -TERM "$pid" 2>/dev/null; done
ticks=0
while [ -n "$(pids)" ] && [ "$ticks" -lt $((KILL_GRACE * 5)) ]; do sleep 0.2; ticks=$((ticks + 1)); done
for pid in $(pids); do say "SIGKILL $pid"; kill -KILL "$pid" 2>/dev/null; done
ticks=0
while [ -n "$(pids)" ] && [ "$ticks" -lt 25 ]; do sleep 0.2; ticks=$((ticks + 1)); done
rm -rf "$WORK_DIR/failed.app"
if ! mv "$TARGET" "$WORK_DIR/failed.app"; then
  say "could not move the new app aside; leaving it in place"
  fail "rollback-failed"
  exit 3
fi
if ! mv "$BACKUP" "$TARGET"; then
  say "could not restore last-good; putting the new app back"
  mv "$WORK_DIR/failed.app" "$TARGET"
  fail "rollback-failed"
  exit 3
fi
fail "did-not-confirm"
say "restored the previous app; relaunching it"
"$LAUNCHER" "$TARGET"
exit 2
`;
}

module.exports = {
  LEGACY_BUNDLE_ID,
  NEW_BUNDLE_ID,
  CHANNELS,
  CONFIRM_SECONDS,
  TCC_RESET_ARGS,
  readFeedUrl,
  manifestUrl,
  zipUrl,
  validateManifest,
  designatedRequirement,
  parseTeam,
  readBundleId,
  runningTeam,
  verifyCandidate,
  planHandoff,
  download,
  zipMatches,
  paths,
  readJson,
  writeJson,
  offerDecision,
  confirmBoot,
  markCleanedUp,
  helperRunning,
  legacyLeftovers,
  writeLegacyStub,
  helperScript,
};
