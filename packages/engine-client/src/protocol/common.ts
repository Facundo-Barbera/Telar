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

export const UsageResolution = z.enum(["day", "hour"]);
export type UsageResolution = z.infer<typeof UsageResolution>;

export const UsageBucket = z.object({
  /** `YYYY-MM-DD` in the requested zone for days; the hour-start epoch ms as
   *  a decimal string for hours — a shape a client can sort lexically or
   *  parse, without this contract committing to a locale. */
  period: z.string().min(1),
  driver: ProviderDriverKind,
  /** The model the transcript names for these records. */
  model: z.string().min(1),
  tokens: TokenUsage,
  costUsd: z.number().nonnegative(),
  /** Whether every record here has a cost — provider-reported or rate-priced. */
  priced: z.boolean(),
  /** Records, not turns: one Claude assistant message or one Codex token
   *  count. The page says "requests" for this reason. */
  turns: z.number().int().nonnegative(),
});
export type UsageBucket = z.infer<typeof UsageBucket>;

export const UsageSource = z.object({
  provider: ProviderDriverKind,
  status: z.enum(["ok", "missing", "failed"]),
  path: z.string().min(1),
  files: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type UsageSource = z.infer<typeof UsageSource>;

export const UsageReport = z.object({
  sinceMs: Timestamp,
  untilMs: Timestamp,
  resolution: UsageResolution,
  timeZone: z.string().min(1),
  buckets: z.array(UsageBucket),
  sources: z.array(UsageSource),
  /** Where rate-priced costs came from: a fetch this read, a disk snapshot,
   *  or nowhere — in which case unreported costs are absent, not guessed. */
  pricing: z.enum(["fresh", "cached", "unavailable"]),
  /** Distinct transcript sessions that spent anything in the window. */
  sessions: z.number().int().nonnegative(),
  readAt: Timestamp,
});
export type UsageReport = z.infer<typeof UsageReport>;

export const UsageLimitSourceKind = z.enum(["cliproxy"]);
export type UsageLimitSourceKind = z.infer<typeof UsageLimitSourceKind>;

export const UsageLimitSource = z.object({
  id: z.string().min(1).max(64),
  kind: UsageLimitSourceKind,
  /** What to call it. Absent means "use the URL's host". */
  label: z.string().max(120).optional(),
  url: z.string().min(1).max(2048),
  /** Always `""` from a read. Send a non-empty value to replace the stored key. */
  managementKey: z.string().max(4096),
  keyRedacted: z.boolean().optional(),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UsageLimitSource = z.infer<typeof UsageLimitSource>;

export const UsageLimitWindow = z.object({
  /** Stable within a driver: `five_hour`, `seven_day`, `primary`, `secondary`,
   *  or `model:<display name>` for Claude's model-scoped weekly limits. */
  key: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  /** When the window rolls over, epoch ms. Absent when the provider gave none. */
  resetsAt: Timestamp.optional(),
});
export type UsageLimitWindow = z.infer<typeof UsageLimitWindow>;

/** One subscription login the hub pools. `error` is per-account on purpose: a
 *  hub that answers for three accounts and fails on the fourth must show three
 *  bars and one explanation, not four blanks. */
export const UsageLimitAccount = z.object({
  id: z.string().min(1),
  driver: ProviderDriverKind,
  email: z.string().optional(),
  plan: z.string().optional(),
  windows: z.array(UsageLimitWindow),
  error: z.string().optional(),
});
export type UsageLimitAccount = z.infer<typeof UsageLimitAccount>;

export const UsageLimitSourceSnapshot = z.object({
  id: z.string().min(1),
  kind: UsageLimitSourceKind,
  label: z.string().min(1),
  checkedAt: Timestamp,
  accounts: z.array(UsageLimitAccount),
  error: z.string().optional(),
});
export type UsageLimitSourceSnapshot = z.infer<typeof UsageLimitSourceSnapshot>;

export const UsageLimits = z.object({
  sources: z.array(UsageLimitSourceSnapshot),
  readAt: Timestamp,
});
export type UsageLimits = z.infer<typeof UsageLimits>;

export const StorageCategory = z.enum([
  "worktrees",
  /** `execution.sqlite` and its WAL — every turn, item and receipt. */
  "journal",
  "sessions",
  /** Interpreters and packages the data-science plugin installed. */
  "python",
  /** Chromium partitions for Telar's own browser. */
  "browser-profiles",
  /** The parsed-transcript cache behind Usage, and its price list. */
  "usage",
  /** Project notebooks. */
  "notes",
  "dictation",
  /** Per-run mounts. */
  "run",
  /** Worker diagnostics. */
  "diagnostics",
  /** Projects, providers, appearance — this install's configuration. */
  "settings",
  /** Attributed to nothing above, so the rows still sum to the total. */
  "other",
]);
export type StorageCategory = z.infer<typeof StorageCategory>;

export const StorageEntry = z.object({
  category: StorageCategory,
  bytes: z.number().min(0),
  path: z.string().min(1),
  kind: z.enum(["directory", "file"]),
  status: z.enum(["measuring", "partial"]).optional(),
  /** While `measuring`: how many of the row's parts have settled. */
  progress: z.object({ measured: z.number().min(0), of: z.number().min(0) }).optional(),
});
export type StorageEntry = z.infer<typeof StorageEntry>;

export const StoreCopy = z.object({
  root: z.string().min(1),
  files: z.number().min(0),
  bytes: z.number().min(0),
});
export type StoreCopy = z.infer<typeof StoreCopy>;

export const PackageCacheStatus = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  dedup: z.enum(["different-device", "unreachable"]),
});
export type PackageCacheStatus = z.infer<typeof PackageCacheStatus>;

export const StorageReport = z.object({
  /** Where the store is, which is the other half of "what is Telar keeping". */
  root: z.string().min(1),
  total: z.number().min(0),
  entries: z.array(StorageEntry),
  measuredAt: Timestamp,
  /** How long the walk took. Shown to nobody; it is what makes a pane that got
   *  slow diagnosable without re-measuring by hand. */
  tookMs: z.number().min(0),
  partial: z.boolean(),
  caches: z.array(PackageCacheStatus).optional(),
});
export type StorageReport = z.infer<typeof StorageReport>;

export const JournalReclaim = z.object({
  before: z.number().min(0),
  after: z.number().min(0),
  deltas: z.number().min(0),
  starts: z.number().min(0),
  sessions: z.number().min(0),
  usage: z.number().min(0).optional(),
});
export type JournalReclaim = z.infer<typeof JournalReclaim>;

export const WorktreesRoot = z.object({
  kind: z.enum(["default", "configured", "absent", "unreadable", "unverifiable"]),
  /** Where checkouts go, or would go. Absent only when the record is
   *  unreadable — the one state with no location to name. */
  root: z.string().min(1).optional(),
  /** Where they would go with nothing configured. What "put it back" means. */
  default: z.string().min(1),
  volume: z.object({ mount: z.string(), uuid: z.string() }).partial({ uuid: true }).optional(),
  label: z.string().optional(),
  blocker: z.string().optional(),
});
export type WorktreesRoot = z.infer<typeof WorktreesRoot>;

export const WorktreeMoveSkip = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1),
  reason: z.enum(["dirty", "branch-gone", "detached", "failed"]),
  /** Git's own words, or the branch that has gone. Never a substitute for
   *  `reason`: a sentence from git is diagnostic, not copy. */
  detail: z.string().optional(),
});
export type WorktreeMoveSkip = z.infer<typeof WorktreeMoveSkip>;

export const WorktreeMoveResult = z.object({
  moved: z.array(z.object({ sessionId: z.string().min(1), from: z.string().min(1), to: z.string().min(1) })),
  skipped: z.array(WorktreeMoveSkip),
  /** The whole thing said in a sentence, composed where the reasons are known. */
  summary: z.string(),
});
export type WorktreeMoveResult = z.infer<typeof WorktreeMoveResult>;

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

export const McpOAuthOverrides = z.object({
  /** Skips protected-resource discovery. For a server that publishes no
   *  metadata but whose authorization server the user knows. */
  authorizationServer: z.string().min(1).optional(),
  /** Pasted from the server's own dashboard, for an authorization server that
   *  will not register a client on demand. */
  clientId: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
});
export type McpOAuthOverrides = z.infer<typeof McpOAuthOverrides>;

export const McpServerSpec = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Overlaid on the worker's own environment, never replacing it: an MCP
     *  server still needs PATH and HOME like any other process. */
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: McpOAuthOverrides.optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: McpOAuthOverrides.optional(),
  }),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const McpOAuthStatus = z.object({
  serverId: Id,
  projectId: Id.optional(),
  requiresOAuth: z.boolean(),
  /** A stored grant exists. Not the same as working — see `health`. */
  connected: z.boolean(),
  expiresAt: Timestamp.optional(),
  scope: z.string().optional(),
  issuer: z.string().optional(),
  /** A live, authenticated `initialize` against the server. `needs-auth` covers
   *  both "never signed in" and "expired": from here they are one observation. */
  health: z.enum(["connected", "needs-auth", "error", "unknown"]),
  message: z.string().min(1).optional(),
});
export type McpOAuthStatus = z.infer<typeof McpOAuthStatus>;

export const McpServer = z.object({
  id: Id,
  projectId: Id.optional(),
  label: z.string().min(1),
  enabled: z.boolean(),
  spec: McpServerSpec,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;

export function resolveMcpServers(servers: readonly McpServer[], projectId: string | undefined): McpServer[] {
  const scoped = servers.filter((server) => server.projectId === projectId);
  const shadowed = new Set(scoped.map((server) => server.id));
  const global = servers.filter((server) => server.projectId === undefined && !shadowed.has(server.id));
  return [...global, ...scoped];
}

export const ProviderInstanceEnvVar = z.object({
  /** The shell's own rule, so a name that cannot be exported is refused here
   *  rather than silently dropped by the child process. */
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "environment variable names are letters, digits and underscores"),
  value: z.string(),
  sensitive: z.boolean(),
  /** Set by the engine on read. Absent on a value the client may see. */
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

/** A model's window class: `standard` is the ~200k–400k family, `long` 1M. */
export type ContextClass = "standard" | "long";

export function contextClassOf(window: number): ContextClass {
  return window >= 500_000 ? "long" : "standard";
}

export const AUTO_COMPACT_DEFAULTS = { standard: 150_000, long: 400_000 } as const;

/** The limit for a session whose window is `window`, or the standard one when
 *  the window is unknown — the earlier of the two, never the later. */
export function autoCompactLimitFor(limits: { standard: number; long: number }, window: number | undefined): number {
  return window !== undefined && contextClassOf(window) === "long" ? limits.long : limits.standard;
}

export const CLAUDE_COMPACTION_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const CLAUDE_COMPACTION_PERCENT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
export const CLAUDE_COMPACTION_DISABLE_ENV = "DISABLE_AUTO_COMPACT";
export const CLAUDE_COMPACTION_ENV_NAMES: readonly string[] = [
  CLAUDE_COMPACTION_WINDOW_ENV,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_DISABLE_ENV,
];

const OUTPUT_RESERVE = 20_000;
const SUMMARY_BUFFER = 13_000;
const WINDOW_FLOOR = 100_000;
const WINDOW_CEILING = 1_000_000;
/** Past this the declared window would exceed the CLI's ceiling. */
const CLAUDE_MAX_TOKENS = WINDOW_CEILING - OUTPUT_RESERVE - SUMMARY_BUFFER;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function boundedWindow(declared: number): number {
  return Math.max(WINDOW_FLOOR, Math.min(declared, WINDOW_CEILING));
}

export function claudeCompactionEnv(autoCompact: AutoCompact | undefined, window: number | undefined): Record<string, string | undefined> | undefined {
  if (!autoCompact) return undefined;
  if (autoCompact.mode === "never") return { [CLAUDE_COMPACTION_DISABLE_ENV]: "1" };
  const tokens = Math.min(autoCompactLimitFor(autoCompact, window), CLAUDE_MAX_TOKENS);
  const declared = boundedWindow(tokens + OUTPUT_RESERVE + SUMMARY_BUFFER);
  const percent = Math.ceil((tokens / (declared - OUTPUT_RESERVE)) * 100 * 1e6) / 1e6;
  return {
    [CLAUDE_COMPACTION_WINDOW_ENV]: String(declared),
    [CLAUDE_COMPACTION_PERCENT_ENV]: String(percent),
    [CLAUDE_COMPACTION_DISABLE_ENV]: undefined,
  };
}

export function migrateClaudeCompaction(
  env: readonly ProviderInstanceEnvVar[],
): { env: ProviderInstanceEnvVar[]; autoCompact?: AutoCompact } | undefined {
  if (!env.some((variable) => CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name))) return undefined;
  const byName = new Map(env.map((variable) => [variable.name, variable.value]));
  const kept = env.filter((variable) => !CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name));
  if (TRUTHY.has((byName.get(CLAUDE_COMPACTION_DISABLE_ENV) ?? "").trim().toLowerCase())) {
    return { env: kept, autoCompact: { mode: "never" } };
  }
  const rawWindow = byName.get(CLAUDE_COMPACTION_WINDOW_ENV)?.trim() ?? "";
  if (!/^\d+$/.test(rawWindow) || Number(rawWindow) <= 0) return { env: kept };
  const effective = boundedWindow(Number(rawWindow)) - OUTPUT_RESERVE;
  const byWindow = effective - SUMMARY_BUFFER;
  const rawPercent = Number.parseFloat(byName.get(CLAUDE_COMPACTION_PERCENT_ENV)?.trim() ?? "");
  const tokens =
    Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent <= 100 ? Math.min(Math.floor((effective * rawPercent) / 100), byWindow) : byWindow;
  return { env: kept, autoCompact: { mode: "limits", standard: Math.max(1, tokens), long: Math.max(AUTO_COMPACT_DEFAULTS.long, tokens) } };
}

export const ProviderInstance = z.object({
  /** The routing key. A slug, because it is also a URL path segment and a
   *  settings-page anchor. */
  id: Id,
  driver: ProviderDriverKind,
  /** Optional label shown in the pickers. The id never changes; this does. */
  displayName: z.string().min(1).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** When the composer says the context is heavy, as a whole percentage of the
   *  model's window. Absent means the default (70). A share rather than a token
   *  count, so it stays right across windows of different sizes. */
  contextNoticePercent: z.number().int().min(1).max(100).optional(),
  /** When this login's sessions compact themselves. Absent means the provider
   *  decides. See `AutoCompact`. */
  autoCompact: AutoCompact.optional(),
  /** Off is a state, not deletion — same rule as an MCP server. */
  enabled: z.boolean(),
  configDir: z.string().min(1).optional(),
  binaryPath: z.string().min(1).optional(),
  env: z.array(ProviderInstanceEnvVar),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProviderInstance = z.infer<typeof ProviderInstance>;

/** The id of the built-in slot for a driver. One spelling, so the engine, the
 *  cockpit and a stored session cannot disagree about what "the default Claude"
 *  is called. */
export function defaultInstanceIdForDriver(driver: ProviderDriverKind): string {
  return driver;
}

export const ProviderSignIn = z.enum(["signed-in", "signed-out", "missing-config-dir", "unknown"]);
export type ProviderSignIn = z.infer<typeof ProviderSignIn>;

export const ProviderUpdate = z.object({
  status: z.enum(["current", "behind", "pinned", "unknown"]),
  latest: z.string().min(1).optional(),
  method: z.enum(["native", "homebrew", "npm", "bun", "pnpm", "vite-plus", "unknown"]).optional(),
  /** The exact command that updates it — shown, copied, and what the engine
   *  runs. Present only on `behind`. */
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
  /** `disabled` outranks everything: an instance switched off is not failing. */
  status: z.enum(["ready", "warning", "error", "disabled"]),
  installed: z.boolean(),
  version: z.string().min(1).optional(),
  update: ProviderUpdate.optional(),
  signIn: ProviderSignIn,
  /** What the harness said when it could not answer. Verbatim, because a
   *  paraphrase of a provider's own error is a second thing to keep true. */
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
  /** A short mark the manifest puts beside a row — `new` on a model that just
   *  shipped. Display only. */
  badge: z.enum(["new"]).optional(),
  fastMode: z.boolean(),
  /**
   * The service tiers this model is sold at, as the provider lists them —
   * Codex's `model/list` `serviceTiers`. Absent or empty means the provider
   * offers no choice, which is every Claude and OpenCode row.
   */
  serviceTiers: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional() })).optional(),
  /** The tier a turn runs at when none is picked, where the provider said. */
  defaultServiceTier: z.string().min(1).optional(),
  hiddenByUser: z.boolean().default(false),
  source: z.enum(["provider", "user"]).default("provider"),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

/** Where a catalogue came from, so a surface can say whether it is asking or
 *  guessing. `builtin` is this cockpit's own list and is a known gap. */
export const ModelCatalogueSource = z.enum(["provider", "builtin"]);
export type ModelCatalogueSource = z.infer<typeof ModelCatalogueSource>;

export const ModelCatalogue = z.object({
  driver: ProviderDriverKind,
  models: z.array(ProviderModel),
  source: ModelCatalogueSource,
  /** Why it fell back, when it did. Never invented. */
  message: z.string().min(1).optional(),
  readAt: Timestamp,
  instanceId: ProviderInstanceId.optional(),
  /** The CLI's own `--version` at read time, when it answered — what the
   *  model manifest's `minVersion` is checked against. Cached with the list
   *  it describes. */
  cliVersion: z.string().min(1).optional(),
  refreshing: z.boolean().optional(),
});
export type ModelCatalogue = z.infer<typeof ModelCatalogue>;

export const CustomProviderModel = z.object({
  /** The provider's own id, verbatim. Never interpreted here. */
  id: z.string().min(1),
  /** What to call it in the picker. Absent means the id itself — no name is
   *  invented for a row nobody published. */
  label: z.string().min(1).optional(),
});
export type CustomProviderModel = z.infer<typeof CustomProviderModel>;

export const ModelOverlay = z.object({
  instanceId: ProviderInstanceId,
  /** Row ids to lift to the top of the menu. */
  favorites: z.array(z.string().min(1)).default([]),
  /** Row ids the reader curated away. Still returned by the catalogue, marked
   *  `hiddenByUser` — see `ProviderModel`. */
  hidden: z.array(z.string().min(1)).default([]),
  order: z.array(z.string().min(1)).default([]),
  custom: z.array(CustomProviderModel).default([]),
  default: z.string().min(1).optional(),
  updatedAt: Timestamp,
});
export type ModelOverlay = z.infer<typeof ModelOverlay>;

/** An untouched overlay. Every surface behaves exactly as it did before the
 *  feature existed when this is what it gets. */
export const DEFAULT_MODEL_OVERLAY: Omit<ModelOverlay, "instanceId" | "updatedAt"> = {
  favorites: [],
  hidden: [],
  order: [],
  custom: [],
};
