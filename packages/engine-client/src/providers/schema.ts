import { z } from "zod";
import { Effort, Id, ProviderDriverKind, ProviderInstanceId, Timestamp } from "../protocol/common";

export const ProviderInstanceEnvVar = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names are letters, digits and underscores"),
  value: z.string(),
  sensitive: z.boolean(),
  valueRedacted: z.boolean().optional(),
});
export type ProviderInstanceEnvVar = z.infer<typeof ProviderInstanceEnvVar>;

export const AUTO_COMPACT_MAX_TOKENS = 1_000_000;
const AutoCompactTokens = z.number().int().min(1).max(AUTO_COMPACT_MAX_TOKENS);
export const AutoCompact = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("limits"), standard: AutoCompactTokens, long: AutoCompactTokens }),
  z.object({ mode: z.literal("never") }),
]);
export type AutoCompact = z.infer<typeof AutoCompact>;

export const ProviderInstance = z.object({
  id: Id,
  driver: ProviderDriverKind,
  displayName: z.string().min(1).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** A whole percent of the model's window; absent means 70. */
  contextNoticePercent: z.number().int().min(1).max(100).optional(),
  autoCompact: AutoCompact.optional(),
  enabled: z.boolean(),
  configDir: z.string().min(1).optional(),
  binaryPath: z.string().min(1).optional(),
  env: z.array(ProviderInstanceEnvVar),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProviderInstance = z.infer<typeof ProviderInstance>;

export function defaultInstanceIdForDriver(driver: ProviderDriverKind): string {
  return driver;
}

export const ProviderSignIn = z.enum(["signed-in", "signed-out", "missing-config-dir", "unknown"]);
export type ProviderSignIn = z.infer<typeof ProviderSignIn>;

export const ProviderUpdate = z.object({
  status: z.enum(["current", "behind", "pinned", "unknown"]),
  latest: z.string().min(1).optional(),
  method: z.enum(["native", "homebrew", "npm", "bun", "pnpm", "vite-plus", "unknown"]).optional(),
  command: z.string().min(1).optional(),
});
export type ProviderUpdate = z.infer<typeof ProviderUpdate>;

export const ProviderUpdateRun = z.object({
  ok: z.boolean(),
  command: z.string().min(1),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean(),
  output: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type ProviderUpdateRun = z.infer<typeof ProviderUpdateRun>;

export const ProviderProbe = z.object({
  instanceId: Id,
  driver: ProviderDriverKind,
  status: z.enum(["ready", "warning", "error", "disabled"]),
  installed: z.boolean(),
  version: z.string().min(1).optional(),
  update: ProviderUpdate.optional(),
  signIn: ProviderSignIn,
  message: z.string().min(1).optional(),
  checkedAt: Timestamp,
});
export type ProviderProbe = z.infer<typeof ProviderProbe>;

export const ProviderModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean(),
  hidden: z.boolean(),
  efforts: z.array(Effort),
  defaultEffort: Effort.optional(),
  resolves: z.string().min(1).optional(),
  defaultWindow: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  legacy: z.boolean().default(false),
  badge: z.enum(["new"]).optional(),
  fastMode: z.boolean(),
  serviceTiers: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional() })).optional(),
  defaultServiceTier: z.string().min(1).optional(),
  hiddenByUser: z.boolean().default(false),
  source: z.enum(["provider", "user"]).default("provider"),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

const ModelCatalogueSource = z.enum(["provider", "builtin"]);

export const ModelCatalogue = z.object({
  driver: ProviderDriverKind,
  models: z.array(ProviderModel),
  source: ModelCatalogueSource,
  message: z.string().min(1).optional(),
  readAt: Timestamp,
  instanceId: ProviderInstanceId.optional(),
  cliVersion: z.string().min(1).optional(),
  refreshing: z.boolean().optional(),
});
export type ModelCatalogue = z.infer<typeof ModelCatalogue>;

export const CustomProviderModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type CustomProviderModel = z.infer<typeof CustomProviderModel>;

export const ModelOverlay = z.object({
  instanceId: ProviderInstanceId,
  favorites: z.array(z.string().min(1)).default([]),
  hidden: z.array(z.string().min(1)).default([]),
  order: z.array(z.string().min(1)).default([]),
  custom: z.array(CustomProviderModel).default([]),
  default: z.string().min(1).optional(),
  updatedAt: Timestamp,
});
export type ModelOverlay = z.infer<typeof ModelOverlay>;

export const DEFAULT_MODEL_OVERLAY: Omit<ModelOverlay, "instanceId" | "updatedAt"> = {
  favorites: [],
  hidden: [],
  order: [],
  custom: [],
};
