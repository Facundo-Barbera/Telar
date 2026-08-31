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
 * House style is `packages/core/src/schemas.ts`: `z.enum`, `z.number().int()`,
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

/** WHAT runs a session: the agent CLI/SDK behind it. Mirrors core's
 *  `ProviderId` vocabulary so the two never disagree about the word "claude". */
export const ProviderDriverKind = z.enum(["claude", "codex"]);
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;

/**
 * WHICH configured provider runs it — an account, its credentials, and its
 * bindings. This is the ROUTING KEY; `driver` is descriptive.
 *
 * ADOPTED UP FRONT RATHER THAN RETROFITTED. t3 code shipped driver-only routing
 * first and its contract still carries the scar: `provider` is marked "optional
 * during the driver/instance migration… once every producer populates it,
 * routing flips to instance-id-only and the legacy field is removed". Doing it
 * in that order means a migration across every event and every persisted model
 * selection. Telar's account registry (`packages/core/src/accounts.ts`) is the
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
 * Tokens for one unit of work.
 *
 * THE FOUR-WAY SPLIT IS NOT ARBITRARY — it is the same pair-plus-cache shape
 * `UltraTokens` (`packages/core/src/ultra/surface.ts`) and core's `UsageEntry`
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
 * Folded from the engine's own journals: every settled turn already carries
 * its final `UsageSnapshot`, so the report needs no second recording path and
 * no provider-transcript scanning (t3 code scans `~/.claude` et al. because
 * its threads run outside its own store; Telar's don't). The cost figure is
 * only ever the provider's own — Claude reports one per turn, Codex reports
 * none, and a bucket that had to guess would be a second price. `priced:
 * false` with a zero cost is "the provider does not say", not "free".
 */
export const UsageResolution = z.enum(["day", "hour"]);
export type UsageResolution = z.infer<typeof UsageResolution>;

export const UsageBucket = z.object({
  /** `YYYY-MM-DD` in the requested zone for days; the hour-start epoch ms as
   *  a decimal string for hours — a shape a client can sort lexically or
   *  parse, without this contract committing to a locale. */
  period: z.string().min(1),
  driver: ProviderDriverKind,
  /** The model the turn ran on, as selected; `default` when the turn rode the
   *  provider's own default and never said which. */
  model: z.string().min(1),
  tokens: TokenUsage,
  costUsd: z.number().nonnegative(),
  /** Whether `costUsd` is provider-reported for every turn in this bucket. */
  priced: z.boolean(),
  turns: z.number().int().nonnegative(),
});
export type UsageBucket = z.infer<typeof UsageBucket>;

export const UsageReport = z.object({
  sinceMs: Timestamp,
  untilMs: Timestamp,
  resolution: UsageResolution,
  timeZone: z.string().min(1),
  buckets: z.array(UsageBucket),
  /** Distinct sessions that spent anything in the window. */
  sessions: z.number().int().nonnegative(),
  readAt: Timestamp,
});
export type UsageReport = z.infer<typeof UsageReport>;

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

export const BrowserTab = z.object({
  id: Id,
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  loading: z.boolean().optional(),
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
 * argument: a project-less session (the Spool's master) gets the environment's
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
   * Whether THIS model offers fast mode. Per model, not per provider: of the six
   * rows the installed Claude Code reports, two support it. A toggle offered on
   * a model that does not is a control that silently does nothing.
   */
  fastMode: z.boolean(),
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
});
export type ModelCatalogue = z.infer<typeof ModelCatalogue>;
