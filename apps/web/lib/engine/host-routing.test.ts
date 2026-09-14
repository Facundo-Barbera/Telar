/**
 * TWO MACS THAT BOTH HOLD `session_shared` — issue #204.
 *
 * A session id is minted per engine, so the same string legally names different
 * conversations on two paired Macs. That is what makes the reported failure
 * possible at all, and what makes it silent when it does not 404: a row opened
 * against the wrong Mac either gets "session does not exist" (the screenshot) or
 * gets somebody else's conversation with nothing on screen saying so.
 *
 * So the fixture is two engines with a DELIBERATELY overlapping id, driven
 * through the production seam — `sessionHref` builds the address a row's click
 * goes to, `hostFetcher` + `createEngineApi` build the request that address
 * makes — and the thing asserted is the pairing of the two: the row that came
 * from host A must reach engine A, from any address bar, and its failures must
 * say which machine answered.
 *
 * No React, no browser, no network: the two engines are a map from URL to
 * Response, and `window.location` is a control this file sets by hand.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test, beforeEach } from "bun:test";
import { createEngineApi, refusedBy, EngineApiError } from "./client";
import { hostFetcher, hostFromPathname, hostName, hostPrefix, rememberHostName, rewriteApiPath, HOST_NAME_HEADER, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { HOST_ID_HEADER } from "@/lib/hosts/proxy";
import { sessionHref, type SidebarSession } from "@/lib/session-list";

/** The id both Macs hand out. Legal, and the whole reason this file exists. */
const SHARED = "session_shared";

type Engine = {
  /** This cockpit's own id for the Mac; `local` is the absence of a hop. */
  hostId: string;
  /** What the Mac calls itself — what a person reads in an error. */
  name: string;
  /** Session ids this engine actually holds. */
  sessions: Record<string, { projectId: string }>;
  projects: { id: string; name: string }[];
};

const LOCAL: Engine = {
  hostId: LOCAL_HOST_ID,
  name: "this Mac",
  sessions: { [SHARED]: { projectId: "project_shared" }, session_local_only: { projectId: "project_shared" } },
  projects: [{ id: "project_shared", name: "telar (here)" }],
};

const MINI: Engine = {
  hostId: "host_b",
  name: "mini.lan",
  // The same id, a different conversation, in a project whose id ALSO collides.
  sessions: { [SHARED]: { projectId: "project_shared" }, session_mini_only: { projectId: "project_shared" } },
  projects: [{ id: "project_shared", name: "telar (mini)" }],
};

const ENGINES = [LOCAL, MINI];

/** Every request this fixture saw, with the engine it actually reached. */
let reached: { url: string; engine: string }[] = [];

/**
 * The two Macs behind one `fetch`, routed exactly as the app routes them: a
 * request under `/api/hosts/:id/…` is this cockpit's proxy hop and is answered
 * by that Mac; anything else under `/api/` is answered by the local engine.
 * Proxied answers carry the host headers the real proxy stamps.
 */
const wire: typeof fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : String(input);
  const hop = /^\/api\/hosts\/([^/]+)\/(.*)$/.exec(url);
  const engine = hop ? ENGINES.find((candidate) => candidate.hostId === hop[1]) : LOCAL;
  const rest = hop ? `/${hop[2]!}` : url.slice("/api".length);
  if (!engine) {
    // What the real route answers for a host id that is not in the book — a
    // pairing removed, or a row cached from one that was.
    return Response.json({ error: { code: "not_found", message: "No such host." } }, { status: 404 });
  }
  reached.push({ url, engine: engine.hostId });
  // What the real proxy stamps on everything it carries back, and nothing at
  // all on a local answer — there is no hop to attribute.
  const headers: Record<string, string> = hop ? { [HOST_NAME_HEADER]: engine.name, [HOST_ID_HEADER]: engine.hostId } : {};

  const session = /^\/sessions\/([^/?]+)/.exec(rest);
  if (session) {
    const held = engine.sessions[session[1]!];
    if (!held) {
      // The engine's own words, verbatim (apps/engine/src/state.ts).
      return Response.json({ error: { code: "not_found", message: "session does not exist" } }, { status: 404, headers });
    }
    return Response.json({ session: { id: session[1], projectId: held.projectId, engine: engine.hostId } }, { headers });
  }
  if (rest.startsWith("/projects")) return Response.json({ projects: engine.projects }, { headers });
  return Response.json({ error: { code: "not_found", message: "engine endpoint does not exist" } }, { status: 404, headers });
}) as typeof fetch;

/** A rail row as `loadHost` stamps it: the host it was READ FROM travels with
 *  it, and `undefined` means this Mac. */
function row(engine: Engine, id: string): SidebarSession {
  return {
    id,
    projectId: "project_shared",
    ...(engine.hostId === LOCAL_HOST_ID ? {} : { hostId: engine.hostId, hostName: engine.name }),
  } as SidebarSession;
}

/** Open a row the way a click does: take its href, and make the request the
 *  screen at that href would make. */
async function openRow(session: SidebarSession) {
  const href = sessionHref(session);
  const hostId = session.hostId ?? LOCAL_HOST_ID;
  const api = createEngineApi(hostFetcher(hostId, wire));
  return { href, answer: await api.session(session.id).catch((error: unknown) => error) };
}

beforeEach(() => {
  reached = [];
});

describe("two Macs, one session id", () => {
  test("each row opens against the Mac it was read from", async () => {
    const here = await openRow(row(LOCAL, SHARED));
    const there = await openRow(row(MINI, SHARED));

    expect(here.href).toBe(`/projects/project_shared/sessions/${SHARED}`);
    expect(there.href).toBe(`/hosts/host_b/projects/project_shared/sessions/${SHARED}`);
    // Same id, two different conversations, and each read landed on its own.
    expect((here.answer as { session: { engine: string } }).session.engine).toBe(LOCAL_HOST_ID);
    expect((there.answer as { session: { engine: string } }).session.engine).toBe("host_b");
    expect(reached.map((call) => call.engine)).toEqual([LOCAL_HOST_ID, "host_b"]);
  });

  test("the href a row carries and the engine its read reaches are the same Mac", () => {
    // The defect this pins: a row can only be opened correctly if its address
    // and its request agree, and both are derived from the row's own hostId.
    for (const engine of ENGINES) {
      const session = row(engine, SHARED);
      expect(sessionHref(session).startsWith(hostPrefix(session.hostId))).toBe(true);
      expect(session.hostId ?? LOCAL_HOST_ID).toBe(engine.hostId);
    }
  });

  test("a row from one Mac is not reachable by the other's address", async () => {
    // `session_mini_only` exists ONLY on mini. Opened correctly it is found;
    // opened as if it were local — which is what a row that lost its hostId
    // produces — it is the reported 404.
    const correct = await openRow(row(MINI, "session_mini_only"));
    expect((correct.answer as { session: { engine: string } }).session.engine).toBe("host_b");

    const mislabelled = await openRow({ ...row(MINI, "session_mini_only"), hostId: undefined } as SidebarSession);
    expect(mislabelled.href).toBe("/projects/project_shared/sessions/session_mini_only");
    expect(mislabelled.answer).toBeInstanceOf(EngineApiError);
    expect((mislabelled.answer as EngineApiError).message).toBe("session does not exist");
  });
});

describe("a failed open says which Mac refused", () => {
  test("a remote 404 names the Mac; a local one does not", async () => {
    const remote = await openRow(row(MINI, "session_local_only"));
    expect(remote.answer).toBeInstanceOf(EngineApiError);
    expect((remote.answer as EngineApiError).code).toBe("not_found");
    expect(refusedBy(remote.answer as EngineApiError)).toBe("mini.lan");

    const local = await openRow(row(LOCAL, "session_mini_only"));
    // The same words from this machine, and nothing to attribute: there is only
    // one of it, and naming it on every ordinary error would be noise.
    expect((local.answer as EngineApiError).message).toBe("session does not exist");
    expect(refusedBy(local.answer as EngineApiError)).toBeUndefined();
  });

  test("the name is the proxy's, learned from the read that was happening anyway", async () => {
    await openRow(row(MINI, SHARED));
    expect(hostName("host_b")).toBe("mini.lan");
    // Local is never named, whatever is remembered.
    rememberHostName(LOCAL_HOST_ID, "nonsense");
    expect(hostName(LOCAL_HOST_ID)).toBeUndefined();
  });

  test("a Mac that has never answered is named by its id rather than not at all", async () => {
    // Two paired Macs are still told apart by an id; silence would not.
    const error = new EngineApiError("not_found", "session does not exist", 404, { id: "host_never_reached" });
    expect(refusedBy(error)).toBe("host_never_reached");
  });

  test("a host removed from the book refuses by name too", async () => {
    // The row survives in the rail's cache after an unpair; the hop then has no
    // host to forward to, and this cockpit answers for it.
    const api = createEngineApi(hostFetcher("host_gone", wire));
    const failure = await api.session(SHARED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineApiError);
    expect((failure as EngineApiError).message).toBe("No such host.");
    expect(refusedBy(failure as EngineApiError)).toBe("host_gone");
  });
});

describe("the address bar is not the subject", () => {
  test("a pinned read stays on its Mac from any address; the default follows the address", async () => {
    /**
     * The rule `lib/hosts/client.ts` states and #204 broke: a screen whose
     * subject is the current address may follow it (`pathnameFetcher`), and a
     * caller that knows which Mac it means must pin (`hostFetcher`). Standing on
     * mini, a PINNED local read still reaches this Mac — which is what stops
     * mini's rows from being cached, badged and linked as local.
     */
    // Standing on mini. Most of this suite runs without a DOM on purpose
    // (apps/web/scripts/test-dom.mjs), so the address is the string itself and
    // the address-following rule is applied to it directly.
    const standingOn = `/hosts/host_b/projects/project_shared/sessions/${SHARED}`;
    expect(hostFromPathname(standingOn)).toBe("host_b");
    // What the DEFAULT fetcher would do from here: follow the address. Correct
    // for a screen whose subject is the address — and the bug when it is not.
    expect(rewriteApiPath(`/api/sessions/${SHARED}`, hostFromPathname(standingOn))).toBe(`/api/hosts/host_b/sessions/${SHARED}`);

    await createEngineApi(hostFetcher(LOCAL_HOST_ID, wire)).session(SHARED);
    expect(reached.at(-1)!.engine).toBe(LOCAL_HOST_ID);

    await createEngineApi(hostFetcher("host_b", wire)).session(SHARED);
    expect(reached.at(-1)!.engine).toBe("host_b");
  });
});
