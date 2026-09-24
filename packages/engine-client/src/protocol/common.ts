/**
 * engine protocol v2 — shared primitives.
 *
 * WHY THIS PACKAGE HAS A DEPENDENCY NOW, and why it is only this one. The v1
 * header said these types were "deliberately dependency-free so browser clients
 * can use them without ever importing the server-side Telar core package". The
 * INTENT of that rule is intact and is the one that matters: nothing here may
 * import `@telar/core`, which touches the filesystem and would not survive in a
 * browser. The literal "no dependencies" reading is what changed, deliberately.
 *
 * The reason is that v1 had no runtime validation at all, and the cost was
 * already visible in two places before v2 was written:
 *   - `isDiscovery()` in ../index.ts — fifteen lines of hand-rolled checks
 *     ending in a `value is EngineDiscovery` assertion that TypeScript takes on
 *     trust. Add a field to the type and forget a line here, and the check
 *     silently weakens with nothing to report it.
 *   - `apps/web/lib/engine/journal.ts` — `typeof event.data.text ===
 *     "string"` written by hand, because v1 typed every event payload as
 *     `Record<string, unknown>` and the type system genuinely did not know.
 * v2 carries ~50 event shapes across three trust boundaries (provider SDK →
 * engine, engine → client over HTTP, disk → engine on restart). Hand-rolling
 * that is how a contract stops describing reality.
 *
 * So: zod defines each shape ONCE and the TypeScript type is derived from it
 * with `z.infer`. They cannot drift, because there is only one of them. zod is
 * isomorphic and browser-safe, and `@telar/core` already depends on it at the
 * same major, so this introduces no new library to the repo.
 *
 * House style is the engine's `schemas.ts` (ported from the retired core package): `z.enum`, `z.number().int()`,
 * and a schema and its inferred type sharing one exported name. Ids are NOT
 * branded — core does not brand, and matching the surrounding code wins over a
 * safety property no other module in this repo has asked for.
 */
import { z } from "zod";

/**
 * Bumped from 1 to 2 as a HARD BREAK. v1's eleven flat `turn.*` events are not
 * a subset of this contract and there is no dual-emit path: an engine speaking
 * v2 refuses a v1 client rather than degrading. The only consumer is
 * `apps/web`, which we control, and the dogfood home holds throwaway
 * sessions.
 */
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

/**
 * The host an engine runs on. Always "local" today.
 *
 * CARRIED DELIBERATELY WHILE IT HAS ONE VALUE. t3 code threads an
 * `EnvironmentId` through every contract from day one so a client can drive a
 * server on another machine; retrofitting that later means touching every event
 * and every persisted reference. A field with one legal value costs nothing now
 * and is the cheapest option we will ever have on it.
 */
export const EnvironmentId = z.literal("local");
export type EnvironmentId = z.infer<typeof EnvironmentId>;

/**
 * WHAT runs a session: the agent CLI/SDK behind it. Mirrors core's
 * `ProviderId` vocabulary so the two never disagree about the word "claude".
 *
 * EVERY MEMBER NAMES A HARNESS SOMEBODY ELSE INSTALLED. `telar` was briefly a
 * fourth member (#526) for the engine's own agent loop and was withdrawn with
 * the Main session (#531) — the Agent is not a provider a session routes to, it
 * is its own thing with its own key, and giving it a driver kind put a row in
 * the provider registry that no login was ever behind.
 *
 * RETIRING A MEMBER OF THIS ENUM IS A MIGRATION, and the stores that already
 * wrote the old word are the ones that pay for it. `readProviderInstances` in
 * `state.ts` drops a row whose driver this build no longer has, rather than
 * refusing to read the registry at all; anything else added here and later
 * removed needs that same courtesy.
 */
export const ProviderDriverKind = z.enum(["claude", "codex", "opencode"]);
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;

export const PROVIDER_CAPABILITIES: Record<ProviderDriverKind, { liveSteering: boolean; compaction: boolean; backgroundTaskStop: boolean }> = {
  claude: { liveSteering: true, compaction: true, backgroundTaskStop: true },
  codex: { liveSteering: true, compaction: true, backgroundTaskStop: false },
  opencode: { liveSteering: false, compaction: false, backgroundTaskStop: false },
};

/**
 * WHICH configured provider runs it — an account, its credentials, and its
 * bindings. This is the ROUTING KEY; `driver` is descriptive.
 *
 * ADOPTED UP FRONT RATHER THAN RETROFITTED. t3 code shipped driver-only routing
 * first and its contract still carries the scar: `provider` is marked "optional
 * during the driver/instance migration… once every producer populates it,
 * routing flips to instance-id-only and the legacy field is removed". Doing it
 * in that order means a migration across every event and every persisted model
 * selection. Telar's account registry (the engine's `accounts.ts`) is the
 * natural source of instances.
 */
export const ProviderInstanceId = Id;
export type ProviderInstanceId = z.infer<typeof ProviderInstanceId>;

/** Reasoning effort. An OPEN STRING on purpose: provider vocabularies differ
 *  and drift, and an enum here would reject a valid value the model accepts. */
export const Effort = z.string().min(1);
export type Effort = z.infer<typeof Effort>;

/**
 * THERE IS NO `ContextWindow` HERE ANY MORE, and its absence is the correction.
 *
 * This contract used to carry a two-position switch — `default` | `1m` — which
 * the Claude driver turned into `betas: ['context-1m-2025-08-07']`. Asking the
 * installed Claude Code what models it has (see apps/engine/src/models.ts)
 * showed both halves of that to be wrong: the long window is not a beta any
 * more, and the provider does not express it as a setting at all. It expresses
 * it as a MODEL: `claude-opus-5[1m]` and `sonnet[1m]` are rows in its own list,
 * alongside `sonnet` and `haiku`.
 *
 * So the switch is gone and long context is picked the way the provider offers
 * it — by choosing that model. One control fewer, and it is the provider's own
 * vocabulary rather than a translation of it.
 */

/**
 * A model AND/OR AN EFFORT on a configured instance. Routing is by
 * `instanceId`; `model` is the provider's own identifier and is never
 * interpreted here.
 *
 * `model` IS OPTIONAL, AND MAKING IT REQUIRED WAS A MISTAKE THIS CORRECTS.
 * Both providers take the two independently — the Agent SDK has `model?` and
 * `effort?` as separate options, and Codex takes both as separate params on
 * `turn/start` — so requiring a model in order to store an effort was a coupling
 * this contract invented. Its cost was concrete and user-visible: a session on
 * the provider default could not be told to think harder, because there was
 * nowhere to put the level. "Use whatever model is configured, at maximum
 * effort" is an ordinary thing to want and is now representable.
 *
 * At least one of the two must be present, because a selection that selects
 * nothing is an absent selection and the engine should see it as one.
 */
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
  })
  .refine((value) => value.model !== undefined || value.effort !== undefined || value.fastMode !== undefined, {
    message: "a model selection must name at least one of model, effort or fast mode",
  });
export type ModelSelection = z.infer<typeof ModelSelection>;

/**
 * How much autonomy a session has, and therefore what happens when a tool call
 * would otherwise open an approval request.
 *
 * THIS IS THE FIELD THAT MAKES DETACHED RUNS WORK OR NOT. A detached session
 * with an open request nobody answers is not autonomous, it is stuck — see
 * `RequestKind` in ./requests.ts for the resolution rules per mode.
 */
export const RuntimeMode = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

/** Attended sessions default to asking. */
export const DEFAULT_ATTENDED_RUNTIME_MODE: RuntimeMode = "approval-required";
/** Detached sessions default to resolving inside their own boundary and
 *  parking anything that escapes it. NOT "full-access": a detached run still
 *  has a blast radius worth bounding. */
export const DEFAULT_DETACHED_RUNTIME_MODE: RuntimeMode = "auto";

/**
 * THE MODES AS A LADDER, NARROWEST FIRST — issue #541 G1.
 *
 * The order is not invented here. It is the one `autoResolution` describes in
 * `./requests.ts` ("approval-required asks about everything except reads …
 * full-access nothing asks") and the one the cockpit's own access menu lists
 * them in. Written down as data so a comparison has something to read, because
 * an ordering that lives only in prose is an ordering every caller re-derives.
 *
 * THE PROPERTY THAT MAKES IT A LADDER rather than a list: for every request
 * kind, a narrower mode never auto-accepts where a wider one parks.
 * `runtime-ceiling.test.ts` holds that against `autoResolution` itself rather
 * than against this array, so the two cannot drift into disagreeing.
 */
const RUNTIME_MODE_LADDER: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * THE PRIVILEGE CEILING, DEFINED ONCE — issue #541 G1.
 *
 * Answers whichever of two modes gives away less. It is in the CONTRACT beside
 * `autoResolution` and for its reason: the engine enforces the ceiling, and a
 * client has to be able to tell a person what a session it is about to create
 * will be allowed to do. A settings screen that computed that from its own copy
 * of the ladder is a settings screen that lies after the first change to it.
 *
 * TOTAL AND SYMMETRIC, so a caller cannot get a different answer by arguing in
 * the other order, and an unrecognised value answers the NARROWEST rather than
 * the widest — an engine reading a mode written by a newer one must fail
 * towards asking, never towards acting.
 */
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

/**
 * Where a session's work lands: the project's own checkout, or a git worktree
 * of its own. `worktree` is the precondition for running several detached
 * sessions on one project without them fighting over a checkout — the
 * Conductor idea, which t3 code encodes as the same two-value choice.
 */
export const EnvMode = z.enum(["local", "worktree"]);
export type EnvMode = z.infer<typeof EnvMode>;

/**
 * WHICH USAGE LIMIT, from a CLOSED set with a generic fallback.
 *
 * The provider's own field is an open string and the set grows, but two durable
 * things a person reads carry this — the `provider_wait` row (`items.ts`) and a
 * `rate_limited` turn failure (`entities.ts`) — and neither is a place to
 * forward an arbitrary remote label. A value this contract does not know
 * becomes `other`, which still says "some limit" without repeating anything
 * unvetted.
 *
 * HERE RATHER THAN BESIDE EITHER USER, because `items.ts` and `entities.ts` both
 * import this file and neither may import the other. It was inline in the wait
 * row first; the failure needed the same closed set, and two copies of a list
 * that must agree is how they stop agreeing.
 */
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

/**
 * Tokens for one unit of work.
 *
 * THE FOUR-WAY SPLIT IS NOT ARBITRARY — it is the same pair-plus-cache shape
 * the retired Ultra surface's `UltraTokens` and the usage ledger's `UsageEntry`
 * already store, so a figure derived from this is comparable with the session
 * ledger's rather than being a second definition of "tokens". AD-18/FR-RF-2:
 * one spend, one number.
 */
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

/**
 * THE USAGE PAGE'S WIRE SHAPE — spend over time, bucketed.
 *
 * Derived by SCANNING THE PROVIDER CLIS' OWN TRANSCRIPTS (`~/.claude/
 * projects`, `~/.codex/sessions`) — t3 code's architecture, adopted after the
 * journal-fold version shipped and immediately showed its two limits: a turn
 * that rode the provider default bucketed as literal `default` (the journals
 * never learn which model that was), and nothing run OUTSIDE Telar counted at
 * all, though it is the same machine spending against the same plans. The
 * transcripts name the real model on every record and cover every harness
 * run, Telar's included — Telar's own turns land in those directories too, so
 * one source counts everything exactly once.
 *
 * Cost is the provider's figure where the transcript carries one, and the
 * LiteLLM rate table's base tier where it does not (Codex never reports cost;
 * Claude omits it on subscription plans). A model neither knows stays
 * unpriced: tokens count, cost reads as absent — never $0.00.
 */
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

/** One transcript directory's scan outcome, so the page can say what was and
 *  was not counted rather than letting a missing install read as zero use. */
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

/**
 * USAGE LIMIT SOURCES — quota read from somewhere this machine does not run.
 *
 * The report above counts what THIS Mac spent, by reading transcripts it can
 * see. A pooled subscription is the other half of the same question and no
 * amount of local scanning can answer it: a CLIProxyAPI hub holds several
 * Claude/Codex logins and routes turns across them, so the windows that
 * actually gate work are the hub's, on accounts this machine never logs in as.
 *
 * A SOURCE IS CONFIGURATION, A SNAPSHOT IS LIVE STATE. The first is stored and
 * survives a restart; the second is re-read from the hub and never persisted,
 * for the same reason a provider probe is not — a quota figure kept across a
 * restart is a figure that is wrong by exactly as long as the engine was down.
 */
export const UsageLimitSourceKind = z.enum(["cliproxy"]);
export type UsageLimitSourceKind = z.infer<typeof UsageLimitSourceKind>;

/**
 * One configured hub.
 *
 * `managementKey` IS ALWAYS EMPTY ON THE WAY OUT and `keyRedacted` says why —
 * the same round trip `ProviderInstanceEnvVar.sensitive` makes, and for the
 * same reason: this row is handed to a settings page over HTTP, so redaction
 * has to be what the type says rather than what each call site remembers.
 * Saving the redacted shape back KEEPS the stored key; only a non-empty value
 * replaces one.
 */
export const UsageLimitSource = z.object({
  id: z.string().min(1).max(64),
  kind: UsageLimitSourceKind,
  /** What to call it. Absent means "use the URL's host". */
  label: z.string().max(120).optional(),
  url: z.string().min(1).max(2048),
  /** Always `""` from a read. Send a non-empty value to replace the stored key. */
  managementKey: z.string().max(4096),
  /** Present and true when a key is stored and was withheld from this read. */
  keyRedacted: z.boolean().optional(),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UsageLimitSource = z.infer<typeof UsageLimitSource>;

/**
 * One quota window on one account.
 *
 * `usedPercent` RATHER THAN "remaining": it is the figure both providers
 * actually report (Claude's `utilization`, Codex's `used_percent`), and
 * deriving the complement once at the edge is cheaper than storing a number
 * neither API said.
 */
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

/** What one source answered, when. A source that failed KEEPS ITS ROW with
 *  `error` set — "configured and unreachable" and "not configured" are
 *  different facts and a page that drew them the same way would hide a typo in
 *  a URL behind an empty section. */
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

/**
 * ══ WHAT TELAR KEEPS ON DISK, BY CATEGORY — issue #642 ══
 *
 * A CLOSED SET, AND `other` IS WHY IT CAN STAY CLOSED. Everything under the
 * store root is attributed to exactly one of these, so the categories sum to
 * the total and nothing is quietly left out of the figure a person reads. A
 * file a later version writes lands in `other` rather than in no row at all,
 * which is the failure this list is arranged to avoid: the whole argument for
 * the pane is that `execution.sqlite` was a gigabyte nobody had ever seen.
 *
 * IDS, NOT COPY. The engine says what the categories ARE and how big each one
 * is; the cockpit says what they are CALLED, because "Session checkouts" is a
 * sentence written for a reader and the engine has no readers. See
 * `components/settings/storage-section.tsx` for the words.
 *
 * TELAR'S OWN FOOTPRINT AND NOTHING ELSE. There is no category here for Docker,
 * for a toolchain, or for the projects a person works on, however much disk
 * those take — a pane that grew opinions about the whole machine would be a
 * disk cleaner, which is a different product.
 */
export const StorageCategory = z.enum([
  /** Session checkouts. Reproducible: the engine re-cuts one from a recorded
   *  base sha, which is what makes it the one category worth relocating (#642
   *  part 2) — with only this away, Telar still starts completely. */
  "worktrees",
  /** `execution.sqlite` and its WAL — every turn, item and receipt. */
  "journal",
  /** Transcripts and what each session was asked. Irreplaceable. */
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

/**
 * One category's measured size and the path a person can be taken to.
 *
 * `path` IS WHAT "REVEAL" OPENS, and `kind` is what tells the shell whether to
 * select a file in its folder or open the folder itself — the journal's row
 * points at `execution.sqlite`, and a row for a group of loose files points at
 * the store root they sit in.
 */
export const StorageEntry = z.object({
  category: StorageCategory,
  bytes: z.number().min(0),
  path: z.string().min(1),
  kind: z.enum(["directory", "file"]),
});
export type StorageEntry = z.infer<typeof StorageEntry>;

/**
 * The whole measurement, AS OF A MOMENT — never as of now.
 *
 * `measuredAt` IS PART OF THE ANSWER rather than a detail the client could
 * infer, because sizing a 13 GB tree takes seconds and the honest thing to show
 * is a figure with a timestamp and a refresh beside it. Nothing polls this: it
 * is measured when a reader first asks and again when one presses refresh (#629
 * is open because four timers in the rail cost ~97,000 requests a day, and a
 * directory's size does not change by the second).
 *
 * `partial` WHEN SOMETHING COULD NOT BE READ — a permission, a volume that went
 * away mid-walk. The total is then a floor rather than a figure, and the pane
 * says so instead of quietly under-reporting.
 */
/**
 * WHETHER AN INSTALL INTO A SESSION CHECKOUT CAN CLONE FROM THE CACHE — #633.
 *
 * `different-device` means deduplication is impossible, not broken: hardlinks
 * and APFS clones are same-filesystem only, so a checkout on one disk and a
 * package cache on another means every install pays a real full copy.
 *
 * `unreachable` IS NOT `different-device`. A cache root that does not exist yet
 * is the ordinary state of a fresh machine or of a package manager nobody has
 * run, and reporting it as a different filesystem would be a wrong answer
 * dressed as a precise one. A drive that went away lands here too.
 *
 * `same-device` NEVER REACHES A READER. It is the single-disk case, which is
 * most people, and their whole entitlement is silence — the engine filters it
 * out rather than sending a row for a cockpit to remember not to draw.
 */
/**
 * WHAT A SAFE COPY OF THE STORE PRODUCED — issue #665.
 *
 * COUNTS AND A PATH, because the point of the operation is that the copy is
 * somewhere a person can open: the path is the answer, and the two numbers are
 * how they know it is the whole store rather than an empty directory.
 *
 * IT IS NOT THE STORE'S SIZE. The reproducible tier — checkouts, Python
 * environments, toolchains — is deliberately not carried, so this figure is
 * smaller than the Storage pane's total and is meant to be.
 */
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
  /**
   * The package caches an install into a checkout cannot clone from — see
   * `PackageCacheStatus`. ABSENT when there are none, which is the ordinary
   * single-disk answer, and optional besides so an engine from before #633
   * still satisfies a cockpit that knows about it.
   */
  caches: z.array(PackageCacheStatus).optional(),
});
export type StorageReport = z.infer<typeof StorageReport>;

/**
 * WHAT ONE PRESS OF RECLAIM RETURNED — issue #646.
 *
 * BEFORE AND AFTER, NOT A SAVING, because the difference is not the only thing
 * a person is owed: a press that moved nothing should read as "already
 * compact", and only both numbers say that. The file is the database plus its
 * `-wal` and `-shm`, so a WAL truncated by the same work is counted where
 * somebody would look for it.
 *
 * `deltas` AND `starts` ARE ROWS, NOT BYTES, and they are here so the sentence
 * can name what went. Both kinds are superseded by the `item.completed` of
 * their own turn — no turn, item or answer is ever dropped — and saying
 * "570,951 rows" without saying which would read like history going away.
 *
 * `usage` IS THE THIRD KIND AND IT IS OPTIONAL — issue #697. Superseded on the
 * same terms: a turn's token count is restated after every item, the fold keeps
 * the last row and writes the sum onto the turn, and the restatements go.
 * Optional because an engine from before the fold answers without it, and a
 * cockpit that demanded the field would refuse that engine's perfectly good
 * before-and-after.
 */
export const JournalReclaim = z.object({
  before: z.number().min(0),
  after: z.number().min(0),
  deltas: z.number().min(0),
  starts: z.number().min(0),
  sessions: z.number().min(0),
  usage: z.number().min(0).optional(),
});
export type JournalReclaim = z.infer<typeof JournalReclaim>;

/**
 * WHERE SESSION CHECKOUTS GO — issue #642 part 2.
 *
 * FIVE KINDS AND NOT A PATH, because four of them are things a person has to
 * be told rather than a location to quietly use: nothing chosen, chosen and
 * present, chosen and on a drive that is not connected, a record this build
 * cannot read, and — issue #665 — chosen on a platform that cannot tell which
 * of those last two is true.
 *
 * `unverifiable` IS THE HONEST WINDOWS ANSWER, and it exists because the
 * alternative was a confident wrong one. `mountRootsFor` returns an empty list
 * on win32, so nothing is ever a mount point there and a checkouts root on
 * `D:\` reported as *configured and fine* whether or not the drive was
 * connected: `worktreesRootBlocker` returned nothing, the cut proceeded, and
 * `mkdirSync` failed mid-session with an I/O error instead of the sentence this
 * type exists to carry. This says "the location is recorded and this build
 * cannot check the drive", which is exactly what is known.
 *
 * THERE IS NO `restartRequired` HERE, and its absence is a finding rather than
 * an omission. The root is consulted at exactly one moment — planning where a
 * new checkout lands — and everything afterwards addresses a worktree by the
 * absolute path recorded on its session, including the prune guard that
 * derives its root per-worktree from that path. So a new root takes effect on
 * the next cut. #630's store move genuinely cannot apply until the next
 * launch; this one can, and inheriting the restart out of symmetry would cost
 * somebody a restart they do not need.
 *
 * `blocker` IS THE WHOLE SENTENCE, not a code to switch on. It names the drive
 * by the label recorded when it was chosen, because the moment it is needed is
 * the moment the drive is not there to be asked.
 */
export const WorktreesRoot = z.object({
  kind: z.enum(["default", "configured", "absent", "unreadable", "unverifiable"]),
  /** Where checkouts go, or would go. Absent only when the record is
   *  unreadable — the one state with no location to name. */
  root: z.string().min(1).optional(),
  /** Where they would go with nothing configured. What "put it back" means. */
  default: z.string().min(1),
  volume: z.object({ mount: z.string(), uuid: z.string() }).partial({ uuid: true }).optional(),
  /** The drive's name the day it was chosen. */
  label: z.string().optional(),
  /** Why no worktree session can be cut right now, in words a person can act
   *  on. Absent when one can. */
  blocker: z.string().optional(),
});
export type WorktreesRoot = z.infer<typeof WorktreesRoot>;

/**
 * WHAT MOVING THE CHECKOUTS ALREADY CUT DID — issue #642 part 2.
 *
 * ONE REASON PER SKIPPED CHECKOUT, NOT A TOTAL, because the reasons lead a
 * person to different places: commit your work, versus a branch that no longer
 * exists and cannot be re-cut from, versus git said something nobody predicted.
 * A single "3 could not be moved" would send them looking for the wrong thing.
 *
 * A PARTIAL RESULT IS A SUCCESS, and that is safe here in a way it would not be
 * for a copy-based move: checkouts are moved by being re-cut from their own
 * branch, one at a time, each with its own state rewrite. Skipping one changes
 * nothing about the others, and the operation is re-runnable — commit the work
 * and press it again.
 */
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

/**
 * The untranslated provider payload behind a normalized event.
 *
 * KEEP IT, KEEP IT OPTIONAL, AND NEVER DEPEND ON IT. It is how a normalization
 * bug gets diagnosed without re-running the session, and how a client can show
 * something this contract does not model yet. A client that BRANCHES on `raw`
 * has moved the contract into the provider's shape, which is the coupling the
 * whole normalization layer exists to prevent.
 */
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

/**
 * Which browser is serving a session.
 *
 * `headless` is the ENGINE's own Chromium and is the default, because it is
 * what makes a detached session able to browse at all. t3 code brokers
 * automation to a connected desktop host and fails outright when none is
 * attached; Telar's headless runtime (`apps/engine/src/browser/`) closes that
 * gap. `attached` takes over when a client offers a webview, so a human can
 * watch — no client offers one yet, so nothing reports it.
 *
 * HERE RATHER THAN IN ./events.ts, where it started: both the journal event and
 * the worker's observation need it, and observations must not have to import
 * the event union to describe a browser tab.
 */
export const BrowserProvider = z.enum(["headless", "attached", "none"]);
export type BrowserProvider = z.infer<typeof BrowserProvider>;

/** Whose hands are on ONE tab — control is per tab, not per browser, so a
 *  human taking tab 2 never stops the agent working in tab 1 (§6). */
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

/**
 * THE BROWSER AS A HUMAN SEES IT, which is a different question from the one
 * `browser.state.changed` answers.
 *
 * That event says which pages exist, and it is journalled because it is history.
 * This is a POLLED SNAPSHOT of a live thing, and its whole reason for existing
 * is `screenshot` — without pixels the browser panel can list URLs and nothing
 * else, which is the state the cockpit shipped in. A screenshot is far too large
 * and far too transient to journal: one per turn would dominate the event log
 * within an hour of browsing, and the interesting one is always the current one.
 *
 * So it is a read, never an event. `null` screenshot is honest and common — the
 * browser may not be running, and asking for a picture must never be the thing
 * that launches a Chromium.
 */
export const BrowserSnapshot = z.object({
  /** The session whose browser this is. Scopes are per session by construction:
   *  two sessions must never share a page. */
  scopeKey: Id,
  provider: BrowserProvider,
  running: z.boolean(),
  tabs: z.array(BrowserTab),
  /** A `data:` URL. NEVER a file path — a detached session has nobody to clean
   *  up a screenshot directory, and a client on another machine could not read
   *  one anyway. */
  screenshot: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  /**
   * Whether asking with `start` could launch a browser HERE. False when the
   * daemon has no runtime attached — the out-of-process worker owns its own,
   * which this process cannot reach — so a client can hide its "open a
   * browser" affordance instead of offering a button that starts a browser
   * beside the one the agent is actually driving.
   */
  canStart: z.boolean().optional(),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshot>;

/**
 * A file the human attached to a message.
 *
 * UPLOADED BEFORE THE TURN, NOT INSIDE IT. The submission carries ids and the
 * bytes arrive on their own route, for three reasons that all bite at once:
 * a JSON body has a size cap the rest of the protocol wants kept small; base64
 * inflates every byte by a third on a path that is already the largest thing a
 * client sends; and a failed upload should not cost the message. Two steps also
 * make an attachment addressable, which is what lets a client show a thumbnail
 * before anything is sent.
 *
 * `path` is where the engine wrote it. The drivers need a real path — Codex's
 * `localImage` input element takes one, and a non-image file is only reachable
 * by the agent's own Read tool — so the engine owning that path is what makes an
 * attachment usable rather than merely stored.
 */
export const TurnAttachment = z.object({
  id: Id,
  /** The human's own filename, kept for display. Never used to build a path —
   *  see the engine's `attachmentFile`, which mints its own. */
  name: z.string().min(1),
  /** As declared by the client. Trusted for DISPLAY and for choosing how to
   *  hand the file to a provider; never for deciding what to execute. */
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Absolute, engine-owned. Present on a stored attachment, which is the only
   *  kind that exists — an attachment is written before it is referenced. */
  path: z.string().min(1),
  /** Free labels: `plot` marks a rendered figure for the gallery, `pinned`
   *  keeps it at the top. Absent on a human upload. */
  tags: z.array(z.string().min(1)).optional(),
  /** What made it — a cell id, a tool name — for a gallery caption. STABLE
   *  across re-runs, which is what lets a gallery stack the four attempts at
   *  one figure instead of drawing four cards (#353). */
  producer: z.string().optional(),
  /**
   * WHAT THE THING IN THE IMAGE CALLS ITSELF — a figure's own title, read off
   * the plot that was drawn rather than off the execution that drew it.
   *
   * `producer` identifies the maker and `title` identifies the made thing, and
   * a gallery wants the second: "Radius vs. period" is what a person is looking
   * for and `exec_9` is what the machine happened to call that attempt. Absent
   * when the figure had no title of its own, which is when the producer is the
   * best name anybody has.
   */
  title: z.string().optional(),
  /** When it was stored. Absent on attachments written before this existed. */
  createdAt: Timestamp.optional(),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

/**
 * An MCP server the USER configured, as opposed to the ones Telar registers for
 * itself.
 *
 * THE TWO KINDS ARE NOT INTERCHANGEABLE and this shape is deliberately not the
 * same as `TELAR_CAPABILITIES`. Telar's own tools run in-process, are named by
 * `mcp__telar__<capability>_<verb>` (see ./tools.ts), and the engine vouches for
 * them. One of these is a THIRD PARTY the user pointed at: it may be a command
 * that gets spawned or a URL that gets called, so it carries a transport, it is
 * disable-able without being deleted, and it is stored per environment rather
 * than per session — the user configures a tool once, not once per conversation.
 */
/**
 * WHAT THE USER MAY PIN ABOUT A SERVER'S OAUTH, and nothing more.
 *
 * OAUTH IS DETECTED, NOT DECLARED. The engine asks the server itself — a 401
 * carrying an RFC 9728 pointer, or a protected-resource-metadata document — so
 * the absence of this block does NOT mean the server has no OAuth, and its
 * presence does not turn OAuth on. Every field here is an OVERRIDE for the case
 * where autodetection cannot get there on its own.
 *
 * THERE IS NO CLIENT SECRET, on purpose. Telar registers as a public client and
 * proves itself with PKCE, which is what OAuth 2.1 asks a native app to do; a
 * secret shipped to a machine its user administers is not a secret, and storing
 * one would imply a guarantee this engine cannot make.
 */
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

/**
 * WHAT THE SETTINGS ROW KNOWS ABOUT ONE SERVER'S SIGN-IN.
 *
 * FOUR SEPARATE FACTS, because collapsing them loses the one the reader needs.
 * "Does this server want OAuth" and "is our token working" are different
 * questions with different fixes, and a server that is merely DOWN must not
 * render as one that needs a login — those two want opposite actions.
 *
 * NO TOKEN IS IN THIS SHAPE and none ever will be. `expiresAt` and `scope` are
 * the non-secret halves of a stored grant; the token itself is reachable only
 * from the worker claim.
 */
export const McpOAuthStatus = z.object({
  serverId: Id,
  projectId: Id.optional(),
  /** Measured from the wire. Best-effort: an unreachable server answers `false`
   *  rather than `true`, because claiming a login is needed when we could not
   *  ask is a confident wrong answer. */
  requiresOAuth: z.boolean(),
  /** A stored grant exists. Not the same as working — see `health`. */
  connected: z.boolean(),
  expiresAt: Timestamp.optional(),
  scope: z.string().optional(),
  /** Who issued the grant, for a row that has to say WHICH account this is. */
  issuer: z.string().optional(),
  /** A live, authenticated `initialize` against the server. `needs-auth` covers
   *  both "never signed in" and "expired": from here they are one observation. */
  health: z.enum(["connected", "needs-auth", "error", "unknown"]),
  message: z.string().min(1).optional(),
});
export type McpOAuthStatus = z.infer<typeof McpOAuthStatus>;

export const McpServer = z.object({
  /** Also the server's NAME as the provider sees it, which is what makes its
   *  tools `mcp__<id>__<tool>`. Constrained to an id so a name cannot inject
   *  separators into a tool name three clients then fail to parse. */
  id: Id,
  /**
   * WHICH PROJECT THIS SERVER BELONGS TO. Absent means every project.
   *
   * THE ORIGINAL SHAPE WAS WRONG AND SAID SO CONFIDENTLY: "stored per
   * environment rather than per session — the user configures a tool once, not
   * once per conversation". The first half of that is right and the conclusion
   * does not follow. Not-per-session does not mean global: an MCP server is
   * usually a thing about a CODEBASE — the issue tracker that repo files
   * against, a database that only one service talks to — and making every one
   * of them visible to every project hands each session a pile of tools that
   * cannot help it and can mislead it. The legacy cockpit had this right; its
   * servers lived in each project's own manifest.
   *
   * BOTH SCOPES EXIST because both are real. A browser or a search tool belongs
   * to the machine; a repo's issue tracker belongs to the repo.
   *
   * THE PAIR (projectId, id) IS THE KEY, not the id alone — so a project may
   * define a server with the SAME id as a global one, and when it does the
   * project's wins. That is a feature rather than a collision: the id is the
   * provider-facing name, so overriding it is how a project points `linear` at
   * a different workspace without renaming the tools its agents already know.
   */
  projectId: Id.optional(),
  label: z.string().min(1),
  /** Off is a real state and not deletion: a server that is failing should be
   *  silenceable without losing how it was configured. */
  enabled: z.boolean(),
  spec: McpServerSpec,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;

/**
 * The servers one session actually gets: this project's, over the global ones.
 *
 * PURE, AND SHARED, so the engine's claim and the settings page that explains
 * the merge cannot disagree about which server wins. A project entry shadows a
 * global entry of the same id — see `McpServer.projectId` for why that is a
 * feature — and everything else is concatenated in a stable order: global
 * first, so a reader sees the machine-wide baseline before the overrides.
 */
/**
 * `projectId` IS OPTIONAL, and absence is meaningful rather than a missing
 * argument: a project-less session gets the environment's
 * GLOBAL servers and no project's, which is exactly what the filter below
 * already produces when nothing matches the scoped arm.
 */
export function resolveMcpServers(servers: readonly McpServer[], projectId: string | undefined): McpServer[] {
  const scoped = servers.filter((server) => server.projectId === projectId);
  const shadowed = new Set(scoped.map((server) => server.id));
  const global = servers.filter((server) => server.projectId === undefined && !shadowed.has(server.id));
  return [...global, ...scoped];
}

/**
 * ONE ENVIRONMENT VARIABLE A PROVIDER INSTANCE SETS ON ITS OWN PROCESS.
 *
 * `sensitive` DECIDES WHERE THE VALUE LIVES, not merely how it renders. A
 * sensitive value is written to a separate 0600 file and never comes back on a
 * read: the list returns `value: ""` with `valueRedacted: true`, and saving that
 * shape back keeps the stored secret rather than blanking it. Anything else and
 * a settings page that round-trips the whole instance would echo every API key
 * it was ever given to whoever opened it.
 */
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

/**
 * WHEN A CLAUDE CODE SESSION COMPACTS ITSELF — three states over the
 * environment a login already carries.
 *
 * THERE IS ONE MECHANISM, WHICH IS THE ENVIRONMENT. Claude Code's own dials are
 * these three variables, the SDK forwards them to the child, and a person could
 * always have typed them into the Environment variables list by hand. So the
 * control does not store a setting of its own beside them: it WRITES those rows
 * and READS them back. A hand-typed pair and the control are the same fact, and
 * cannot drift apart because there is nothing for them to drift between.
 *
 * WHAT THE CLI ACTUALLY DOES WITH THEM, read out of the installed binary
 * (2.1.273 — the bundle is plain JS inside the executable) rather than inferred
 * from the names. All three sit on the SDK's forwarding allowlist, which proves
 * they REACH the child and nothing about what they mean:
 *
 *   · `DISABLE_AUTO_COMPACT` is a boolean over `1`/`true`/`yes`/`on`, trimmed
 *     and case-insensitive. Anything else — including `0` and `false` — is not
 *     "off", it is INERT, and the CLI carries on as if the variable were absent.
 *   · `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is a TOKEN COUNT, not a percentage. It
 *     is raised to 100,000, capped at 1,000,000, and then clamped down to the
 *     model's own window. So it pins the denominator, DOWNWARD ONLY — which is
 *     the fact this whole conversion rests on, and the reason no model window
 *     has to be guessed to honour "compact after N tokens".
 *   · `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is a percentage on 0–100 (exclusive of
 *     0, inclusive of 100), read with `parseFloat`, so fractions are allowed and
 *     an out-of-range value is ignored. It can only LOWER the threshold:
 *     `min(floor(effective × pct / 100), effective − 13,000)`.
 *
 * where `effective = window − min(the model's max output tokens, 20,000)`. Both
 * halves move the REAL trigger and not merely the meter — and a window from the
 * environment additionally makes the CLI compact deterministically at that
 * threshold instead of possibly deferring to the API's prompt-too-long.
 *
 * AND ALL THREE WERE WATCHED DOING IT, because reading a bundle is still reading
 * rather than measuring. Against 2.1.273: `/context` reports the declared window
 * verbatim (120k, 183k, 400k on a 1M model) with a fixed 33k of reserve beside
 * it — which is 20,000 + 13,000, the two constants below, arriving from the
 * other direction. A two-turn session holding 41,843 tokens compacted on the
 * second turn under a percentage that put the threshold at 10,000, did NOT
 * compact with the same window and no percentage, and did NOT compact again once
 * `DISABLE_AUTO_COMPACT=1` was added. Three states, three observations.
 *
 * THE TWO CONSTANTS BELOW ARE THE CLI'S, and they are the one thing here that
 * can rot. If a future CLI moves its 20,000 output reservation or its 13,000
 * summary buffer, a threshold lands off by the DIFFERENCE — tens of tokens to a
 * few thousand — rather than off by a factor, because the window carries the
 * token count and the percentage only agrees with it.
 */
export const CLAUDE_COMPACTION_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
export const CLAUDE_COMPACTION_PERCENT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
export const CLAUDE_COMPACTION_DISABLE_ENV = "DISABLE_AUTO_COMPACT";

/** Every variable the control owns. A row named here is the control's to write;
 *  every other row in the list is untouched by it. */
export const CLAUDE_COMPACTION_ENV_NAMES: readonly string[] = [
  CLAUDE_COMPACTION_WINDOW_ENV,
  CLAUDE_COMPACTION_PERCENT_ENV,
  CLAUDE_COMPACTION_DISABLE_ENV,
];

/**
 * What the CLI holds back from the window for the model's own reply — capped at
 * this, so it is this for every model Claude Code runs (the smallest reports
 * 32,000 output tokens). A model reporting FEWER than 20,000 would reserve less
 * and compact that much later than asked; none exists today, and the drift would
 * be at most 20,000 tokens rather than a factor.
 */
const OUTPUT_RESERVE = 20_000;
/** What it holds back again for the summary compaction is about to write. */
const SUMMARY_BUFFER = 13_000;
/** The CLI raises a smaller declared window to this, and caps a larger one at
 *  the ceiling. Both are its own bounds, not Telar's. */
const WINDOW_FLOOR = 100_000;
const WINDOW_CEILING = 1_000_000;

/**
 * THE LARGEST THRESHOLD THAT CAN BE STATED HONESTLY.
 *
 * Above this the declared window would exceed the CLI's own 1,000,000 ceiling,
 * the CLI would cap it, and the session would compact EARLIER than the number on
 * screen. A control that accepted such a number would be lying about the only
 * thing it says, so the number is refused instead — and "compact very late" was
 * never what anyone meant by it anyway; that is what Never compact is for.
 */
export const CLAUDE_COMPACTION_MAX_TOKENS = WINDOW_CEILING - OUTPUT_RESERVE - SUMMARY_BUFFER;

export type ClaudeCompaction =
  /** Send nothing. Claude Code's own behaviour, and what every login has today. */
  | { mode: "default" }
  /** Compact once the conversation passes this many tokens. */
  | { mode: "after"; tokens: number }
  /** `DISABLE_AUTO_COMPACT`. Manual `/compact` still works — that is
   *  `DISABLE_COMPACT`, a different variable this never writes. */
  | { mode: "never" };

/** The CLI's own truthiness, so a value it ignores is one this reads as absent
 *  rather than as "off". */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Declared, then bounded the way the CLI bounds it. */
function resolvedWindow(declared: number): number {
  return Math.max(WINDOW_FLOOR, Math.min(declared, WINDOW_CEILING));
}

/**
 * The window to declare so that `tokens` is reachable inside it — and, because
 * the CLI clamps a declared window down to the model's own, ALSO the smallest
 * model context this threshold lands exactly on. Exported for the sentence that
 * says so: computing it twice is how the number on screen drifts from the number
 * in the variable.
 */
export function claudeCompactionWindowFor(tokens: number): number {
  return resolvedWindow(tokens + OUTPUT_RESERVE + SUMMARY_BUFFER);
}

/**
 * The percentage that lands the threshold on `tokens` inside that window.
 *
 * BOTH ARMS OF THE CLI'S `min` ARE MADE TO NAME THE SAME NUMBER, which is what
 * makes the pair robust rather than clever: above ~67,000 the window's own
 * `effective − 13,000` already IS the answer and the percentage merely agrees,
 * and below it — where the CLI's 100,000 window floor means the window alone
 * cannot express the number — the percentage is what carries it.
 *
 * ROUNDED UP, at six decimals. Rounding down would put the percentage arm a
 * token or two BELOW the window arm on some inputs, and `min` would then pick
 * the rounding error instead of the number that was typed.
 */
function percentFor(tokens: number): string {
  const effective = claudeCompactionWindowFor(tokens) - OUTPUT_RESERVE;
  return String(Math.ceil(((tokens / effective) * 100) * 1e6) / 1e6);
}

/** Only a plain run of digits. A hand-typed value spelled any other way is one
 *  this cannot be SURE the CLI reads the same, so it reports that it cannot
 *  summarise the login rather than printing a number it guessed. */
function digits(value: string | undefined): number | undefined {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * WHAT THIS LOGIN'S ENVIRONMENT ALREADY SAYS, which is also how a variable
 * somebody typed by hand reaches the control.
 *
 * The arithmetic below is the CLI's, re-run: given a window and a percentage,
 * this is the token count that login will actually compact at. So the control
 * reflects a hand-typed pair as the number it really produces, rather than only
 * recognising pairs it wrote itself.
 *
 * `undefined` MEANS "I CANNOT STATE THIS AS A TOKEN COUNT" and is a real answer,
 * not an error: a percentage on its own is a percentage of a window nobody
 * pinned, so the threshold depends on which model the session runs. Naming a
 * number there would be exactly the fabrication this feature exists to avoid.
 */
export function claudeCompactionOf(env: readonly ProviderInstanceEnvVar[]): ClaudeCompaction | undefined {
  const byName = new Map(env.map((variable) => [variable.name, variable.value]));
  if (TRUTHY.has((byName.get(CLAUDE_COMPACTION_DISABLE_ENV) ?? "").trim().toLowerCase())) return { mode: "never" };

  const rawWindow = byName.get(CLAUDE_COMPACTION_WINDOW_ENV);
  const rawPercent = byName.get(CLAUDE_COMPACTION_PERCENT_ENV);
  const percent = rawPercent === undefined ? undefined : Number.parseFloat(rawPercent.trim());
  const usablePercent = percent !== undefined && Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : undefined;

  const declared = digits(rawWindow);
  if (declared === undefined) {
    // A window the CLI would ignore is a window it does not have. With a live
    // percentage still in the list there is no denominator to divide by.
    if (rawWindow !== undefined || usablePercent !== undefined) return undefined;
    return { mode: "default" };
  }

  const effective = resolvedWindow(declared) - OUTPUT_RESERVE;
  const byWindow = effective - SUMMARY_BUFFER;
  const tokens = usablePercent === undefined ? byWindow : Math.min(Math.floor((effective * usablePercent) / 100), byWindow);
  return { mode: "after", tokens };
}

/**
 * The same list with this login's compaction rows replaced.
 *
 * `null` REFUSES rather than clamping: a threshold this cannot express is one
 * the person has to see refused, because silently moving their number is the
 * failure mode the whole design is arranged against.
 *
 * Every other variable keeps its place and its order. Default removes the rows
 * entirely — an empty string is a value the CLI reads, and `DISABLE_AUTO_COMPACT=""`
 * would leave a variable on the process that says nothing.
 */
export function applyClaudeCompaction(
  env: readonly ProviderInstanceEnvVar[],
  next: ClaudeCompaction,
): ProviderInstanceEnvVar[] | null {
  if (next.mode === "after" && !(Number.isSafeInteger(next.tokens) && next.tokens > 0 && next.tokens <= CLAUDE_COMPACTION_MAX_TOKENS)) {
    return null;
  }
  const kept = env.filter((variable) => !CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name));
  if (next.mode === "default") return kept;
  if (next.mode === "never") return [...kept, { name: CLAUDE_COMPACTION_DISABLE_ENV, value: "1", sensitive: false }];
  return [
    ...kept,
    { name: CLAUDE_COMPACTION_WINDOW_ENV, value: String(claudeCompactionWindowFor(next.tokens)), sensitive: false },
    { name: CLAUDE_COMPACTION_PERCENT_ENV, value: percentFor(next.tokens), sensitive: false },
  ];
}

/**
 * A CONFIGURED PROVIDER — which is to say, an account.
 *
 * THE SPLIT THIS COMPLETES. `ProviderDriverKind` says which implementation runs
 * a turn; `ProviderInstanceId` says which configured thing it runs as. The
 * contract has routed by instance id since v2 precisely so one Telar can hold
 * two Claude logins, but until now the engine minted `<driver>:default` at
 * session creation and there was nothing behind the id. This is the registry
 * that comment promised.
 *
 * THE DEFAULT INSTANCE'S ID IS THE DRIVER KIND ITSELF — `claude`, `codex` —
 * which is t3 code's `defaultInstanceIdForDriver`. It keeps the built-in slot
 * addressable without a reserved separator, and it means an instance id is a
 * plain slug that survives a URL path segment. Sessions created before this
 * carry `claude:default`; resolution falls back to the driver's default
 * instance for any id the registry does not know, which is also what happens
 * when a custom instance is deleted out from under a session.
 *
 * WHAT IS NOT HERE: a `config` blob. t3 code keeps driver-specific settings
 * opaque (`Schema.Unknown`) so a driver package can own its schema. Telar has
 * two drivers in one repo and exactly one field that changes which login runs,
 * so `configDir` is typed rather than smuggled through an untyped bag.
 */
export const ProviderInstance = z.object({
  /** The routing key. A slug, because it is also a URL path segment and a
   *  settings-page anchor. */
  id: Id,
  driver: ProviderDriverKind,
  /** Optional label shown in the pickers. The id never changes; this does. */
  displayName: z.string().min(1).optional(),
  /** `#rrggbb`, used to tell two logins of the same provider apart. */
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** When the composer says the context is heavy, as a whole percentage of the
   *  model's window. Absent means the default (70). A share rather than a token
   *  count, so it stays right across windows of different sizes. */
  contextNoticePercent: z.number().int().min(1).max(100).optional(),
  /** Off is a state, not deletion — same rule as an MCP server. */
  enabled: z.boolean(),
  /**
   * The folder this instance is signed in with — `CLAUDE_CONFIG_DIR` or
   * `CODEX_HOME`. ABSENT MEANS THE BASE LOGIN, and for Claude that is
   * load-bearing rather than a default: pointing `CLAUDE_CONFIG_DIR` at
   * `~/.claude` hashes to a different, empty Keychain entry and 401s, so the
   * base login is the one that must leave the variable unset.
   */
  configDir: z.string().min(1).optional(),
  /**
   * WHICH BINARY THIS LOGIN RUNS. Absent means the driver's own name, resolved
   * the way a terminal would resolve it.
   *
   * TWO SHAPES, ONE FIELD, which is T3 Code's rule and the reason it is usable:
   * a value with a path separator in it is THAT FILE and nothing else, and a
   * bare name (`claude`, `claude-beta`) is a name to look up on PATH. So
   * "whichever one my shell finds" and "this exact build" are both expressible,
   * and the common case needs no absolute path that would break on another
   * machine.
   *
   * It beats `CLAUDE_CODE_EXECUTABLE` / `CODEX_BIN` when both are set: the
   * per-login declaration is the more specific one, the same way an instance's
   * declared environment variable beats an inherited one.
   */
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

/**
 * WHETHER A CONFIGURED INSTANCE CAN ACTUALLY RUN, as far as the engine can tell.
 *
 * EVERY FIELD IS MEASURED AND NONE IS GUESSED, which is the whole reason this
 * is a separate shape from the instance itself. `installed` and `version` come
 * from `<bin> --version` and nothing else — an auth subcommand's prose is not a
 * contract, and scraping sign-in state out of it turns a phrasing change into a
 * confident wrong answer.
 *
 * `signIn` IS A FILESYSTEM FACT, NOT A CREDENTIAL READ. Telar never opens an
 * auth file or a Keychain entry; it checks whether the config folder exists and
 * whether the provider's login artefact is IN it. That bounds what the answer
 * can be: on macOS Claude keeps its token in the Keychain, so a Claude instance
 * with a config dir and no file credentials is `unknown`, never `signed-out`.
 * Only Codex — whose credentials really are a file — may report `signed-out`.
 *
 * See apps/engine/src/provider-probe.ts for the measurement.
 */
export const ProviderSignIn = z.enum(["signed-in", "signed-out", "missing-config-dir", "unknown"]);
export type ProviderSignIn = z.infer<typeof ProviderSignIn>;

/**
 * WHETHER A NEWER CLI EXISTS, AND WHAT WOULD INSTALL IT.
 *
 * A FACT ABOUT THE BINARY, NOT ABOUT THIS LOGIN. Every instance of a driver
 * runs the same executable, so this is identical across them and updating from
 * one row updates all of them — the same way `version` already behaves.
 *
 * `pinned` IS THE STATE WORTH READING TWICE. It means a newer version is
 * published AND the installed one is exactly what this build of Telar pairs
 * with. There is deliberately no `command` on it: the wrapper and the CLI speak
 * a control protocol to each other, an install sitting on the tested pairing is
 * the best state Telar can verify, and a one-click button that moved it off
 * would be Telar breaking its own pairing on its own advice. The newer version
 * is reported so the choice stays with the person; the command is not.
 *
 * See apps/engine/src/cli-updates.ts for the measurement, and for why a
 * Homebrew install is compared against Homebrew rather than npm.
 */
export const ProviderUpdate = z.object({
  status: z.enum(["current", "behind", "pinned", "unknown"]),
  /** The newest published version, when a registry answered. Absent means the
   *  check failed, was switched off, or there was no installed version to
   *  compare — never "there is nothing newer". */
  latest: z.string().min(1).optional(),
  /** How it was installed, when the path said so. Absent is a real answer: a
   *  binary somewhere unrecognised is one Telar must not guess an installer
   *  for. */
  method: z.enum(["native", "homebrew", "npm", "bun", "pnpm", "vite-plus", "unknown"]).optional(),
  /** The exact command that updates it — shown, copied, and what the engine
   *  runs. Present only on `behind`. */
  command: z.string().min(1).optional(),
});
export type ProviderUpdate = z.infer<typeof ProviderUpdate>;

/**
 * WHAT HAPPENED WHEN TELAR RAN THE UPDATE.
 *
 * THE COMMAND COMES BACK IN THE ANSWER, not just in the request, because the
 * caller never sent one — the engine derived it from the install it found. A
 * report that said "it failed" without naming what ran would leave the reader
 * unable to try it themselves, which is the first thing anybody does next.
 *
 * `output` IS THE INSTALLER'S OWN WORDS, capped and otherwise unedited. A
 * paraphrase of a package manager's error is a second thing to keep true.
 */
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

/**
 * ONE MODEL A PROVIDER SAYS IT HAS.
 *
 * ASKED FOR, NOT HAND-MAINTAINED. The cockpit shipped a static list of model
 * ids and it was wrong within a week: it offered Codex a `gpt-5.5-codex` that
 * does not exist and defaulted to `gpt-5.5` when the installed harness defaults
 * to something else entirely. A list a human types is a list that goes stale,
 * and the failure mode is a 404 at the provider rather than a visible gap.
 *
 * `isDefault` AND `hidden` COME FROM THE PROVIDER because only the provider
 * knows. The cockpit's own idea of "which of these is old" is a separate,
 * derived thing (see the version split in the client) — this field is the
 * provider saying "do not show this at all".
 *
 * `efforts` IS PER MODEL, which the previous per-provider guess could not
 * express: Codex reports six levels for its newest model and four for an older
 * one, and offering a level a model does not have fails the turn.
 */
export const ProviderModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean(),
  hidden: z.boolean(),
  efforts: z.array(Effort),
  defaultEffort: Effort.optional(),
  /**
   * The canonical id an ALIAS resolves to right now — `sonnet` → `claude-sonnet-5`.
   *
   * Claude Code's list is mostly aliases, and the alias is what a session should
   * store: it keeps meaning the current model as the provider moves it, which a
   * pinned wire id does not. This field is what the alias means TODAY, so a
   * surface can say which model you are actually about to run and a stored wire
   * id can be matched back to the row that covers it.
   */
  resolves: z.string().min(1).optional(),
  /**
   * THIS ROW IS THE MODEL'S DEFAULT WINDOW — a fact to read, never a choice
   * made for you. Set on the `[1m]` row of a family whose provider ships it 1M
   * by default (Fable 5.1, per Claude Code's own changelog), from the model
   * manifest; the picker marks the row `Default` and still sends whichever
   * row you pick. Absent means nobody said, which is what every row was
   * before the manifest existed.
   */
  defaultWindow: z.boolean().optional(),
  /**
   * The manifest says this generation is history; the picker folds it, a
   * session on it still runs. Stated per model by the model manifest (Claude
   * today), so the picker need not guess a generation from the id.
   *
   * NOT `hidden` (the provider withdrew the row) and NOT `hiddenByUser` (a
   * reader curated it away): a legacy row is still offered, one fold down.
   */
  legacy: z.boolean().default(false),
  /** A short mark the manifest puts beside a row — `new` on a model that just
   *  shipped. Display only. */
  badge: z.enum(["new"]).optional(),
  /**
   * Whether THIS model offers fast mode. Per model, not per provider: of the six
   * rows the installed Claude Code reports, two support it. A toggle offered on
   * a model that does not is a control that silently does nothing.
   */
  fastMode: z.boolean(),
  /**
   * THE PERSON WHO CONFIGURED THIS ENGINE SAID "not this one" — which is a
   * different sentence from `hidden` above, and the two must not share a field.
   *
   * `hidden` is the PROVIDER withdrawing a row; this is a reader curating a menu
   * the provider is still publishing. Conflating them would un-hide somebody's
   * choice the moment the provider republished, and would file a curated-away
   * model under "Legacy models" — where `splitGenerations` puts provider-hidden
   * rows — instead of nowhere.
   *
   * THE ROW STILL COMES BACK, marked rather than dropped. The Models tab has to
   * show it to offer un-hiding it, and a session already running this model must
   * still resolve its efforts and its context window.
   */
  hiddenByUser: z.boolean().default(false),
  /**
   * WHO SAID THIS MODEL EXISTS. `provider` is every row the harness answered
   * with; `user` is an id somebody typed into the Models tab because the
   * installed harness does not publish it yet — a real state, and the one this
   * overlay exists for: a model can ship, a login can be entitled to it, and the
   * CLI can still not list it.
   *
   * IT IS NOT `ModelCatalogueSource`. That answers "was this catalogue asked for
   * or guessed" for a whole list; this answers "did a person type this id" for
   * one row, and a list can honestly be both at once.
   *
   * The distinction is load-bearing downstream: a user row carries no published
   * `efforts`, so the surfaces must not strip a level the way they may for a
   * provider row.
   */
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
  /**
   * WHICH LOGIN'S VIEW THIS IS.
   *
   * The provider answer behind it is still keyed by driver (see
   * apps/engine/src/models.ts, which asks the default CLI in the daemon's own
   * cwd) — the OVERLAY is what makes this per-instance, and naming the instance
   * here is what stops a client caching one login's curated list under
   * another's key. When the provider read itself becomes per-instance, this
   * field stops being only about the overlay and nothing else has to change.
   *
   * Optional so a catalogue stored or replayed from before this still parses.
   */
  instanceId: ProviderInstanceId.optional(),
  /** The CLI's own `--version` at read time, when it answered — what the
   *  model manifest's `minVersion` is checked against. Cached with the list
   *  it describes. */
  cliVersion: z.string().min(1).optional(),
});
export type ModelCatalogue = z.infer<typeof ModelCatalogue>;

/**
 * WHAT ONE PERSON DID TO ONE LOGIN'S MODEL LIST.
 *
 * FOUR FACTS, ONE DOCUMENT, KEYED BY THE PROVIDER'S OWN ROW ID — `sonnet`,
 * `opus[1m]`, `gpt-5.6-sol`. Not by the family key the composer's picker lists
 * (apps/web/lib/model-families.ts): a family is a way of READING a catalogue and
 * its key moves when the provider re-points an alias, whereas a row id is the
 * string that goes on the wire. Hiding `sonnet[1m]` while keeping `sonnet` is a
 * thing somebody may reasonably want, and a family-keyed hide could not express
 * it. The family view is DERIVED from the rows.
 *
 * KEYED BY INSTANCE AND NOT BY DRIVER, even though the provider answer behind it
 * is driver-keyed today. Two logins of one provider can hold different
 * entitlements, so this becomes a per-instance fact the moment the catalogue
 * read stops using the daemon's own cwd — and retrofitting a key space is
 * exactly the scar `ProviderInstanceId` above already refuses once.
 *
 * `custom` IS NOT A PREFERENCE. The other three decide what a menu SHOWS; a
 * custom id decides what can RUN, and it is the only way to reach a model the
 * installed CLI has not started publishing. That is why this whole document
 * lives on the engine rather than in a browser: an id somebody added has to be
 * runnable from a paired phone and from a session an agent started, and a
 * per-browser copy would be a model that exists in one tab.
 */
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
  /**
   * The reader's own order, as row ids. A PARTIAL ORDER AND DELIBERATELY SO: ids
   * named here lead, in this sequence; everything else follows in the provider's
   * own order. A total order would have to be rewritten every time the provider
   * ships a model, and until somebody rewrote it the new model would sort last —
   * which is the opposite of what a new model wants.
   */
  order: z.array(z.string().min(1)).default([]),
  custom: z.array(CustomProviderModel).default([]),
  /**
   * The row this login runs when a session names no model, chosen by the
   * reader. Absent means Telar's own pick (the manifest's `defaults.chat`, else
   * the provider's). A row the catalogue no longer carries is ignored rather
   * than invented, so a withdrawn model falls back instead of failing a turn.
   */
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
