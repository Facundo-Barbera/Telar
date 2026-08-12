/**
 * vNext engine protocol v2 — shared primitives.
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
 *   - `apps/vnext-web/lib/vnext/journal.ts` — `typeof event.data.text ===
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
 * `apps/vnext-web`, which we control, and the dogfood home holds throwaway
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
  })
  .refine((value) => value.model !== undefined || value.effort !== undefined, {
    message: "a model selection must name a model, an effort, or both",
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
export const McpServerSpec = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Overlaid on the worker's own environment, never replacing it: an MCP
     *  server still needs PATH and HOME like any other process. */
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ transport: z.literal("http"), url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }),
  z.object({ transport: z.literal("sse"), url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const McpServer = z.object({
  /** Also the server's NAME as the provider sees it, which is what makes its
   *  tools `mcp__<id>__<tool>`. Constrained to an id so a name cannot inject
   *  separators into a tool name three clients then fail to parse. */
  id: Id,
  label: z.string().min(1),
  /** Off is a real state and not deletion: a server that is failing should be
   *  silenceable without losing how it was configured. */
  enabled: z.boolean(),
  spec: McpServerSpec,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;
