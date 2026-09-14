// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * ONE READ PER HOST PER PASS — issue #459.
 *
 * The rail used to fan out three ways on every tick, per paired host: the live
 * list, `health()` for the engine's identity, and `inbox()` for its settling
 * window. Two of those answered a single field that changes when somebody opens
 * Settings, and PR #450's audit measured the result at seven concurrent reads
 * with one remote paired — over a browser's six-connection cap, which is the
 * mechanism behind #82's frozen navigation.
 *
 * The engine now stamps `daemonId` and `inbox` on the list itself, so the pass
 * is one request. This is pinned against SOURCE rather than rendered, like the
 * rail's other decisions: `loadHost` runs inside a sidebar provider with a
 * router, a command registry and a pairing book behind it, and a harness that
 * approximated those would be asserting about the harness.
 */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sidebar = code(readFileSync(new URL("./app-sidebar.tsx", import.meta.url), "utf8"));
/** `loadHost` — one Mac's rows, from its opening to `loadAll` below it. */
const loadHost = sidebar.slice(sidebar.indexOf("const loadHost = useCallback"), sidebar.indexOf("const loadAll = useCallback"));

describe("a rail's pass is one read per host", () => {
  test("the fan-out is gone: no health, no inbox, no Promise.all beside the list", () => {
    expect(loadHost).toContain("hostApi.liveSessions()");
    expect(loadHost).not.toContain("hostApi.health()");
    expect(loadHost).not.toContain("hostApi.inbox()");
    // The concurrency itself, not just its members: a `Promise.all` here is the
    // shape that grew three arms once and would grow a fourth unnoticed.
    expect(loadHost).not.toContain("Promise.all");
  });

  test("both folded fields are read off the one answer", () => {
    expect(loadHost).toContain("result.daemonId");
    expect(loadHost).toContain("result.inbox");
  });

  test("and they stay optional, so an older engine costs neither rows nor bands", () => {
    // `daemonId` absent leaves a host undeduplicated; `inbox` absent falls back
    // to the default window. Both are spread conditionally exactly as before, so
    // an engine that predates the fields is the old cockpit, not a broken one.
    expect(loadHost).toContain("...(daemonId ? { daemonId } : {})");
    expect(loadHost).toContain("...(policy ? { policy } : {})");
  });
});

describe("and that one read is conditional", () => {
  test("the rail asks with the cursor it was given, and keeps its page when nothing moved", () => {
    expect(loadHost).toContain("revisions.current.get(key)");
    expect(loadHost).toContain("hostApi.liveSessionsSince(known)");
    // "Unchanged" means KEEP WHAT YOU HAVE. A rail that redrew from the absent
    // rows would blank itself once a tick, which is the one way this design can
    // fail in a reader's face.
    expect(loadHost).toContain("if (answer.unchanged)");
    expect(loadHost).toContain("pages.current.get(key)");
  });

  test("a cursor is only kept while the engine offers one", () => {
    // An engine too old to count sends no revision, and the rail then goes on
    // making full reads rather than spending a stale cursor against it.
    expect(loadHost).toContain("if (result.revision === undefined) revisions.current.delete(key)");
    expect(loadHost).toContain("if (result.revision !== undefined) pages.current.set(key, page)");
  });

  test("the cursor is per host, so one Mac's number is never spent on another's", () => {
    // Two Macs count independently; a cursor crossing hosts would look current
    // against a revision that means something else entirely.
    expect(loadHost).toContain("const key = host?.id ?? LOCAL_HOST;");
  });
});

describe("the route forwards what the engine stamped", () => {
  const route = code(readFileSync(new URL("../app/api/sessions/live/route.ts", import.meta.url), "utf8"));

  test("daemonId and the inbox policy reach a browser, omitted when absent", () => {
    // This proxy re-composes the engine's answer rather than streaming it, so a
    // field it forgets is a field the LOCAL rail cannot see while the hosts
    // proxy (which forwards verbatim) carries it — the exact asymmetry that
    // silently emptied `assignments` once.
    expect(route).toContain("daemonId");
    expect(route).toContain("...(daemonId ? { daemonId } : {})");
    expect(route).toContain("...(inbox ? { inbox } : {})");
  });

  test("and it learns the conditional read rather than spending it on the engine's behalf", () => {
    // This proxy re-composes rather than streams, so without this a browser's
    // rail would pull the full list every tick while the phone — which reaches
    // the engine verbatim through the hosts proxy — got the cheap answer.
    expect(route).toContain('query.get("since")');
    expect(route).toContain("client.liveSessionsSince(Number(since))");
    expect(route).toContain("if (live.unchanged) return Response.json(live)");
    // An unchanged answer must not go on to fetch the registry either: writing
    // it bumps the same revision, so it cannot have moved.
    expect(route.indexOf("if (live.unchanged)")).toBeLessThan(route.indexOf("client.listProjects()"));
  });

  test("and the shelf's ask reaches the engine, with the count that draws the shelf", () => {
    // The engine answers only the unsettled rows by default (#457). Without the
    // pass-through a browser's Settled shelf would be permanently empty while
    // the phone's — reaching the engine verbatim through the hosts proxy —
    // filled: the same asymmetry this file exists to catch.
    expect(route).toContain('query.get("all") === "1"');
    expect(route).toContain("client.liveSessions({ all: true })");
    expect(route).toContain("...(settledCount === undefined ? {} : { settledCount })");
    // AND THE WIDE ASK IS NOT CONDITIONAL. The revision counts writes, so it
    // does not move when a reader opens a shelf; spending a cursor across the
    // two lists would answer "unchanged" and leave the shelf empty.
    expect(route.indexOf('all ? await client.liveSessions({ all: true })')).toBeGreaterThan(-1);
  });
});
