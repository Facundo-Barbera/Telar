"use strict";

/**
 * THE GATE BEFORE THE ENGINE — issue #630, `store-gate.js`.
 *
 * The property, again and from the other side: **an absent drive never ends up
 * having a store written where the history was.** `store-location.test.js` pins
 * that the classifier never says `first-run`; this pins that the loop acting on
 * those answers never creates anything either, including when somebody clicks
 * retry twenty times while the drive stays in their bag.
 *
 * The presenter is injected, so every state here is a test rather than a thing
 * you discover by unplugging a disk.
 */

const { afterEach, beforeEach, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { adoptStore, initialiseStore, readMarker, readStamp, writeStamp, STAMP_NAME } = require("./store-location");
const { awaitStore, describeOutcome } = require("./store-gate");

let scratch;
let userData;
let defaultRoot;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telar-store-gate-"));
  userData = path.join(scratch, "userData");
  defaultRoot = userData;
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const never = async () => {
  throw new Error("the presenter should not have been reached");
};

function makeVolumeStore(name = "Drive", storeId) {
  const mount = path.join(scratch, "Volumes", name);
  const root = path.join(mount, "Telar");
  fs.mkdirSync(root, { recursive: true });
  const stamp = storeId ? writeStamp(root, { storeId, createdAt: 1 }) : initialiseStore(root);
  return { mount, root, storeId: stamp.storeId };
}

const mountsAt = (...mounted) => (candidate) => mounted.includes(candidate);

// --- Opening ----------------------------------------------------------------

test("a first run adopts the default root and records it", async () => {
  const outcome = await awaitStore({ userData, defaultRoot }, { present: never });
  expect(outcome.root).toBe(defaultRoot);
  const { marker } = readMarker(userData);
  expect(marker.active.path).toBe(defaultRoot);
  expect(marker.active.storeId).toBe(readStamp(defaultRoot).storeId);
});

test("AN EXISTING INSTALL IS ADOPTED, NOT REPLACED — the upgrade path", async () => {
  // A store full of history, with no stamp and no marker: exactly what every
  // install looks like the first time it runs a build that has this.
  fs.mkdirSync(path.join(defaultRoot, "engine", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(defaultRoot, "engine", "projects.json"), '{"projects":[{"id":"p"}]}');

  const outcome = await awaitStore({ userData, defaultRoot }, { present: never });

  expect(outcome.root).toBe(defaultRoot);
  // Adopting wrote one small file beside what was there. Nothing else moved.
  expect(JSON.parse(fs.readFileSync(path.join(defaultRoot, "engine", "projects.json"), "utf8")).projects).toHaveLength(1);
  expect(fs.existsSync(path.join(defaultRoot, STAMP_NAME))).toBe(true);
});

test("a store already stamped keeps its id rather than being given a new one", async () => {
  const stamp = initialiseStore(defaultRoot);
  const outcome = await awaitStore({ userData, defaultRoot }, { present: never });
  expect(outcome.root).toBe(defaultRoot);
  expect(readMarker(userData).marker.active.storeId).toBe(stamp.storeId);
});

test("a present drive opens without anyone being asked anything", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "U" } });

  const outcome = await awaitStore({ userData, defaultRoot }, { present: never, isMountPoint: mountsAt(drive.mount) });
  expect(outcome.root).toBe(drive.root);
});

test("opening is stamped on the marker, which later gates deleting a migration source", async () => {
  const stamp = initialiseStore(defaultRoot);
  adoptStore(userData, { path: defaultRoot, storeId: stamp.storeId, adoptedAt: 1, lastOpenedAt: 1 });
  await awaitStore({ userData, defaultRoot }, { present: never, now: () => 5000 });
  expect(readMarker(userData).marker.active.lastOpenedAt).toBe(5000);
});

// --- Waiting ----------------------------------------------------------------

test("an absent drive waits, and the drive arriving is what ends the wait", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "U", label: "Drive" } });

  let plugged = false;
  const outcome = await awaitStore(
    { userData, defaultRoot },
    {
      isMountPoint: (candidate) => plugged && candidate === drive.mount,
      present: async (shown) => {
        expect(shown.state).toBe("waiting");
        plugged = true;
        return "retry";
      },
    },
  );

  expect(outcome.root).toBe(drive.root);
});

test("waiting through many retries creates nothing at all", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "U", label: "Drive" } });
  fs.rmSync(path.join(scratch, "Volumes"), { recursive: true, force: true });

  let asked = 0;
  const outcome = await awaitStore(
    { userData, defaultRoot },
    {
      isMountPoint: mountsAt(),
      present: async () => (++asked < 20 ? "retry" : "quit"),
    },
  );

  expect(outcome.quit).toBe(true);
  expect(asked).toBe(20);
  // NOTHING was created: no store at the default, no store at the recorded
  // path, and the marker still points where it did.
  expect(fs.existsSync(path.join(defaultRoot, STAMP_NAME))).toBe(false);
  expect(fs.existsSync(path.join(scratch, "Volumes"))).toBe(false);
  expect(readMarker(userData).marker.active.path).toBe(drive.root);
});

test("quitting rather than continuing leaves the recorded store recorded", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "U" } });

  const outcome = await awaitStore({ userData, defaultRoot }, { isMountPoint: mountsAt(), present: async () => "quit" });
  expect(outcome.quit).toBe(true);
  expect(readMarker(userData).marker.active.storeId).toBe(drive.storeId);
});

// --- Starting over ----------------------------------------------------------

test("starting a new store is deliberate, and archives rather than discards", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: drive.storeId, volume: { mount: drive.mount, uuid: "U", label: "Drive" } });
  fs.rmSync(path.join(scratch, "Volumes"), { recursive: true, force: true });

  const outcome = await awaitStore(
    { userData, defaultRoot },
    { isMountPoint: mountsAt(), present: async () => "new-store" },
  );

  expect(outcome.root).toBe(defaultRoot);
  const { marker } = readMarker(userData);
  expect(marker.archived).toHaveLength(1);
  // The old location, its id and its drive are all still recoverable by hand.
  expect(marker.archived[0].path).toBe(drive.root);
  expect(marker.archived[0].storeId).toBe(drive.storeId);
  expect(marker.archived[0].volume.uuid).toBe("U");
});

// --- Refusals ---------------------------------------------------------------

test("a foreign store is refused and is NOT offered a fresh start", async () => {
  const drive = makeVolumeStore();
  adoptStore(userData, { path: drive.root, storeId: "ours", volume: { mount: drive.mount, uuid: "U" } });

  let shown;
  await awaitStore(
    { userData, defaultRoot },
    {
      isMountPoint: mountsAt(drive.mount),
      present: async (outcome) => {
        shown = describeOutcome(outcome);
        return "quit";
      },
    },
  );

  expect(shown.severity).toBe("refuse");
  expect(shown.title).toContain("different Telar store");
  // Making a THIRD store is not the answer to finding a second one.
  expect(shown.newStore).toBe(false);
});

test("an unreadable marker refuses, and never offers to start over on top of it", async () => {
  fs.writeFileSync(path.join(userData, "store-location.json"), "not json");
  let shown;
  const outcome = await awaitStore(
    { userData, defaultRoot },
    {
      present: async (answer) => {
        shown = describeOutcome(answer);
        return "quit";
      },
    },
  );
  expect(outcome.quit).toBe(true);
  expect(shown.newStore).toBe(false);
  expect(fs.existsSync(path.join(defaultRoot, STAMP_NAME))).toBe(false);
});

test("every presented state says plainly that nothing was created", async () => {
  const drive = makeVolumeStore();
  for (const [reason, setup] of Object.entries({
    waiting: () => fs.rmSync(path.join(scratch, "Volumes"), { recursive: true, force: true }),
    missing: () => fs.rmSync(drive.root, { recursive: true, force: true }),
  })) {
    fs.rmSync(path.join(userData, "store-location.json"), { force: true });
    const fresh = makeVolumeStore(`Drive-${reason}`);
    adoptStore(userData, { path: fresh.root, storeId: fresh.storeId, volume: { mount: fresh.mount, uuid: "U", label: "Drive" } });
    setup();
    if (reason === "missing") fs.rmSync(fresh.root, { recursive: true, force: true });

    let shown;
    await awaitStore(
      { userData, defaultRoot },
      {
        isMountPoint: reason === "missing" ? mountsAt(fresh.mount) : mountsAt(),
        present: async (answer) => {
          shown = describeOutcome(answer);
          return "quit";
        },
      },
    );
    expect(`${reason}: ${shown.detail}`).toContain("created");
    expect(shown.retry).toBe(true);
  }
});
