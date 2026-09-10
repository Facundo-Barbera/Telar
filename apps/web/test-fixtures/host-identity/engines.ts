/**
 * Two fake Macs, and the wire between them — shared by the reproduction script
 * and the rendered-sidebar harness so both exercise the same world.
 *
 * IDS COLLIDE ON PURPOSE. One session id and one project id (with the same
 * name) exist on both engines, which is legal: ids are minted per engine.
 * Anything that keys on an id alone is therefore provably wrong here.
 */
import type { Project, Session } from "@telar/engine-client";

export const SHARED_SESSION = "session_7b1c";
export const SHARED_PROJECT = "project_9ab0";
export const LOCAL_ENGINE = "local";

export type Engine = { daemonId: string; label: string; sessions: Session[]; projects: Project[] };

const session = (id: string, title: string, projectId: string): Session =>
  ({
    id,
    title,
    projectId,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z",
    state: "active",
    driver: "claude",
    envMode: "local",
    workspace: { mode: "local", path: "/x" },
  }) as unknown as Session;

const project = (id: string, name: string): Project => ({ id, name }) as unknown as Project;

export const ENGINES: Record<string, Engine> = {
  [LOCAL_ENGINE]: {
    daemonId: "dmn_local",
    label: "this Mac",
    sessions: [session(SHARED_SESSION, "LOCAL — shared id", SHARED_PROJECT), session("session_local1", "LOCAL — only here", SHARED_PROJECT)],
    // A second project so the picker has somewhere to go: the canvas is on the
    // shared id, and switching to the id you are already on is not a
    // navigation.
    projects: [project(SHARED_PROJECT, "telar"), project("project_local_only", "LOCAL notes")],
  },
  host_a: {
    daemonId: "dmn_remote_a",
    label: "studio.lan",
    sessions: [session(SHARED_SESSION, "REMOTE A — shared id", SHARED_PROJECT), session("session_a1", "REMOTE A — only there", SHARED_PROJECT)],
    projects: [project(SHARED_PROJECT, "telar"), project("project_a_only", "REMOTE A notes")],
  },
  host_b: {
    daemonId: "dmn_remote_b",
    label: "mac.lan",
    sessions: [session(SHARED_SESSION, "REMOTE B — shared id", SHARED_PROJECT), session("session_b1", "REMOTE B — only there", SHARED_PROJECT)],
    projects: [project(SHARED_PROJECT, "telar"), project("project_b_only", "REMOTE B notes")],
  },
};

export const BOOK = [
  { id: "host_a", name: "studio.lan" },
  { id: "host_b", name: "mac.lan" },
];

export type Hop = { pathname: string; reachedEngine: string; status: number };

/** Which engine a cockpit path actually reaches — the proxy's rule, not a
 *  guess: `/api/hosts/:id/*` goes to that Mac, anything else to this one. */
export function routeTo(pathname: string): { engine: string; rest: string } {
  const match = /^\/api\/hosts\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return { engine: LOCAL_ENGINE, rest: pathname.slice("/api".length) };
  return { engine: decodeURIComponent(match[1]!), rest: match[2] ?? "/" };
}

export type Wire = {
  hops: Hop[];
  /** Replies parked while `hold` is true, released by `release`. */
  hold: (on: boolean) => void;
  release: (engine?: string) => number;
  parked: () => number;
  fetch: typeof fetch;
};

/** A fetch that answers as these engines and records where every call went. */
export function makeWire(): Wire {
  const hops: Hop[] = [];
  let holding = false;
  const parked: Array<{ engine: string; deliver: () => void }> = [];

  const impl = (async (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : new URL((input as Request).url).pathname;
    const pathname = raw.split("?")[0]!;
    const { engine, rest } = routeTo(pathname);
    const target = ENGINES[engine];
    const answer = (status: number, body: unknown) => {
      hops.push({ pathname, reachedEngine: engine, status });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const reply = () => {
      // An unknown host is the proxy's own 404; an unknown session is the
      // engine's. #204 asks for these to be told apart, so they are.
      if (!target) return answer(404, { error: { code: "not_found", message: "No such host." } });
      if (rest === "/sessions/live") return answer(200, { sessions: target.sessions, projects: target.projects });
      if (rest === "/health") return answer(200, { version: 2, daemonId: target.daemonId, protocol: 2 });
      if (rest === "/inbox") return answer(200, { inbox: { autoSettleAfterHours: 72 } });
      if (rest === "/projects") return answer(200, { projects: target.projects });
      // The book is always THIS cockpit's, whichever Mac the fetcher points at.
      if (rest === "/hosts" || rest === "/hosts/") return answer(200, { hosts: BOOK });
      if (rest === "/sidebar-layout") return answer(200, { layout: {} });
      if (rest === "/looms") return answer(200, { looms: [] });
      if (rest === "/spool") return answer(200, {});
      const found = /^\/sessions\/([^/]+)$/.exec(rest);
      if (found) {
        const id = decodeURIComponent(found[1]!);
        const known = target.sessions.find((entry) => entry.id === id);
        return known
          ? answer(200, { session: known, turns: [], items: [], requests: [], tasks: [], cursor: 0 })
          : answer(404, { error: { code: "not_found", message: "This session does not exist." } });
      }
      return answer(404, { error: { code: "not_found", message: "No such route." } });
    };
    if (!holding) return reply();
    return new Promise<Response>((resolve) => parked.push({ engine, deliver: () => resolve(reply()) }));
  }) as unknown as typeof fetch;

  return {
    hops,
    hold: (on) => {
      holding = on;
    },
    release: (engine) => {
      const due = engine ? parked.filter((entry) => entry.engine === engine) : parked.slice();
      for (const entry of due) {
        parked.splice(parked.indexOf(entry), 1);
        entry.deliver();
      }
      return due.length;
    },
    parked: () => parked.length,
    fetch: impl,
  };
}
