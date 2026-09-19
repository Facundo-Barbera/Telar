"use strict";

/**
 * WHERE THIS INSTALL'S STORE IS, AND WHETHER IT IS HERE RIGHT NOW — issue #630.
 *
 * WHY THIS EXISTS. The store may live on a volume now, and a volume can be
 * absent. The whole difficulty is one sentence: A STORE THAT IS ABSENT AND A
 * STORE THAT NEVER EXISTED LOOK IDENTICAL FROM THE FILESYSTEM. Both are a
 * directory that is not there. Get that wrong in the obvious direction and
 * Telar starts, finds nothing, and initialises a fresh empty store over the top
 * of somebody's history — which is the one failure in this feature that no
 * later fix recovers from, because a person's conversations are not
 * reproducible.
 *
 * So the decision is moved OFF the filesystem, onto two records that have to
 * agree. Neither alone is grounds to write anything.
 *
 *   THE MARKER, on the internal disk (`<userData>/store-location.json`). Says a
 *   store exists, where it is, and which drive it is on. It is in Electron's own
 *   userData — the one place that is present whatever is mounted — beside
 *   `server-port.json`, `update-prefs.json` and `keybindings.json`, which are
 *   there for exactly this reason. Deliberately NOT under TELAR_HOME, because
 *   TELAR_HOME is the thing it decides.
 *
 *   THE STAMP, inside the store (`<storeRoot>/store.json`). Carries a `storeId`
 *   minted once and CARRIED by a migration, never regenerated.
 *
 * WHY THE STAMP IS NOT REDUNDANT WITH THE PATH RESOLVING. Three ordinary things
 * make a path resolve to something that is not your store: a drive that was
 * reformatted, a DIFFERENT drive mounted at the same name (macOS hands out
 * `<name> 1` freely, so names are not identity), and the empty folder macOS
 * leaves behind at a mount point after an unmount. `isMountPoint` catches the
 * third. Only a matching `storeId` catches the first two — and initialising at
 * any of them is the unrecoverable case above.
 *
 * WHY `active` AND `pending` ARE SEPARATE FIELDS, which is the subtlety worth
 * the extra key. They are different KINDS of fact: `active` is "a store exists
 * there and it has been opened", `pending` is "somebody asked for a move that
 * has not finished". If saving the setting wrote `active`, then a mistyped path
 * or a migration that failed halfway would leave this install permanently
 * refusing to start — against a store that was never there. So `pending` is
 * never consulted when deciding where to open.
 *
 * THE STAMP IS PRIMARY IDENTITY; THE VOLUME UUID IS AN ACCELERATOR. The uuid is
 * what turns a remount under a different name into a rename rather than a loss,
 * and it is what names the missing drive while it is away. But it is macOS-only
 * and absent for network shares (`apps/engine/src/volumes.ts`), so nothing
 * load-bearing may require one. Every path through here works without it.
 *
 * ══ VERSION DISCIPLINE: THE SAME SHAPE AS `remote-file.js`, THE OPPOSITE
 *    TERMINAL ANSWER, AND BOTH ON PURPOSE ══
 *
 * `remote-file.js` is this module's sibling — the other file the shell reads,
 * before anything opens, to decide something it cannot take back. #627/#628
 * established the rule there and it is the same rule here:
 *
 *   THREE STATES, NEVER TWO. Missing, version-known, and version-unknown are
 *   different answers, and the unknown one must never collapse into the missing
 *   one. `remote-file.js` says it as "a first launch is guarded, and the shell
 *   must not read that as unconfigured, so open"; here it is "an absent store
 *   must never read as no store". Same sentence, different nouns. An
 *   unparseable file is a fourth state and is not a missing one either.
 *
 * WHAT DIFFERS IS THE TERMINAL ANSWER, and it differs because the irreversible
 * direction is opposite. For `remote.json` the unsafe direction is WIDENING, so
 * an untrusted file keeps the socket on loopback and the cockpit's own gate
 * falls open — being locked out of a working install would need a reinstall to
 * undo. Here the unsafe direction is PROCEEDING: falling back to the default
 * path is precisely the fresh-store-over-absent-history bug, and no reinstall
 * undoes that. So there an untrusted file yields the narrow answer and the app
 * still runs; here it yields no answer at all and the app refuses to start.
 *
 * WHICH IS WHY THE TWO ARE NOT ONE HELPER. A shared reader parameterised by
 * "what to do when you do not trust it" would hide the only thing about these
 * two files worth understanding — that the same discipline lands in opposite
 * places because the unrecoverable failure is in opposite directions. They
 * cite each other instead.
 *
 * EVERY DEPENDENCY IS INJECTED, which is why the unit tests need no drive: the
 * mount checks and the uuid reader are seams, and every transition this module
 * claims to classify is a test against a temp directory.
 */

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

const MARKER_VERSION = 1;
const STAMP_VERSION = 1;

const MARKER_NAME = "store-location.json";
const STAMP_NAME = "store.json";

/**
 * WHAT A "STORE" IS MADE OF, and why it is a list rather than "the whole
 * directory".
 *
 * At the default location the store root IS Electron's userData, which also
 * holds `Cache/`, `Local Storage/`, `update-prefs.json` and this module's own
 * marker. Moving "the store" can therefore never mean moving the directory —
 * it means moving the subtrees the store actually owns. `engine/` is the
 * engine's (`apps/engine/src/state.ts`); `remote/` is the cockpit's pairing
 * store (`apps/web/lib/remote/store.ts`), a sibling and not inside it.
 *
 * A relocated store root holds only these plus the stamp, which is why a
 * migration onto a drive does not drag a Chromium cache along with it.
 */
const STORE_SUBTREES = ["engine", "remote"];

function markerPath(userData) {
  return path.join(userData, MARKER_NAME);
}

function stampPath(storeRoot) {
  return path.join(storeRoot, STAMP_NAME);
}

function resolveDeps(deps = {}) {
  return {
    fs: deps.fs ?? fsDefault,
    // Both default to the engine's own rules, re-expressed here because the
    // shell cannot import TypeScript from apps/engine. `volume-watch.js` says
    // the same thing about the mount-root list; three apps, none importing
    // another, each saying so.
    isMountPoint: deps.isMountPoint ?? defaultIsMountPoint,
    findVolumeMount: deps.findVolumeMount ?? (() => undefined),
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => crypto.randomUUID()),
  };
}

/**
 * Whether something is really mounted there — the check a recreated empty
 * `/Volumes/<name>` fails. A mount point's `st_dev` differs from its parent's
 * because they are two filesystems; a leftover folder shares its parent's. The
 * twin of `volumes.ts`'s `isMountPoint`, and the reason an empty directory
 * where a drive used to be is never written into.
 */
function defaultIsMountPoint(mount, fs = fsDefault) {
  const parent = path.dirname(mount);
  if (parent === mount) return false;
  try {
    return fs.statSync(mount).dev !== fs.statSync(parent).dev;
  } catch {
    return false;
  }
}

// --- The marker -------------------------------------------------------------

/**
 * Read the marker.
 *
 * THREE ANSWERS, NOT TWO, and the third is the point. `{ marker: null }` means
 * no marker — first run, and the only state in which initialising is correct.
 * `{ unreadable }` means there IS one and it cannot be trusted, which must not
 * collapse into the first: that collapse is the bug this module exists to
 * prevent.
 */
function readMarker(userData, deps = {}) {
  const { fs } = resolveDeps(deps);
  let text;
  try {
    text = fs.readFileSync(markerPath(userData), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { marker: null };
    return { unreadable: "unreadable", detail: error && error.message ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { unreadable: "unparseable", detail: error && error.message ? error.message : String(error) };
  }
  if (parsed === null || typeof parsed !== "object") return { unreadable: "unparseable", detail: "not an object" };
  // A version this build does not know describes a layout it cannot reason
  // about. Guessing a store path from it is precisely what must not happen.
  if (parsed.version !== MARKER_VERSION) {
    return { unreadable: "version", detail: `marker version ${String(parsed.version)} is not ${MARKER_VERSION}` };
  }
  const active = readActive(parsed.active);
  if (parsed.active !== undefined && active === undefined) {
    return { unreadable: "unparseable", detail: "the recorded store location is malformed" };
  }
  return {
    marker: {
      version: MARKER_VERSION,
      active,
      pending: readPending(parsed.pending),
      archived: readArchived(parsed.archived),
      retired: readRetired(parsed.retired),
    },
  };
}

/**
 * The store a completed move left behind, still on disk under a renamed path.
 *
 * KEPT IN THE MARKER RATHER THAN INFERRED FROM THE DISK, because the offer to
 * remove it has to survive the restart that the move requires — and because
 * `stamp` is what `deleteRetiredSubtrees` compares against `lastOpenedAt` to
 * decide whether the new store has actually been run from yet.
 */
function readRetired(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  if (typeof raw.source !== "string" || !path.isAbsolute(raw.source)) return undefined;
  if (typeof raw.stamp !== "string" || raw.stamp === "") return undefined;
  return { source: raw.source, stamp: raw.stamp };
}

function readActive(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return undefined;
  if (typeof raw.path !== "string" || !path.isAbsolute(raw.path)) return undefined;
  if (typeof raw.storeId !== "string" || raw.storeId === "") return undefined;
  return {
    path: raw.path,
    storeId: raw.storeId,
    ...(readVolume(raw.volume) ? { volume: readVolume(raw.volume) } : {}),
    adoptedAt: Number.isFinite(raw.adoptedAt) ? raw.adoptedAt : 0,
    lastOpenedAt: Number.isFinite(raw.lastOpenedAt) ? raw.lastOpenedAt : 0,
  };
}

function readVolume(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  if (typeof raw.mount !== "string" || !path.isAbsolute(raw.mount)) return undefined;
  return {
    mount: raw.mount,
    // Both optional, and everything below copes without them: a network share
    // has no uuid, and a label is a convenience for the waiting window.
    ...(typeof raw.uuid === "string" && raw.uuid ? { uuid: raw.uuid } : {}),
    ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
  };
}

function readPending(raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  if (typeof raw.path !== "string" || !path.isAbsolute(raw.path)) return undefined;
  return { path: raw.path, requestedAt: Number.isFinite(raw.requestedAt) ? raw.requestedAt : 0 };
}

function readArchived(raw) {
  return Array.isArray(raw) ? raw.filter((entry) => readActive(entry) !== undefined) : [];
}

/**
 * Write the marker.
 *
 * Temp-and-rename, the same shape as `apps/engine/src/atomic.ts`: a reader must
 * never meet a half-written marker, because a torn marker is an unreadable one
 * and an unreadable one refuses to start.
 */
function writeMarker(userData, marker, deps = {}) {
  const { fs } = resolveDeps(deps);
  const target = markerPath(userData);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: MARKER_VERSION, ...marker }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Already renamed away, which is the successful path.
    }
  }
}

// --- The stamp --------------------------------------------------------------

/** The store's own id, or nothing when there is no store here. */
function readStamp(storeRoot, deps = {}) {
  const { fs } = resolveDeps(deps);
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath(storeRoot), "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    if (parsed.version !== STAMP_VERSION) return undefined;
    return typeof parsed.storeId === "string" && parsed.storeId ? { storeId: parsed.storeId, createdAt: parsed.createdAt } : undefined;
  } catch {
    return undefined;
  }
}

/** Stamp a root, carrying an id when a migration brought one. */
function writeStamp(storeRoot, stamp, deps = {}) {
  const { fs } = resolveDeps(deps);
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(stampPath(storeRoot), `${JSON.stringify({ version: STAMP_VERSION, ...stamp }, null, 2)}\n`, { mode: 0o600 });
  return stamp;
}

/**
 * Mint a store at a root that has none — first run, or the explicit "start a
 * new store here".
 *
 * NEVER CALLED FROM THE RESOLVER. Initialising is a decision, and it is taken
 * in exactly two places that both know they are taking it. That separation is
 * what makes "an absent volume can never initialise" a property of the shape of
 * this module rather than of remembering an if.
 */
function initialiseStore(storeRoot, deps = {}) {
  const { now, newId } = resolveDeps(deps);
  return writeStamp(storeRoot, { storeId: newId(), createdAt: now() }, deps);
}

// --- The decision -----------------------------------------------------------

/**
 * WHERE TO OPEN, OR WHY NOT TO.
 *
 * Pure: it reads, and it answers. Nothing here creates, writes or initialises
 * anything — the caller acts on the answer, and the two callers that may
 * initialise are the ones that asked for a first run.
 *
 * Answers, and every one of them is a state somebody can actually be in:
 *   first-run  no marker at all. Initialise at the default; this is the ONLY
 *              answer that sanctions it.
 *   ready      open `root`. `rewritten` when the drive came back somewhere new
 *              and the marker should be updated to match.
 *   waiting    the store's volume is not here. Not an error — the designed-for
 *              case. Wait, watch, recover.
 *   refuse     something is here and it is not the store. Never initialise,
 *              never guess; say which case it is.
 */
function resolveStoreLocation(input, deps = {}) {
  const resolved = resolveDeps(deps);
  const { marker, unreadable, detail } = readMarker(input.userData, resolved);

  if (unreadable) {
    return {
      state: "refuse",
      reason: unreadable === "version" ? "marker-version" : "marker-unreadable",
      detail,
      message:
        unreadable === "version"
          ? "This copy of Telar does not understand where your store is recorded to be. It has not opened or created anything."
          : "Telar could not read the record of where your store is. It has not opened or created anything.",
    };
  }

  // NO MARKER IS THE ONLY FIRST RUN. Every other absence below is a store that
  // exists and is not reachable, which is a different thing entirely.
  if (!marker || !marker.active) return { state: "first-run", root: input.defaultRoot };

  const active = marker.active;

  // On the machine's own disk there is no drive to be absent: the store is
  // either there and stamped, or somebody moved or deleted it by hand.
  if (!active.volume) return atRecordedPath(active, resolved);

  // THE VOLUME FIRST, and this order is the one that matters. A stat on the
  // store path can succeed inside a leftover empty mount point, which is the
  // case that would otherwise read as "the store is gone" and invite a fresh
  // one exactly where the drive is about to come back.
  if (resolved.isMountPoint(active.volume.mount, resolved.fs)) {
    const here = atRecordedPath(active, resolved);
    if (here.state === "ready") return here;
    // The mount point is occupied but the store is not on it. Before believing
    // that, ask whether OUR drive is somewhere else — macOS will happily mount
    // a different disk at the name ours used to have.
    const moved = atMovedVolume(active, resolved);
    if (moved) return moved;
    return here;
  }

  const moved = atMovedVolume(active, resolved);
  if (moved) return moved;

  /**
   * THE DESIGNED-FOR CASE. The drive is intended to be here and is not, so this
   * is a condition to sit in rather than an exception to throw. Nothing has
   * been opened, nothing created, nothing written at the recorded path.
   */
  return {
    state: "waiting",
    root: active.path,
    volume: active.volume,
    message: `Telar is waiting for ${describeVolume(active.volume)}. Your store is on it and has not been touched.`,
  };
}

/** The store as the marker records it, believed only if the stamp agrees. */
function atRecordedPath(active, deps) {
  const stamp = readStamp(active.path, deps);
  if (!stamp) {
    return {
      state: "refuse",
      reason: "store-missing",
      root: active.path,
      message: "Telar's store is not where it is recorded to be. It has not created a new one.",
    };
  }
  if (stamp.storeId !== active.storeId) {
    return {
      state: "refuse",
      reason: "store-foreign",
      root: active.path,
      detail: `expected ${active.storeId}, found ${stamp.storeId}`,
      message: "There is a different Telar store at that location. It has not been opened or changed.",
    };
  }
  return { state: "ready", root: active.path, storeId: active.storeId };
}

/**
 * THE DRIVE IS BACK, UNDER A DIFFERENT NAME.
 *
 * macOS mounts a volume whose name is taken at `<name> 1`, so replugging
 * routinely changes the path while changing nothing about the disk. The uuid is
 * what proves it is the same drive; the stamp is what proves the store on it is
 * the same store. Both, because the drive being ours does not make an arbitrary
 * directory on it ours.
 *
 * The engine does exactly this for a project — see `recoverRemountedProject` in
 * `apps/engine/src/state.ts` — including the refusal to compose a path from a
 * root that was never under its own recorded mount.
 */
function atMovedVolume(active, deps) {
  if (!active.volume.uuid) return undefined;
  const mount = deps.findVolumeMount(active.volume.uuid);
  if (mount === undefined || mount === active.volume.mount) return undefined;
  const within = path.relative(active.volume.mount, active.path);
  if (within.startsWith("..") || path.isAbsolute(within)) return undefined;
  const root = within === "" ? mount : path.join(mount, within);
  const stamp = readStamp(root, deps);
  if (!stamp) {
    // The drive is here and the store is not on it. That is a deletion, not a
    // cable, and saying "waiting" would tell somebody to plug in a disk they
    // are already looking at — `probeAvailability`'s distinction exactly.
    return {
      state: "refuse",
      reason: "store-missing",
      root,
      message: "That drive is connected, but Telar's store is not on it. It has not created a new one.",
    };
  }
  if (stamp.storeId !== active.storeId) {
    return {
      state: "refuse",
      reason: "store-foreign",
      root,
      detail: `expected ${active.storeId}, found ${stamp.storeId}`,
      message: "There is a different Telar store on that drive. It has not been opened or changed.",
    };
  }
  return {
    state: "ready",
    root,
    storeId: active.storeId,
    // The caller updates the marker: the path moved, the store did not.
    rewritten: { ...active, path: root, volume: { ...active.volume, mount } },
  };
}

function describeVolume(volume) {
  if (volume.label) return `the drive “${volume.label}”`;
  return `the drive mounted at ${volume.mount}`;
}

// --- Marker transitions -----------------------------------------------------

/**
 * Record that a store at this root has been PROVEN — stamped on a first run, or
 * migrated and verified. This is the only writer of `active`, and it is the
 * moment a location becomes the one Telar opens.
 */
function adoptStore(userData, next, deps = {}) {
  const { now } = resolveDeps(deps);
  const { marker } = readMarker(userData, deps);
  const at = now();
  writeMarker(
    userData,
    {
      active: { ...next, adoptedAt: next.adoptedAt ?? at, lastOpenedAt: next.lastOpenedAt ?? at },
      ...(marker && marker.archived && marker.archived.length ? { archived: marker.archived } : {}),
      ...(next.retired ?? (marker && marker.retired) ? { retired: next.retired ?? marker.retired } : {}),
    },
    deps,
  );
}

/** Forget a retired store — after it has been removed, or after the person
 *  said to keep it and stop being asked. Removes the record, never files. */
function clearRetired(userData, deps = {}) {
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.retired) return;
  const next = { ...marker };
  delete next.retired;
  writeMarker(userData, next, deps);
}

/** Stamp a successful open. `deleteSource` is gated on this post-dating the
 *  migration, which is what makes "verified" mean "opened and run from". */
function noteOpened(userData, deps = {}) {
  const { now } = resolveDeps(deps);
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.active) return;
  writeMarker(userData, { ...marker, active: { ...marker.active, lastOpenedAt: now() } }, deps);
}

/** A move somebody asked for. Intent, never consulted when deciding where to
 *  open — see this module's header for why that separation is load-bearing. */
function setPending(userData, pending, deps = {}) {
  const { now } = resolveDeps(deps);
  const { marker } = readMarker(userData, deps);
  writeMarker(userData, { ...(marker ?? {}), pending: { path: pending.path, requestedAt: now() } }, deps);
}

function clearPending(userData, deps = {}) {
  const { marker } = readMarker(userData, deps);
  if (!marker) return;
  const next = { ...marker };
  delete next.pending;
  writeMarker(userData, next, deps);
}

/**
 * Put the current store aside and start a new one — the deliberate act for a
 * drive that is gone for good.
 *
 * IT ARCHIVES RATHER THAN OVERWRITES, so choosing it by accident is still
 * reversible: the old location, its id and its drive are all still recorded and
 * can be restored by hand. This is never automatic and never a default button.
 */
function archiveActive(userData, deps = {}) {
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.active) return;
  const next = { pending: marker.pending, archived: [...(marker.archived ?? []), marker.active] };
  if (!next.pending) delete next.pending;
  writeMarker(userData, next, deps);
}

module.exports = {
  MARKER_VERSION,
  STAMP_VERSION,
  MARKER_NAME,
  STAMP_NAME,
  STORE_SUBTREES,
  markerPath,
  stampPath,
  readMarker,
  writeMarker,
  readStamp,
  writeStamp,
  initialiseStore,
  resolveStoreLocation,
  adoptStore,
  noteOpened,
  setPending,
  clearPending,
  clearRetired,
  archiveActive,
  describeVolume,
};
