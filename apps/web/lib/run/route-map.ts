/**
 * Which client verb serves which run path — a table, not an if-chain.
 *
 * TESTABLE WITHOUT A SERVER, which is the point: the cockpit's paths
 * (`runPath`) and the engine's ten typed verbs are the same spelling written
 * twice, and a tail nobody matches is a silent 404 the panel reports as "the
 * run request failed". `route-map.test.ts` drives the real paths through this
 * table with a stub client, so drift fails there rather than in a running app.
 */
import type { RunConfigurationDraft, RunStartInput } from "@telar/engine-client";

/** Just the run verbs, so a stub in a test satisfies this without a socket. */
export type RunEngineVerbs = {
  runConfigurations(sessionId: string): Promise<unknown>;
  createRunConfiguration(sessionId: string, draft: RunConfigurationDraft): Promise<unknown>;
  updateRunConfiguration(sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>): Promise<unknown>;
  removeRunConfiguration(sessionId: string, configId: string): Promise<unknown>;
  runStatus(sessionId: string): Promise<unknown>;
  startRun(sessionId: string, input: RunStartInput): Promise<unknown>;
  stopRun(sessionId: string, runId?: string): Promise<unknown>;
  restartRun(sessionId: string, runId?: string): Promise<unknown>;
  releaseRun(sessionId: string, runId: string): Promise<unknown>;
  runOutput(sessionId: string, input: { runId?: string; after?: number }): Promise<unknown>;
};

export type RunRequestParts = {
  sessionId: string;
  /** Path segments after `/run/`, already decoded by the framework. */
  tail: string[];
  /** The decoded JSON body, or `{}` for a request without one. */
  body: Record<string, unknown>;
  query: URLSearchParams;
};

/** A refusal this layer can make on its own: a bad shape, not a bad outcome. */
export class RunRouteRefusal extends Error {
  constructor(
    readonly code: "not_found" | "invalid_request",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RunRouteRefusal";
  }
}

type Entry = {
  method: "GET" | "POST" | "DELETE";
  /** Segment count and literal head, e.g. `["configs", "*"]` for one param. */
  segments: readonly string[];
  call(client: RunEngineVerbs, parts: RunRequestParts): Promise<unknown>;
};

const string = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

export const RUN_ROUTE_TABLE: readonly Entry[] = [
  { method: "GET", segments: ["configs"], call: (client, { sessionId }) => client.runConfigurations(sessionId) },
  {
    method: "POST",
    segments: ["configs"],
    call: (client, { sessionId, body }) => client.createRunConfiguration(sessionId, body as unknown as RunConfigurationDraft),
  },
  {
    /**
     * A PATCH IN POST'S CLOTHING, and omitting `env` means "leave it alone" —
     * the only way a client that was never sent a secret value can edit a
     * configuration without erasing it.
     */
    method: "POST",
    segments: ["configs", "*"],
    call: (client, { sessionId, tail, body }) => client.updateRunConfiguration(sessionId, tail[1]!, body as unknown as Partial<RunConfigurationDraft>),
  },
  { method: "DELETE", segments: ["configs", "*"], call: (client, { sessionId, tail }) => client.removeRunConfiguration(sessionId, tail[1]!) },
  { method: "GET", segments: ["status"], call: (client, { sessionId }) => client.runStatus(sessionId) },
  { method: "POST", segments: ["start"], call: (client, { sessionId, body }) => client.startRun(sessionId, body as unknown as RunStartInput) },
  { method: "POST", segments: ["stop"], call: (client, { sessionId, body }) => client.stopRun(sessionId, string(body.runId)) },
  { method: "POST", segments: ["restart"], call: (client, { sessionId, body }) => client.restartRun(sessionId, string(body.runId)) },
  {
    method: "POST",
    segments: ["release"],
    call: (client, { sessionId, body }) => {
      const runId = string(body.runId);
      // Releasing names the run being given up: defaulting to "whatever is
      // active" would free a slot the human never looked at.
      if (!runId) throw new RunRouteRefusal("invalid_request", "Releasing a slot names the run being given up.", 400);
      return client.releaseRun(sessionId, runId);
    },
  },
  {
    method: "GET",
    segments: ["output"],
    call: (client, { sessionId, query }) => {
      const runId = query.get("runId");
      const after = query.get("after");
      return client.runOutput(sessionId, {
        ...(runId ? { runId } : {}),
        // A non-numeric cursor is dropped rather than sent as NaN: every answer
        // carries its own cursor, so starting from the top is recoverable.
        ...(after !== null && after !== "" && Number.isFinite(Number(after)) ? { after: Number(after) } : {}),
      });
    },
  },
];

export function matchRunRequest(method: string, tail: string[]): Entry | undefined {
  return RUN_ROUTE_TABLE.find(
    (entry) => entry.method === method && entry.segments.length === tail.length && entry.segments.every((segment, index) => segment === "*" || segment === tail[index]),
  );
}

/** Serve one request, or refuse it. Throws `RunRouteRefusal` for a shape this
 *  layer can judge; everything else is the engine's error to report. */
export function serveRunRequest(client: RunEngineVerbs, method: string, parts: RunRequestParts): Promise<unknown> {
  const entry = matchRunRequest(method, parts.tail);
  if (!entry) throw new RunRouteRefusal("not_found", "There is no such run route.", 404);
  return entry.call(client, parts);
}
