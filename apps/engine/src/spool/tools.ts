/**
 * The `spool` toolkit — the ONLY path any session has to the user's item store.
 *
 * Ported from `apps/web_old/lib/workspace-mcp.ts`.
 *
 * ── WHY A TOOL SURFACE AND NOT FILE ACCESS ──────────────────────────────────
 * CAP-12 says items "are not the Workspace surface's private data": every
 * session anywhere in Telar must be able to read and file them. File access
 * cannot be how. Codex's sandbox write boundary is purely path-based — working
 * root plus `--add-dir` — and a project session's root is its own repo, so the
 * spool sits outside it. Granting every session an `--add-dir` onto the store
 * would widen each one's write boundary across every project's items, which is
 * the opposite of the isolation the rest of the system maintains. So this file
 * is not a convenience wrapper over the store; it is the store's only door, and
 * the store sits deliberately outside every session's cwd.
 *
 * ── THIS FILE'S CONTRACT IS MOSTLY ITS ABSENCES, AND EACH IS ASSERTED ───────
 * `test/spool-tools.test.ts` proves all of these, because a comment claiming a
 * negative is worth nothing:
 *   · NO ACCEPT PATH. No tool here transitions anything: the moat is that no
 *     AGENT may declare a thing done (docs/spool-loops.md §9), and no input
 *     shape on this wall can spell doneness. Filing a task is PREPARE, never
 *     COMMIT. Settling a THREAD is not an exception: it answers a QUESTION
 *     with the user's own answer (required, refused empty) and says nothing
 *     about any work — `SpoolThread`'s header carries the full argument.
 *   · NO CLOSE VERB, ABOVE ALL. `SpoolItem.closed` exists — the human's own
 *     checkbox — and it is writable ONLY through the daemon's dedicated
 *     close/reopen routes. No tool here names it, no argument can carry it,
 *     and the generic update path this wall CAN reach refuses `closed` by
 *     name in the store. A model can never touch it, spoof it, or be talked
 *     into it; the human closing their own task is the moat working.
 *   · NO DELETE TOOL. "No deletion path." Nothing here removes an item, and
 *     dismissing one from the desk drains it to the queue.
 *   · NO PROMOTION PATH. "Agents have no promotion path, proposed or
 *     otherwise." `promotedFrom` exists on the item; no input shape here can
 *     write it, and the verb is not reachable from this file.
 *   · NO LANE-STRUCTURE CHANGE. Lane splits, renames and retires are reserved
 *     to the human. `spool_list_lanes` READS; nothing here creates, renames or
 *     retires one. The store's ensure step seeds a lane, and that it is the
 *     STORE and not a TOOL is the whole of what makes it legal.
 *   · NO VERDICT INPUT — and no verdict at all any more, because the verdict was
 *     the question "session or loom?" and looms are not built. When it returns,
 *     it must NOT return as an argument here: its writers are an expert pass and
 *     a human's own click, and a key on this shape would be a third,
 *     agent-driven writer with no override gate in front of it.
 *   · NO CROSS-PROJECT REACH. See `scope` below.
 *   · NO ENTITY SCHEMA. The shapes below are ARGUMENT schemas — what a caller
 *     may pass — and are structurally unrelated to `SpoolItem`, which the
 *     protocol owns.
 *   · NO PATH-SHAPED INPUT KEY. `path`, `file_path` and `notebook_path` are
 *     what a guardrail resolves against the session root on EVERY tool call. An
 *     argument called `path` here would have an opaque item id resolved against
 *     a repo and matched against protected paths — meaningless, and it would
 *     deny by accident. Hence `laneKey` and `itemId`.
 */
import { z } from "zod";
import { SpoolApertureView, SpoolSubjectColor, SpoolSubjectPermits } from "@telar/engine-client";
import type {
  SpoolAperture,
  SpoolArea,
  SpoolDeadline,
  SpoolPin,
  SpoolExpertOutcome,
  SpoolFocusDay,
  SpoolFocusEntry,
  SpoolItem,
  SpoolItemDetail,
  SpoolLane,
  SpoolLookOutcome,
  SpoolMap,
  SpoolNote,
  SpoolPickup,
  SpoolSearchHit,
  SpoolSnapshot,
  SpoolSubject,
  SpoolTerrain,
  SpoolThread,
  SpoolThreadView,
} from "@telar/engine-client";

/** Who a thread is stuck on, as the tools spell it — flat, because an MCP
 *  argument schema reads better to a model as three keys than as one object. */
type WaitingInput = { kind: "you" | "agent" | "person"; who?: string; note?: string };

/**
 * What the toolkit may do.
 *
 * IT IS THE ENGINE'S OWN HTTP SURFACE, not the store, and that is deliberate:
 * there are two worker deployments — the daemon's embedded one and
 * `worker-main.ts` — and only one of them could reach the filesystem store. A
 * capability built on the client works identically in both, which is the exact
 * drift `drivers.ts` exists to prevent ("the out-of-process worker shipped with
 * no browser at all while the embedded one had it, silently"). It also means
 * every rule about items has ONE implementation, already under test.
 */
export type SpoolCapability = {
  /**
   * The project LABEL this session's items are scoped to; absent is the
   * project-less master, which sees everything.
   */
  project?: string;
  snapshot(): Promise<SpoolSnapshot>;
  item(id: string): Promise<SpoolItemDetail | null>;
  create(input: {
    title: string;
    lane?: string;
    project?: string;
    creationNote?: string;
    deadline?: SpoolDeadline;
    /** Always "session" from this toolkit — set by the handler's own code so
     *  the footer's "agents added N" stays honest, never by a model argument
     *  (no tool shape carries it). */
    source?: "you" | "session";
  }): Promise<SpoolItem>;
  update(
    id: string,
    patch: {
      title?: string;
      lane?: string;
      project?: string;
      desk?: boolean;
      unplaced?: boolean;
      mirrored?: string;
      deadline?: SpoolDeadline;
      /** `{day}` sets, an explicit `null` clears. Written only by `spool_pin`,
       *  whose description carries the provenance law a model reads. */
      pinned?: SpoolPin | null;
    },
  ): Promise<SpoolItem>;
  /**
   * Run the item's own project expert over it.
   *
   * THE ONE VERB HERE THAT SPENDS MONEY, and the only one that is slow. It is
   * still not a commit path: the expert can write a brief, acceptance criteria,
   * a timeline note and mined commitments, and there is no verb behind it that
   * could start, accept, promote or delete anything. `SpoolExpertOutcome`'s
   * shape is what enforces that, not a check here.
   */
  consult(id: string): Promise<SpoolExpertOutcome>;
  // ── the work-state verbs — every one lands on the store's own rules ──
  map(): Promise<SpoolMap>;
  openThread(
    subject: string,
    input: { question: string; handle?: string; items: string[]; waiting?: WaitingInput },
  ): Promise<SpoolThread>;
  setWaiting(subject: string, threadId: string, waiting: WaitingInput): Promise<SpoolThread>;
  settle(subject: string, threadId: string, answer: string): Promise<SpoolThread>;
  answer(itemId: string, question: string, answer: string): Promise<SpoolItem>;
  focus(): Promise<{ pickup: SpoolPickup; days: SpoolFocusDay[] }>;
  setFocus(input: { subject: string; note?: string }): Promise<SpoolFocusEntry>;
  endFocus(id: string, end: { reason: "done" | "paused"; note?: string }): Promise<SpoolFocusEntry>;
  /**
   * Reconcile-on-look, from conversation. STILL PULL: a model calls this only
   * inside a turn a human started, which is exactly the "reason to look" §4
   * names. It is deterministic and model-free on the server — the observations
   * it returns were composed by a diff, never by the caller.
   */
  look(subjectKey: string): Promise<SpoolLookOutcome>;
  /**
   * Record where a subject lives, when the USER states it. `null` clears. The
   * repo-address guard is the store's; a name it cannot hold refuses loudly.
   */
  setTerrain(subjectKey: string, terrain: SpoolTerrain | null): Promise<SpoolSubject>;
  /**
   * Record whose a subject is — its `area` and/or its `color` — when the USER
   * states it. `null` clears a field, absent leaves it untouched. The closed
   * color set and the area cap are the store's; a value it must not hold
   * refuses loudly. Identity, never state: neither field may ever be read as
   * urgency.
   */
  setIdentity(subjectKey: string, patch: { area?: string | null; color?: SpoolSubjectColor | null }): Promise<SpoolSubject>;
  /**
   * Point the room at a smart view. STILL HERE FOR THE HAND'S OWN ROUTE — no
   * tool on any wall calls this any more (§13.6: the room is the user's own to
   * navigate), so this member exists only because the daemon and worker's
   * capability objects are one shape for both the tool wall and the aperture
   * HTTP route. Never a subject: subject focus is the deeper aperture and has
   * its own verbs above.
   */
  setAperture(view: SpoolApertureView): Promise<SpoolAperture>;
  /**
   * State — or withdraw, with `null` — an area's permit ceiling, when the USER
   * states it. The clamp itself (down only, never a raise) is the store's;
   * a level it does not know refuses loudly.
   */
  setAreaPermits(name: string, ceiling: SpoolSubjectPermits | null): Promise<SpoolArea>;
  /** The whole shelf — every note, retired ones included. The TOOL slices to
   *  the session's scope; the capability answers whole, like `snapshot`. */
  notes(): Promise<SpoolNote[]>;
  /**
   * Write a note. `author` is declared by the handler's own code — always
   * "session" from this toolkit, exactly as `create.source` is — never by a
   * model argument (no tool shape carries it).
   */
  createNote(input: { title: string; body: string; tags?: string[]; subjectKey?: string; author?: "you" | "session" }): Promise<SpoolNote>;
  updateNote(id: string, patch: { title?: string; body?: string; tags?: string[] }): Promise<SpoolNote>;
  /**
   * The deterministic lexical search — the engine scans, scores and ranks;
   * nothing here calls a model. The subject narrows to one subject's slice.
   */
  search(query: string, subject?: string): Promise<SpoolSearchHit[]>;
};

/** Just enough of the SDK to register a tool — the same seam the browser
 *  toolkit takes, so a test can drive this with no SDK installed. */
export type ToolFactory = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
) => unknown;

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const json = (value: unknown) => ok(JSON.stringify(value, null, 2));

/**
 * A row as a model should read it — the queue's own chips, in words.
 *
 * THE SAME FIELDS THE QUEUE RENDERS, so "a task seen from a session must be
 * recognisably the same task" is true of the DATA and not only of the CSS. A
 * summary that dropped the deadline's kind, or flattened `floating` to nothing,
 * would make the in-session view a different task with the same title.
 */
function summarise(item: SpoolItem, rank: number | null, lane: string | undefined) {
  const subtasks = item.subtasks ?? [];
  return {
    id: item.id,
    title: item.title,
    ...(lane ? { lane } : {}),
    ...(rank !== null ? { rank } : {}),
    // ABSENT IS `floating`, said out loud rather than left blank: a model
    // reading no `project` key cannot tell "unfiled" from "the field was
    // dropped".
    project: item.project ?? "floating",
    ...(item.mirrored ? { mirrored: item.mirrored } : {}),
    provenance: item.provenance,
    captured: item.captured,
    ...(item.deadline ? { deadline: item.deadline } : {}),
    // The user's own day, quoted. A model reading it relays the date; it never
    // computes distance from it.
    ...(item.pinned ? { pinned: item.pinned } : {}),
    // The user's own labels, verbatim — identity, never a state or urgency.
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(subtasks.length ? { subtasks: { done: subtasks.filter((s) => s.done).length, total: subtasks.length } } : {}),
    ...(item.desk ? { onDesk: true } : {}),
    ...(item.unplaced ? { unplaced: true } : {}),
  };
}

const LIST_ITEMS = `Every task on the user's spool that belongs to this session's project, with its lane, its rank in that lane's stack, and its chips. Order is stack position — there is no schedule and no due-date sort. Read this before answering anything about what the user has to do here.`;

const LIST_LANES = `The user's lanes — the coarse buckets their tasks are stacked in. Lanes are the user's own structure, not a fixed set: you can READ them here, and you cannot create, rename, retire or split one. Proposing a split is fine; only the human applies it.`;

const CREATE_ITEM = `File a new task on the user's spool. Use it when the user asks you to remember or track something, not for your own scratch notes. It is PREPARED, never started: filing a task begins no work. It lands on the user's desk for them to see, and it is stamped as coming from this session. If you name a lane that does not exist, the task is still filed and flagged for the user to place — no lane is ever created for you.`;

const UPDATE_ITEM = `Change a task you can already see with spool_list_items: its title, its lane, whether it sits on the desk, or the foreign ref it mirrors. It cannot rewrite the user's original words, cannot promote a sub-task, and cannot delete anything — those are the user's, or have their own path. Dismissing from the desk (desk: false) drains the task to the queue; it deletes nothing.`;

const CONSULT_EXPERT = `Ask the task's own project expert to read it: it decompresses the user's shorthand into a brief someone could execute from, adds acceptance criteria, and notes any promise to a person it heard in the original words. Use it on a task whose title or capture is terse, not on one already written out. THIS SPENDS MONEY AND TAKES A WHILE — one call, one pass, so do not loop it, and do not re-run it to "finish" a pass that failed: a repeat appends its notes a second time. It changes nothing else: it starts no work, accepts nothing, moves no task between lanes, and never touches what the user originally wrote.`;

const LIST_THREADS = `The subject's open questions — its threads: what is not known, who each one is stuck on, what the user's captures feed it, and what has been settled with an answer. Read this before marking anything waiting, answering, or settling: every one of those verbs addresses a thread or a question listed here.`;

const OPEN_QUESTION = `Put ONE open question on the map, around a capture that already exists. The capture is the evidence the question is the user's and not yours — a question with no capture is refused, and nothing here can create a new task. A question the map already holds comes back as the existing thread rather than a duplicate. The grouping is marked as agent-proposed until the user looks.`;

const MARK_WAITING = `Say who a thread is stuck on: the user ("you"), an unattended agent, or a named person from the user's own words. This is a mark on an OPEN question — a settled one is refused, and naming the user as a "person" is normalised to "you". Use it when the user says something is blocked, owed, or with someone.`;

const ANSWER_QUESTION = `Record the user's answer to one of a task's open questions. The question must be one the task actually holds (spool_list_items shows them) and the answer must be real — an empty one is refused, because this verb REDUCES open state rather than deleting anything: the question comes off the list and the answer lands on the task's timeline, marked as written from this session until the user looks. Use the user's own words for the answer wherever you can.`;

const SETTLE_THREAD = `Close a thread's question with WHAT WAS FOUND OUT — the user's answer, in their words. Only use this to relay an answer the user actually gave in this conversation; never settle on your own conclusion. The answer is required: a settle without one would be a status flip, and this store cannot express one. The thread stays on the map as the record of what was worked out — nothing is deleted, and no work is started or accepted by this.`;

const SET_FOCUS = `Record what the user is on — one subject, with an optional note in their words about where they are. This is a work record, not a view: it feeds the pickup ("where you left off") the next time the user opens that subject's brief. It does not and cannot move the user's screen — they navigate their own rooms. Set it when the user says they are working on something ("let's focus on sample-project"); never set it on your own initiative.`;

const LOOK = `Glance at a subject's terrain — the repository the user said it lives in — and get back what MOVED since the Spool's last look, as plain sentences with issue/PR numbers ("PR #420 merged since your last look."). Deterministic and read-only: it never writes to the tracker, never invents urgency, and a subject with no terrain answers with a note, not an error. Use it when the user arrives at a subject or asks what changed; do not loop it — the world does not move that fast.`;

const SET_TERRAIN = `Record where a subject lives, ONLY when the user has stated it in this conversation ("sample-project lives in example-owner/sample-project"). The terrain is an address plus the user's own facts about it (notes) — never something you discovered and asserted on your own. Pass clear: true to withdraw it when the user says the address is wrong. A subject with no terrain is fully first-class; never press the user to add one.`;

const SET_SUBJECT_IDENTITY = `Record a subject's identity — the area it belongs to and/or its color — ONLY when the user states it in this conversation ("pon casa en el área personal, de color mar"). Identity is the user's: an area is their own group name ("Trabajo", "Personal"), written verbatim, and a color is one of the Spool's named tokens. NEVER invent an area, never pick a color uninvited, and never suggest either unprompted. Color says WHOSE a subject is, never how urgent — it carries no state, no priority and no deadline meaning. Pass clearArea or clearColor when the user withdraws one; a subject with no area and no color is fully ordinary.`;

const PIN_ITEM = `Pin a task to a day the USER stated, or clear a pin when they ask. The calendar belongs to the user: a pin is THEIR placement of work on THEIR day, so you pin ONLY when the user names the date, and you write exactly the date they named as YYYY-MM-DD. NEVER resolve "tomorrow", "Friday" or "next week" against a clock, never invent a date, and never move a pin on your own initiative — if the user said "Friday" without a date, ask which day they mean rather than computing one. Pass clear: true when they ask to unpin; that removes the pin and nothing else — the task stays exactly where it is.`;

/**
 * `spool_set_aperture` USED TO LIVE HERE. Removed under docs/spool-loops.md
 * §13.6: the room has belonged to the user's own hand since the re-entry
 * rebuild — "the user navigates rooms themselves; the agent no longer
 * controls what the screen shows." The aperture SLOT and its route
 * (`spool/aperture.ts`, `readAperture`/`setAperture`) stay on disk — cheap,
 * dormant, still written by the hand's own click — but no tool on any wall
 * reaches it any more. A request to "show me today" is now answered the way
 * every other question is: in words, from the store (see `spool_list_items`,
 * `spool_pin`).
 */

const SET_AREA_PERMITS = `Set a permit ceiling on one of the user's areas — ONLY when the user states it in this conversation ("Personal nunca se trabaja sin preguntar" → ceiling "read" on Personal). A ceiling CLAMPS every subject in the area DOWN to it: effective permits are the lower of what the subject states and what the area allows, and a ceiling can never raise anything. Never set one uninvited, never assume any area — Personal included — wants one, and pass clear: true only when the user withdraws the statement. The levels: "read" (glance and brief only), "draft" (may propose an approach), "propose" (may open a pull request).`;

const SHELF = `The user's shelf: markdown NOTES beside the tasks — knowledge that is not work (guard notes, runbooks, preferences, decisions), each with tags and an author. Without a noteId you get the list (titles, tags, authors — retired ones marked, never hidden); pass a noteId to read one note's full body. Read the shelf before answering questions about what the user knows or has decided, and before writing a note that might already exist.`;

const WRITE_NOTE = `Write a note on the user's shelf, or edit one you can see with spool_shelf (pass its noteId). Use it when the user ASKS you to keep something, or states knowledge worth keeping — a decision, a constraint, a fact about how something works. NEVER invent knowledge: a note holds what the user said or showed, quoted in their own words wherever possible, not your own conclusions. It is knowledge, not work — filing a task is spool_create_item. The note is stamped as written from this session, permanently; editing cannot change the author, and retiring a note is the user's own verb, not yours.`;

const SEARCH = `Search everything on the user's spool — tasks, open questions, shelf notes, and what the Spool observed in the world — with one query. Lexical and deterministic: it matches the words (accents don't matter), it does not understand meaning, so search the user's own vocabulary and try a second wording before concluding something is not there. Closed and settled things are included, marked closed, and ranked below open ones. Read-only: searching changes nothing.`;

const END_FOCUS = `End the user's current focus: "done" when they finished, "paused" when they are stepping away or widening back out. The note is where they left it — the single most valuable string for picking back up, so quote the user when they said. This is a fact about their attention, never a status on any work.`;

/**
 * THE MASTER'S SUBJECT ARGUMENT — the premise repair.
 *
 * "Scope is never a tool input" was written when every session WAS a scope,
 * and there it stands: a scoped session still has no `subjectKey`, because for
 * it the subject is a fact about the session, not a choice. The project-less
 * master broke the premise, not the rule — its whole purpose is cross-subject
 * reach, so for it the subject must be ADDRESSABLE or everything it files
 * floats forever, which is exactly what happened live: the master resorted to
 * mirror refs and asked the human to re-file by hand.
 */
const SUBJECT_ARG = z
  .string()
  .optional()
  .describe(
    "Which subject this task is about — the subject's own key, from spool_list_items' `project` field. " +
      "Only file to a subject the user named or that their words clearly place it in; leave it off to keep " +
      "the task floating, which is a valid resting state.",
  );

/**
 * THE DEADLINE PAIR, under §3.2's QUOTING LAW — the same rule
 * `commitments.when` already states: a date may be QUOTED from a source, never
 * resolved or computed. The descriptions are the enforcement a model reads.
 */
const DEADLINE_LABEL = z
  .string()
  .optional()
  .describe(
    'A deadline QUOTED from a source, with the source\'s own words: the user said "Friday", the issue\'s ' +
      'milestone says "Sep 2". NEVER resolve "today" or "next week" to a date, never compute one from a ' +
      "clock, and never invent one — no deadline is the honest default. Requires deadlineKind.",
  );
const DEADLINE_KIND = z
  .enum(["external", "self"])
  .optional()
  .describe(
    '"external" when the date comes from outside the user (a milestone, a client, a form); "self" when it ' +
      "is their own commitment. A self-deadline renders dashed and tracks how often it slid — the kinds are " +
      "not interchangeable.",
  );

/** Compose the pair, or say which half is missing — a label with no kind would
 *  draw a chip whose provenance nobody stated. */
function deadlineFrom(args: Record<string, unknown>): SpoolDeadline | Error | undefined {
  const label = typeof args.deadlineLabel === "string" ? args.deadlineLabel.trim() : undefined;
  const kind = args.deadlineKind === "external" || args.deadlineKind === "self" ? args.deadlineKind : undefined;
  if (!label && !kind) return undefined;
  if (!label || !kind) {
    return new Error(
      "A deadline is a pair: deadlineLabel (the quoted date) and deadlineKind (external or self). " +
        "Half of one draws a chip whose provenance nobody stated — pass both, or neither.",
    );
  }
  return { label, kind };
}

/**
 * Build the toolkit.
 *
 * THE `tool` FACTORY ARRIVES AS AN ARGUMENT rather than being imported, the same
 * seam the browser toolkit takes: the provider SDK is loaded lazily on the first
 * run, and a module that imported it at the top would pull it into every unit
 * test. `zod` is imported directly — it is the engine's own dependency, not the
 * provider's.
 */
export function spoolTools(tool: ToolFactory, capability: SpoolCapability): unknown[] {
  const scope = capability.project;
  /**
   * IN SCOPE MEANS THE SAME PROJECT — and a FLOATING item is NOT in a project
   * session's scope. Floating means "not yet placed anywhere", and handing a
   * project session every unplaced fragment in the user's life is exactly the
   * cross-project leak this predicate exists to stop. The master, which has no
   * scope, sees them.
   */
  const inScope = (item: SpoolItem) => scope === undefined || item.project === scope;

  const laneOf = (snapshot: SpoolSnapshot, id: string) => snapshot.rows.find((r) => r.item.id === id);

  /** The flat stuck-on triple, folded back into the store's shape. */
  const waitingFrom = (args: Record<string, unknown>): WaitingInput | undefined => {
    const kind = args.stuckOn;
    if (kind !== "you" && kind !== "agent" && kind !== "person") return undefined;
    return {
      kind,
      ...(typeof args.who === "string" && args.who.trim() ? { who: args.who } : {}),
      ...(typeof args.stuckNote === "string" && args.stuckNote.trim() ? { note: args.stuckNote } : {}),
    };
  };

  /**
   * A thread by id, or by the capture it holds — always through the map, so
   * scope filters BEFORE anything matches and an out-of-scope thread answers
   * byte-identically to one that does not exist (the oracle rule, again).
   */
  const resolveThread = async (
    args: Record<string, unknown>,
  ): Promise<{ subject: string; view: SpoolThreadView } | string> => {
    const threadId = typeof args.threadId === "string" && args.threadId ? args.threadId : undefined;
    const itemId = typeof args.itemId === "string" && args.itemId ? args.itemId : undefined;
    if (!threadId && !itemId) return "Name the thread (threadId) or one of its captures (itemId).";
    const map = await capability.map();
    for (const s of map.subjects) {
      if (scope !== undefined && s.subject !== scope) continue;
      const view = threadId
        ? s.threads.find((v) => v.thread.id === threadId)
        : s.threads.find((v) => v.thread.items.includes(itemId!));
      if (view) return { subject: s.subject, view };
    }
    if (itemId) {
      // The capture may exist and simply be in no thread — that is a resting
      // state with a named next move, not a missing record.
      const existing = await capability.item(itemId);
      if (existing && inScope(existing.item)) {
        return `"${existing.item.title}" is in no thread yet — open a question around it first (spool_open_question).`;
      }
      return `No spool item found with id "${itemId}".`;
    }
    return `No thread found with id "${threadId}".`;
  };

  return [
    tool(
      "spool_list_items",
      LIST_ITEMS,
      // NO ARGUMENTS AT ALL. There is nothing a caller could usefully narrow
      // that the server does not already know, and an empty shape is the
      // strongest possible form of "no identity and no scope on any input".
      {},
      async () => {
        const snapshot = await capability.snapshot();
        const rows = snapshot.rows.filter((r) => inScope(r.item));
        // Unfiled items are in no stack and so in no row — they still belong to
        // the answer, or a session would be told a task it can see on the desk
        // does not exist.
        const filedIds = new Set(snapshot.rows.map((r) => r.item.id));
        const unfiled = snapshot.desk.filter((d) => !filedIds.has(d.id));
        return json({
          // The RESOLVED scope, rendered so the model can say what it is looking
          // at. Never an argument that produced it.
          scope: scope ?? "all projects",
          items: rows.map((r) => summarise(r.item, r.rank, r.lane)),
          ...(unfiled.length ? { unfiledOnDesk: unfiled.length } : {}),
          // ONE UNREADABLE PACKET NEVER BLANKS THE OTHER NINETY-NINE, and a
          // model told nothing would report a short list as the whole truth.
          //
          // A COUNT WHEN SCOPED, THE DIAGNOSIS ONLY WHEN NOT. An unreadable
          // packet has no readable `project` BY CONSTRUCTION — that is what
          // unreadable means — so it cannot be filtered, and passing the reasons
          // through would hand a project session other projects' item ids and
          // lane keys in the text.
          ...(snapshot.unreadable.length
            ? scope === undefined
              ? { unreadable: snapshot.unreadable }
              : { unreadable: snapshot.unreadable.length }
            : {}),
        });
      },
    ),
    tool("spool_list_lanes", LIST_LANES, {}, async () => {
      const snapshot = await capability.snapshot();
      return json({
        lanes: snapshot.lanes.map((lane: SpoolLane) => ({
          key: lane.key,
          label: lane.label,
          window: lane.window,
          ...(lane.note ? { note: lane.note } : {}),
          // The count of what THIS session can see in it, not the stored total —
          // otherwise a scoped session reads a number it cannot reconcile with
          // the list it just got.
          items: snapshot.rows.filter((r) => r.lane === lane.key && inScope(r.item)).length,
        })),
      });
    }),
    tool(
      "spool_create_item",
      CREATE_ITEM,
      // `laneKey`, never `lane` — and never `path`, `file_path` or
      // `notebook_path`. See the header. `subjectKey` and the deadline pair
      // are shared with update and explained there.
      {
        title: z.string().min(1),
        laneKey: z.string().optional(),
        ...(scope === undefined ? { subjectKey: SUBJECT_ARG } : {}),
        deadlineLabel: DEADLINE_LABEL,
        deadlineKind: DEADLINE_KIND,
      },
      async (args) => {
        const title = String(args.title ?? "");
        const laneKey = typeof args.laneKey === "string" ? args.laneKey : undefined;
        const subjectKey = scope === undefined && typeof args.subjectKey === "string" ? args.subjectKey : undefined;
        const deadline = deadlineFrom(args);
        if (deadline instanceof Error) return err(deadline.message);
        let item: SpoolItem;
        try {
          item = await capability.create({
            title,
            ...(laneKey ? { lane: laneKey } : {}),
            /**
             * FOR A SCOPED SESSION, SERVER-SUPPLIED AND NOTHING ELSE — its
             * `subjectKey` argument does not exist, so scope stays something a
             * scoped session cannot name. The MASTER'S argument rides only
             * when the session has no scope; see `SUBJECT_ARG`.
             */
            ...(scope ? { project: scope } : subjectKey ? { project: subjectKey } : {}),
            ...(deadline ? { deadline } : {}),
            creationNote: "captured from this session",
            // THE ONE DECLARATION OF AGENCY, and it is this handler's own code
            // making it: everything through the tool wall is an agent's filing,
            // so the human API's default ("you") must not apply to it.
            source: "session",
          });
        } catch (e) {
          // A write that can fail returns an actionable sentence; a read that
          // legitimately finds nothing returns an empty result.
          return err(`Could not file "${title}": ${e instanceof Error ? e.message : String(e)}`);
        }
        const snapshot = await capability.snapshot();
        const row = laneOf(snapshot, item.id);
        /**
         * ONE `note`, COMPOSED — not two keys named `note`, which is what this
         * was and which silently dropped the half that mattered: the later
         * literal won, so a model that filed into a lane the user does not have
         * was told "Filed, not started" and never learned the lane was refused.
         * The unplaced clause goes FIRST because it is the surprising half.
         */
        const notes: string[] = [];
        if (item.unplaced) {
          notes.push(
            laneKey
              ? `There is no lane "${laneKey}", and none was created — lanes are the user's to make. The task is filed where unplaced things go and flagged for them to place.`
              : `Filed where unplaced things go, and flagged for the user to place.`,
          );
        }
        notes.push("Filed, not started. It is on the user's desk; nothing about it has begun.");
        return json({
          id: item.id,
          lane: item.lane,
          ...(row ? { rank: row.rank } : {}),
          provenance: item.provenance,
          onDesk: item.desk === true,
          ...(item.unplaced ? { unplaced: true } : {}),
          note: notes.join(" "),
        });
      },
    ),
    tool(
      "spool_update_item",
      UPDATE_ITEM,
      /**
       * EXACTLY the patchable fields. `project` appears ONLY on the scope-less
       * master, as `subjectKey`: "scope is never a tool input" is a law about
       * SCOPED SESSIONS, whose subject is a fact and not a choice — the master
       * has no scope to protect and cross-subject reach is its whole purpose,
       * so for it the subject must be addressable or everything it touches
       * floats (which is what happened live). The deadline pair is legal under
       * the quoting law its descriptions carry. See the header for why a
       * verdict may never appear here even once verdicts exist again.
       */
      {
        itemId: z.string().min(1),
        title: z.string().min(1).optional(),
        laneKey: z.string().optional(),
        desk: z.boolean().optional(),
        unplaced: z.boolean().optional(),
        mirrored: z.string().optional(),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "The item's labels, REPLACED WHOLE — only when the user asked for a tag or stated one, in their own words " +
              '("etiquétalo no-tocar"). Never invent a tag, never tag to signal urgency or state. Pass the full list ' +
              "(their existing tags plus the change); [] removes them all.",
          ),
        ...(scope === undefined ? { subjectKey: SUBJECT_ARG } : {}),
        deadlineLabel: DEADLINE_LABEL,
        deadlineKind: DEADLINE_KIND,
      },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        const patch: {
          title?: string;
          lane?: string;
          project?: string;
          desk?: boolean;
          unplaced?: boolean;
          mirrored?: string;
          deadline?: SpoolDeadline;
          tags?: string[];
        } = {};
        if (typeof args.title === "string") patch.title = args.title;
        if (typeof args.laneKey === "string") patch.lane = args.laneKey;
        if (typeof args.desk === "boolean") patch.desk = args.desk;
        if (typeof args.unplaced === "boolean") patch.unplaced = args.unplaced;
        if (typeof args.mirrored === "string") patch.mirrored = args.mirrored;
        if (Array.isArray(args.tags)) patch.tags = args.tags.filter((tag): tag is string => typeof tag === "string");
        if (scope === undefined && typeof args.subjectKey === "string") patch.project = args.subjectKey;
        const deadline = deadlineFrom(args);
        if (deadline instanceof Error) return err(deadline.message);
        if (deadline) patch.deadline = deadline;
        if (Object.keys(patch).length === 0) {
          return err(
            `Nothing to change on "${itemId}" — pass at least one of title, laneKey, desk, unplaced, mirrored, tags` +
              `${scope === undefined ? ", subjectKey" : ""} or the deadline pair.`,
          );
        }

        /**
         * SCOPE IS CHECKED BEFORE THE WRITE, NOT AFTER, and the order is the
         * whole guarantee. An item id is opaque, so a session that guessed or
         * was told one belonging to ANOTHER project must not be able to modify
         * it — and checking afterwards would mean the write had already happened
         * and only the confirmation was withheld.
         *
         * THE ANSWER FOR AN OUT-OF-SCOPE ID IS BYTE-IDENTICAL to the answer for
         * one that does not exist, so this surface never becomes an oracle for
         * whether some other project holds a given id.
         */
        const existing = await capability.item(itemId);
        if (!existing || !inScope(existing.item)) return err(`No spool item found with id "${itemId}".`);

        let updated: SpoolItem;
        try {
          updated = await capability.update(itemId, patch);
        } catch (e) {
          return err(`Could not update "${itemId}": ${e instanceof Error ? e.message : String(e)}`);
        }
        // READ AFTER THE WRITE, because a lane change is a TWO-FILE move: a
        // stale read here would report the rank the item held before its move.
        const snapshot = await capability.snapshot();
        const row = laneOf(snapshot, updated.id);
        const unknownLane =
          typeof args.laneKey === "string" && !snapshot.lanes.some((l) => l.key === args.laneKey);
        return json({
          ...summarise(updated, row?.rank ?? null, row?.lane),
          // THE INVERSE OF create's GUARD. Without it a laneKey naming no lane
          // reported success and said nothing, so a model was told a move
          // happened that had in fact been refused.
          ...(unknownLane
            ? {
                note: `There is no lane "${String(args.laneKey)}", and none was created — so the task did not move. It is still where it was, flagged for the user to place.`,
              }
            : {}),
        });
      },
    ),
    tool(
      "spool_consult_expert",
      CONSULT_EXPERT,
      // ONE ARGUMENT, AND NO WAY TO STEER THE PASS. No prompt, no model, no
      // instruction key: the expert's whole contract is that it reads the
      // project's own digest and the item, and a caller-supplied instruction
      // would make it a generic agent wearing the expert's name — the thing
      // CAP-9 exists instead of.
      { itemId: z.string().min(1) },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        /**
         * SCOPE FIRST, and byte-identical to the not-found answer, for the same
         * reason `spool_update_item` does it: this surface must never become an
         * oracle for whether another project holds a given id. It matters more
         * here — a consultation costs money, so an unchecked id would let a
         * session bill the user for reading a stranger's item.
         */
        const existing = await capability.item(itemId);
        if (!existing || !inScope(existing.item)) return err(`No spool item found with id "${itemId}".`);

        let outcome: SpoolExpertOutcome;
        try {
          outcome = await capability.consult(itemId);
        } catch (e) {
          return err(`Could not consult the expert for "${itemId}": ${e instanceof Error ? e.message : String(e)}`);
        }
        /**
         * A REFUSAL IS AN ERROR RESULT CARRYING THE STORE'S OWN SENTENCE. Each
         * one names the next move ("file it into a project first"), which is
         * something the model can actually relay or act on — unlike a generic
         * failure, which it would most likely retry.
         */
        if (!outcome.ok) return err(outcome.reason);

        const { item } = outcome.applied;
        return json({
          id: item.id,
          title: item.title,
          // WHAT THE PASS PRODUCED, not the whole item: the caller already has
          // the item from list_items, and the answer to "what did the expert
          // do?" is these fields.
          fixed: item.fixed,
          acceptance: item.acceptance ?? [],
          minedCommitments: outcome.applied.commitments,
          // SAID OUT LOUD so a model relaying this does not imply the expert had
          // memory it did not have, or read files it never saw.
          firstPass: outcome.cold,
          readTheProject: outcome.cwd !== undefined,
          note: outcome.cold
            ? `First pass on ${outcome.project} — the expert had no digest and has now written one.`
            : `The ${outcome.project} expert refreshed its digest.`,
        });
      },
    ),
    tool(
      "spool_list_threads",
      LIST_THREADS,
      // The master may name a subject; a scoped session's subject is a fact,
      // so it takes no argument at all — same rule as everywhere here.
      scope === undefined ? { subjectKey: z.string().optional() } : {},
      async (args) => {
        const wanted = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : undefined);
        const map = await capability.map();
        const subjects = map.subjects.filter((s) => wanted === undefined || s.subject === wanted);
        if (wanted !== undefined && subjects.length === 0) {
          return json({ subject: wanted, threads: [], loose: [], note: "Nothing is mapped for this subject yet." });
        }
        return json({
          subjects: subjects.map((s) => ({
            subject: s.subject,
            threads: s.threads.map((view) => ({
              threadId: view.thread.id,
              question: view.thread.question,
              ...(view.thread.handle ? { handle: view.thread.handle } : {}),
              ...(view.thread.waiting ? { stuckOn: view.thread.waiting } : {}),
              ...(view.thread.settled ? { settled: view.thread.settled.answer } : {}),
              ...(view.thread.proposed ? { proposedByAgent: true } : {}),
              captures: view.items,
              // The ply, in words a model can relay — never a percentage.
              known: view.ply.verified,
              unchecked: view.ply.unchecked,
              openQuestions: view.ply.open,
            })),
            unclaimedCaptures: s.loose,
          })),
        });
      },
    ),
    tool(
      "spool_open_question",
      OPEN_QUESTION,
      {
        itemId: z.string().min(1).describe("The capture that is evidence for this question. Required — no capture, no thread."),
        question: z.string().min(1).describe("The thing that is NOT KNOWN, phrased as the user would ask it. Never your own access problem."),
        handle: z.string().optional().describe("Three to six words for the map — a label, not a sentence."),
        stuckOn: z.enum(["you", "agent", "person"]).optional(),
        who: z.string().optional().describe('For "person": the name the user\'s own words contained.'),
        stuckNote: z.string().optional().describe('What it is stuck on, one clause: "needs the live tracker".'),
      },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        // Scope first, byte-identical to not-found — the oracle rule.
        const existing = await capability.item(itemId);
        if (!existing || !inScope(existing.item)) return err(`No spool item found with id "${itemId}".`);
        const subject = existing.item.project;
        if (!subject) {
          return err(
            `"${existing.item.title}" is floating — a question lives on a subject's map, so file the item to a subject first.`,
          );
        }
        try {
          const thread = await capability.openThread(subject, {
            question: String(args.question ?? ""),
            ...(typeof args.handle === "string" ? { handle: args.handle } : {}),
            items: [itemId],
            ...(waitingFrom(args) ? { waiting: waitingFrom(args)! } : {}),
          });
          return json({
            threadId: thread.id,
            subject,
            question: thread.question,
            ...(thread.waiting ? { stuckOn: thread.waiting } : {}),
            note: "On the map, marked as proposed from this session until the user looks. Nothing was started.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_mark_waiting",
      MARK_WAITING,
      {
        threadId: z.string().optional().describe("A thread id from spool_list_threads."),
        itemId: z.string().optional().describe("Or a capture id — resolves to the thread that holds it."),
        stuckOn: z.enum(["you", "agent", "person"]),
        who: z.string().optional().describe('For "person": the name the user\'s own words contained.'),
        stuckNote: z.string().optional().describe('What it is stuck on, one clause: "needs Ana\'s numbers".'),
      },
      async (args) => {
        const waiting = waitingFrom(args);
        if (!waiting) return err("Say who this is stuck on: you, agent, or a named person.");
        const found = await resolveThread(args);
        if (typeof found === "string") return err(found);
        try {
          const thread = await capability.setWaiting(found.subject, found.view.thread.id, waiting);
          return json({
            threadId: thread.id,
            subject: found.subject,
            stuckOn: thread.waiting,
            note: "Marked. This is a mark on the question, not on any work — nothing was started or stopped.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_answer_question",
      ANSWER_QUESTION,
      {
        itemId: z.string().min(1),
        question: z.string().min(1).describe("The open question, as the task lists it."),
        answer: z.string().min(1).describe("The user's answer, in their words wherever possible."),
      },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        const existing = await capability.item(itemId);
        if (!existing || !inScope(existing.item)) return err(`No spool item found with id "${itemId}".`);
        try {
          const item = await capability.answer(itemId, String(args.question ?? ""), String(args.answer ?? ""));
          return json({
            id: item.id,
            stillOpen: item.openQuestions ?? [],
            note: "Recorded on the task's timeline, marked as written from this session until the user looks.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_settle_thread",
      SETTLE_THREAD,
      {
        threadId: z.string().min(1).describe("A thread id from spool_list_threads."),
        answer: z.string().min(1).describe("WHAT WAS FOUND OUT — the user's answer, in their words. Required."),
      },
      async (args) => {
        const found = await resolveThread(args);
        if (typeof found === "string") return err(found);
        if (found.view.thread.settled) {
          return err(
            `That thread is already settled: "${found.view.thread.settled.answer}". New evidence about it is a new question — open one.`,
          );
        }
        try {
          const thread = await capability.settle(found.subject, found.view.thread.id, String(args.answer ?? ""));
          return json({
            threadId: thread.id,
            subject: found.subject,
            settled: thread.settled?.answer,
            note: "The question is closed with that answer and stays on the map as the record. No work was accepted, started or deleted.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_set_focus",
      SET_FOCUS,
      // A scoped session can only be "on" its own subject, so it takes no
      // argument; the master names one, because narrowing across subjects is
      // exactly what it is for.
      scope === undefined
        ? {
            subjectKey: z.string().min(1).describe("The subject the user said they are on."),
            note: z.string().optional().describe("Where they are on it, in their words."),
          }
        : { note: z.string().optional().describe("Where the user is on it, in their words.") },
      async (args) => {
        const subject = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : "");
        if (!subject) return err("Name the subject the user is focusing on.");
        // A typo'd subject would record a fact about attention that is not
        // true, so the name is checked against what exists before anything is
        // written.
        const map = await capability.map();
        if (!map.subjects.some((s) => s.subject === subject)) {
          const known = map.subjects.map((s) => s.subject);
          return err(
            known.length > 0
              ? `No subject is called "${subject}". The user's subjects: ${known.join(", ")}.`
              : `No subject is called "${subject}" — nothing is filed to any subject yet.`,
          );
        }
        try {
          const entry = await capability.setFocus({
            subject,
            ...(typeof args.note === "string" && args.note.trim() ? { note: args.note } : {}),
          });
          return json({
            subject: entry.subject,
            ...(entry.note ? { note: entry.note } : {}),
            note2: "Recorded as what the user is on now. Focus is their attention, not a status on any work, and it does not move their screen — they navigate their own rooms.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_end_focus",
      END_FOCUS,
      {
        reason: z.enum(["done", "paused"]).describe('"done" = they finished; "paused" = stepping away or widening out.'),
        ...(scope === undefined
          ? { subjectKey: z.string().optional().describe("Which focus to end, when more than one is open. Newest when absent.") }
          : {}),
        note: z.string().optional().describe("Where they left it, in their words — what picking back up will read."),
      },
      async (args) => {
        const { pickup } = await capability.focus();
        const wanted = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : undefined);
        const entry = wanted
          ? [...pickup.current].reverse().find((e) => e.subject === wanted)
          : pickup.current.at(-1);
        if (!entry) {
          return err(
            wanted ? `The user is not on "${wanted}" right now.` : "The user is not on anything right now — there is no focus to end.",
          );
        }
        try {
          const ended = await capability.endFocus(entry.id, {
            reason: args.reason === "done" ? "done" : "paused",
            ...(typeof args.note === "string" && args.note.trim() ? { note: args.note } : {}),
          });
          return json({
            subject: ended.subject,
            reason: args.reason,
            note: "Recorded. This is a fact about their attention, not a status on any work, and it does not move their screen.",
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "spool_look",
      LOOK,
      // The master names a subject; a scoped session's subject is a fact, so it
      // takes no argument — the same scope rule as every verb here. There is
      // deliberately NO acknowledge tool beside this one: "noted" is the
      // human's verb, and an agent draining the user's observations would be an
      // agent deciding what the user has seen.
      scope === undefined
        ? { subjectKey: z.string().min(1).describe("The subject to look at — its key from spool_list_items' `project` field.") }
        : {},
      async (args) => {
        const subject = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : "");
        if (!subject) return err("Name the subject to look at.");
        let outcome: SpoolLookOutcome;
        try {
          outcome = await capability.look(subject);
        } catch (e) {
          return err(`Could not look at "${subject}": ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!outcome.terrain) {
          return json({ subject, note: outcome.note ?? "This subject has no terrain — there is nowhere to look." });
        }
        const observations = (outcome.look?.observations ?? []).filter((o) => !o.acknowledged);
        return json({
          subject,
          repo: outcome.terrain.repo,
          // The label, quoted with its attribution — the only form of time a
          // surface or a relay may carry out of here.
          ...(outcome.look ? { looked: outcome.look.lastLooked } : {}),
          fresh: outcome.fresh,
          ...(outcome.error ? { error: outcome.error } : {}),
          observations: observations.map((o) => ({ id: o.id, text: o.text, refs: o.refs })),
          ...(observations.length === 0 && !outcome.error ? { note: "Nothing is waiting to be relayed." } : {}),
        });
      },
    ),
    tool(
      "spool_pin",
      PIN_ITEM,
      {
        itemId: z.string().min(1),
        day: z
          .string()
          .optional()
          .describe(
            'The date the USER stated, written out: "2026-08-19". Strict YYYY-MM-DD — the engine refuses anything ' +
              "else. Never a date you resolved from a relative phrase. Required unless clearing.",
          ),
        clear: z.boolean().optional().describe("True to remove the pin, when the user asks to unpin. The task itself is untouched."),
      },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        const clear = args.clear === true;
        const day = typeof args.day === "string" ? args.day.trim() : "";
        if (!clear && !day) return err("Pass the day the user stated (YYYY-MM-DD), or clear: true to remove the pin.");
        if (clear && day) return err("Pass day OR clear, not both — pinning to a day and clearing the pin are opposite moves.");
        // Scope first, byte-identical to not-found — the oracle rule, same as
        // every write verb here.
        const existing = await capability.item(itemId);
        if (!existing || !inScope(existing.item)) return err(`No spool item found with id "${itemId}".`);
        let updated: SpoolItem;
        try {
          // Through the SAME update path the human API uses, so the store's one
          // gate — strict date, real calendar day, loud sentence — is the only
          // implementation of the rule.
          updated = await capability.update(itemId, { pinned: clear ? null : { day } });
        } catch (e) {
          return err(`Could not ${clear ? "unpin" : "pin"} "${itemId}": ${e instanceof Error ? e.message : String(e)}`);
        }
        return json({
          id: updated.id,
          title: updated.title,
          ...(updated.pinned ? { pinned: updated.pinned } : {}),
          note: clear
            ? "Unpinned. The task keeps its lane, its rank and everything else — only the day mark is gone."
            : `Pinned to ${day} — the user's own date, recorded verbatim. Nothing was scheduled, started or reordered by this.`,
        });
      },
    ),
    tool(
      "spool_set_area_permits",
      SET_AREA_PERMITS,
      /**
       * THE AREA IS NAMED BY EVERY SESSION — a deliberate reading of the scope
       * rule rather than a breach of it. Terrain and identity resolve a scoped
       * session's SUBJECT as a fact about the session; an area is not a fact
       * about any session — it spans subjects, possibly none of them this
       * one's — so there is nothing to resolve and the name comes from the
       * user's own words, exactly as the provenance law requires anyway.
       */
      {
        area: z.string().min(1).describe('The area name the USER stated, verbatim: "Personal", "Trabajo". Never a name you coined.'),
        ceiling: SpoolSubjectPermits.optional().describe(
          'The ceiling the user stated. "read" = glance and brief only; "draft" = may propose an approach; "propose" = may open a PR. Required unless clearing.',
        ),
        clear: z.boolean().optional().describe("True to withdraw the ceiling, when the user says the area no longer needs one."),
      },
      async (args) => {
        const area = typeof args.area === "string" ? args.area.trim() : "";
        if (!area) return err("Name the area the user was talking about.");
        const clear = args.clear === true;
        const ceiling = SpoolSubjectPermits.safeParse(args.ceiling);
        // Same bare-harness guard as the aperture's: a misspelt level must
        // refuse loudly, not read as "no ceiling given".
        if (args.ceiling !== undefined && !ceiling.success) {
          return err(
            `"${String(args.ceiling)}" is not a permit level. Pick one of ${SpoolSubjectPermits.options
              .map((p) => `"${p}"`)
              .join(", ")}.`,
          );
        }
        if (!clear && !ceiling.success) return err("Pass the ceiling the user stated, or clear: true to withdraw it.");
        if (clear && ceiling.success) return err("Pass ceiling OR clear, not both — stating a ceiling and withdrawing it are opposite moves.");
        try {
          const updated = await capability.setAreaPermits(area, clear ? null : ceiling.success ? ceiling.data : null);
          return json({
            area: updated.name,
            ceiling: updated.ceiling ?? null,
            note: clear
              ? "The ceiling is withdrawn — every subject in the area is back to exactly what it states on its own."
              : `Recorded. Every subject in "${updated.name}" is now clamped to "${String(updated.ceiling)}" or its own permit, whichever is lower — a ceiling restricts, it never raises.`,
          });
        } catch (e) {
          return err(`Could not set a ceiling on "${area}": ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      "spool_set_terrain",
      SET_TERRAIN,
      {
        ...(scope === undefined
          ? { subjectKey: z.string().min(1).describe("The subject the user was talking about.") }
          : {}),
        repo: z
          .string()
          .optional()
          .describe('The address the USER stated, as `owner/name` — e.g. "example-owner/sample-project". Required unless clearing.'),
        notes: z
          .string()
          .optional()
          .describe('The user\'s own facts about the place, verbatim where possible: "milestones are phases; needs-approval is the accept gate".'),
        clear: z.boolean().optional().describe("True to withdraw the terrain, when the user says the address is wrong."),
      },
      async (args) => {
        const subject = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : "");
        if (!subject) return err("Name the subject the user was talking about.");
        const clear = args.clear === true;
        const repo = typeof args.repo === "string" ? args.repo.trim() : "";
        if (!clear && !repo) return err("Pass the repo the user stated (`owner/name`), or clear: true to withdraw the terrain.");
        try {
          const updated = await capability.setTerrain(
            subject,
            clear
              ? null
              : { kind: "github-repo", repo, ...(typeof args.notes === "string" && args.notes.trim() ? { notes: args.notes } : {}) },
          );
          return json({
            subject: updated.key,
            terrain: updated.terrain ?? null,
            note: clear
              ? "The terrain is withdrawn. The subject keeps everything else — a subject with no terrain is an ordinary subject."
              : "Recorded. The Spool can now glance at this address when the user arrives — it still starts nothing on its own.",
          });
        } catch (e) {
          return err(`Could not set terrain on "${subject}": ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      "spool_set_subject_identity",
      SET_SUBJECT_IDENTITY,
      {
        // The master names a subject; a scoped session's subject is a fact, so
        // it takes no argument — the standing scope rule, same as set_terrain.
        ...(scope === undefined
          ? { subjectKey: z.string().min(1).describe("The subject the user was talking about.") }
          : {}),
        area: z
          .string()
          .optional()
          .describe('The group name the USER stated, verbatim: "Trabajo", "Personal". Never a name you coined.'),
        color: SpoolSubjectColor.optional().describe(
          "The identity token the user picked, or the closest token to the color they named " +
            '("mar" → "sea"). Identity only — never chosen to signal urgency or state.',
        ),
        clearArea: z.boolean().optional().describe("True to withdraw the area, when the user says it no longer belongs there."),
        clearColor: z.boolean().optional().describe("True to withdraw the color, when the user asks for none."),
      },
      async (args) => {
        const subject = scope ?? (typeof args.subjectKey === "string" ? args.subjectKey : "");
        if (!subject) return err("Name the subject the user was talking about.");
        const area = typeof args.area === "string" ? args.area.trim() : "";
        const color = SpoolSubjectColor.safeParse(args.color);
        // The SDK's own schema refuses a stray token before this line runs; the
        // check exists so the bare test harness (and any future transport that
        // skips schema validation) refuses just as loudly instead of silently
        // treating a misspelt token as "no color given".
        if (args.color !== undefined && !color.success) {
          return err(
            `"${String(args.color)}" is not a color the Spool knows. Pick one of ${SpoolSubjectColor.options
              .map((c) => `"${c}"`)
              .join(", ")}.`,
          );
        }
        if (area && args.clearArea === true) return err("Pass area OR clearArea, not both — naming a group and withdrawing it are opposite moves.");
        if (color.success && args.clearColor === true) return err("Pass color OR clearColor, not both — picking a color and withdrawing it are opposite moves.");
        const patch: { area?: string | null; color?: SpoolSubjectColor | null } = {
          ...(args.clearArea === true ? { area: null } : area ? { area } : {}),
          ...(args.clearColor === true ? { color: null } : color.success ? { color: color.data } : {}),
        };
        if (!("area" in patch) && !("color" in patch)) {
          return err("Name what the user stated — an area, a color, or clearArea / clearColor to withdraw one.");
        }
        try {
          const updated = await capability.setIdentity(subject, patch);
          return json({
            subject: updated.key,
            area: updated.area ?? null,
            color: updated.color ?? null,
            note: "Recorded, in the user's own terms. Identity says whose this subject is — nothing about its urgency or its work changed.",
          });
        } catch (e) {
          return err(`Could not set identity on "${subject}": ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      "spool_shelf",
      SHELF,
      // The master may narrow to a subject; a scoped session's subject is a
      // fact, so its only argument is which note to open — the standing scope
      // rule, same as every read here.
      {
        noteId: z.string().optional().describe("Read ONE note in full. Leave it off to list the shelf."),
        ...(scope === undefined
          ? { subjectKey: z.string().optional().describe("Narrow the list to one subject's notes. Leave it off for the whole shelf.") }
          : {}),
      },
      async (args) => {
        // A scoped session sees its own subject's notes and nothing else — a
        // floating (subjectless) note is cross-subject knowledge and belongs
        // to the master's view, the same rule floating items follow.
        const inShelfScope = (note: SpoolNote) => scope === undefined || note.subjectKey === scope;
        const notes = (await capability.notes()).filter(inShelfScope);
        const noteId = typeof args.noteId === "string" && args.noteId ? args.noteId : undefined;
        if (noteId) {
          // Byte-identical for out-of-scope and non-existent — the oracle rule.
          const found = notes.find((note) => note.id === noteId);
          if (!found) return err(`No shelf note found with id "${noteId}".`);
          return json({
            id: found.id,
            subject: found.subjectKey ?? "floating",
            title: found.title,
            body: found.body,
            tags: found.tags,
            author: found.author,
            created: found.created.label,
            updated: found.updated.label,
            ...(found.retired ? { retired: { reason: found.retired.reason, at: found.retired.label } } : {}),
          });
        }
        const wanted = scope ?? (typeof args.subjectKey === "string" && args.subjectKey ? args.subjectKey : undefined);
        const listed = wanted === undefined ? notes : notes.filter((note) => note.subjectKey === wanted);
        return json({
          scope: wanted ?? "everything",
          notes: listed.map((note) => ({
            id: note.id,
            subject: note.subjectKey ?? "floating",
            title: note.title,
            tags: note.tags,
            author: note.author,
            updated: note.updated.label,
            // Marked, never hidden — retirement drains, and a list that hid a
            // retired note would make the drain a delete.
            ...(note.retired ? { retired: true } : {}),
          })),
          ...(listed.length === 0 ? { note: "The shelf holds nothing here yet." } : {}),
        });
      },
    ),
    tool(
      "spool_write_note",
      WRITE_NOTE,
      {
        noteId: z.string().optional().describe("Edit an existing note from spool_shelf. Leave it off to write a new one."),
        title: z.string().optional().describe("What the knowledge is about, in a few words. Required for a new note."),
        body: z.string().optional().describe("The knowledge itself, as markdown — the user's own words wherever possible. Required for a new note."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Labels in the user's own words, replaced whole on an edit. Only tags the user asked for or stated."),
        ...(scope === undefined ? { subjectKey: SUBJECT_ARG } : {}),
      },
      async (args) => {
        const title = typeof args.title === "string" ? args.title : undefined;
        const bodyText = typeof args.body === "string" ? args.body : undefined;
        const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
        const noteId = typeof args.noteId === "string" && args.noteId ? args.noteId : undefined;
        if (noteId) {
          // Scope first, byte-identical to not-found — the oracle rule, same
          // as every write verb here.
          const existing = (await capability.notes()).find(
            (note) => note.id === noteId && (scope === undefined || note.subjectKey === scope),
          );
          if (!existing) return err(`No shelf note found with id "${noteId}".`);
          const patch = {
            ...(title !== undefined ? { title } : {}),
            ...(bodyText !== undefined ? { body: bodyText } : {}),
            ...(tags !== undefined ? { tags } : {}),
          };
          if (Object.keys(patch).length === 0) {
            return err(`Nothing to change on "${noteId}" — pass a title, a body, or tags.`);
          }
          try {
            const updated = await capability.updateNote(noteId, patch);
            return json({
              id: updated.id,
              title: updated.title,
              tags: updated.tags,
              author: updated.author,
              note: "Edited. The author does not change — who wrote it is provenance, not a field.",
            });
          } catch (e) {
            return err(`Could not edit "${noteId}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (!title || !bodyText) {
          return err("A new note needs a title and a body — the knowledge itself, in the user's own words wherever possible.");
        }
        const subjectKey = scope ?? (typeof args.subjectKey === "string" && args.subjectKey ? args.subjectKey : undefined);
        try {
          const created = await capability.createNote({
            title,
            body: bodyText,
            ...(tags !== undefined ? { tags } : {}),
            /**
             * FOR A SCOPED SESSION, SERVER-SUPPLIED AND NOTHING ELSE — the same
             * construction `spool_create_item` states. The master's argument
             * rides only when the session has no scope.
             */
            ...(subjectKey ? { subjectKey } : {}),
            // THE ONE DECLARATION OF AUTHORSHIP, and it is this handler's own
            // code making it — never a model argument, exactly like an item's
            // `source`.
            author: "session",
          });
          return json({
            id: created.id,
            subject: created.subjectKey ?? "floating",
            title: created.title,
            tags: created.tags,
            author: created.author,
            note: "On the shelf, marked as written from this session. It is knowledge, not work — nothing was filed, started or scheduled.",
          });
        } catch (e) {
          return err(`Could not write "${title}": ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      "spool_search",
      SEARCH,
      // The master may narrow to a subject; a scoped session searches its own
      // slice and takes no subject argument — the standing scope rule.
      {
        query: z.string().min(1).describe("The words to find, ideally the user's own. Accents are ignored; meaning is not inferred."),
        ...(scope === undefined
          ? { subjectKey: z.string().optional().describe("Narrow to one subject. Leave it off to search everything.") }
          : {}),
      },
      async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) return err("Say what to search for.");
        const subject = scope ?? (typeof args.subjectKey === "string" && args.subjectKey ? args.subjectKey : undefined);
        let hits: SpoolSearchHit[];
        try {
          hits = await capability.search(query, subject);
        } catch (e) {
          return err(`Could not search: ${e instanceof Error ? e.message : String(e)}`);
        }
        return json({
          query,
          scope: subject ?? "everything",
          hits,
          ...(hits.length === 0
            ? { note: "Nothing matched. The search is lexical — try the user's own words or another spelling before concluding it is not there." }
            : {}),
        });
      },
    ),
  ];
}
