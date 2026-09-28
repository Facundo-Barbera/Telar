// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { SidebarSession } from "./session-list";
import { forgetRows, parseSidebarCache, rememberRows, ROWS_PER_HOST, staleRows } from "./sidebar-cache";

const row = (id: string): SidebarSession => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
  activity: "idle",
});

describe("sidebar cache", () => {
  test("remembers one host's rows without touching another's", () => {
    let cache = rememberRows({}, "local", [row("a")], 10);
    cache = rememberRows(cache, "host_ab", [row("b")], 20);
    cache = rememberRows(cache, "local", [row("c")], 30);
    expect(cache.local).toEqual({ savedAt: 30, sessions: [row("c")] });
    expect(cache.host_ab?.sessions.map((session) => session.id)).toEqual(["b"]);
    expect(forgetRows(cache, "host_ab").host_ab).toBeUndefined();
  });

  test("two hosts' rows never mix — same session id, separate shelves", () => {
    // Two Macs can mint the same session id; each host's entry must answer
    // only for itself, remembering, reading back stale, and forgetting.
    let cache = rememberRows({}, "local", [row("same"), row("mine")], 10);
    cache = rememberRows(cache, "host_ab", [row("same"), row("theirs")], 20);
    expect(staleRows(cache, "local").map((session) => session.id)).toEqual(["same", "mine"]);
    expect(staleRows(cache, "host_ab").map((session) => session.id)).toEqual(["same", "theirs"]);
    expect(staleRows(cache, "local").every((session) => session.stale === 10)).toBe(true);
    expect(staleRows(cache, "host_ab").every((session) => session.stale === 20)).toBe(true);
    const forgotten = forgetRows(cache, "host_ab");
    expect(staleRows(forgotten, "host_ab")).toEqual([]);
    expect(staleRows(forgotten, "local").map((session) => session.id)).toEqual(["same", "mine"]);
  });

  test("stale rows carry the time they were read, and a never-read host has none", () => {
    const cache = rememberRows({}, "host_ab", [row("b")], 20);
    expect(staleRows(cache, "host_ab")).toEqual([{ ...row("b"), stale: 20 }]);
    expect(staleRows(cache, "nope")).toEqual([]);
  });

  test("caps rows per host, and survives garbage on disk", () => {
    const many = Array.from({ length: ROWS_PER_HOST + 10 }, (_, index) => row(`s${index}`));
    expect(rememberRows({}, "local", many).local?.sessions).toHaveLength(ROWS_PER_HOST);
    expect(parseSidebarCache(null)).toEqual({});
    expect(parseSidebarCache("not json")).toEqual({});
    expect(parseSidebarCache(JSON.stringify({ local: { savedAt: "x", sessions: [] }, ok: { savedAt: 1, sessions: [] } }))).toEqual({
      ok: { savedAt: 1, sessions: [] },
    });
  });
});
