/**
 * The run door, as data rather than as an if-chain.
 *
 * A TABLE THE DAEMON MOUNTS. This file deliberately imports nothing from
 * `daemon.ts` and writes no responses: each entry matches a session-scoped tail
 * (`/run/…`) and returns a value, and refusals are thrown as `RunError`, whose
 * `{ code, message }` shape the mount point adapts to its own `HttpError`. That
 * keeps the whole surface testable by calling `handle()` with a plain object,
 * and keeps a second writer out of the daemon's dispatch while it is being
 * restructured.
 *
 * THE CONTEXT CARRIES A CAPABILITY, NOT THE ENGINE STORE, because resolving
 * "which project and which worktree is this session" is the daemon's knowledge
 * and nothing here should reach for it. The mount point builds the capability
 * with `storeRunCapability({ store, manager, context })` and hands it over.
 */
import { z } from "zod";
import type { RunCapability } from "./capability";
import { RunConfigurationInput, RunError } from "./types";

export type RunRouteContext = {
  /** Capture groups from `pattern`, in order. */
  params: string[];
  /** The decoded JSON body, or `{}` for a request without one. */
  input: Record<string, unknown>;
  capability: RunCapability;
};

export type RunRoute = {
  method: "GET" | "POST" | "DELETE";
  /** Matched against the session-scoped tail, e.g. `/run/start`. */
  pattern: RegExp;
  handle(ctx: RunRouteContext): Promise<unknown>;
};

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RunError("invalid_request", issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "that request is not valid");
  }
  return result.data;
}

const RunIdOnly = z.object({ runId: z.string().min(1).optional() });

export const runRoutes: RunRoute[] = [
  {
    method: "GET",
    pattern: /^\/run\/configs$/,
    handle: async ({ capability }) => ({ configurations: await capability.configurations() }),
  },
  {
    method: "POST",
    pattern: /^\/run\/configs$/,
    handle: async ({ capability, input }) => await capability.createConfiguration(parse(RunConfigurationInput, input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/configs\/([^/]+)$/,
    handle: async ({ capability, params, input }) => await capability.updateConfiguration(params[0]!, parse(RunConfigurationInput.partial(), input)),
  },
  {
    method: "DELETE",
    pattern: /^\/run\/configs\/([^/]+)$/,
    handle: async ({ capability, params }) => {
      await capability.removeConfiguration(params[0]!);
      return { removed: params[0] };
    },
  },
  {
    method: "GET",
    pattern: /^\/run\/status$/,
    handle: async ({ capability }) => await capability.status(),
  },
  {
    method: "POST",
    pattern: /^\/run\/start$/,
    handle: async ({ capability, input }) =>
      await capability.start(parse(z.object({ configId: z.string().min(1), replace: z.boolean().optional() }), input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/stop$/,
    handle: async ({ capability, input }) => await capability.stop(parse(RunIdOnly, input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/restart$/,
    handle: async ({ capability, input }) => await capability.restart(parse(RunIdOnly, input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/release$/,
    handle: async ({ capability, input }) => await capability.release(parse(z.object({ runId: z.string().min(1) }), input)),
  },
  {
    method: "GET",
    pattern: /^\/run\/output$/,
    handle: async ({ capability, input }) =>
      await capability.output(parse(RunIdOnly.extend({ after: z.coerce.number().int().min(0).optional() }), input)),
  },
];

/** Find the entry for a request, with its capture groups. Used by the mount. */
export function matchRunRoute(method: string, tail: string): { route: RunRoute; params: string[] } | undefined {
  for (const route of runRoutes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(tail);
    if (match) return { route, params: match.slice(1) };
  }
  return undefined;
}
