/**
 * THE ROUTE EVERY COCKPIT POLLS — issue #459.
 *
 * `GET /v2/sessions/live` is the most-served read on the engine: each cockpit
 * asks for it on a timer, for every paired host, for as long as it is open.
 * Measured on the owner's store (267 sessions, 724 MB) it answered 317,813
 * bytes in 200 ms, and the engine sat at 65–78% CPU with a Mac and a phone
 * attached. Most of those bytes were fields no rail has ever drawn.
 *
 * These tests pin the two halves of the fix: WHICH KEYS reach the wire, and
 * what a store the size of the owner's actually costs.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine } from "../src/daemon";
import { EngineStore } from "../src/state";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-engine-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A checkout path the length of a real one, so the bytes below are not an
 *  artefact of `/tmp`: the owner's sessions live under
 *  `~/Library/Application Support/Telar/engine/worktrees/<branch-slug>-<hash>`. */
const checkout = (): string => {
  const directory = path.join(root(), "Library", "Application Support", "Telar", "engine", "worktrees", "459-lean-live-list-cursor-not-poll-5e1ea4-f08495d8");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

/** Everything the record can hold that a rail never reads, set through the
 *  public API — otherwise the saving measured below is a saving on absent
 *  fields, which is not a saving at all. */
function loadedStore(count: number): EngineStore {
  const store = new EngineStore(root(), () => 1_700_000_000_000);
  store.registerProject({ id: "project_one", name: "Telar", root: checkout() });
  for (let index = 0; index < count; index += 1) {
    const id = `session_${index.toString(16).padStart(8, "0")}b2c3d4e5f60718293a4b5c`;
    store.createSession({ id, projectId: "project_one", title: `Lean the live list: cursor, not poll (${index})` });
    store.updateSession(id, {
      model: { instanceId: "claude", model: "claude-opus-5[1m]", effort: "high" },
      runtimeMode: "full-access",
      detached: true,
      resumeAfterRateLimit: true,
      ...(index % 3 === 0 ? { settledOverride: "settled" as const } : {}),
      ...(index % 5 === 0 ? { snoozedUntil: 1_700_000_900_000 } : {}),
    });
  }
  return store;
}

test("the live list answers rows, not whole sessions — every key a rail draws and none it does not", () => {
  const store = loadedStore(1);
  const [row] = store.liveSessionRows().sessions;
  const [full] = store.liveSessions().sessions;
  expect(row).toBeDefined();
  expect(full).toBeDefined();

  /**
   * ENGINE BOOKKEEPING, GONE FROM THE WIRE. Each of these is read by the
   * session surface (`GET /v2/sessions/:id`), by the worker, or by nobody — and
   * each was being serialized for 267 rows several times a second. The full
   * record still carries them, which is what `?full=1` serves.
   */
  for (const key of ["environmentId", "providerInstanceId", "runtimeMode", "interactionMode", "detached", "resumeCursor", "resumeAfterRateLimit", "unsettledAssignments", "agentMessagesBlocked", "paused", "origin"]) {
    expect(row).not.toHaveProperty(key);
  }
  // The four this fixture can actually set are on the full record, so the
  // absences above are the projection's doing and not the fixture's.
  for (const key of ["environmentId", "providerInstanceId", "runtimeMode", "detached", "resumeAfterRateLimit"]) {
    expect(full).toHaveProperty(key);
  }
  // The commit a checkout was cut from is a review surface's question, asked
  // once per session opened — not 267 times a poll.
  expect(row!.workspace).not.toHaveProperty("baseRef");

  /** WHAT A ROW ACTUALLY RENDERS, and it has to be all of it: the rail's
   *  projection (`toSidebarSession`) reads every one of these, and a row that
   *  lost one would draw a blank rather than fail. */
  for (const key of ["id", "projectId", "title", "state", "createdAt", "updatedAt", "driver", "model", "envMode", "workspace", "activity", "settledOverride", "settledAt"]) {
    expect(row).toHaveProperty(key);
  }
  // Absent rather than null: `JSON.stringify` drops the one and spends bytes on
  // the other, and the point of the whole exercise is the bytes.
  expect(Object.values(row as Record<string, unknown>)).not.toContain(undefined);
});

test("a 267-session store answers the live list in a fraction of what it used to", () => {
  // The owner's store, to the session: 267 live conversations.
  const store = loadedStore(267);
  const full = JSON.stringify(store.liveSessions()).length;
  const lean = JSON.stringify(store.liveSessionRows()).length;

  expect(store.liveSessionRows().sessions).toHaveLength(267);
  /**
   * THE BOUND IS PER ROW, not per answer, because it is the per-row cost that
   * multiplies: 267 sessions today, more next month, and the same read on every
   * tick per paired host either way. Measured on this fixture: 726 bytes a row
   * whole, 572 as a row. 600 is the ceiling that catches a field creeping back
   * onto the wire without pinning the exact byte count.
   *
   * WHY NOT THE 40 KB THE ISSUE ASKED FOR, WHICH IS 153 BYTES A ROW. Because
   * `workspace` alone is 216 of these 572: an absolute checkout path, which the
   * rail's row menu copies and its subtitle falls back to. Getting under 40 KB
   * means the row stops carrying the path, the model, the created stamp and the
   * usage figures — every one of which something draws today. The cold read is
   * as small as it can be while the rail draws what it draws; what takes the
   * STEADY state under 40 KB is `?since=`, which sends only the rows that moved.
   *
   * REAL ROWS ARE HEAVIER THAN THESE, and so is the saving: a fixture cannot
   * cheaply carry a resume cursor, a usage ledger, a `startedFrom` or an
   * un-settle ledger, and the whole record carries all four on the owner's
   * store while a row carries one.
   */
  expect(lean / 267).toBeLessThan(600);
  expect(lean).toBeLessThan(full);
});

test("the shapes disagree about rows and about nothing else", () => {
  // The escape hatch is the OLD method, unchanged — not a second projection
  // that could drift from it. A client asking for either must not find itself
  // reading a different LIST.
  const store = loadedStore(3);
  const full = store.liveSessions();
  const lean = store.liveSessionRows();
  expect(lean.sessions.map((session) => session.id)).toEqual(full.sessions.map((session) => session.id));
  expect(lean.projects).toEqual(full.projects);
  expect(lean.layout).toEqual(full.layout);
  expect(lean.assignments).toEqual(full.assignments);
});

test("`?full=1` serves the old shape over the wire, for one release", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  try {
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root: engineRoot });
    await client.createSession({ id: "session_one", projectId: "project_one" });

    // The default is the row: this is what every cockpit now receives.
    const live = await client.liveSessions();
    expect(live.sessions[0]).not.toHaveProperty("runtimeMode");
    expect(live.sessions[0]).not.toHaveProperty("environmentId");
    /**
     * AND THE RAIL'S WHOLE PASS IS THIS ONE ANSWER. `daemonId` and the settling
     * window used to be a `/v2/health` and a `/v2/inbox` issued concurrently
     * with this — three reads per host per tick for two fields that move when
     * somebody opens Settings.
     */
    expect(live.daemonId).toBe(daemon.discovery.daemonId);
    expect(live.inbox).toEqual(await client.inboxPolicy().then((answer) => answer.inbox));

    // And a client built against the old shape still has one to ask for — a
    // paired Mac on last week's nightly, or a script.
    const answer = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live?full=1`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}` },
    });
    expect(answer.status).toBe(200);
    const whole = (await answer.json()) as { sessions: Array<Record<string, unknown>> };
    expect(whole.sessions[0]).toHaveProperty("runtimeMode");
    expect(whole.sessions[0]).toHaveProperty("environmentId");
    expect(whole.sessions[0]?.id).toBe("session_one");
  } finally {
    await daemon.close();
  }
});
