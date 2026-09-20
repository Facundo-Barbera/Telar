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
    // The live list, whichever of its three spellings this pass uses — the
    // claim is that there is ONE read here and not three.
    expect(loadHost).toContain("hostApi.liveSessions");
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
  test("the rail asks with the tag it was given, and keeps its page when nothing moved", () => {
    // AN ETAG RATHER THAN THE CURSOR (#457): the tag names the LIST it
    // described, so a tag earned against the unsettled rows cannot be answered
    // with "unchanged" against `?all=1` — which would leave the Settled shelf
    // a reader just opened permanently empty.
    expect(loadHost).toContain("tags.current.get(key)");
    expect(loadHost).toContain("hostApi.liveSessionsMatching(");
    // "Not modified" means KEEP WHAT YOU HAVE. A rail that redrew from the
    // absent rows would blank itself once a tick, which is the one way this
    // design can fail in a reader's face.
    expect(loadHost).toContain("if (answer.notModified)");
    expect(loadHost).toContain("pages.current.get(key)");
  });

  test("the cursor is the floor, so a Mac too old to mint a tag loses nothing it had", () => {
    // An engine that predates the ETag answers 200 without one; the rail then
    // falls back to `?since=` — exactly what it did before — rather than
    // dropping to a full read every tick.
    expect(loadHost).toContain("hostApi.liveSessionsSince(cursor)");
    expect(loadHost).toContain("if (result.revision === undefined) revisions.current.delete(key)");
  });

  test("a conditional is only kept while the engine offers one", () => {
    expect(loadHost).toContain("else tags.current.delete(key)");
    expect(loadHost).toContain("pages.current.set(key, page)");
  });

  test("the conditional is per host, so one Mac's tag is never spent on another's", () => {
    // Two Macs count independently; a tag crossing hosts would look current
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
    expect(route).toContain("...(all ? { all: true } : {})");
    expect(route).toContain("...(settledCount === undefined ? {} : { settledCount })");
  });

  test("and it forwards the conditional, and passes a 304 straight back", () => {
    // Without this a browser's rail would pull the full list every tick while
    // the phone — which reaches the engine verbatim through the hosts proxy —
    // got the cheap answer. The same asymmetry this file exists to catch.
    expect(route).toContain('request.headers.get("if-none-match")');
    expect(route).toContain("client.liveSessionsMatching(");
    expect(route).toContain("status: 304");
    // AND THE UNCONDITIONAL READ CARRIES A TAG OUT. Without one the caller has
    // nothing to hand back and the cheap tick is unreachable from a cold start.
    expect(route).toContain("compose(answer, answer.etag)");
    expect(route).toContain("{ headers: { etag, \"cache-control\": \"no-store\" } }");
    // The cursor still answers a caller that sends one and no tag: nothing is
    // taken away from `?since=`.
    expect(route).toContain("client.liveSessionsSince(Number(since))");
  });
});
