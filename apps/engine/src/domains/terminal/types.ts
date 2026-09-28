import { randomBytes } from "node:crypto";
import { RunIcon, RunShell, type RunStatus } from "@telar/engine-client";
import { z } from "zod";

const MIN_SECRET_CHARS = 4;

export const RunEnvVar = z
  .object({
    key: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name is letters, digits and underscores, not starting with a digit"),
    value: z.string().max(8192),
    secret: z.boolean().optional(),
  })
  .superRefine((entry, ctx) => {
    if (!entry.secret) return;
    if (entry.value.length < MIN_SECRET_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `a secret value must be at least ${MIN_SECRET_CHARS} characters: a shorter one cannot be removed from captured output without mangling unrelated text, and Telar will not label a value secret it cannot hide`,
      });
    }
    if (/[\r\n]/.test(entry.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "a secret value cannot contain a line break: captured output is redacted one line at a time, so a multi-line secret would survive in pieces",
      });
    }
  });
export type RunEnvVar = z.infer<typeof RunEnvVar>;

const RelativeCwd = z
  .string()
  .max(1024)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "the working directory must stay inside the worktree");

export const RunConfigurationInput = z.object({
  name: z.string().min(1).max(120),
  icon: RunIcon.optional(),
  command: z.string().min(1).max(4000),
  shell: RunShell.optional(),
  cwd: RelativeCwd.optional(),
  env: z.array(RunEnvVar).max(200).optional(),
  readinessUrl: z
    .string()
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), "a readiness URL is checked with an HTTP request, so it must be http:// or https://")
    .optional(),
});
export type RunConfigurationInput = z.infer<typeof RunConfigurationInput>;

export const RunConfiguration = RunConfigurationInput.extend({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RunConfiguration = z.infer<typeof RunConfiguration>;

export type RunConfigurationView = Omit<RunConfiguration, "env"> & {
  env: Array<{ key: string; value?: string; secret?: boolean }>;
};

export function isTerminal(status: RunStatus): boolean {
  return status === "exited" || status === "failed" || status === "closed";
}

export type RunProbeResult = { answered: boolean; serving: boolean };
export type RunProbe = (url: string) => Promise<RunProbeResult>;

export class RunError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "conflict",
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunError";
  }
}

export function newPipeTerminalId(): string {
  return `pipe_${randomBytes(8).toString("hex")}`;
}

export function newConfigId(): string {
  return `runcfg_${randomBytes(8).toString("hex")}`;
}

export function secretValues(config: Pick<RunConfiguration, "env">): string[] {
  return (config.env ?? [])
    .filter((entry) => entry.secret && isHideable(entry.value))
    .map((entry) => entry.value)
    .sort((a, b) => b.length - a.length);
}

function isHideable(value: string): boolean {
  return value.length >= MIN_SECRET_CHARS && !/[\r\n]/.test(value);
}

export function unhideableSecrets(config: Pick<RunConfiguration, "env">): string[] {
  return (config.env ?? []).filter((entry) => entry.secret && !isHideable(entry.value)).map((entry) => entry.key);
}

export const REDACTED = "«redacted»";

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redactConfiguration(config: RunConfiguration): RunConfigurationView {
  const secrets = secretValues(config);
  return {
    ...config,
    name: redactText(config.name, secrets),
    command: redactText(config.command, secrets),
    ...(config.shell === undefined
      ? {}
      : {
          shell: {
            program: redactText(config.shell.program, secrets),
            ...(config.shell.args === undefined ? {} : { args: config.shell.args.map((arg) => redactText(arg, secrets)) }),
          },
        }),
    ...(config.cwd === undefined ? {} : { cwd: redactText(config.cwd, secrets) }),
    ...(config.readinessUrl === undefined ? {} : { readinessUrl: redactText(config.readinessUrl, secrets) }),
    env: (config.env ?? []).map((entry) => (entry.secret ? { key: entry.key, secret: true } : { key: entry.key, value: redactText(entry.value, secrets) })),
  };
}
