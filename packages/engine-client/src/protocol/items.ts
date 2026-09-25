/**
 * engine protocol v2 — timeline items.
 *
 * THIS FILE IS THE POINT OF v2. Protocol v1's driver read `text_delta` and
 * assistant text blocks and dropped `tool_use`, `tool_result` and `thinking` on
 * the floor (`apps/engine/src/driver.ts`), so a session rendered as a wall of
 * prose with no tool timeline, no reasoning, and nothing to approve. Every
 * surface the frozen cockpit has and `apps/web` does not was downstream
 * of that one omission.
 *
 * An ITEM is one row in a turn's timeline. Items have a lifecycle
 * (`item.started` → `item.updated`* → `item.completed`) and streaming text
 * arrives against them as `content.delta` rather than being buffered — a tool's
 * output should appear as it is produced, not when it finishes.
 *
 * The canonical set is adapted from t3 code's `CanonicalItemType`, which is the
 * hard-won part of its contract: it is provider-agnostic, so a Claude
 * `tool_use` for Bash and a Codex `exec_command` land on the SAME row type and
 * the UI needs one renderer rather than one per provider.
 */
import { z } from "zod";
import { Id, ProviderRefs, RateLimitType, Timestamp, TurnAttachment } from "./common";
import { NotificationDetail, WakeReason } from "./entities";

/**
 * The subset of item types that represent a tool doing something. These are the
 * rows a client renders as expandable tool cards, and the ones an approval can
 * be attached to.
 *
 * SPLIT OUT AS ITS OWN LIST because three separate things need to ask "is this
 * a tool?" — the renderer, the approval router, and the usage roll-up — and
 * three copies of that predicate is how they drift.
 */
export const ToolItemType = z.enum([
  /** A shell command. Claude's Bash, Codex's exec_command. */
  "command_execution",
  /** A file written, edited or patched. */
  "file_change",
  /** A file read. Separate from file_change because reading is approvable on
   *  its own in read-restricted postures, and because it is far more common. */
  "file_read",
  /** A tool from a configured MCP server. */
  "mcp_tool_call",
  /** A provider built-in that is not one of the above (WebFetch, Glob, …). */
  "dynamic_tool_call",
  "web_search",
  /** The engine's browser acting on a page. See ./events.ts `browser.*`. */
  "browser_action",
]);
export type ToolItemType = z.infer<typeof ToolItemType>;

export const ItemType = z.enum([
  "user_message",
  /**
   * SOMETHING REACHED THIS SESSION THAT NOBODY TYPED — a peer's message, a wake
   * from a session it subscribed to, a request one of them parked. Its own type
   * rather than a flag on `user_message` precisely so that no renderer and no
   * driver can treat it as the person speaking by forgetting to check a field.
   * See `NotificationDetail`.
   */
  "notification",
  "assistant_message",
  /** Extended thinking. Carried as its own item type rather than folded into
   *  assistant_message so a client can collapse it independently — which is the
   *  only way a long reasoning block is readable. */
  "reasoning",
  /** The agent's todo/plan list. Updated in place across a turn. */
  "plan",
  ...ToolItemType.options,
  /** A sub-agent or background job. The row is a handle; the detail is on the
   *  task events in ./tasks.ts. */
  "task",
  /** The provider compacted its own context mid-turn. Worth a visible row: it
   *  explains why the agent appears to forget something. */
  "context_compaction",
  "error",
  /** Forward compatibility. A client MUST render an unknown item rather than
   *  dropping it — a silently missing row is worse than an ugly one. */
  "unknown",
]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum([
  "inProgress",
  "completed",
  "failed",
  /** A human said no. Distinct from `failed`: nothing went wrong. */
  "declined",
]);
export type ItemStatus = z.infer<typeof ItemStatus>;

/**
 * Which stream a `content.delta` belongs to. Deltas name their stream rather
 * than assuming the item has only one, so an item that later streams two can
 * be read without a migration.
 *
 * ONLY THE FIRST TWO ARE EVER EMITTED — see the sets `apps/engine/test/
 * execution-store.test.ts` asserts this against, and #686 for the measurement.
 * The other three are room the contract keeps, not behaviour it has, and the
 * difference matters to journal compaction: `compactJournal` drops a delta only
 * where the item's own `item.completed` proves it holds that text, and only
 * `assistant_message` and `reasoning` keep the streamed text on the settled
 * row. Whoever first emits on a third stream is deciding, at that moment, that
 * those deltas are HISTORY rather than redundancy — the only durable copy of
 * what was streamed — and compaction must go on keeping them.
 */
export const ContentStream = z.enum([
  "assistant_text",
  "reasoning_text",
  /** Not emitted by any driver in this repository. See the note above. */
  "command_output",
  /** Not emitted by any driver in this repository. See the note above. */
  "tool_output",
  /** Not emitted by any driver in this repository. See the note above. */
  "unknown",
]);
export type ContentStream = z.infer<typeof ContentStream>;

/** A shell command and what it produced. `exitCode` absent while running. */
export const CommandExecutionDetail = z.object({
  command: z.string(),
  cwd: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  /**
   * THE FIRST 4,000 CHARACTERS AND AN ELLIPSIS, AND NOWHERE IS THERE MORE.
   *
   * This said the full text streamed as `command_output` deltas. It does not:
   * nothing emits that stream (see `ContentStream`), so past 4,000 characters
   * the output is not in the journal, not on this row, and not recoverable —
   * it was only ever sent to the model. A client showing this is showing a
   * preview, and so is everything else.
   *
   * NOT A VALID COMPARISON TARGET FOR JOURNAL COMPACTION. `compactJournal`
   * drops deltas by proving the settled row is at least as long as what was
   * streamed; a field capped at 4,000 would pass that test exactly when the
   * output was too short to be worth compacting, and fail wherever it was
   * long — with the failure looking like a check that works.
   */
  outputPreview: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CommandExecutionDetail = z.infer<typeof CommandExecutionDetail>;

export const FileChangeKind = z.enum(["create", "edit", "delete", "rename"]);
export type FileChangeKind = z.infer<typeof FileChangeKind>;

/**
 * One file touched. The diff is carried as a unified diff string rather than a
 * structured hunk list: every renderer and every review tool already speaks it,
 * and a bespoke structure would have to be converted back at each of them.
 */
export const FileChangeDetail = z.object({
  path: z.string().min(1),
  kind: FileChangeKind,
  renamedFrom: z.string().min(1).optional(),
  unifiedDiff: z.string().optional(),
  /**
   * `unifiedDiff` IS A PREFIX OF THE PATCH, NOT THE PATCH — issue #694, §2.5.
   *
   * The diff a row may carry is bounded (`MAX_DIFF_CHARS`), because `items.json`
   * holds every item of every turn and is rewritten whole. That bound used to
   * announce itself INSIDE the string — `… diff truncated at 12000 characters
   * …` on a line of its own — on the argument that "a silently clipped patch
   * looks like a complete one and would be applied as such".
   *
   * True of a renderer that printed every line. False since the renderer became
   * a parser: the marker is not a diff line, so it is dropped as unreadable and
   * the reader is shown a complete-looking patch. A fact about the READ cannot
   * live in the CONTENT of the answer — the same reason `GitFilePatch` carries
   * `incomplete` rather than an empty string.
   *
   * ABSENT means the diff is whole. Never `false` for an untruncated one, so an
   * older engine's silence reads as "nobody said" rather than "it is complete".
   */
  diffTruncated: z.boolean().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
});
export type FileChangeDetail = z.infer<typeof FileChangeDetail>;

export const FileReadDetail = z.object({
  path: z.string().min(1),
  /** Present when the agent read a slice rather than the whole file. */
  fromLine: z.number().int().positive().optional(),
  toLine: z.number().int().positive().optional(),
});
export type FileReadDetail = z.infer<typeof FileReadDetail>;

/**
 * Any tool call that is not a command or a file operation.
 *
 * `input`/`output` ARE UNKNOWN AND THAT IS DELIBERATE — MCP tool schemas are
 * defined by the servers a user configures, so this contract cannot know their
 * shape and must not pretend to. Clients render them generically.
 */
export const ToolCallDetail = z.object({
  /** Fully-qualified where the provider qualifies it, e.g. `mcp__linear__search`. */
  name: z.string().min(1),
  server: z.string().min(1).optional(),
  input: z.unknown().optional(),
  /**
   * The same 4,000-character cap as `CommandExecutionDetail.outputPreview`,
   * and for the same reason NOT A VALID COMPARISON TARGET FOR JOURNAL
   * COMPACTION: `tool_output` is emitted by nothing, so past the cap the text
   * is not in the journal either. `unknown` because the value's shape is the
   * server's, not this contract's — the cap is applied to the string form.
   */
  output: z.unknown().optional(),
  /** Provider-side call id, for matching a result back to its call. */
  toolUseId: z.string().min(1).optional(),
});
export type ToolCallDetail = z.infer<typeof ToolCallDetail>;

export const PlanStepStatus = z.enum(["pending", "inProgress", "completed"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanDetail = z.object({
  steps: z.array(z.object({ step: z.string().min(1), status: PlanStepStatus })),
});
export type PlanDetail = z.infer<typeof PlanDetail>;

/**
 * THE PROVIDER MADE THE TURN WAIT, AND SAID WHY.
 *
 * The Claude SDK emits `api_retry` when a request failed retryably and will be
 * retried after a delay, and `rate_limit_event` when the account's limit state
 * changes. Telar handled neither, so a turn that spent four minutes inside the
 * provider's own backoff was indistinguishable from a turn that spent four
 * minutes thinking — which is precisely the ambiguity the #201 audit could not
 * resolve from the journal.
 *
 * SCALARS AND ENUMS ONLY, deliberately. The retry message carries the failing
 * request's error object and the limit event carries account state; none of
 * that belongs in a durable journal, and a row that says "waiting 30s for a
 * five-hour limit that resets at T" already answers the question a person
 * staring at a silent session is asking. No prompt, no header, no error text.
 *
 * A row is opened when the wait starts and closed when the stream speaks
 * again, so the pause has a visible beginning and end rather than a marker
 * floating in silence.
 */
export const ProviderWaitDetail = z.object({
  /**
   * `no_response` is the wait NOBODY REPORTS — the engine's own reading, not the
   * provider's. A request that stalls before its response headers emits no frame
   * on the SDK iterator and no line on the CLI's stderr for the whole stall
   * (measured: 60 s of silence), so the cockpit shows a quiet turn while the
   * model is unreachable. The engine knows anyway, because it sees `requesting`
   * go out and `message_start` not come back — see the silence watch in
   * `apps/engine/src/driver.ts`.
   */
  kind: z.enum(["api_retry", "rate_limit", "no_response"]),
  /** `api_retry`: which attempt is about to be made, and out of how many. */
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
  /** How long the provider said it would wait before trying again. */
  delayMs: z.number().int().nonnegative().optional(),
  /** HTTP status of the failed request. Absent for a connection error that
   *  never got a response, which the SDK reports as a null status. */
  status: z.number().int().optional(),
  /**
   * HOW LONG THE FAILED ATTEMPT ALREADY STOOD STILL, for the one retry cause
   * where that is the whole story.
   *
   * `delayMs` is the backoff AHEAD — typically a second or two — and on its own
   * it describes a retry as cheap. When the CLI gives up on a request that never
   * sent response headers, the expensive part is already behind it: the attempt
   * sat on an open socket for this long with nothing on the wire. A row reading
   * "retrying in 1s after a connection error" is true and useless about a turn
   * that has just lost two minutes; this is the number that explains it.
   *
   * Present only for that cause (the SDK's `no_response` block), so absent means
   * the request failed with an answer rather than with silence.
   */
  waitedMs: z.number().int().nonnegative().optional(),
  /** `rate_limit`: the account's state. `allowed` is not surfaced — a routine
   *  "still fine" event is not a wait and would be noise on the timeline. */
  limitStatus: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  /**
   * WHICH LIMIT, from a CLOSED set with a generic fallback — see `RateLimitType`
   * in `common.ts`, which a `rate_limited` turn failure now reads from too. A
   * durable row is not the place to forward an arbitrary remote string: a
   * journal a person reads is exactly where an attacker-shaped label would want
   * to land.
   */
  limitType: RateLimitType.optional(),
  /** Unix seconds at which the limit resets, when the provider says. */
  resetsAt: z.number().int().nonnegative().optional(),
  /** Fraction of the window consumed, when the provider says. Finite, because
   *  `z.number()` alone admits Infinity and a meter cannot render one. */
  utilization: z.number().nonnegative().finite().optional(),
});
export type ProviderWaitDetail = z.infer<typeof ProviderWaitDetail>;

export const ErrorDetail = z.object({
  message: z.string(),
  /** Provider-supplied classification when there is one. */
  kind: z.string().min(1).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

/**
 * WHERE AN ADOPTED CONVERSATION CAME FROM — `/resume` (#616), and the only
 * record there will ever be of it.
 *
 * THE PROVIDER STAMPS NOTHING. Measured on a real fork: the forked transcript
 * mentions the source id zero times, and the two files' key sets are identical.
 * So "a person opening this session in six weeks can tell what it was" is not
 * something that can be recovered later from the store on disk — it exists only
 * if Telar writes it at the moment of the adoption, which is this.
 *
 * IT IS A ROW, NOT A FIELD ON THE SESSION, and that is the point of it being
 * here. A field would be a debug value one surface reads; a row is in the
 * journal, so `sessions_read` returns it among the events, the turn fold names
 * it, and the cockpit draws it at the head of the history it explains — three
 * readers, one fact, nothing to keep in step.
 *
 * TWO CUTS, BOTH REPORTED, because they are different questions and a single
 * number would answer neither honestly:
 *   - `records` / `cut` — what the FORK carries, which is what the model can
 *     still remember.
 *   - `rows` / `rowCut` — what the COCKPIT shows, which is what the person can
 *     still scroll.
 * They coincide when the fork was whole and the transcript fitted the row
 * budget, and they diverge exactly when somebody needs to be told they have.
 */
export const ConversationImportDetail = z.object({
  /** Claude only in this pass (#616 scope). Named rather than assumed, so a
   *  second provider's import cannot quietly read as this one's. */
  provider: z.literal("claude"),
  /** The conversation that was adopted — the id in the person's OWN store. */
  sourceSessionId: z.string().min(1),
  /** The fork Telar made and now resumes. Never the source: Telar does not
   *  write into somebody's own Claude Code history. */
  sessionId: z.string().min(1),
  /** The source's working directory, when its records carried one. What makes
   *  "which conversation was that" answerable a month later. */
  sourceCwd: z.string().optional(),
  /** The conversation's own opening prompt, clipped. The CLI's titles do not
   *  distinguish conversations — six identically-titled ones were produced
   *  deliberately and the CLI itself refused to tell them apart — so this is
   *  the field that identifies WHICH conversation this was. */
  firstPrompt: z.string().max(500).optional(),
  /** Records carried into the fork. */
  records: z.number().int().nonnegative(),
  /** Where the fork was cut. `whole` is the whole conversation. */
  cut: z.enum(["whole", "since_compact_boundary"]),
  /** Journal rows this import wrote. */
  rows: z.number().int().nonnegative(),
  /** Why the READ stopped where it did — Claude's own compaction boundary, a
   *  row budget, or not at all. */
  rowCut: z.enum(["whole", "compact_boundary", "row_budget"]),
  /** Size of the source transcript at the moment it was adopted. Half of the
   *  evidence that adopting it did not change it. */
  sourceBytes: z.number().int().nonnegative().optional(),
});
export type ConversationImportDetail = z.infer<typeof ConversationImportDetail>;

/**
 * The per-type payload of an item.
 *
 * A DISCRIMINATED UNION ON `type`, not an optional grab-bag, so that narrowing
 * on the type in a renderer gives you exactly the fields that type has. v1's
 * `data: Record<string, unknown>` is the thing this replaces, and it is why
 * `apps/web/lib/engine/journal.ts` had to hand-check `typeof
 * event.data.text === "string"` at the point of use.
 */
export const ItemDetail = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    text: z.string(),
    /** The files sent with a mid-turn message, so the transcript can show
     *  them the way it shows a queued turn's. Absent on every row written
     *  before the steer channel carried attachments. */
    attachments: z.array(TurnAttachment).optional(),
    /** Present when an AGENT sent this mid-turn message (`sessions_send`).
     *  The row is drawn as a peer's, never as the person's bubble. */
    sender: z.object({ sessionId: z.string().min(1).optional() }).optional(),
    /**
     * The engine's short announcement of that message — sender, run, size and
     * opening line. `text` is still the body: this is the COLLAPSED label, and
     * expanding the row shows what the peer actually sent. It is also what the
     * provider was handed, so the row and the model agree about what the turn
     * was told. See `Turn.agentNotice`.
     */
    notice: z.string().optional(),
    /**
     * Present when the ENGINE ITSELF wrote this mid-turn message: a wake, from
     * a session this one subscribed to. Nobody typed it and no agent sent it,
     * so it is neither the person's bubble nor a peer's report — it is the
     * same happening a queued wake turn announces, and the transcript draws it
     * as the same wake row.
     *
     * STRUCTURAL, NOT TEXTUAL. The wake text begins `[wake: …]`, but that is
     * for the model to read, not for a renderer to classify on: a person is
     * free to type those characters, and a wake whose wording changes must not
     * silently become a human bubble. Exactly one of `sender`/`wakeReason` is
     * ever present.
     */
    wakeReason: WakeReason.optional(),
  }),
  /**
   * A PEER'S MESSAGE, A WAKE, OR A PARKED REQUEST — announced, not ventriloquised.
   *
   * THE WHOLE POINT IS THE TYPE. A `user_message` carrying `sender` or
   * `wakeReason` said the same facts, but it said them in fields a renderer or a
   * driver had to REMEMBER to look at — and the one that forgot drew engine prose
   * as the person's bubble and handed it to the model as the person's
   * instruction. A distinct arm cannot be forgotten: narrowing on the type is
   * what gives you the payload at all.
   */
  z.object({ type: z.literal("notification"), notification: NotificationDetail }),
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  z.object({
    type: z.literal("reasoning"),
    text: z.string(),
    /**
     * THE PROVIDER'S RUNNING ESTIMATE of how long the thought is, in tokens.
     * Claude Code omits the thinking text itself in Telar mode and reports only
     * this, so without it a six-minute thought is an empty row. Absent means
     * nobody said, not zero.
     */
    estimatedTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("plan"), plan: PlanDetail }),
  z.object({ type: z.literal("command_execution"), command: CommandExecutionDetail }),
  z.object({ type: z.literal("file_change"), change: FileChangeDetail }),
  z.object({ type: z.literal("file_read"), read: FileReadDetail }),
  z.object({ type: z.literal("mcp_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("dynamic_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("web_search"), query: z.string(), resultCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("browser_action"), call: ToolCallDetail, url: z.string().optional() }),
  z.object({ type: z.literal("task"), taskId: Id }),
  z.object({
    type: z.literal("context_compaction"),
    /** What triggered it, when the provider says — Claude reports "auto" or
     *  "manual" on its compact boundary. */
    reason: z.string().optional(),
    /** Window occupancy either side of the squeeze, when reported. The pair is
     *  the row's whole story: what it reclaimed. */
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("provider_wait"), wait: ProviderWaitDetail }),
  /**
   * THE HEAD OF AN ADOPTED CONVERSATION — its own arm for the same reason
   * `notification` has one: the facts have to live somewhere a renderer cannot
   * forget to look. Stated as prose in an `assistant_message` it would be
   * indistinguishable from something the model said, which is the precise lie
   * an import must not tell.
   */
  z.object({ type: z.literal("conversation_import"), import: ConversationImportDetail }),
  z.object({ type: z.literal("error"), error: ErrorDetail }),
  z.object({ type: z.literal("unknown"), label: z.string().optional(), payload: z.unknown().optional() }),
]);
export type ItemDetail = z.infer<typeof ItemDetail>;

/**
 * One timeline row.
 *
 * `title` is the one-line label a collapsed row shows and is the ENGINE's job
 * to produce, not the client's: three clients deriving "what does an Edit of
 * src/foo.ts say when collapsed" independently is three answers.
 */
export const Item = z.object({
  id: Id,
  runId: Id,
  sessionId: Id,
  status: ItemStatus,
  title: z.string().optional(),
  detail: ItemDetail,
  startedAt: Timestamp,
  completedAt: Timestamp.optional(),
  /**
   * Text streamed into this item SO FAR, present only while it is open.
   *
   * `detail` is not filled in until an item closes — folding every token into
   * the projection would rewrite the whole document per token — so a client
   * opening on a snapshot mid-reply had no way to learn the prefix it had
   * missed. The snapshot's `cursor` is stamped past those deltas, so tailing
   * from it skips them, and the reader saw only what arrived after they looked
   * away (#214).
   *
   * ALWAYS PAIRED WITH `streamedThrough`, which says where the prefix ENDS.
   * A prefix whose end a client has to infer — from the snapshot's cursor, from
   * a same-tick read, from anything — is a prefix that silently loses or
   * duplicates text the moment that inference is off by one event. Carrying the
   * watermark makes the field self-describing: a client appends exactly the
   * deltas above it, and can hold a snapshot and a tail from different reads
   * without having to prove they were taken together.
   */
  streamed: z.string().optional(),
  /**
   * The journal event id `streamed` runs through. Deltas at or below this are
   * already IN the prefix; deltas above it append to it.
   *
   * REBUILDABLE FROM THE JOURNAL, never only from memory. The engine keeps a
   * per-item accumulator as a CACHE — a restart empties it, and a reader coming
   * back to a stopped-but-unclosed item would otherwise find their partial
   * reply gone. The deltas are durable, so the answer is to re-read them, which
   * is rebuilding a display and not replaying any work.
   */
  streamedThrough: z.number().int().nonnegative().optional(),
  /** Set when this item was produced inside a sub-agent rather than by the
   *  main loop, so a client can file it under that agent instead of the
   *  parent timeline. */
  taskId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
  /**
   * THIS ROW WAS READ OUT OF A PROVIDER'S TRANSCRIPT, not produced by a turn
   * this engine ran — `/resume` adopting an existing Claude Code conversation
   * (#616). The distinction has to be on the row itself: a session can hold
   * imported history and live turns at once, so "is this session imported" is
   * not a question with one answer, and a row that passes for a Telar turn it
   * never was misleads every later reader.
   *
   * `literal(true)`, not `boolean`, so absent and `false` are not two spellings
   * of the same state. An imported row says so; every other row stays silent.
   */
  imported: z.literal(true).optional(),
});
export type Item = z.infer<typeof Item>;
