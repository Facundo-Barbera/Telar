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
 *   · NO ACCEPT PATH. No tool here transitions anything, and the item schema
 *     carries no status/state/done/accepted field to transition. Filing a task
 *     is PREPARE, never COMMIT.
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
import type { SpoolExpertOutcome, SpoolItem, SpoolItemDetail, SpoolLane, SpoolSnapshot } from "@telar/engine-client";

/**
 * What the toolkit may do, narrowed to four verbs.
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
  create(input: { title: string; lane?: string; project?: string; creationNote?: string }): Promise<SpoolItem>;
  update(
    id: string,
    patch: { title?: string; lane?: string; desk?: boolean; unplaced?: boolean; mirrored?: string },
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

/**
 * Build the four tools.
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
      // `notebook_path`. See the header.
      { title: z.string().min(1), laneKey: z.string().optional() },
      async (args) => {
        const title = String(args.title ?? "");
        const laneKey = typeof args.laneKey === "string" ? args.laneKey : undefined;
        let item: SpoolItem;
        try {
          item = await capability.create({
            title,
            ...(laneKey ? { lane: laneKey } : {}),
            // SERVER-SUPPLIED. The one place the session's project reaches the
            // store, and it cannot come from anywhere else — there is no
            // `project` argument on this shape.
            ...(scope ? { project: scope } : {}),
            creationNote: "captured from this session",
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
      // EXACTLY the patchable fields, minus `project` (a scope, and scope is
      // never a tool input) and minus `deadline`. See the header for why a
      // verdict may never appear here even once verdicts exist again.
      {
        itemId: z.string().min(1),
        title: z.string().min(1).optional(),
        laneKey: z.string().optional(),
        desk: z.boolean().optional(),
        unplaced: z.boolean().optional(),
        mirrored: z.string().optional(),
      },
      async (args) => {
        const itemId = String(args.itemId ?? "");
        const patch: { title?: string; lane?: string; desk?: boolean; unplaced?: boolean; mirrored?: string } = {};
        if (typeof args.title === "string") patch.title = args.title;
        if (typeof args.laneKey === "string") patch.lane = args.laneKey;
        if (typeof args.desk === "boolean") patch.desk = args.desk;
        if (typeof args.unplaced === "boolean") patch.unplaced = args.unplaced;
        if (typeof args.mirrored === "string") patch.mirrored = args.mirrored;
        if (Object.keys(patch).length === 0) {
          return err(
            `Nothing to change on "${itemId}" — pass at least one of title, laneKey, desk, unplaced or mirrored.`,
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
  ];
}
