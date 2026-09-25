/**
 * The run door, as data rather than as an if-chain.
 *
 * A TABLE THE DAEMON MOUNTS. This file deliberately imports nothing from
 * `daemon.ts` and writes no responses: each entry matches a session-scoped tail
 * (`/run/…`) and returns a value, and refusals are thrown as `RunError`, whose
 * `{ code, message }` shape the mount point adapts to its own `HttpError`.
 *
 * THE CONTEXT CARRIES A CAPABILITY, NOT THE ENGINE STORE, because resolving
 * "which session, project and worktree is this" is the daemon's knowledge. The
 * mount point builds the capability with `storeRunCapability(…)`.
 *
 * A TERMINAL IS NAMED BY `terminalId` ON EVERY ROUTE, and `runId` is still
 * read as the same thing so a caller from before terminals keeps working.
 * `/run/release` is gone: there is no slot left to release.
 */
import { z } from "zod";
import type { RunCapability } from "./capability";
import { RunClosedBy, RunConfigurationInput, RunError } from "./types";

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

const Target = z.object({ terminalId: z.string().min(1).optional(), runId: z.string().min(1).optional() });

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
  /** This session's terminals, newest first — a list, where there used to be
   *  one project-wide `active` run. */
  {
    method: "GET",
    pattern: /^\/run\/status$/,
    handle: async ({ capability }) => await capability.status(),
  },
  {
    method: "POST",
    pattern: /^\/run\/start$/,
    // `replace` still parses — an old caller sends it — and means nothing now.
    handle: async ({ capability, input }) =>
      await capability.start(parse(z.object({ configId: z.string().min(1), replace: z.boolean().optional() }), input)),
  },
  /**
   * CLOSE A TERMINAL. `signal` is a polite first word (a closed set of three),
   * and `closedBy` is who is asking — absent means the person, which is what
   * the cockpit is.
   */
  {
    method: "POST",
    pattern: /^\/run\/stop$/,
    handle: async ({ capability, input }) =>
      await capability.stop(parse(Target.extend({ signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).optional(), closedBy: RunClosedBy.optional() }), input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/restart$/,
    handle: async ({ capability, input }) => await capability.restart(parse(Target.extend({ closedBy: RunClosedBy.optional() }), input)),
  },
  {
    method: "GET",
    pattern: /^\/run\/output$/,
    handle: async ({ capability, input }) =>
      await capability.output(
        parse(
          Target.extend({
            after: z.coerce.number().int().min(0).optional(),
            // THE THREE NARROWINGS (#890). `z.coerce` because these arrive as
            // query strings; `grep` is compiled by the manager, which is what
            // turns a bad pattern into "your argument was wrong".
            tail: z.coerce.number().int().min(1).max(1000).optional(),
            grep: z.string().min(1).max(500).optional(),
            stream: z.enum(["stdout", "stderr"]).optional(),
          }),
          input,
        ),
      ),
  },
  /**
   * WAIT FOR ONE OF FOUR THINGS — the route that replaces `sleep 2 && curl`.
   *
   * A POST because it HOLDS ITS CONNECTION for up to a minute. THE CEILING IS
   * ENFORCED HERE AS WELL AS IN THE TOOL SCHEMA: the HTTP surface is everyone
   * else's contract.
   */
  {
    method: "POST",
    pattern: /^\/run\/wait$/,
    handle: async ({ capability, input }) =>
      await capability.wait(
        parse(
          Target.extend({
            pattern: z.string().min(1).max(500).optional(),
            ready: z.boolean().optional(),
            exit: z.boolean().optional(),
            timeoutMs: z.number().int().min(0).max(60_000),
          }),
          input,
        ),
      ),
  },
  /** THE SAME WINDOW, IN BYTES — what the cockpit's emulator reads (#198). */
  {
    method: "GET",
    pattern: /^\/run\/bytes$/,
    handle: async ({ capability, input }) =>
      await capability.bytes(parse(Target.extend({ after: z.coerce.number().int().min(0).optional() }), input)),
  },
  /**
   * AND THE KEYBOARD. `data` MAY BE EMPTY AND MAY NOT BE ABSENT: a missing
   * field is a caller that meant something and sent nothing.
   */
  {
    method: "POST",
    pattern: /^\/run\/write$/,
    handle: async ({ capability, input }) => await capability.write(parse(Target.extend({ data: z.string() }), input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/resize$/,
    handle: async ({ capability, input }) =>
      await capability.resize(parse(Target.extend({ cols: z.number().int().positive(), rows: z.number().int().positive() }), input)),
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
