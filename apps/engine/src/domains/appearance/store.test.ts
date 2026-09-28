import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

test("the published appearance is an opaque blob, capped, and survives a restart", () => {
  // THE STORE'S WHOLE JOB IS TO NOT UNDERSTAND THIS. The cockpit's look lives
  // in a browser's localStorage and is republished here for paired clients, so
  // the vocabulary belongs to the cockpit and grows on its release schedule.
  // What is tested is the mailbox: it holds what it was given, byte for byte,
  // and it refuses the two things that are not a look.
  const stateRoot = root();
  const store = new EngineStore(stateRoot, () => 100);

  // Nothing published yet is `null`, not a default look — a client with no
  // host to copy wears its own.
  expect(store.appearance.get()).toBeNull();

  const blob = {
    version: 1,
    accent: "sea",
    fontSize: 17,
    // A key this engine has never heard of, which is the point: an iOS client
    // shipping ahead of the engine must not need an engine release.
    somethingInventedLater: { nested: [1, 2, 3] },
    theme: { light: { background: "oklch(1 0 0)" }, dark: { background: "oklch(0.145 0 0)" } },
  };
  const written = store.appearance.set(blob);
  expect(written.blob).toEqual(blob);
  // STAMPED BY THE ENGINE, not by the publisher: the blob's own `updatedAtHint`
  // is advisory, and an ETag cut from two browsers' disagreeing clocks could
  // go backwards. What is recorded is when THIS engine accepted the write.
  expect(written.updatedAt).toBeGreaterThan(0);
  expect(store.appearance.get()).toEqual({ updatedAt: written.updatedAt, blob });

  // A SNAPSHOT, NOT A PATCH: the second publish replaces the first outright,
  // because two merged halves would describe a look nobody is wearing.
  store.appearance.set({ accent: "rose" });
  expect(store.appearance.get()?.blob).toEqual({ accent: "rose" });

  // Not an object is not a look.
  expect(() => store.appearance.set([1, 2, 3])).toThrow(EngineStateError);
  expect(() => store.appearance.set("indigo")).toThrow(EngineStateError);
  expect(() => store.appearance.set(null)).toThrow(EngineStateError);

  // THE CAP MOVED UP AND CHANGED ITS MEANING. It used to forbid an inlined
  // wallpaper at 64 KB; a published look now IS a whole Look and legitimately
  // carries its backdrop's pixels, so a megabyte of image rides through and
  // only the absurd is refused.
  const wallpaper = { look: { backdrop: { image: `data:image/webp;base64,${"A".repeat(2 * 1024 * 1024)}` } } };
  expect(store.appearance.set(wallpaper).blob).toEqual(wallpaper);
  expect(() => store.appearance.set({ wallpaper: "x".repeat(9 * 1024 * 1024) })).toThrow(EngineStateError);
  // …and the refusal left the last good publish alone.
  expect(store.appearance.get()?.blob).toEqual(wallpaper);

  // Cleared is `null` again, and clearing twice is not an error: "nothing is
  // published" is the state the caller asked for either way.
  store.appearance.clear();
  expect(store.appearance.get()).toBeNull();
  store.appearance.clear();
  expect(store.appearance.get()).toBeNull();

  // On disk, so a restarted engine still answers a phone that pairs tomorrow.
  store.appearance.set({ accent: "rose" });
  expect(new EngineStore(stateRoot, () => 100).appearance.get()?.blob).toEqual({ accent: "rose" });

  // Same never-throws rule as the policies: a corrupt file costs the
  // decoration, never the request that asked for it.
  fs.writeFileSync(path.join(stateRoot, "appearance.json"), "not json at all");
  expect(store.appearance.get()).toBeNull();
});
