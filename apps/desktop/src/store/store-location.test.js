"use strict";

const { afterEach, beforeEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("./store-location");

let scratch;
let userData;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-location-"));
  userData = path.join(scratch, "userData");
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function makeStore(root, deps = {}) {
  fs.mkdirSync(root, { recursive: true });
  return store.initialiseStore(root, deps);
}

function mountsAt(...mounted) {
  return (candidate) => mounted.includes(candidate);
}

test("no marker is a first run, and the default root is where it says to start", () => {
  const outcome = store.resolveStoreLocation({ userData, defaultRoot: path.join(scratch, "default") });
  expect(outcome.state).toBe("first-run");
  expect(outcome.root).toBe(path.join(scratch, "default"));
});

test("a first run stamps the root, and the stamp is what makes it findable again", () => {
  const root = path.join(scratch, "default");
  const stamp = makeStore(root);
  expect(stamp.storeId).toBeTruthy();
  expect(store.readStamp(root).storeId).toBe(stamp.storeId);

  store.adoptStore(userData, { path: root, storeId: stamp.storeId });
  const outcome = store.resolveStoreLocation({ userData, defaultRoot: root });
  expect(outcome.state).toBe("ready");
  expect(outcome.root).toBe(root);
});

test("an unreadable marker refuses rather than falling back to the default", () => {
  fs.writeFileSync(store.markerPath(userData), "{ this is not json");
  const outcome = store.resolveStoreLocation({ userData, defaultRoot: path.join(scratch, "default") });
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("marker-unreadable");
});

test("a marker version this build does not know refuses, and names no path", () => {
  fs.writeFileSync(store.markerPath(userData), JSON.stringify({ version: 99, active: { path: "/somewhere", storeId: "x" } }));
  const outcome = store.resolveStoreLocation({ userData, defaultRoot: path.join(scratch, "default") });
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("marker-version");
  expect(outcome.root).toBeUndefined();
});

test("a malformed active block refuses instead of reading as no marker at all", () => {
  fs.writeFileSync(store.markerPath(userData), JSON.stringify({ version: 1, active: { path: "relative/path", storeId: "x" } }));
  const outcome = store.resolveStoreLocation({ userData, defaultRoot: path.join(scratch, "default") });
  expect(outcome.state).toBe("refuse");
});

test("a marker survives a round trip, and its intent is kept apart from its fact", () => {
  const root = path.join(scratch, "store");
  const stamp = makeStore(root);
  store.adoptStore(userData, { path: root, storeId: stamp.storeId });
  store.setPending(userData, { path: "/Volumes/Somewhere/Telar" });

  const { marker } = store.readMarker(userData);
  expect(marker.active.path).toBe(root);
  expect(marker.pending.path).toBe("/Volumes/Somewhere/Telar");

  expect(store.resolveStoreLocation({ userData, defaultRoot: root }).root).toBe(root);
});

test("a failed move leaves the store openable, because pending never became active", () => {
  const root = path.join(scratch, "store");
  const stamp = makeStore(root);
  store.adoptStore(userData, { path: root, storeId: stamp.storeId });
  store.setPending(userData, { path: path.join(scratch, "nowhere") });

  expect(store.resolveStoreLocation({ userData, defaultRoot: root }).state).toBe("ready");
  store.clearPending(userData);
  expect(store.readMarker(userData).marker.pending).toBeUndefined();
  expect(store.resolveStoreLocation({ userData, defaultRoot: root }).state).toBe("ready");
});

test("a store that was deleted by hand refuses; it does not quietly reappear empty", () => {
  const root = path.join(scratch, "store");
  const stamp = makeStore(root);
  store.adoptStore(userData, { path: root, storeId: stamp.storeId });
  fs.rmSync(root, { recursive: true, force: true });

  const outcome = store.resolveStoreLocation({ userData, defaultRoot: root });
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("store-missing");
});

test("a directory with no stamp is not a store, however much the path resolves", () => {
  const root = path.join(scratch, "store");
  const stamp = makeStore(root);
  store.adoptStore(userData, { path: root, storeId: stamp.storeId });
  fs.rmSync(store.stampPath(root));

  expect(store.resolveStoreLocation({ userData, defaultRoot: root }).reason).toBe("store-missing");
});

test("somebody else's store at our path is refused by id, not opened", () => {
  const root = path.join(scratch, "store");
  makeStore(root);
  store.adoptStore(userData, { path: root, storeId: "the-one-we-remember" });

  const outcome = store.resolveStoreLocation({ userData, defaultRoot: root });
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("store-foreign");
});

function makeVolumeStore(name = "Drive", storeId) {
  const mount = path.join(scratch, "Volumes", name);
  const root = path.join(mount, "Telar");
  fs.mkdirSync(root, { recursive: true });
  const stamp = storeId ? store.writeStamp(root, { storeId, createdAt: 1 }) : store.initialiseStore(root);
  return { mount, root, storeId: stamp.storeId };
}

test("an absent drive waits — it does not refuse, and above all it does not initialise", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, {
    path: drive.root,
    storeId: drive.storeId,
    volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" },
  });

  fs.rmSync(path.join(scratch, "Volumes"), { recursive: true, force: true });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt() },
  );
  expect(outcome.state).toBe("waiting");
  expect(outcome.volume.label).toBe("Drive");
  expect(outcome.message).toContain("Drive");
});

test("the empty folder macOS leaves behind is not a mount, and waits", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, {
    path: drive.root,
    storeId: drive.storeId,
    volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" },
  });

  fs.rmSync(drive.root, { recursive: true, force: true });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt() },
  );
  expect(outcome.state).toBe("waiting");
});

test("a platform that cannot resolve volumes still opens the store when it is there", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" } });
  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },

    { isMountPoint: mountsAt(), volumesResolvable: false },
  );
  expect(outcome.state).toBe("ready");
  expect(outcome.root).toBe(drive.root);
});

test("…and says which question it cannot answer when the store is not there", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" } });
  fs.rmSync(drive.root, { recursive: true, force: true });
  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt(), volumesResolvable: false },
  );

  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("volume-unresolvable");

  expect(outcome.message).toContain("cannot tell whether that drive is connected");
  expect(outcome.message).toContain("Drive");
});

test("a present drive with the right store opens", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "UUID-1" } });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt(drive.mount) },
  );
  expect(outcome.state).toBe("ready");
  expect(outcome.root).toBe(drive.root);
});

test("a drive back under a new name is a rename, and the marker is told to follow", () => {
  const first = makeVolumeStore("Drive");
  store.adoptStore(userData, {
    path: first.root,
    storeId: first.storeId,
    volume: { mount: first.mount, uuid: "UUID-1", label: "Drive" },
  });

  const second = makeVolumeStore("Drive 1", first.storeId);
  fs.rmSync(first.mount, { recursive: true, force: true });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt(second.mount), findVolumeMount: (uuid) => (uuid === "UUID-1" ? second.mount : undefined) },
  );
  expect(outcome.state).toBe("ready");
  expect(outcome.root).toBe(second.root);
  expect(outcome.rewritten.volume.mount).toBe(second.mount);
});

test("a DIFFERENT drive at our old mount name does not become our store", () => {
  const ours = makeVolumeStore("Drive");
  store.adoptStore(userData, {
    path: ours.root,
    storeId: ours.storeId,
    volume: { mount: ours.mount, uuid: "UUID-1", label: "Drive" },
  });

  fs.rmSync(ours.root, { recursive: true, force: true });
  const stranger = path.join(ours.mount, "Telar");
  fs.mkdirSync(stranger, { recursive: true });
  store.writeStamp(stranger, { storeId: "somebody-elses", createdAt: 1 });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt(ours.mount), findVolumeMount: () => undefined },
  );
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("store-foreign");
});

test("a reformatted drive refuses rather than being restocked with a fresh store", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, {
    path: drive.root,
    storeId: drive.storeId,
    volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" },
  });

  fs.rmSync(drive.root, { recursive: true, force: true });

  const outcome = store.resolveStoreLocation(
    { userData, defaultRoot: path.join(scratch, "default") },
    { isMountPoint: mountsAt(drive.mount), findVolumeMount: (uuid) => (uuid === "UUID-1" ? drive.mount : undefined) },
  );
  expect(outcome.state).toBe("refuse");
  expect(outcome.reason).toBe("store-missing");
});

test("a store on a share with no uuid still opens, and still waits when it is away", () => {
  const drive = makeVolumeStore("Share");
  store.adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, label: "Share" } });

  expect(
    store.resolveStoreLocation({ userData, defaultRoot: scratch }, { isMountPoint: mountsAt(drive.mount) }).state,
  ).toBe("ready");
  expect(store.resolveStoreLocation({ userData, defaultRoot: scratch }, { isMountPoint: mountsAt() }).state).toBe("waiting");
});

test("starting a new store archives the old one rather than overwriting it", () => {
  const drive = makeVolumeStore();
  store.adoptStore(userData, {
    path: drive.root,
    storeId: drive.storeId,
    volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" },
  });

  store.archiveActive(userData);
  const { marker } = store.readMarker(userData);
  expect(marker.active).toBeUndefined();
  expect(marker.archived).toHaveLength(1);
  expect(marker.archived[0].path).toBe(drive.root);
  expect(marker.archived[0].storeId).toBe(drive.storeId);

  expect(store.resolveStoreLocation({ userData, defaultRoot: path.join(scratch, "default") }).state).toBe("first-run");
});

test("opening is stamped, which is what later gates deleting a migration source", () => {
  const root = path.join(scratch, "store");
  const stamp = makeStore(root);
  store.adoptStore(userData, { path: root, storeId: stamp.storeId, adoptedAt: 1000, lastOpenedAt: 1000 });
  store.noteOpened(userData, { now: () => 2000 });
  expect(store.readMarker(userData).marker.active.lastOpenedAt).toBe(2000);
});

test("NOTHING but an absent marker ever answers first-run", () => {
  const drive = makeVolumeStore();
  const adopted = {
    path: drive.root,
    storeId: drive.storeId,
    volume: { mount: drive.mount, uuid: "UUID-1", label: "Drive" },
  };

  const cases = {
    "drive unplugged": () => fs.rmSync(path.join(scratch, "Volumes"), { recursive: true, force: true }),
    "empty mount point": () => fs.rmSync(drive.root, { recursive: true, force: true }),
    "stamp deleted": () => fs.rmSync(store.stampPath(drive.root)),
    "foreign store": () => store.writeStamp(drive.root, { storeId: "stranger", createdAt: 1 }),
    "marker corrupt": () => fs.writeFileSync(store.markerPath(userData), "nonsense"),
    "marker from the future": () =>
      fs.writeFileSync(store.markerPath(userData), JSON.stringify({ version: 99, active: adopted })),
  };

  for (const [name, breakIt] of Object.entries(cases)) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(userData, { recursive: true });
    const fresh = makeVolumeStore();
    store.adoptStore(userData, { ...adopted, path: fresh.root, storeId: fresh.storeId, volume: { ...adopted.volume, mount: fresh.mount } });
    breakIt();

    for (const mounted of [mountsAt(), mountsAt(fresh.mount)]) {
      const outcome = store.resolveStoreLocation(
        { userData, defaultRoot: path.join(scratch, "default") },
        { isMountPoint: mounted, findVolumeMount: () => undefined },
      );
      expect(`${name}: ${outcome.state}`).not.toBe(`${name}: first-run`);
    }
  }
});
