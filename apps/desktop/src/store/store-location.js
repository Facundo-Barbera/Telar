"use strict";

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const path = require("node:path");

const MARKER_VERSION = 1;
const STAMP_VERSION = 1;

const MARKER_NAME = "store-location.json";
const STAMP_NAME = "store.json";

const STORE_SUBTREES = ["engine", "remote"];

function markerPath(userData) {
  return path.join(userData, MARKER_NAME);
}

function stampPath(storeRoot) {
  return path.join(storeRoot, STAMP_NAME);
}

function volumesResolvableOn(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

function resolveDeps(deps = {}) {
  return {
    fs: deps.fs ?? fsDefault,

    isMountPoint: deps.isMountPoint ?? defaultIsMountPoint,
    findVolumeMount: deps.findVolumeMount ?? (() => undefined),

    volumesResolvable: deps.volumesResolvable ?? volumesResolvableOn(),
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => crypto.randomUUID()),
  };
}

function defaultIsMountPoint(mount, fs = fsDefault) {
  const parent = path.dirname(mount);
  if (parent === mount) return false;
  try {
    return fs.statSync(mount).dev !== fs.statSync(parent).dev;
  } catch {
    return false;
  }
}

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
      archived: readArchived(parsed.archived),
      retired: readRetired(parsed.retired),
    },
  };
}

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

    ...(typeof raw.uuid === "string" && raw.uuid ? { uuid: raw.uuid } : {}),
    ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
  };
}

function readArchived(raw) {
  return Array.isArray(raw) ? raw.filter((entry) => readActive(entry) !== undefined) : [];
}

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
    }
  }
}

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

function writeStamp(storeRoot, stamp, deps = {}) {
  const { fs } = resolveDeps(deps);
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(stampPath(storeRoot), `${JSON.stringify({ version: STAMP_VERSION, ...stamp }, null, 2)}\n`, { mode: 0o600 });
  return stamp;
}

function initialiseStore(storeRoot, deps = {}) {
  const { now, newId } = resolveDeps(deps);
  return writeStamp(storeRoot, { storeId: newId(), createdAt: now() }, deps);
}

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

  if (!marker || !marker.active) return { state: "first-run", root: input.defaultRoot };

  const active = marker.active;

  if (!active.volume) return atRecordedPath(active, resolved);

  if (!resolved.volumesResolvable) {
    const here = atRecordedPath(active, resolved);
    if (here.state === "ready") return here;
    return {
      state: "refuse",
      reason: "volume-unresolvable",
      detail: active.path,
      message:
        `Telar's store is recorded on ${describeVolume(active.volume)}, and this build cannot tell whether that drive is connected. ` +
        `It has not opened or created anything. Reconnect the drive if it is out, or choose the store's location again.`,
    };
  }

  if (resolved.isMountPoint(active.volume.mount, resolved.fs)) {
    const here = atRecordedPath(active, resolved);
    if (here.state === "ready") return here;

    const moved = atMovedVolume(active, resolved);
    if (moved) return moved;
    return here;
  }

  const moved = atMovedVolume(active, resolved);
  if (moved) return moved;

  return {
    state: "waiting",
    root: active.path,
    volume: active.volume,
    message: `Telar is waiting for ${describeVolume(active.volume)}. Your store is on it and has not been touched.`,
  };
}

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

function atMovedVolume(active, deps) {
  if (!active.volume.uuid) return undefined;
  const mount = deps.findVolumeMount(active.volume.uuid);
  if (mount === undefined || mount === active.volume.mount) return undefined;
  const within = path.relative(active.volume.mount, active.path);
  if (within.startsWith("..") || path.isAbsolute(within)) return undefined;
  const root = within === "" ? mount : path.join(mount, within);
  const stamp = readStamp(root, deps);
  if (!stamp) {
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

    rewritten: { ...active, path: root, volume: { ...active.volume, mount } },
  };
}

function describeVolume(volume) {
  if (volume.label) return `the drive “${volume.label}”`;
  return `the drive mounted at ${volume.mount}`;
}

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

function clearRetired(userData, deps = {}) {
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.retired) return;
  const next = { ...marker };
  delete next.retired;
  writeMarker(userData, next, deps);
}

function noteOpened(userData, deps = {}) {
  const { now } = resolveDeps(deps);
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.active) return;
  writeMarker(userData, { ...marker, active: { ...marker.active, lastOpenedAt: now() } }, deps);
}

function archiveActive(userData, deps = {}) {
  const { marker } = readMarker(userData, deps);
  if (!marker || !marker.active) return;
  writeMarker(userData, { archived: [...(marker.archived ?? []), marker.active] }, deps);
}

module.exports = {
  volumesResolvableOn,
  STAMP_NAME,
  STORE_SUBTREES,
  markerPath,
  stampPath,
  readMarker,
  readStamp,
  writeStamp,
  initialiseStore,
  resolveStoreLocation,
  adoptStore,
  noteOpened,
  clearRetired,
  archiveActive,
};
