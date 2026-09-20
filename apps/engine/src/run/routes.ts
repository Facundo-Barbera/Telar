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
  /**
   * THE SAME WINDOW, IN BYTES — what the cockpit's emulator reads (#198).
   *
   * BESIDE `/run/output` RATHER THAN INSTEAD OF IT. The line view is what
   * `run_output` hands an agent, and an agent wants lines rather than escape
   * sequences; retiring it would also have left a session on a PAIRED MAC with
   * nothing, since `terminalBridge()` is local-host only by design while this
   * path goes over the ordinary host hop like every other run route.
   */
  {
    method: "GET",
    pattern: /^\/run\/bytes$/,
    handle: async ({ capability, input }) =>
      await capability.bytes(parse(RunIdOnly.extend({ after: z.coerce.number().int().min(0).optional() }), input)),
  },
  /**
   * AND THE KEYBOARD. The owner's decision for #198 is that a run's terminal is
   * writable — `psql`, an installer's `Proceed (Y/n)`, a dev server's `r`.
   *
   * `data` MAY BE EMPTY AND MAY NOT BE ABSENT. A missing field is a caller
   * that meant something and sent nothing; an empty string is a caller that
   * meant nothing, which is cheap to honour and impossible to misread.
   */
  {
    method: "POST",
    pattern: /^\/run\/write$/,
    handle: async ({ capability, input }) => await capability.write(parse(RunIdOnly.extend({ data: z.string() }), input)),
  },
  {
    method: "POST",
    pattern: /^\/run\/resize$/,
    handle: async ({ capability, input }) =>
      await capability.resize(parse(RunIdOnly.extend({ cols: z.number().int().positive(), rows: z.number().int().positive() }), input)),
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
