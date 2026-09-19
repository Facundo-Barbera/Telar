/**
 * READING remote.json FROM THE SHELL, WITH THE SAME VERSION DISCIPLINE THE GATE
 * APPLIES — issue #627.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ────────────────────────────────────────────
 * The cockpit's own reader (apps/web/lib/remote/store.ts `readRemote`) resets a
 * file whose `version` it does not know to `requireAuth: false`, deliberately:
 * every paired device is gone with the file anyway, so falling open is the only
 * answer that does not need a reinstall to undo. That is correct — for a socket
 * bound to loopback.
 *
 * The shell used to read the same file with a bare `JSON.parse` and no version
 * check, and then decide two things from it: whether to bind every interface,
 * and whether to publish over `tailscale serve`. So a `remote.json` carrying an
 * unknown version — written by a newer build, met again after a rollback — made
 * the shell open the socket to the network AND publish it to the tailnet while
 * the gate admitted every caller. Both of the store's write-side invariants
 * (`setExposure`, `setRequireAuth`) were bypassed, because neither is consulted
 * on the read path.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * THE SHELL NEVER WIDENS ON A FILE IT CANNOT TRUST. A file is trusted when it
 * parses and its version is one this build knows; anything else keeps the
 * socket on loopback and publishes nothing. The gate's fall-open is then
 * exactly what it was designed to be — a cockpit you can still reach from the
 * machine it runs on — rather than an open door onto a network.
 *
 * ── THE SAME DISCIPLINE LANDS SOMEWHERE ELSE IN `store-location.js` (#630) ──
 * That module reads the shell's OTHER before-anything-opens file — where this
 * install's store lives — and applies this rule's shape exactly: missing,
 * version-known and version-unknown are three answers, and the unknown one
 * never collapses into the missing one.
 *
 * Its terminal answer is the opposite of this one's, deliberately. Here the
 * irreversible direction is WIDENING, so an untrusted file stays on loopback
 * and the app still runs. There the irreversible direction is PROCEEDING — a
 * store that falls back to the default path initialises a fresh empty one over
 * somebody's absent history — so an untrusted file refuses to start at all.
 *
 * They are two readers rather than one parameterised helper for that reason:
 * collapsing them would hide the only interesting thing about the pair.
 *
 * ── AND IT IS ONE DEFINITION, NOT TWO ───────────────────────────────────────
 * `scripts/dev.mjs` imports this module rather than restating the rule. The
 * direction matters: a dev script may depend on the desktop app, which is
 * always present in the repo; the packaged shell must never depend on
 * `scripts/`, which is why the `tailscale.js` twin is duplicated by hand and
 * this is not.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** The one version this build understands. Must track `RemoteFile["version"]`
 *  in apps/web/lib/remote/store.ts — a drift here reads every file as unknown,
 *  which is safe but closes remote access for everybody. */
const REMOTE_FILE_VERSION = 1;

/**
 * What the shell may conclude from remote.json.
 *
 * `requireAuth` is WHAT THE GATE WILL DO, not what the file says — the two
 * differ precisely in the case this module exists for. `trusted` is whether
 * the rest of the record means anything at all.
 *
 * `state` is for logging: "fresh" (no file — a first launch), "trusted",
 * "unknown-version", "unreadable".
 */
function posture(state, { requireAuth, exposure = "local-only", tailscaleServe = false } = {}) {
  return { state, trusted: state === "trusted" || state === "fresh", requireAuth, exposure, tailscaleServe };
}

function remotePath(home) {
  return path.join(home, "remote", "remote.json");
}

/**
 * The three cases, mirroring `readRemote` so the shell and the gate cannot
 * disagree about a given file:
 *
 *   missing          FRESH — pairing required, nothing published. A first
 *                    launch is guarded, and the shell must not read that as
 *                    "unconfigured, so open".
 *   version known    the file, with `exposure` normalised the way the store
 *                    normalises it: anything but the one widening value reads
 *                    as loopback.
 *   version unknown  RESET — the gate will fall open, so the shell must not
 *                    widen. Reported as untrusted, not as "local-only with
 *                    pairing off", because a caller that only looked at
 *                    `exposure` would draw the wrong conclusion.
 *   unreadable       the gate's `readRemote` THROWS here, so the cockpit
 *                    answers 500 rather than falling open. The shell's only
 *                    job is the same either way: publish nothing. `requireAuth`
 *                    is reported false so a posture warning errs toward
 *                    warning.
 */
function readRemotePosture(home, readFile = fs.readFileSync) {
  let text;
  try {
    text = readFile(remotePath(home), "utf8");
  } catch {
    // ENOENT and an unreadable directory are the same answer, and it is the
    // one a fresh install already had.
    return posture("fresh", { requireAuth: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return posture("unreadable", { requireAuth: false });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return posture("unreadable", { requireAuth: false });
  if (parsed.version !== REMOTE_FILE_VERSION) return posture("unknown-version", { requireAuth: false });
  return posture("trusted", {
    requireAuth: parsed.requireAuth === true,
    exposure: parsed.exposure === "network-accessible" ? "network-accessible" : "local-only",
    tailscaleServe: parsed.tailscaleServe === true,
  });
}

/**
 * WHERE THE SOCKET LISTENS. Every interface only when the file is trusted, asks
 * for it, and has the gate on — three conditions, and the first one is the fix.
 */
function serverBindHost(home, readFile) {
  const remote = readRemotePosture(home, readFile);
  return remote.trusted && remote.exposure === "network-accessible" && remote.requireAuth ? "0.0.0.0" : "127.0.0.1";
}

/** Same three conditions: a ts.net name is a door, and it must not open with
 *  nothing behind it — or on the strength of a file we cannot read. */
function tailscaleServeRequested(home, readFile) {
  const remote = readRemotePosture(home, readFile);
  return remote.trusted && remote.tailscaleServe && remote.requireAuth;
}

/** What the cockpit's gate will do with this file — for the dev launcher's
 *  posture warning, which is about the GATE and not about the bind. */
function gateWillRequireAuth(home, readFile) {
  return readRemotePosture(home, readFile).requireAuth;
}

module.exports = {
  REMOTE_FILE_VERSION,
  readRemotePosture,
  serverBindHost,
  tailscaleServeRequested,
  gateWillRequireAuth,
};
