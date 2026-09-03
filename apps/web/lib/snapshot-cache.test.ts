// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "@telar/engine-client";
import { memorySnapshotStore, saveSnapshot, SESSIONS_PER_HOST, snapshotKey } from "./snapshot-cache";

// Structural fixture: the cache never looks inside a snapshot.
const snapshot = (id: string) => ({ session: { id }, turns: [], items: [], tasks: [], requests: [] }) as unknown as SessionSnapshot;

describe("snapshot cache", () => {
  test("the stale key includes the host — the cockpit's cache read names its Mac", () => {
    expect(snapshotKey("host_ab", "s1")).toBe("host_ab:s1");
    expect(snapshotKey("local", "s1")).toBe("local:s1");
    expect(snapshotKey("host_ab", "s1")).not.toBe(snapshotKey("local", "s1"));
  });

  test("keys are scoped by host — two Macs can mint the same session id", async () => {
    const store = memorySnapshotStore();
    await saveSnapshot(store, "local", "s1", snapshot("s1"), 10);
    await saveSnapshot(store, "host_ab", "s1", snapshot("s1"), 20);
    expect((await store.read(snapshotKey("local", "s1")))?.savedAt).toBe(10);
    expect((await store.read(snapshotKey("host_ab", "s1")))?.savedAt).toBe(20);
  });

  test("keeps only the newest per host, and never touches another host's entries", async () => {
    const store = memorySnapshotStore();
    await saveSnapshot(store, "other", "keep", snapshot("keep"), 1);
    for (let index = 0; index < SESSIONS_PER_HOST + 5; index++) {
      await saveSnapshot(store, "local", `s${index}`, snapshot(`s${index}`), 100 + index);
    }
    expect(await store.read(snapshotKey("local", "s0"))).toBeUndefined();
    expect(await store.read(snapshotKey("local", "s4"))).toBeUndefined();
    expect(await store.read(snapshotKey("local", "s5"))).toBeDefined();
    expect((await store.keys("local:")).length).toBe(SESSIONS_PER_HOST);
    // The oldest entry of all belongs to another host and is not this host's to evict.
    expect(await store.read(snapshotKey("other", "keep"))).toBeDefined();
  });
});
