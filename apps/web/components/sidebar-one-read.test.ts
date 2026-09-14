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
});
