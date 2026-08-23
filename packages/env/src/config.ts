import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { machineConfigPath, sidecarConfigPath } from "./paths.ts";

export const CostClass = z.enum(["none", "light", "heavy"]);
export type CostClass = z.infer<typeof CostClass>;

const EnvBlock = z
  .object({
    cost: CostClass,
    up: z.string().optional(),
    ready: z.string().optional(),
    reset: z.string().optional(),
    down: z.string().optional(),
    verify: z.string().optional(),
    tiers: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.cost === "none") return;
    for (const verb of ["up", "ready", "down"] as const) {
      if (!env[verb]) {
        ctx.addIssue({
          code: "custom",
          message: `env.${verb} is required when cost is "${env.cost}"`,
        });
      }
    }
  });

const ContractFile = z.object({
  version: z.literal(1),
  env: EnvBlock,
});

export type EnvContract = z.infer<typeof ContractFile>["env"];

export interface LoadedContract {
  contract: EnvContract;
  /** Where it came from — the sidecar always wins over a repo-committed telar.yaml. */
  source: "sidecar" | "repo";
  path: string;
}

function tryLoad(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, "utf8"));
}

/**
 * Load the environment contract for a project. Sidecar
 * ($TELAR_HOME/projects/<id>/env.yaml) takes precedence; a repo-committed
 * telar.yaml with an `env:` block is honored for solo projects.
 */
export function loadContract(projectId: string, projectRoot: string): LoadedContract | null {
  const sidecar = sidecarConfigPath(projectId);
  const raw = tryLoad(sidecar);
  if (raw !== null) {
    return { contract: ContractFile.parse(raw).env, source: "sidecar", path: sidecar };
  }
  const repoPath = join(projectRoot, "telar.yaml");
  const repoRaw = tryLoad(repoPath) as Record<string, unknown> | null;
  if (repoRaw && typeof repoRaw === "object" && repoRaw.env) {
    return {
      contract: EnvBlock.parse(repoRaw.env),
      source: "repo",
      path: repoPath,
    };
  }
  return null;
}

const MachineConfig = z.object({
  env: z
    .object({
      pool: z
        .object({
          heavy: z.number().int().min(1).optional(),
          light: z.number().int().min(1).optional(),
        })
        .optional(),
      leaseTtlMinutes: z.number().int().min(1).optional(),
      portRangeBase: z.number().int().min(1024).optional(),
      portRangeSize: z.number().int().min(1).optional(),
    })
    .optional(),
});

export interface MachinePolicy {
  pool: { heavy: number; light: number };
  leaseTtlMinutes: number;
  portRangeBase: number;
  portRangeSize: number;
}

/** Per-machine pool policy from $TELAR_HOME/config.yaml; defaults apply when absent or invalid. */
export function loadMachinePolicy(): MachinePolicy {
  const raw = tryLoad(machineConfigPath());
  const parsed = MachineConfig.safeParse(raw ?? {});
  const env = parsed.success ? (parsed.data.env ?? {}) : {};
  return {
    pool: { heavy: env.pool?.heavy ?? 1, light: env.pool?.light ?? 4 },
    leaseTtlMinutes: env.leaseTtlMinutes ?? 45,
    portRangeBase: env.portRangeBase ?? 40000,
    portRangeSize: env.portRangeSize ?? 20,
  };
}
