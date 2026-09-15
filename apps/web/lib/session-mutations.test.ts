/**
 * WHAT A MUTATION IS ALLOWED TO COST — issue #495, and this file is the
 * acceptance for it.
 *
 * THE NUMBER THAT MATTERS IS THE LIVE-LIST READ. Before this, every verb on a
 * rail row ended in `onRefresh()`, which the rail answered with `loadAll()`:
 * one `hosts()` read plus one `/api/sessions/live` read PER PAIRED MAC, per
 * click. So the recorded reads below are not a performance smoke test — they
 * are the whole feature, and a regression would be invisible in every other
 * assertion this suite makes.
 *
 * ONE TEST PER MUTATION, DELIBERATELY REPETITIVE. Settle, pin, snooze, rename
 * and delete are five call sites across two components, and a shared "no reads
 * happened" helper run once would pass while four of them had quietly grown a
 * reload back.
 *
 * AND THE ORDER OF THE THREE STATES IS ASSERTED, not just the endpoint: the
 * guess must land BEFORE the request goes out, or "optimistic" is only a word
 * for "the same wait with a nicer name".
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { LiveSessionRow } from "@telar/engine-client";
import type { SidebarSession } from "./session-list";
import {
  applyRowChange,
  deleteSession,
  mutateRow,
  patchedRow,
  patchSession,
  withSettling,
  withSnooze,
  withTitle,
  type SessionRowChange,
} from "./session-mutations";

const row = (over: Partial<SidebarSession> = {}): SidebarSession => ({
  id: "session_one",
  title: "Exoplanets",
  projectId: "project_one",
  projectName: "telar",
  projectIcon: "icon_abc",
  projectIconName: "rocket",
  projectRemote: "github.com/owner/telar",
  projectBranch: "main",
  createdAt: 1_000,
  updatedAt: 2_000,
  archived: false,
  driver: "claude",
  activity: "idle",
  workspacePath: "/repo",
  ...over,
});

/** What the engine answers a PATCH with — the record, not a row projection. */
const record = (over: Partial<LiveSessionRow> = {}): LiveSessionRow =>
  ({
    id: "session_one",
    title: "Exoplanets",
    projectId: "project_one",
    createdAt: 1_000,
    updatedAt: 9_000,
    state: "active",
    driver: "claude",
    activity: "idle",
    workspace: { mode: "local", path: "/repo" },
    ...over,
  }) as LiveSessionRow;

/**
 * EVERY REQUEST THIS PROCESS MAKES, in order. The real `fetch` is replaced
 * rather than a fetcher injected, because `sessionFetch` reaches for
 * `hostFetcher` itself — a fake threaded in through an argument would prove
 * nothing about the path the rail actually takes, including the remote-host
 * rewrite that turns `/api/x` into `/api/hosts/:id/x`.
 */
let asked: string[] = [];
let answer: () => Response = () => Response.json({ session: record() });
const realFetch = globalThis.fetch;

beforeEach(() => {
  asked = [];
  answer = () => Response.json({ session: record() });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${typeof input === "string" ? input : String(input)}`);
    return Promise.resolve(answer());
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The assertion this file exists for. `live` is the aggregate list read the
 *  rail polls on; `hosts` is the pairing book `loadAll` reads before it. */
const liveListReads = () => asked.filter((call) => call.includes("/sessions/live") || call.endsWith("/api/hosts"));

/** Run one mutation and report what the rail was told, in order. */
async function run(
  before: SidebarSession,
  after: SessionRowChange,
  send: Parameters<typeof mutateRow>[0]["send"],
): Promise<{ changes: SessionRowChange[]; said: string[] }> {
  const changes: SessionRowChange[] = [];
  const said: string[] = [];
  await mutateRow({ before, after, send, onRowChanged: (change) => changes.push(change), report: (message) => said.push(message) });
  return { changes, said };
}

describe("no mutation reads the live list", () => {
  test("settle sends one PATCH and nothing else", async () => {
    const before = row();
    const { changes } = await run(before, { row: withSettling(before, "settled", 5_000) }, () =>
      patchSession(before, { settledOverride: "settled" }),
    );
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["PATCH /api/sessions/session_one"]);
    expect(changes).toHaveLength(2);
  });

  test("pin sends one PATCH and nothing else", async () => {
    const before = row();
    await run(before, { row: withSettling(before, "active", 5_000) }, () => patchSession(before, { settledOverride: "active" }));
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["PATCH /api/sessions/session_one"]);
  });

  test("snooze sends one PATCH and nothing else", async () => {
    const before = row();
    await run(before, { row: withSnooze(before, 8_000, 5_000) }, () => patchSession(before, { snoozedUntil: 8_000 }));
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["PATCH /api/sessions/session_one"]);
  });

  test("rename sends one PATCH and nothing else", async () => {
    const before = row();
    await run(before, { row: withTitle(before, "Transit timing", 5_000) }, () => patchSession(before, { title: "Transit timing" }));
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["PATCH /api/sessions/session_one"]);
  });

  test("delete sends one DELETE and nothing else", async () => {
    const before = row();
    answer = () => Response.json({ deleted: true });
    await run(before, { removed: "session_one" }, () => deleteSession(before));
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["DELETE /api/sessions/session_one"]);
  });

  test("un-settling costs its two patches and still no list read", () => {
    // The two-step exists because clearing an override a drift-settled session
    // never had writes nothing, and it is the one verb that could plausibly
    // have kept a reload to sort itself out.
    const before = row();
    return run(before, { row: withSettling(before, null, 5_000) }, async () => {
      await patchSession(before, { settledOverride: "active" });
      return patchSession(before, { settledOverride: null });
    }).then(() => {
      expect(liveListReads()).toEqual([]);
      expect(asked).toEqual(["PATCH /api/sessions/session_one", "PATCH /api/sessions/session_one"]);
    });
  });

  test("a row on a paired Mac patches THAT Mac, and still reads no list", async () => {
    const before = row({ hostId: "host_mini", hostName: "mini" });
    await run(before, { row: withSettling(before, "settled", 5_000) }, () => patchSession(before, { settledOverride: "settled" }));
    expect(liveListReads()).toEqual([]);
    expect(asked).toEqual(["PATCH /api/hosts/host_mini/sessions/session_one"]);
  });
});

describe("the three states of a mutation", () => {
  test("the guess lands BEFORE the request goes out", async () => {
    const before = row();
    const seen: { changes: number; asked: number }[] = [];
    await mutateRow({
      before,
      after: { row: withSettling(before, "settled", 5_000) },
      send: () => {
        // Recorded inside `send`: by the time the engine is reached, the rail
        // must already have been handed the guess. If this is 0 the mutation
        // is not optimistic, whatever the endpoint state looks like.
        seen.push({ changes: 1, asked: asked.length });
        return patchSession(before, { settledOverride: "settled" });
      },
      onRowChanged: () => {
        if (seen.length === 0) seen.push({ changes: 0, asked: asked.length });
      },
    });
    expect(seen[0]).toEqual({ changes: 0, asked: 0 });
  });

  test("the row settles on what the engine STORED, not on what was clicked", async () => {
    const before = row();
    // A clamp is the honest case: the engine trimmed the title, and the rail
    // has to show the trim rather than the 400 characters somebody pasted.
    answer = () => Response.json({ session: record({ title: "Trimmed", updatedAt: 9_000 }) });
    const { changes } = await run(before, { row: withTitle(before, "A very long name", 5_000) }, () =>
      patchSession(before, { title: "A very long name" }),
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual({ row: expect.objectContaining({ title: "A very long name" }) });
    expect(changes[1]).toEqual({ row: expect.objectContaining({ title: "Trimmed", updatedAt: 9_000 }) });
  });

  test("a refusal puts the row back exactly as it was, and says why", async () => {
    const before = row();
    answer = () => Response.json({ error: { message: "that session is mid-turn" } }, { status: 409 });
    const { changes, said } = await run(before, { row: withSettling(before, "settled", 5_000) }, () =>
      patchSession(before, { settledOverride: "settled" }),
    );
    expect(changes[0]).toEqual({ row: expect.objectContaining({ settledOverride: "settled" }) });
    expect(changes[1]).toEqual({ row: before });
    expect(said).toEqual(["that session is mid-turn"]);
    // AND STILL NO RELOAD. The old path refreshed on failure too — the argument
    // was "show what is stored rather than what was clicked" — and the revert
    // is that, without the fan-out.
    expect(liveListReads()).toEqual([]);
  });

  test("a refused delete brings the row back", async () => {
    const before = row();
    answer = () => Response.json({ error: { message: "a turn is in flight" } }, { status: 409 });
    const { changes, said } = await run(before, { removed: "session_one" }, () => deleteSession(before));
    expect(changes[0]).toEqual({ removed: "session_one" });
    expect(changes[1]).toEqual({ row: before });
    expect(said).toEqual(["a turn is in flight"]);
  });
});

describe("what the engine's answer keeps of the row", () => {
  test("the rail's own resolutions survive the patch", () => {
    // The project's name, icon, glyph and remote, and which Mac this is, are
    // properties of the READ rather than of the session — the engine's answer
    // carries none of them, and a patch that dropped them would blank the row's
    // header line until the next poll.
    const before = row({ hostId: "host_mini", hostName: "mini" });
    const patched = patchedRow(before, record({ title: "Renamed" }));
    expect(patched.title).toBe("Renamed");
    expect(patched.projectName).toBe("telar");
    expect(patched.projectIcon).toBe("icon_abc");
    expect(patched.projectIconName).toBe("rocket");
    expect(patched.projectRemote).toBe("github.com/owner/telar");
    expect(patched.projectBranch).toBe("main");
    expect(patched.hostId).toBe("host_mini");
    expect(patched.hostName).toBe("mini");
  });

  test("a stale mark does not survive it — this row is an answer that just arrived", () => {
    const before = row({ stale: 1_234 });
    expect(patchedRow(before, record()).stale).toBeUndefined();
  });
});

describe("the optimistic shapes", () => {
  test("settling stamps the clock, because un-settling depends on it", () => {
    // Returning a drift-settled session to the list works by restarting the
    // inactivity clock. A guess that kept the old stamp would draw the row
    // straight back onto the shelf it had just left.
    expect(withSettling(row(), null, 5_000).updatedAt).toBe(5_000);
  });

  test("clearing a field REMOVES it rather than setting it undefined", () => {
    const cleared = withSettling(row({ settledOverride: "settled", settledAt: 3_000 }), null, 5_000);
    expect("settledOverride" in cleared).toBe(false);
    expect("settledAt" in cleared).toBe(false);
  });

  test("settling by hand drops the engine's reason for settling", () => {
    // `settledBy` only ever means "the engine shelved this because delegated
    // work was delivered" (#378). A person deciding about the row must not
    // leave that sentence hanging off it.
    const engineSettled = row({
      settledOverride: "settled",
      settledBy: { kind: "delegation", coordinatorSessionId: "session_coord", runId: "run_one", at: 4_000 },
      settledForTitle: "Coordinator",
    });
    const byHand = withSettling(engineSettled, null, 5_000);
    expect("settledBy" in byHand).toBe(false);
    expect("settledForTitle" in byHand).toBe(false);
  });

  test("waking clears both snooze fields; snoozing sets both", () => {
    const asleep = withSnooze(row(), 8_000, 5_000);
    expect(asleep.snoozedUntil).toBe(8_000);
    expect(asleep.snoozedAt).toBe(5_000);
    const awake = withSnooze(asleep, null, 6_000);
    expect("snoozedUntil" in awake).toBe(false);
    expect("snoozedAt" in awake).toBe(false);
  });
});

/**
 * AND THE WIRING, BECAUSE THE TESTS ABOVE ONLY PROVE THE MODULE.
 *
 * `mutateRow` cannot read a list — it is handed one row and one send — so the
 * assertions above would go on passing if a component grew `onRowChanged={() =>
 * { patch(); void loadAll(); }}` back. The three files that draw a rail row are
 * read here instead, which is the same shape as `session-action-menu.test.ts`
 * guarding a verb out of one list: a rule the compiler cannot state, asserted
 * where it is cheap.
 */
describe("no rail row hands a mutation a list read", () => {
  const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
  /**
   * COMMENTS OUT FIRST, AND THAT IS NOT A CONVENIENCE.
   *
   * Both files EXPLAIN the reload they replaced — "the rail answered it with
   * `loadAll()`" is the sentence that makes the change legible — so an
   * assertion over raw source would ban the documentation along with the call
   * and be deleted by the next person who wrote either.
   */
  const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  test("the row surfaces cannot reach a list read at all", () => {
    for (const path of ["../components/session/session-row.tsx", "../components/session/session-inbox-menu.tsx"]) {
      const source = code(path);
      // `createEngineApi` is the only door to `liveSessions` in this app, and
      // `loadAll` is the rail's own fan-out. Neither file names either.
      expect(source).not.toContain("createEngineApi");
      expect(source).not.toContain("liveSessions");
      expect(source).not.toContain("loadAll");
    }
  });

  test("every row the rail draws is given the one patching hand", () => {
    const source = read("../components/app-sidebar.tsx");
    const bindings = [...source.matchAll(/onRowChanged=\{([^}]*)\}/g)].map((match) => match[1]);
    // Nine places draw a row. Each used to read `onRefresh={() => void
    // loadAll()}` — nine fan-outs, one per click, spelled nine times — so the
    // regression this catches is a tenth spelling, not an absence.
    expect(bindings.length).toBeGreaterThanOrEqual(8);
    expect(new Set(bindings)).toEqual(new Set(["onRowChanged"]));
  });
});

describe("the rail's side: one change, one row", () => {
  const a = row({ id: "session_a" });
  const b = row({ id: "session_b" });
  const remote = row({ id: "session_a", hostId: "host_mini", hostName: "mini" });

  test("a patch replaces exactly the row it names", () => {
    const next = applyRowChange([a, b], { row: { ...a, title: "Renamed" } });
    expect(next.map((entry) => entry.title)).toEqual(["Renamed", "Exoplanets"]);
    expect(next).toHaveLength(2);
  });

  test("a removal drops exactly the row it names", () => {
    expect(applyRowChange([a, b], { removed: "session_b" }).map((entry) => entry.id)).toEqual(["session_a"]);
  });

  test("two Macs' rows with one id are told apart", () => {
    // `sessionKey`, not the bare id: settling on the mini must not rewrite a
    // local conversation that happens to share an id.
    const next = applyRowChange([a, remote], { row: { ...remote, title: "On the mini" } });
    expect(next.map((entry) => entry.title)).toEqual(["Exoplanets", "On the mini"]);
  });

  test("a row the list no longer holds is not inserted by a late answer", () => {
    // The poll owns what the list CONTAINS; this owns what a row LOOKS like. A
    // mutation landing after the project was deregistered must not put the row
    // back.
    expect(applyRowChange([b], { row: a })).toEqual([b]);
  });
});
