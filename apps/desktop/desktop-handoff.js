// THE WIRED HALF OF THE IDENTITY HAND-OFF (#1042) — see desktop-handoff-core.js
// for the decisions. Two entry points:
//
//   start()      in the old-id app (H): find N's manifest, fetch and verify N,
//                explain what macOS will ask again, and swap on the person's
//                click. Nothing installs without that click: the Keychain
//                prompt that follows needs somebody there to answer it.
//   recordBoot() in every packaged launch: N's first boot confirms the swap;
//                later ones tidy up what the old id left behind.
//
// Inert until a handoff-<channel>-mac.json exists under N's feed prefix.
"use strict";
const { app, dialog, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./desktop-handoff-core");
const { cleanBuildEnv, runningBundlePath } = require("./dev-update-core");
const helperPin = require("./computer-use-helper.json");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 30_000;
// How long the helper waits for H itself to quit before abandoning the swap.
const PARENT_EXIT_SECONDS = 600;
// SIGTERM to SIGKILL, when a new app that never confirmed is stopped.
const KILL_GRACE_SECONDS = 30;

let inFlight = false;
let declined = false;

const workDir = () => path.join(app.getPath("userData"), "handoff");
const helperLog = () => path.join(workDir(), "handoff.log");

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 600_000 }, (err, _stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${stderr || err.message}`)) : resolve()));
  });
}

function ownBundle() {
  return process.platform === "darwin" ? runningBundlePath(process.execPath) : null;
}

async function fetchManifest(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, { headers, signal: controller.signal, cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`manifest answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch N's zip (or reuse a matching one), unpack it and return the staged app. */
async function stage(manifest, feedUrl, headers, log) {
  const dir = workDir();
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, manifest.zip);
  if (!core.zipMatches(zip, manifest)) {
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".zip") || name.endsWith(".zip.part")) fs.rmSync(path.join(dir, name), { force: true });
    log.info(`hand-off: downloading ${manifest.version}`);
    await core.download({ url: core.zipUrl(feedUrl, manifest), headers, dest: zip, expect: manifest, fetchImpl: net.fetch });
  }
  const staged = core.paths(dir).staged;
  fs.rmSync(staged, { recursive: true, force: true });
  await execAsync("ditto", ["-x", "-k", zip, staged]);
  const apps = fs.readdirSync(staged).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error(`the download holds ${apps.length} apps, expected 1`);
  return path.join(staged, apps[0]);
}

const verify = (appPath, team) =>
  core.verifyCandidate(appPath, { team, helperAppName: helperPin.appName, helperBundleId: helperPin.bundleId });

async function explainAndAsk(version) {
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Install now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: "Telar is moving to a new app identity",
    detail:
      `Telar ${version} replaces this app in place. Your projects, sessions and settings stay as they are.\n\n` +
      "Afterwards macOS asks again for a few permissions:\n" +
      "• Keychain access to “Telar Safe Storage”: choose Always Allow, or sites in Telar's browser will be signed out.\n" +
      "• Notifications, Automation, camera, microphone and screen sharing, the first time each is used.\n\n" +
      "Computer use keeps its permissions. If the new version can't start, this one comes back by itself.",
  });
  return response === 0;
}

async function explainManual(plan, stagedApp) {
  if (plan.reason === "translocated") {
    await dialog.showMessageBox({
      type: "info",
      buttons: ["OK"],
      message: "Move Telar to Applications to continue",
      detail: "Telar is moving to a new app identity, but it can't replace itself while it runs from here. Drag Telar into Applications, open it from there, and it will offer the move again.",
    });
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Show new version", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: "Telar can't replace itself in this folder",
    detail:
      `Telar is moving to a new app identity, and the new version is downloaded and checked. Telar can't write to ${plan.dir}, so: quit Telar, then drag the new Telar from the Finder window into ${plan.dir}, replacing the old one.`,
  });
  if (response === 0) shell.showItemInFolder(stagedApp);
}

async function reportFailure(failed) {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["OK", "Show log"],
    defaultId: 0,
    message: `Telar ${failed.version} couldn't start`,
    detail: "You're still on this version and nothing was lost. Telar will offer the move again when a newer version is out.",
  });
  if (response === 1) shell.showItemInFolder(helperLog());
}

/** Copy N beside the target, re-check the copy, and hand over to the helper. */
async function handOver({ plan, stagedApp, manifest, team, quit, log }) {
  fs.rmSync(plan.incoming, { recursive: true, force: true });
  await execAsync("ditto", [stagedApp, plan.incoming]);
  const again = await verify(plan.incoming, team);
  if (!again.ok) {
    fs.rmSync(plan.incoming, { recursive: true, force: true });
    throw new Error(`the copied app failed its check: ${again.error}`);
  }
  const dir = workDir();
  core.writeJson(core.paths(dir).pending, { version: manifest.version, bundleId: core.NEW_BUNDLE_ID, target: plan.target });
  const script = path.join(dir, "handoff.sh");
  fs.writeFileSync(script, core.helperScript(), { mode: 0o755 });
  const helper = spawn(
    "bash",
    [
      script,
      String(process.pid),
      plan.incoming,
      plan.target,
      dir,
      helperLog(),
      "open",
      manifest.version,
      String(core.CONFIRM_SECONDS),
      plan.execName,
      String(KILL_GRACE_SECONDS),
      String(PARENT_EXIT_SECONDS),
    ],
    { env: cleanBuildEnv(process.env), detached: true, stdio: "ignore" },
  );
  helper.unref();
  log.info(`hand-off: swapping to ${manifest.version}; quitting`);
  await quit();
}

async function attempt({ channel, key, quit, log }) {
  const bundle = ownBundle();
  if (!bundle || core.readBundleId(bundle) !== core.LEGACY_BUNDLE_ID) return;
  let feedUrl = null;
  try {
    feedUrl = core.readFeedUrl(fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    /* no baked feed: nothing to hand off from */
  }
  if (!feedUrl) return;
  const headers = key ? { "X-Telar-Update-Key": key } : {};
  const raw = await fetchManifest(core.manifestUrl(feedUrl, channel), headers);
  if (!raw) return;
  const checked = core.validateManifest(raw, { channel });
  if (!checked.ok) throw new Error(checked.error);
  const manifest = checked.manifest;

  const decision = core.offerDecision(workDir(), manifest);
  if (decision.action === "notify-failed") return reportFailure(decision.failed);
  if (decision.action === "blocked") return;

  // THE TEAM COMES FROM THIS APP'S OWN SIGNATURE, never from the feed: a
  // feed that could name the team could name any team.
  const team = core.runningTeam(bundle);
  if (!team) throw new Error("this build is not signed, so it cannot check the new one");
  if (manifest.teamId !== team) throw new Error(`the manifest names team ${manifest.teamId}, this app is ${team}`);

  const stagedApp = await stage(manifest, feedUrl, headers, log);
  const verdict = await verify(stagedApp, team);
  if (!verdict.ok) throw new Error(verdict.error);

  const plan = core.planHandoff({
    execPath: process.execPath,
    canWrite: (dir) => {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!plan.ok) {
    log.warn(`hand-off: ${plan.reason}; showing manual steps`);
    declined = true;
    return explainManual(plan, stagedApp);
  }
  if (!(await explainAndAsk(manifest.version))) {
    declined = true;
    return;
  }
  await handOver({ plan, stagedApp, manifest, team, quit, log });
}

async function check(options) {
  if (inFlight || declined) return;
  inFlight = true;
  try {
    await attempt(options);
  } catch (err) {
    options.log.error(`hand-off: ${err?.message || err}`);
  } finally {
    inFlight = false;
  }
}

/**
 * Look for the hand-off now and with every update check after. `channel` is a
 * function so a channel switch takes effect on the next check; `quit` is how
 * main.js quits for an install.
 */
function start({ channel, key, quit, log }) {
  if (!ownBundle()) return;
  const run = () => void check({ channel: channel(), key, quit, log });
  run();
  setInterval(run, CHECK_INTERVAL_MS).unref?.();
}

/** Whether this launch is the one a helper is waiting on. */
function awaitingConfirmation() {
  return fs.existsSync(core.paths(workDir()).pending);
}

function removeLegacyLeftovers(log) {
  for (const parts of core.LEGACY_LEFTOVERS) {
    const target = path.join(os.homedir(), "Library", ...parts);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      log(`could not remove ${target}: ${err.message}`);
    }
  }
}

async function offerPermissionCleanup(log) {
  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Remove old entries", "Keep"],
    defaultId: 0,
    cancelId: 1,
    message: "Telar has moved to its new identity",
    detail: "System Settings still lists permissions for the old Telar. Removing them doesn't affect this Telar or computer use.",
  });
  if (response !== 0) return;
  execFile("tccutil", ["reset", "All", core.LEGACY_BUNDLE_ID], (err, _stdout, stderr) => {
    log(err ? `tccutil reset failed: ${stderr || err.message}` : "removed the old identity's permission entries");
  });
}

/** Called once the engine has a worker. `log` takes one line. */
function recordBoot(log) {
  const bundle = ownBundle();
  if (!bundle) return;
  const dir = workDir();
  const p = core.paths(dir);
  if (!fs.existsSync(p.pending) && !fs.existsSync(p.confirmed)) return;
  const bundleId = core.readBundleId(bundle);
  if (!bundleId) return;
  const { action } = core.confirmBoot(dir, { bundleId, version: app.getVersion() });
  if (action === "confirmed") {
    log(`hand-off confirmed: ${bundleId} ${app.getVersion()}`);
    removeLegacyLeftovers(log);
    fs.rmSync(p.staged, { recursive: true, force: true });
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".zip")) fs.rmSync(path.join(dir, name), { force: true });
    void offerPermissionCleanup(log);
  } else if (action === "remove-last-good") {
    fs.rmSync(p.lastGood, { recursive: true, force: true });
    log("hand-off: removed the previous app kept for rollback");
  }
}

module.exports = { start, awaitingConfirmation, recordBoot };
