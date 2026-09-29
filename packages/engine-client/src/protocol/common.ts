import { z } from "zod";

export const ENGINE_PROTOCOL_VERSION = 2 as const;

/**
 * Every id in this protocol is an opaque non-empty string. Opaque is the
 * contract: clients must never parse structure out of one, because the engine
 * reserves the right to change how it mints them.
 */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** Epoch milliseconds, as v1 used. Not ISO strings — they sort and diff wrong
 *  as often as they read nicely, and every consumer here does arithmetic. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

export const EnvironmentId = z.literal("local");
export type EnvironmentId = z.infer<typeof EnvironmentId>;

export const ProviderDriverKind = z.enum(["claude", "codex", "opencode"]);
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;

export const PROVIDER_CAPABILITIES: Record<ProviderDriverKind, { liveSteering: boolean; compaction: boolean; backgroundTaskStop: boolean }> = {
  claude: { liveSteering: true, compaction: true, backgroundTaskStop: true },
  codex: { liveSteering: true, compaction: true, backgroundTaskStop: false },
  opencode: { liveSteering: false, compaction: false, backgroundTaskStop: false },
};

export const ProviderInstanceId = Id;
export type ProviderInstanceId = z.infer<typeof ProviderInstanceId>;

export const Effort = z.string().min(1);
export type Effort = z.infer<typeof Effort>;

export const ModelSelection = z
  .object({
    instanceId: ProviderInstanceId,
    model: z.string().min(1).optional(),
    effort: Effort.optional(),
    /**
     * Trade some quality for latency, where the provider offers it. Reaches the
     * Agent SDK as an inline `settings: { fastMode }`. Claude-only, and not on
     * every Claude model — the catalogue says which (`ProviderModel.fastMode`).
     */
    fastMode: z.boolean().optional(),
    serviceTier: z.string().min(1).optional(),
    /**
     * Claude's ultracode: xhigh effort plus standing workflow orchestration.
     * Reaches the Agent SDK as `settings: { ultracode }`, like `fastMode`, and
     * needs a model that offers `xhigh`.
     */
    ultracode: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.model !== undefined || value.effort !== undefined || value.fastMode !== undefined || value.serviceTier !== undefined || value.ultracode !== undefined,
    { message: "a model selection must name at least one of model, effort, fast mode, service tier or ultracode" },
  );
export type ModelSelection = z.infer<typeof ModelSelection>;

export const AgentModelChoice = z.object({ model: z.string().min(1).optional(), effort: Effort.optional() });
export type AgentModelChoice = z.infer<typeof AgentModelChoice>;

export const RuntimeMode = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

/** Attended sessions default to asking. */
export const DEFAULT_ATTENDED_RUNTIME_MODE: RuntimeMode = "approval-required";
export const DEFAULT_DETACHED_RUNTIME_MODE: RuntimeMode = "auto";

const RUNTIME_MODE_LADDER: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export function narrowerRuntimeMode(left: RuntimeMode, right: RuntimeMode): RuntimeMode {
  const rank = (mode: RuntimeMode): number => {
    const index = RUNTIME_MODE_LADDER.indexOf(mode);
    return index === -1 ? -1 : index;
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank === -1) return left;
  if (rightRank === -1) return right;
  return leftRank <= rightRank ? left : right;
}

/** Whether a turn may act or is only allowed to propose a plan. */
export const InteractionMode = z.enum(["default", "plan"]);
export type InteractionMode = z.infer<typeof InteractionMode>;

export const EnvMode = z.enum(["local", "worktree"]);
export type EnvMode = z.infer<typeof EnvMode>;

export const RateLimitType = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
  "other",
]);
export type RateLimitType = z.infer<typeof RateLimitType>;

export const TokenUsage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreate: z.number().int().nonnegative(),
  /** Reasoning tokens when the provider reports them separately. */
  reasoning: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** Tokens plus what they cost and how full the window is. `costUsd` is the
 *  provider's own figure when it gives one — never computed here, because a
 *  second way of arriving at a price is a second price. */
export const UsageSnapshot = z.object({
  tokens: TokenUsage,
  costUsd: z.number().nonnegative().optional(),
  contextUsed: z.number().int().nonnegative().optional(),
  contextMax: z.number().int().positive().optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

export const RawProviderEvent = z.object({
  source: ProviderDriverKind,
  /** The provider's own event/method name, verbatim. */
  method: z.string().min(1).optional(),
  payload: z.unknown(),
});
export type RawProviderEvent = z.infer<typeof RawProviderEvent>;

/** Provider-side correlation ids, carried so a normalized row can be traced
 *  back to the exact provider object it came from. */
export const ProviderRefs = z.object({
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  /** The provider's own session/thread handle — Claude's resume token, Codex's
   *  conversation id. This is what makes continuity survive a restart. */
  sessionId: z.string().min(1).optional(),
});
export type ProviderRefs = z.infer<typeof ProviderRefs>;

export const BrowserProvider = z.enum(["headless", "attached", "none"]);
export type BrowserProvider = z.infer<typeof BrowserProvider>;

export const BrowserTabController = z.enum(["agent", "human", "idle"]);
export type BrowserTabController = z.infer<typeof BrowserTabController>;

export const BrowserTab = z.object({
  id: Id,
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  loading: z.boolean().optional(),
  /** Optional: an older engine (or the headless runtime, which has no human
   *  to share with) simply omits these. */
  controller: BrowserTabController.optional(),
  openedBy: z.enum(["agent", "human"]).optional(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

export const BrowserSnapshot = z.object({
  /** The session whose browser this is. Scopes are per session by construction:
   *  two sessions must never share a page. */
  scopeKey: Id,
  provider: BrowserProvider,
  running: z.boolean(),
  tabs: z.array(BrowserTab),
  screenshot: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  canStart: z.boolean().optional(),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshot>;

export const TurnAttachment = z.object({
  id: Id,
  name: z.string().min(1),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Absolute, engine-owned. Present on a stored attachment, which is the only
   *  kind that exists — an attachment is written before it is referenced. */
  path: z.string().min(1),
  /** Free labels: `plot` marks a rendered figure for the gallery, `pinned`
   *  keeps it at the top. Absent on a human upload. */
  tags: z.array(z.string().min(1)).optional(),
  producer: z.string().optional(),
  title: z.string().optional(),
  createdAt: Timestamp.optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

