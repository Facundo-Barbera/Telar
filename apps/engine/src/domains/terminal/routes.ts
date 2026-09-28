import { RunOpenInput, RunClosedBy } from "@telar/engine-client";
import { z } from "zod";
import type { RunCapability } from "./capability";
import { RunConfigurationInput, RunError } from "./types";

type RunRouteContext = {
  params: string[];
  input: Record<string, unknown>;
  capability: RunCapability;
};

export type RunRoute = {
  method: "GET" | "POST" | "DELETE";
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

const runRoutes: RunRoute[] = [
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
      await capability.start(
        parse(z.object({ configId: z.string().min(1), replace: z.boolean().optional(), openedBy: z.enum(["person", "agent"]).optional() }), input),
      ),
  },
  {
    method: "POST",
    pattern: /^\/run\/open$/,
    handle: async ({ capability, input }) => await capability.open(parse(RunOpenInput, input)),
  },
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
            tail: z.coerce.number().int().min(1).max(1000).optional(),
            grep: z.string().min(1).max(500).optional(),
            stream: z.enum(["stdout", "stderr"]).optional(),
          }),
          input,
        ),
      ),
  },
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
  {
    method: "GET",
    pattern: /^\/run\/bytes$/,
    handle: async ({ capability, input }) =>
      await capability.bytes(parse(Target.extend({ after: z.coerce.number().int().min(0).optional() }), input)),
  },
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

export function matchRunRoute(method: string, tail: string): { route: RunRoute; params: string[] } | undefined {
  for (const route of runRoutes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(tail);
    if (match) return { route, params: match.slice(1) };
  }
  return undefined;
}
