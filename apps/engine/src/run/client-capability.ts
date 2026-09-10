/**
 * `RunCapability` out of engine calls — the worker's copy.
 *
 * THE WORKER MUST NOT SPAWN THE PROCESS. Every verb here is an HTTP call to the
 * daemon, because a dev server started by a worker would be a child of one
 * conversation: it would die when that conversation ended and be invisible to
 * every other session. The daemon owns the process group, so the run outlives
 * whoever launched it — which is the entire point of the feature.
 *
 * THE TRANSPORT IS STRUCTURAL ON PURPOSE. `EngineClient` grows a `run()` verb
 * at the same time this module is mounted; typing against the shape rather than
 * the class lets this file compile and be tested before that lands, and
 * `Pick<EngineClient, "run">` satisfies it on the day it does.
 *
 * IT SPEAKS THE ROUTE TABLE, NOT A PARALLEL VOCABULARY. `routes.ts` is REST —
 * `POST /run/configs`, `DELETE /run/configs/:id` — so this asks for exactly
 * those, method and path. An earlier draft invented RPC-ish method names
 * (`configs/create`) that no route matched: three verbs that typechecked, read
 * fine, and would have 404'd the first time a worker used them.
 */
import type { RunCapability } from "./capability";

export type RunRequest = {
  method: "GET" | "POST" | "DELETE";
  /** The session-scoped tail, exactly as `matchRunRoute` expects it. */
  path: string;
  body?: unknown;
  /** GET parameters; `undefined` entries are omitted by the transport. */
  query?: Record<string, string | number | undefined>;
};

export type RunTransport = {
  run<T>(sessionId: string, request: RunRequest): Promise<T>;
};

export function clientRunCapability(client: RunTransport, sessionId: string): RunCapability {
  const call = <T>(request: RunRequest) => client.run<T>(sessionId, request);
  const id = (configId: string) => `/run/configs/${encodeURIComponent(configId)}`;
  return {
    configurations: () => call({ method: "GET", path: "/run/configs" }),
    createConfiguration: (input) => call({ method: "POST", path: "/run/configs", body: input }),
    updateConfiguration: (configId, patch) => call({ method: "POST", path: id(configId), body: patch }),
    removeConfiguration: (configId) => call<void>({ method: "DELETE", path: id(configId) }).then(() => undefined),
    status: () => call({ method: "GET", path: "/run/status" }),
    start: (input) => call({ method: "POST", path: "/run/start", body: input }),
    stop: (input) => call({ method: "POST", path: "/run/stop", body: input ?? {} }),
    restart: (input) => call({ method: "POST", path: "/run/restart", body: input ?? {} }),
    release: (input) => call({ method: "POST", path: "/run/release", body: input }),
    output: (input) => call({ method: "GET", path: "/run/output", ...(input ? { query: { ...input } } : {}) }),
  };
}
