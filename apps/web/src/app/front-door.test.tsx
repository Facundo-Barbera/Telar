/**
 * WHAT THE LAUNCH ASKS THE ENGINE FOR — issue #490.
 *
 * THE ASSERTIONS ARE COUNTS AND PATHS, NEVER A DURATION. A millisecond figure
 * taken on a shared machine is noise, and it passes whether or not the read it
 * is supposed to be about happened at all; a REQUEST is a thing the broken state
 * cannot help producing. So these count what went out and name what it was.
 *
 * THE DEFECT, IN TWO HALVES, AND EACH FAILS SEPARATELY ON `main`:
 *
 *   - THE WARM LAUNCH ASKED FOR ANYTHING AT ALL. `go(remembered)` redirects on
 *     the first frame, before any await — and then `decide()` ran regardless,
 *     issuing a 101.6 KB read whose answer had no consumer left, into the same
 *     two-slot read gate the route it had just opened was reading through.
 *   - THE COLD LAUNCH ASKED FOR THE WHOLE WORLD. `liveSessions({ all: true })`
 *     is every active session on the machine — 291 rows on the owner's store —
 *     to rank ~20 projects by one timestamp each and render none of it.
 *
 * MOUNTED FOR REAL, because both halves are about an effect's ordering against a
 * redirect: the guard is a line that runs between `go()` and a `setInterval`, and
 * a static render would exercise neither.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `router.replace` the door issued, in order — the redirect it decided. */
let replaced: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (href: string) => replaced.push(href),
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { FrontDoor } = await import("./front-door");
const { canvasHrefFor } = await import("@/lib/composer-project");

const NOTE_KEY = "telar.front-door.v1";
const STAMP = 1_700_000_000_000;

/** Two projects: `quiet` was registered later, `busy` holds the newer session.
 *  The ranking has to prefer `busy`, which is the only way to tell a real fold
 *  from a fallback to most-recently-registered. */
const PROJECTS = [
  { id: "project_busy", name: "Busy", root: "/tmp/busy", createdAt: 1 },
  { id: "project_quiet", name: "Quiet", root: "/tmp/quiet", createdAt: 2 },
];

/** Every request the door made, as paths — what this file asserts on. */
let asked: string[] = [];
const realFetch = globalThis.fetch;

function wire() {
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    asked.push(url.pathname + url.search);
    if (url.pathname === "/api/projects") return Response.json({ projects: PROJECTS });
    if (url.pathname === "/api/sessions/activity") {
      return Response.json({
        projects: [
          { projectId: "project_quiet", updatedAt: STAMP },
          { projectId: "project_busy", updatedAt: STAMP + 1_000 },
        ],
      });
    }
    /**
     * THE READ THIS CHANGE REMOVES, answered anyway. A fixture that 404'd here
     * would make the test pass for the wrong reason — a door that still asked
     * would merely fail to rank, and `asked` is what has to carry the verdict.
     */
    if (url.pathname === "/api/sessions/live") {
      return Response.json({
        projects: PROJECTS,
        sessions: [
          { id: "session_a", projectId: "project_quiet", updatedAt: STAMP },
          { id: "session_b", projectId: "project_busy", updatedAt: STAMP + 1_000 },
        ],
      });
    }
    return Response.json({});
  }) as typeof fetch;
}

/** Whichever session list went out, by any spelling. The point of the warm test
 *  is that NOTHING did, so this must not be pinned to one query string. */
const sessionReads = (): string[] => asked.filter((path) => path.startsWith("/api/sessions/"));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  replaced = [];
  window.localStorage.clear();
  wire();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Mount the door and let its reads land. Several passes because the decision is
 *  a `Promise.all` behind a read gate behind an effect — one `act` is not enough
 *  turns of the loop, and a fixed sleep would be a flake on a loaded machine. */
async function open() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<FrontDoor />);
  });
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("a launch the note already answered reads nothing from the engine", async () => {
  // The note the last visit left: the registry, and the project it was in.
  window.localStorage.setItem(
    NOTE_KEY,
    JSON.stringify({ projects: PROJECTS.map(({ id, createdAt, name }) => ({ id, createdAt, name })), composer: "project_busy", at: STAMP }),
  );

  await open();

  // It redirected — on the note, so this is the warm path and not a cold one
  // that happened to agree.
  expect(replaced).toEqual([canvasHrefFor("project_busy")]);
  /**
   * AND IT ASKED FOR NOTHING. On `main` this is `["/api/sessions/live?all=1"]`:
   * the 101.6 KB read, issued after the redirect, with no consumer and the
   * opening's own reads queued behind it.
   */
  expect(sessionReads()).toEqual([]);
  // Not even the registry, which had nothing left to correct either.
  expect(asked).toEqual([]);
});

test("a first launch ranks from the aggregate, not from every session on the machine", async () => {
  // No note: the cold path, which is the one that still has to read.
  await open();

  /**
   * ONE SESSION READ, AND IT IS THE NARROW ONE. On `main` this is
   * `/api/sessions/live?all=1` — every active session on the engine, rendered
   * nowhere. The equality is deliberate: a door that asked for BOTH would pass
   * a "did it call activity" check and still ship the defect.
   */
  expect(sessionReads()).toEqual(["/api/sessions/activity"]);
  expect(asked.sort()).toEqual(["/api/projects", "/api/sessions/activity"]);

  // And the answer it ranked from is the same one: `busy` holds the newer
  // session, `quiet` was registered later. A fold that had failed would fall
  // back to most-recently-registered and open `quiet`.
  expect(replaced).toEqual([canvasHrefFor("project_busy")]);
});

test("an engine that cannot answer the aggregate still opens a project", async () => {
  /**
   * THE READ IS NOT LOAD-BEARING, and that is a property rather than a detail:
   * `composerProject` seeds every registered project at 0, so an unanswered
   * aggregate ranks them all cold and the most-recently-registered one opens.
   * The failure mode this forbids is a blank front door — which is what an
   * unhandled rejection in the `Promise.all` would produce.
   */
  const answering = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/sessions/activity") {
      asked.push(url.pathname);
      return new Response("not found", { status: 404 });
    }
    return answering(input as Parameters<typeof fetch>[0]);
  }) as typeof fetch;

  await open();

  expect(asked).toContain("/api/sessions/activity");
  // `quiet` is `createdAt: 2` — the registration fallback, reached rather than
  // nothing being reached at all.
  expect(replaced).toEqual([canvasHrefFor("project_quiet")]);
});
