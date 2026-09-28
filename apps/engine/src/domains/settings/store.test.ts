import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EngineStateError } from "../../platform/kernel";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("the inbox policy is one document, defaulted rather than absent", () => {
  // THE POLICY HALF OF SETTLING. The per-session pin says "not this one"; this
  // says how long anything stays in the list at all — and it is on the engine
  // so the desktop shell and a browser tab band the same sessions the same way.
  const { store } = readyStore();
  // The delegation grace rides the same document (#378) and defaults with it.
  const grace = { settleDelegatedAfterHours: 1, settledTerminalLimit: 5 };
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: 72, ...grace });

  expect(store.settings.setInbox({ autoSettleAfterHours: 14 })).toEqual({ autoSettleAfterHours: 14, ...grace });
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: 14, ...grace });

  // `null` IS THE OFF SWITCH, and it is a value rather than an omission:
  // "never" is an answer, not a very large duration.
  expect(store.settings.setInbox({ autoSettleAfterHours: null })).toEqual({ autoSettleAfterHours: null, ...grace });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.settings.setInbox({})).toEqual({ autoSettleAfterHours: null, ...grace });

  for (const bad of [0, 90 * 24 + 1, 3.5, "7", Number.NaN]) {
    expect(() => store.settings.setInbox({ autoSettleAfterHours: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: null, ...grace });
});

test("a days-shaped inbox document from before the hours move still means what it said", () => {
  const { store, root: stateRoot } = readyStore();
  const grace = { settleDelegatedAfterHours: 1, settledTerminalLimit: 5 };
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":2}');
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: 48, ...grace });
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterDays":null}');
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: null, ...grace });
});

test("a policy written before the delegation grace keeps its own window — #378", () => {
  // THE FIELD IS DEFAULTED RATHER THAN REQUIRED FOR EXACTLY THIS. A required
  // one would fail the schema on every stored document, and a failed parse
  // here answers with the whole default — silently replacing the window
  // somebody chose with 72 hours.
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":2,"autoSettleAfterHours":6}');
  expect(store.settings.inbox()).toEqual({ autoSettleAfterHours: 6, settleDelegatedAfterHours: 1, settledTerminalLimit: 5 });
});

test("the standing session defaults round-trip, and refuse a mode that is not one", () => {
  // WHAT A SESSION IS BUILT WITH WHEN NOBODY SAID. `local` is what the engine
  // did before this document existed, so an install that never opens the
  // settings page behaves exactly as it always has.
  const { store } = readyStore();
  expect(store.settings.sessionDefaults()).toEqual({ envMode: "local" });

  expect(store.settings.setSessionDefaults({ envMode: "worktree" })).toEqual({ envMode: "worktree" });
  expect(store.settings.sessionDefaults()).toEqual({ envMode: "worktree" });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.settings.setSessionDefaults({})).toEqual({ envMode: "worktree" });

  for (const bad of ["", "detached", 1, null]) {
    expect(() => store.settings.setSessionDefaults({ envMode: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.settings.sessionDefaults()).toEqual({ envMode: "worktree" });
});

test("a standing access mode opens new sessions in it, and a creator's ceiling still narrows it", () => {
  const { store } = readyStore();
  expect(store.settings.setSessionDefaults({ runtimeMode: "full-access" })).toEqual({ envMode: "local", runtimeMode: "full-access" });
  expect(store.lifecycle.createSession({ id: "session_default", projectId: "project_one" }).runtimeMode).toBe("full-access");

  // A supervised creator cannot hand out more than it has.
  store.lifecycle.updateSession("session_default", { runtimeMode: "approval-required" });
  expect(store.lifecycle.createSession({ id: "session_child", projectId: "project_one", ceilingFrom: "session_default" }).runtimeMode).toBe(
    "approval-required",
  );
  // An attended session keeps asking whatever the default says.
  expect(store.lifecycle.createSession({ id: "session_attended", projectId: "project_one", detached: false }).runtimeMode).toBe("approval-required");

  expect(() => store.settings.setSessionDefaults({ runtimeMode: "yolo" })).toThrow(EngineStateError);
  expect(() => store.settings.setSessionDefaults({ resumeAfterRateLimit: "yes" })).toThrow(EngineStateError);
  // `null` clears it back to the posture's own default.
  expect(store.settings.setSessionDefaults({ runtimeMode: null })).toEqual({ envMode: "local" });
  expect(store.lifecycle.createSession({ id: "session_plain", projectId: "project_one" }).runtimeMode).toBe("auto");
});

test("the sidebar layout round-trips, dedupes, and refuses a shape that is not a list of keys", () => {
  // WHERE EACH PROJECT GROUP SITS. Empty by default — the rail reads that as
  // "alphabetical, nobody has moved anything" — and on the engine so the
  // desktop shell, a browser tab and a paired phone draw one arrangement.
  const { store } = readyStore();
  const blank = { projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" as const };
  expect(store.settings.sidebarLayout()).toEqual(blank);

  expect(store.settings.setSidebarLayout({ projectOrder: ["b", "h1:a", "a"] })).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  expect(store.settings.sidebarLayout()).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  // An empty patch changes nothing rather than resetting anything.
  expect(store.settings.setSidebarLayout({})).toEqual({ ...blank, projectOrder: ["b", "h1:a", "a"] });
  // A key said twice is kept once, at its first position.
  expect(store.settings.setSidebarLayout({ projectOrder: ["a", "b", "a"] })).toEqual({ ...blank, projectOrder: ["a", "b"] });

  for (const bad of ["a", null, [1], [""], [{ key: "a" }], Array.from({ length: 1001 }, (_, i) => `k${i}`)]) {
    expect(() => store.settings.setSidebarLayout({ projectOrder: bad })).toThrow(EngineStateError);
  }
  // …and the refusal left the stored answer alone.
  expect(store.settings.sidebarLayout()).toEqual({ ...blank, projectOrder: ["a", "b"] });
});

test("the rows inside a group and inside pinned are arranged by their own fields", () => {
  // Each of the three is patched on its own: the rail writes ONE of them per
  // drop, and a write that also sent the other two would let a stale copy of
  // this document overwrite an arrangement another window had just made.
  const { store } = readyStore();
  store.settings.setSidebarLayout({ projectOrder: ["p1"] });

  expect(store.settings.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } })).toEqual({
    projectOrder: ["p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: [],
    mode: "grouped",
  });
  // The pinned write leaves the group arrangement — and the project one — alone.
  expect(store.settings.setSidebarLayout({ pinnedOrder: ["h1:s9", "s8", "s8"] })).toEqual({
    projectOrder: ["p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["h1:s9", "s8"],
    mode: "grouped",
  });
  // A key said twice inside a group list is kept once too.
  expect(store.settings.setSidebarLayout({ sessionOrder: { p1: ["s1", "s2", "s1"] } }).sessionOrder).toEqual({ p1: ["s1", "s2"] });

  for (const bad of ["a", null, { p1: "s1" }, { p1: [""] }, { "": ["s1"] }, { p1: Array.from({ length: 1001 }, (_, i) => `s${i}`) }]) {
    expect(() => store.settings.setSidebarLayout({ sessionOrder: bad })).toThrow(EngineStateError);
  }
  for (const bad of ["a", [1], [""], Array.from({ length: 1001 }, (_, i) => `s${i}`)]) {
    expect(() => store.settings.setSidebarLayout({ pinnedOrder: bad })).toThrow(EngineStateError);
  }
  expect(store.settings.sidebarLayout()).toEqual({ projectOrder: ["p1"], sessionOrder: { p1: ["s1", "s2"] }, pinnedOrder: ["h1:s9", "s8"], mode: "grouped" });
});

test("the rail mode defaults to grouped, persists on its own, and refuses anything else", () => {
  const { store } = readyStore();
  store.settings.setSidebarLayout({ pinnedOrder: ["s1"] });
  expect(store.settings.sidebarLayout().mode).toBe("grouped");
  // The mode write leaves every arrangement alone, and they leave it alone.
  expect(store.settings.setSidebarLayout({ mode: "flat" })).toMatchObject({ pinnedOrder: ["s1"], mode: "flat" });
  expect(store.settings.setSidebarLayout({ pinnedOrder: ["s2"] }).mode).toBe("flat");
  for (const bad of ["tree", null, 1, ""]) {
    expect(() => store.settings.setSidebarLayout({ mode: bad })).toThrow(EngineStateError);
  }
  expect(store.settings.sidebarLayout().mode).toBe("flat");
});

test("a malformed sidebar-layout document costs the arrangement, never the list", () => {
  const { store, root: stateRoot } = readyStore();
  const blank = { projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" as const };
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), '{"version":2,"projectOrder":"b,a"}');
  expect(store.settings.sidebarLayout()).toEqual(blank);
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), "not json at all");
  expect(store.settings.sidebarLayout()).toEqual(blank);
  // A document written before the row arrangements existed still parses — it
  // means "nobody has arranged any rows", not "this file is broken".
  fs.writeFileSync(path.join(stateRoot, "sidebar-layout.json"), '{"version":2,"projectOrder":["b","a"]}');
  expect(store.settings.sidebarLayout()).toEqual({ ...blank, projectOrder: ["b", "a"] });
});

test("a malformed session-defaults document costs the preference, never the session", () => {
  // Read on the CREATE path, which is why the never-throws rule matters more
  // here than anywhere: garbage in this file must not make sessions unopenable.
  const { store, root: stateRoot } = readyStore();
  fs.writeFileSync(path.join(stateRoot, "session-defaults.json"), '{"version":1,"envMode":"elsewhere"}');
  expect(store.settings.sessionDefaults()).toEqual({ envMode: "local" });
  fs.writeFileSync(path.join(stateRoot, "session-defaults.json"), "not json at all");
  expect(store.settings.sessionDefaults()).toEqual({ envMode: "local" });
  expect(() => store.lifecycle.createSession({ id: "session_two", projectId: "project_one" })).not.toThrow();
});

test("a malformed inbox document costs the preference, never the sidebar", () => {
  // EVERY OTHER REGISTRY HERE REFUSES TO PARSE GARBAGE, because a malformed MCP
  // server is a server that must not run. A malformed settling window is a
  // preference, and the worst it can do is band a list wrongly.
  const { store, root: stateRoot } = readyStore();
  const whole = { autoSettleAfterHours: 72, settleDelegatedAfterHours: 1, settledTerminalLimit: 5 };
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), '{"version":1,"autoSettleAfterDays":"soon"}');
  expect(store.settings.inbox()).toEqual(whole);
  fs.writeFileSync(path.join(stateRoot, "inbox.json"), "not json at all");
  expect(store.settings.inbox()).toEqual(whole);
});
