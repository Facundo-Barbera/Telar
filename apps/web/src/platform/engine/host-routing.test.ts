/**
 * Two engines deliberately sharing a session id: a row must reach the Mac it was read from,
 * and its failures must name that Mac. The engines are a map from URL to Response.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test, beforeEach } from "bun:test";
import { createEngineApi, refusedBy, EngineApiError } from "./client";
import { hostFetcher, hostFromPathname, hostName, hostPrefix, rememberHostName, rewriteApiPath, HOST_NAME_HEADER, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { HOST_ID_HEADER } from "@/lib/hosts/proxy";
import { sessionHref, type SidebarSession } from "@/lib/session-list";

/** Session ids are minted per engine, so both Macs may hold this one. */
const SHARED = "session_shared";

type Engine = {
  /** `local` is the absence of a hop. */
  hostId: string;
  name: string;
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
  sessions: { [SHARED]: { projectId: "project_shared" }, session_mini_only: { projectId: "project_shared" } },
  projects: [{ id: "project_shared", name: "telar (mini)" }],
};

const ENGINES = [LOCAL, MINI];

let reached: { url: string; engine: string }[] = [];

/** Routed as the app does: `/api/hosts/:id/…` goes to that Mac, anything else to the local engine. */
const wire: typeof fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : String(input);
  const hop = /^\/api\/hosts\/([^/]+)\/(.*)$/.exec(url);
  const engine = hop ? ENGINES.find((candidate) => candidate.hostId === hop[1]) : LOCAL;
  const rest = hop ? `/${hop[2]!}` : url.slice("/api".length);
  if (!engine) {
    return Response.json({ error: { code: "not_found", message: "No such host." } }, { status: 404 });
  }
  reached.push({ url, engine: engine.hostId });
  // The proxy stamps host headers; local answers carry none.
  const headers: Record<string, string> = hop ? { [HOST_NAME_HEADER]: engine.name, [HOST_ID_HEADER]: engine.hostId } : {};

  const session = /^\/sessions\/([^/?]+)/.exec(rest);
  if (session) {
    const held = engine.sessions[session[1]!];
    if (!held) {
      // The engine's own words (apps/engine/src/state.ts).
      return Response.json({ error: { code: "not_found", message: "session does not exist" } }, { status: 404, headers });
    }
    return Response.json({ session: { id: session[1], projectId: held.projectId, engine: engine.hostId } }, { headers });
  }
  if (rest.startsWith("/projects")) return Response.json({ projects: engine.projects }, { headers });
  return Response.json({ error: { code: "not_found", message: "engine endpoint does not exist" } }, { status: 404, headers });
}) as typeof fetch;

/** As `loadHost` stamps it: `hostId` undefined means this Mac. */
function row(engine: Engine, id: string): SidebarSession {
  return {
    id,
    projectId: "project_shared",
    ...(engine.hostId === LOCAL_HOST_ID ? {} : { hostId: engine.hostId, hostName: engine.name }),
  } as SidebarSession;
}

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
    expect((here.answer as { session: { engine: string } }).session.engine).toBe(LOCAL_HOST_ID);
    expect((there.answer as { session: { engine: string } }).session.engine).toBe("host_b");
    expect(reached.map((call) => call.engine)).toEqual([LOCAL_HOST_ID, "host_b"]);
  });

  test("the href a row carries and the engine its read reaches are the same Mac", () => {
    for (const engine of ENGINES) {
      const session = row(engine, SHARED);
      expect(sessionHref(session).startsWith(hostPrefix(session.hostId))).toBe(true);
      expect(session.hostId ?? LOCAL_HOST_ID).toBe(engine.hostId);
    }
  });

  test("a row from one Mac is not reachable by the other's address", async () => {
    // Opened as local, which is what a row that lost its hostId produces, it 404s.
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
    expect((local.answer as EngineApiError).message).toBe("session does not exist");
    expect(refusedBy(local.answer as EngineApiError)).toBeUndefined();
  });

  test("the name is the proxy's, learned from the read that was happening anyway", async () => {
    await openRow(row(MINI, SHARED));
    expect(hostName("host_b")).toBe("mini.lan");
    rememberHostName(LOCAL_HOST_ID, "nonsense");
    expect(hostName(LOCAL_HOST_ID)).toBeUndefined();
  });

  test("a Mac that has never answered is named by its id rather than not at all", async () => {
    const error = new EngineApiError("not_found", "session does not exist", 404, { id: "host_never_reached" });
    expect(refusedBy(error)).toBe("host_never_reached");
  });

  test("a host removed from the book refuses by name too", async () => {
    const api = createEngineApi(hostFetcher("host_gone", wire));
    const failure = await api.session(SHARED).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineApiError);
    expect((failure as EngineApiError).message).toBe("No such host.");
    expect(refusedBy(failure as EngineApiError)).toBe("host_gone");
  });
});

describe("the address bar is not the subject", () => {
  test("a pinned read stays on its Mac from any address; the default follows the address", async () => {
    // This suite mostly runs without a DOM (apps/web/scripts/test-dom.mjs), so the address is a string.
    const standingOn = `/hosts/host_b/projects/project_shared/sessions/${SHARED}`;
    expect(hostFromPathname(standingOn)).toBe("host_b");
    // The default fetcher follows the address; wrong when the subject is not the address.
    expect(rewriteApiPath(`/api/sessions/${SHARED}`, hostFromPathname(standingOn))).toBe(`/api/hosts/host_b/sessions/${SHARED}`);

    await createEngineApi(hostFetcher(LOCAL_HOST_ID, wire)).session(SHARED);
    expect(reached.at(-1)!.engine).toBe(LOCAL_HOST_ID);

    await createEngineApi(hostFetcher("host_b", wire)).session(SHARED);
    expect(reached.at(-1)!.engine).toBe("host_b");
  });
});
