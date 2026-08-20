/**
 * engine protocol v2 — Spool: the item store behind SPEC-organization-workspace.
 *
 * Ported from `packages/core/src/workspace/schema.ts`. The spec calls this
 * module "the organization workspace"; `workspace` was already taken twice in
 * this protocol — `SessionWorkspace`/`WorkspaceFile`/`WorkspaceListing` in
 * `./entities.ts` mean the session's WORKING TREE, and `./items.ts`'s `Item` is
 * a timeline row — so the module is Spool here. `docs/spool-port.md` holds the
 * translation table and the full reasoning. The spec's prose is unchanged and
 * still says "workspace" throughout.
 *
 * WHY THE PERSISTED SHAPES ARE PROTOCOL SHAPES, which is a deviation from the
 * donor. `NFR-X-5` put persisted schemas in `@telar/core` and forbade `apps/web`
 * from redefining them; here neither app may import core at all, and the engine
 * already treats the protocol as its persistence schema — `state.ts` imports
 * `Session as SessionSchema`, `Task as TaskSchema` and parses documents off disk
 * with them. One definition site was the point of NFR-X-5 and this is where it
 * now is. The engine's `spool/store.ts` reads and writes with these; the web
 * renders from them.
 *
 * `z.looseObject`, NOT `z.object`, on every shape a packet nests (SpoolItem,
 * SpoolDeadline, SpoolSubtask, SpoolTimelineEvent, SpoolLoomRef). Do not "tidy"
 * any of these to `z.object`: a strict NESTED shape silently DESTROYS an unknown
 * key on the next update, which a strict top-level item would not, and that
 * asymmetry is worse than being strict everywhere. `SpoolLane` is deliberately
 * the one shape here that stays `z.object` — it is not part of a packet.
 */
import { z } from "zod";

// ── the nested shapes ───────────────────────────────────────────────────────

/**
 * `item-model.md` § Deadline. `label` is coarse human text ("Fri", "Sep 2") and
 * is NEVER a date to compare — the module forbids clocks and scheduling, and
 * nothing in this tree performs a comparison on it anywhere.
 */
export const SpoolDeadlineKind = z.enum(["external", "self"]);
export type SpoolDeadlineKind = z.infer<typeof SpoolDeadlineKind>;

export const SpoolDeadline = z.looseObject({
  label: z.string(),
  kind: SpoolDeadlineKind,
  /** Self-deadlines only: how often this slid (CAP-7's witness). A witness,
   *  never an alarm — nothing here schedules on it. */
  slips: z.number().optional(),
});
export type SpoolDeadline = z.infer<typeof SpoolDeadline>;

/**
 * A PIN — the user's own placement of an item on a day. §3.2 as AMENDED
 * 2026-08-16: the calendar belongs to the human. The day is a date the USER
 * stated, stored verbatim as a strict ISO date so a calendar can draw it in the
 * right place; it is never compared against a clock to derive urgency, an
 * "overdue" state, or an order. HUMAN-OWNED: agents may write it only when
 * relaying a date the user said (provenance law §12) — never one they resolved
 * or invented.
 *
 * `day` IS STRICTLY `YYYY-MM-DD` and the store refuses anything else with a
 * sentence, because "Friday", "next week" and epoch numbers are exactly the
 * shapes a model reaches for when it starts computing dates instead of quoting
 * them.
 */
export const SpoolPin = z.looseObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type SpoolPin = z.infer<typeof SpoolPin>;

/**
 * Sub-tasks per `item-model.md`'s Item table are `{title, done}[]`; `id` is a
 * disclosed addition, forced because `promotedFrom` (below) names a PARENT ITEM
 * and a title is not a stable address.
 */
export const SpoolSubtask = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean().optional(),
});
export type SpoolSubtask = z.infer<typeof SpoolSubtask>;

/**
 * `item-model.md`'s Packet table gives `actor ∈ you | expert | bed`. `session`
 * is a disclosed widening by one member — a tolerant reader absorbs it, and a
 * renderer meeting an unknown actor shows a neutral icon rather than throwing.
 */
export const SpoolActor = z.enum(["you", "expert", "bed", "session"]);
export type SpoolActor = z.infer<typeof SpoolActor>;

/**
 * `item-model.md`'s Packet table: `{at, actor, text, proposal?}`. `at` is a
 * display label, same class as `SpoolItem.captured` below — never a comparable
 * stamp. `proposal: true` marks agent output awaiting a human look, which is
 * the prepare-never-commit law made visible.
 */
export const SpoolTimelineEvent = z.looseObject({
  at: z.string(),
  actor: SpoolActor,
  text: z.string(),
  proposal: z.boolean().optional(),
});
export type SpoolTimelineEvent = z.infer<typeof SpoolTimelineEvent>;

// ── WHAT IS DELIBERATELY ABSENT: EVERYTHING LOOM ────────────────────────────
//
// The contract gives an item two more fields than are declared below, and both
// name a loom:
//
//   · `tracking` — a weak reference to the loom an item was woven into, written
//     at ply time by the store's `trackLoom`, and rendered on the queue as the
//     mark that says a row is out at a loom without saying it is done.
//   · `verdict` — the expert's triage, whose entire content is the question
//     "should this be executed as a session or as a loom?", plus the durable
//     `verdictOverride` flag that makes a human's answer stick against a later
//     expert pass.
//
// LOOMS ARE NOT BUILT IN THIS APP. They exist only in the frozen legacy tree,
// and nothing in the engine can ply, land or accept one. A `tracking` field
// with no writer is dead weight; a verdict offering a destination that does not
// exist is worse — it is a question the user cannot answer correctly, rendered
// as though they could.
//
// So they are out until looms are. Issue #93 tracks that work and lists these
// as the exact re-attachment points. Restoring them is additive: both are optional
// fields, so a packet written by a future build that carries them still parses
// here (`z.looseObject` keeps unknown keys and no write path destroys them),
// and a packet written today needs no migration to gain them.

/**
 * A time-commitment mined out of a capture (the enrichment pass, feeding CAP-8's
 * gap detection). The spec pins where this comes from: "Mining time-commitments
 * from captures is expert work during the enrichment pass, not a separate parser
 * — the expert already reads every capture." So there is no commitment parser
 * anywhere in the tree; there is this shape, and the expert fills it.
 *
 * IT HANGS OFF THE ITEM, NOT OFF A SECOND STORE, for the same reason the desk is
 * a boolean on the item: the commitment was spoken INSIDE a capture, and the
 * capture is a packet. A floating capture keeps its commitments with no project
 * to file them under, which is a resting state `item-model.md` already blesses.
 *
 * `when` IS A COARSE HUMAN LABEL AND NOT A DATE — "Thursday", "next week",
 * "after the demo". Nothing in this store parses, compares or sorts it. Gap
 * detection asks the HUMAN whether the moment passed (the briefing is pull-based
 * and answers when arrived at); it does not compute the answer from a clock.
 *
 * `text` IS THE COMMITMENT IN THE CAPTURE'S OWN WORDS. Same law as `raw`: the
 * user must be able to check the expert did not invent a promise they never
 * made, so the quote is stored beside the expert's reading of it.
 */
export const SpoolExpectation = z.looseObject({
  id: z.string(),
  text: z.string(),
  when: z.string(),
  /** Which packet's capture it was mined from. Redundant with the item it is
   *  stored on today, and kept anyway: the briefing reads a flat list of every
   *  commitment in the store, and a line that cannot say which item it came from
   *  is a line nobody can act on. */
  itemId: z.string(),
  /** Display label of when the expert mined it, same class as `captured`. */
  mined: z.string(),
});
export type SpoolExpectation = z.infer<typeof SpoolExpectation>;

// ── subjects.json ───────────────────────────────────────────────────────────

/**
 * A SUBJECT — the thing an item is ABOUT, and the thing an expert belongs to.
 *
 * ── WHY THIS RECORD EXISTS ───────────────────────────────────────────────────
 * `SpoolItem.project` was a free-form string, which meant the module had ONE
 * noun doing three jobs: the fragment you dumped, the work you would sit down
 * and do, and — with nowhere else to put them — facts about a project's shape.
 * The third job is what produced `hito 1 cierra en dos semanas` as an ITEM: a
 * milestone's closing date is not a piece of work, and a drafting pass over it
 * spent all five of its questions asking for the record type that did not
 * exist.
 *
 * `docs/spool-definition.md` §7.2: "A subject needs to be a real thing with a
 * permitted-action level, where 'has a repo' is one property rather than the
 * price of admission."
 *
 * ── `SpoolItem.project` DOES NOT CHANGE SHAPE ────────────────────────────────
 * It already holds the slug; it simply stops being a bare label and becomes a
 * reference to `SpoolSubject.key`. So there is NO packet migration and no
 * `SPOOL_ITEM_SCHEMA_VERSION` bump — the migration is a one-way derivation of
 * this registry from the distinct `project` values already on disk. The field
 * keeps the name `project` for now; renaming it is mechanical across ten files
 * plus a packet migration, and would double a diff for no behaviour.
 */
export const SPOOL_SUBJECT_SCHEMA_VERSION = 1;

/**
 * WHAT THIS ASSISTANT MAY DO HERE, UNATTENDED — §7.6, the mechanism that makes
 * §3.1's "nothing lands" enforceable rather than advisory.
 *
 * ORDERED, AND EACH LEVEL CONTAINS THE ONE BELOW IT. It is not decorative and
 * not a setting waiting for a feature: `read` gates `needsRipening` and `draft`
 * gates `needsDrafting`, so the night's plan is subject-aware from the day this
 * lands. Lowering a subject to `read` stops it being drafted for, tonight.
 *
 * `propose` IS NOT REACHABLE YET and is declared anyway, because the level it
 * names — may open a pull request — is the one §3.1 turns on, and a runner that
 * discovers the vocabulary later tends to discover it as a boolean.
 *
 * PER SUBJECT RATHER THAN PER ACTION, which §9's third open question calls
 * "simpler and probably wrong at the edges" — "may open PRs" and "may spend API
 * budget overnight" are not the same grant. Taken deliberately: `subjects.json`
 * is small and new, so turning one level into a set of grants is a cheap
 * migration on a cheap file, and the edges that actually bite are worth
 * observing rather than imagining.
 */
export const SpoolSubjectPermits = z.enum([
  /** An expert may read this subject and write a brief. The floor: a subject
   *  nothing may be done for is a subject that should not be filed to. */
  "read",
  /** Plus: may propose an approach. This is today's behaviour for everything. */
  "draft",
  /** Plus: may open a pull request. No code path reaches this yet. */
  "propose",
]);
export type SpoolSubjectPermits = z.infer<typeof SpoolSubjectPermits>;

/**
 * WHERE A SUBJECT LIVES IN THE WORLD — an address plus a few facts, stated once
 * by the human. `docs/spool-loops.md` §3: *"a terrain is an address plus a few
 * facts… A handful of lines, not a sync engine."*
 *
 * A DISCRIMINATED UNION WITH ONE MEMBER TODAY, deliberately. "Terrain types are
 * plural from day one — a repo, a directory, a URL, nothing. If a mechanism
 * only works for the GitHub case, it is not core." Declaring the union now
 * means adding `directory` or `url` later is a new arm, not a migration, and
 * every reader is already written against `kind` rather than against the one
 * shape that happens to exist.
 *
 * TERRAINS ARE OPTIONAL AND SUBJECTS WITHOUT ONE ARE FIRST-CLASS. School and a
 * client engagement have no terrain, and that is the ordinary case — a terrain
 * only gives the Spool one more place to look. Nothing downstream may require
 * one (the no-code test).
 */
export const SpoolTerrain = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("github-repo"),
    /** `owner/name`, exactly as `gh -R` takes it. The store guards the shape
     *  before it can ever reach a `gh` argv. */
    repo: z.string(),
    /** The few facts, in the human's own words: "milestones are Hitos;
     *  needs-approval is the accept gate." Prose for a model, never a field
     *  code branches on. */
    notes: z.string().optional(),
  }),
]);
export type SpoolTerrain = z.infer<typeof SpoolTerrain>;

/**
 * A SUBJECT'S IDENTITY COLOR — a closed set of named tokens, never a hex value.
 *
 * COLOR SAYS WHOSE A SUBJECT IS, NEVER HOW URGENT. This is Calendar's
 * per-calendar hue, not a status light: no code anywhere may map a token to a
 * state, a deadline or a priority, and the set is CLOSED so an "urgent red"
 * cannot be smuggled in as free hex. The web owns the mapping from token to an
 * actual oklch value; the engine stores only the name the user picked.
 */
export const SpoolSubjectColor = z.enum(["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"]);
export type SpoolSubjectColor = z.infer<typeof SpoolSubjectColor>;

/**
 * A CEILING ON WHAT AN AREA'S SUBJECTS PERMIT, UNATTENDED — "Personal never
 * gets worked without asking", said once about the group instead of once per
 * subject.
 *
 * A CEILING CLAMPS DOWN AND NEVER RAISES. A subject's effective permit is the
 * LOWER of what it states and what its area's ceiling allows, in
 * `SpoolSubjectPermits`' own order — a ceiling of "propose" over a subject at
 * "read" leaves the subject at "read". The clamp itself lives in the engine's
 * `effectivePermits`, the one function every enforcement path reads.
 *
 * CREATED LAZILY, AND NEVER WITH A CEILING BY DEFAULT. An area exists as a
 * free-text name on subjects long before this record does; the record appears
 * the first time someone states a ceiling for it, and NO area — "Personal"
 * included — is ever given one the user did not state. There is no delete
 * path: clearing the ceiling withdraws the statement and the record sits
 * harmlessly, exactly like a lowered permit.
 */
export const SpoolArea = z.looseObject({
  /** The user's own group name, verbatim — the same string `SpoolSubject.area`
   *  holds, which is the join key. */
  name: z.string(),
  /** The stated ceiling. Absent means no clamp — the ordinary case. */
  ceiling: SpoolSubjectPermits.optional(),
  /** Display label, minted by the store's clock like `SpoolSubject.created`. */
  created: z.string(),
  schemaVersion: z.number().default(1),
});
export type SpoolArea = z.infer<typeof SpoolArea>;

export const SpoolSubject = z.looseObject({
  /**
   * The slug `SpoolItem.project` holds, and the directory name its memory lives
   * under. Guarded exactly as an item id is — the store refuses a name it
   * cannot address on disk.
   */
  key: z.string(),
  /** What a human calls it. Free of the slug's constraints. */
  name: z.string(),
  /**
   * Telar's registered `Project`, when this subject HAS a checkout.
   *
   * A REFERENCE, NEVER AN EXTENSION. `Project` is wired through sessions,
   * worktrees and git; making it repo-optional would put a branch through all
   * of that — the same argument `master-chat.tsx` records for not making the
   * cockpit project-optional. And the polarity matters: a checkout is something
   * a subject HAS, not what a subject IS. School and a client engagement are
   * subjects with none, and that is the ordinary case rather than a degraded
   * one.
   */
  projectId: z.string().optional(),
  permits: SpoolSubjectPermits.default("draft"),
  /** Where this subject lives in the world, when the human has said. Absent is
   *  the ordinary case, not a degraded one — see `SpoolTerrain`. */
  terrain: SpoolTerrain.optional(),
  /**
   * The group the USER filed this subject under — "Trabajo", "Personal" —
   * Reminders' list-groups, in the user's own word. Free text because the
   * groups are the user's vocabulary, optional because an ungrouped subject is
   * an ordinary subject. Identity the human states, like `terrain` above:
   * never derived, never invented by an agent.
   */
  area: z.string().optional(),
  /** The identity hue the user picked, as a token from the closed set. Absent
   *  is the ordinary case — see `SpoolSubjectColor` for the identity-not-state
   *  law. */
  color: SpoolSubjectColor.optional(),
  /**
   * The user's own manual position among the other subjects in the SAME
   * `area` — a drag order, not a computed one, the way a Reminders list-group
   * remembers the hand that reordered it. Absent is the ordinary case: an
   * unranked subject sorts after every ranked one, never invented by the
   * store. Compared only against subjects sharing this one's `area` — see
   * `sortSubjectsByRank`.
   */
  rank: z.number().optional(),
  /** Display label, minted by the store's clock like `captured`. Never sorted
   *  on, never compared — the module forbids a clock that reaches a renderer. */
  created: z.string(),
  schemaVersion: z.number().default(SPOOL_SUBJECT_SCHEMA_VERSION),
});
export type SpoolSubject = z.infer<typeof SpoolSubject>;

// ── shelf.json ──────────────────────────────────────────────────────────────
//
// THE SHELF — documents beside the items (`docs/spool-loops.md` §10.1).
// Knowledge that is not work stops wearing task clothing: a guard note, a
// runbook, a client's preferences. Notes are written by the hand or by agents
// WHEN ASKED; agent-written notes carry their author, permanently. Retiring a
// note drains it — the record stays on disk with its reason — and nothing
// deletes.

export const SPOOL_NOTE_SCHEMA_VERSION = 1;

/** Label plus epoch, the split the focus log already carries: the label is what
 *  a surface quotes with attribution; the number is agent-facing only. */
export const SpoolNoteStamp = z.looseObject({ label: z.string(), at: z.number() });
export type SpoolNoteStamp = z.infer<typeof SpoolNoteStamp>;

/**
 * WHOSE HAND WROTE IT — the provenance law applied to knowledge. "you" is the
 * hand; "session" is any agent, which may write only what the user asked it to
 * keep. The author NEVER changes on edit: a note an agent wrote stays marked as
 * an agent's, even after the user touches its tags.
 */
export const SpoolNoteAuthor = z.enum(["you", "session"]);
export type SpoolNoteAuthor = z.infer<typeof SpoolNoteAuthor>;

export const SpoolNote = z.looseObject({
  id: z.string(),
  /** The subject this knowledge belongs to. ABSENT IS FLOATING, the same
   *  resting state an item's absent `project` is — cross-subject knowledge is
   *  ordinary, not degraded. */
  subjectKey: z.string().optional(),
  title: z.string(),
  /** Markdown, verbatim as written. The store never rewrites a body it did not
   *  receive. */
  body: z.string(),
  /** Free-text labels — the cross-cutting axis lanes and areas cannot express
   *  (§10.4). */
  tags: z.array(z.string()).default([]),
  created: SpoolNoteStamp,
  updated: SpoolNoteStamp,
  author: SpoolNoteAuthor,
  /** Drained, never deleted: a retired note leaves the shelf's working set and
   *  stays on disk with the reason it stopped mattering. */
  retired: z.looseObject({ label: z.string(), at: z.number(), reason: z.string() }).optional(),
  schemaVersion: z.number().default(SPOOL_NOTE_SCHEMA_VERSION),
});
export type SpoolNote = z.infer<typeof SpoolNote>;

// ── the search (§10.2) ──────────────────────────────────────────────────────

/**
 * ONE HIT from the deterministic lexical search over everything the Spool
 * holds. NO EMBEDDINGS, honestly: Telar does not support external embedding
 * models, so the search is lexical — tokenized, diacritic-folded, field-
 * weighted — and this shape carries no similarity score for a surface to dress
 * up as understanding.
 *
 * CLOSED THINGS ARE INCLUDED AND MARKED, ranked below open ones — hiding a
 * closed item from search would be a delete path wearing a filter's name.
 */
export const SpoolSearchHit = z.object({
  kind: z.enum(["item", "thread", "note", "observation"]),
  id: z.string(),
  /** The owning subject, when the thing has one. */
  subject: z.string().optional(),
  title: z.string(),
  /** A line of the matching text, from the field that matched best. */
  snippet: z.string(),
  /** True when the thing is closed, settled, retired or acknowledged — over,
   *  in its own vocabulary, and still findable. */
  closed: z.boolean().optional(),
});
export type SpoolSearchHit = z.infer<typeof SpoolSearchHit>;

// ── the socket (§10.3) ──────────────────────────────────────────────────────

/**
 * THE CONNECT CARD'S DATA — where the outward MCP socket listens and the
 * dedicated secret that opens it. The secret is DELIBERATELY NOT the engine's
 * management token: a chat client that leaks its MCP secret must not have
 * leaked engine admin with it. Served only behind the normal bearer token, so
 * the web can show a connect card and nothing else can ask.
 */
export const SpoolMcpInfo = z.object({
  url: z.string(),
  secret: z.string(),
  /** The `claude mcp add` line, composed by the engine so the card and the
   *  socket cannot disagree about the header shape. */
  addCommand: z.string(),
});
export type SpoolMcpInfo = z.infer<typeof SpoolMcpInfo>;

// ── experts/<project>/digest.json ───────────────────────────────────────────

/**
 * The version this build WRITES. Unlike a packet, a digest IS re-derivable — it
 * is the expert's own compression of a project, and a later pass rewrites it —
 * so there is no digest migration and an unreadable digest degrades to "no
 * digest" (a cold expert with nothing to rehydrate from) rather than to a throw.
 * The field is recorded so a future build can tell what wrote it.
 */
export const SPOOL_DIGEST_SCHEMA_VERSION = 1;

/**
 * One term the project says in shorthand, and what it means in full. This is the
 * field CAP-9's "decompress shorthand a generic agent cannot" cashes out as: a
 * generic model reading "the SEP path" learns nothing; an expert rehydrated from
 * a digest that spells it out does.
 */
export const SpoolDigestTerm = z.looseObject({
  term: z.string(),
  means: z.string(),
});
export type SpoolDigestTerm = z.infer<typeof SpoolDigestTerm>;

/**
 * WHAT KIND OF FACT THIS IS — and therefore how long it is good for, and who is
 * allowed to correct it.
 *
 * THESE FOUR ARE NOT INVENTED. They are the four already mixed into one
 * `notes: string[]` on disk, with one volatility between them:
 *
 *   · "Reconciliation core logic: packages/module-pd/src/core/reconciliation.ts,
 *      auto-copied to supabase/functions/_shared/…"      → howItWorks
 *   · "Ana appears to be a stakeholder tracking budget-vs-actuals"  → person
 *   · "Aurora has no locally reachable codebase … searched thoroughly this
 *      time"                                              → environment
 *
 * That last one is the case that forced this: it is a CACHE ENTRY WITH NO
 * EXPIRY, written into a blob with no retraction verb, telling every future
 * pass not to look. The day aurora gets a checkout it becomes a lie that
 * suppresses work, and nothing could remove it.
 */
export const SpoolMemoryKind = z.enum([
  /** How the subject works. Verifiable against a tree, and decays with it. */
  "howItWorks",
  /** People and the social shape of the work. Not verifiable from any repo —
   *  only the human can correct it, so it is never retired automatically. */
  "person",
  /** What was decided and why. Permanent, highest-value, and until now
   *  homeless: it could only live as a timeline note on whichever item happened
   *  to be open when it was said. */
  "decision",
  /** Reachability and other state of the world. NOT DURABLE — this is a cache,
   *  and marking it as one is what lets it expire instead of misleading. */
  "environment",
]);
export type SpoolMemoryKind = z.infer<typeof SpoolMemoryKind>;

/**
 * ONE REMEMBERED FACT, individually addressable — which is the whole change.
 *
 * ── WHY IT IS NOT A STRING ANY MORE ──────────────────────────────────────────
 * A digest used to be handed to `writeExpertDigest` WHOLE, rebuilt from scratch
 * by whichever pass ran last. Three consequences, all bad: a fact the current
 * item did not touch silently evaporated; nothing carried provenance, so a fact
 * from the first pass wore the timestamp of the most recent; and nothing could
 * be retracted except by hoping a model chose to drop it.
 *
 * ── THE LAW THIS BENDS, AND EXACTLY HOW FAR ──────────────────────────────────
 * `SpoolExpertDigest` below states that every field is prose "for a model to
 * read, not a record for code to branch on", because a digest that grew a
 * `status` or a `nextAction` would be a second, agent-writable planner sitting
 * beside the item store.
 *
 * That stays true of the WORK. What code may branch on here is TRUSTWORTHINESS
 * — how old a fact is, what it was checked against, whether a human has looked.
 * `status` and `nextAction` remain forbidden BY NAME. A field that decides what
 * gets worked on belongs on the item or the plan, never here.
 *
 * ── `retired` IS NOT A DELETION, AND NOT A NEW LAW ───────────────────────────
 * "No deletion path. Dismissing drains. Nothing here deletes." A retired fact
 * stays on disk, marked, with its reason, and is left out of the prompt. That
 * is the drain verb the law already prescribes, applied to an agent's note
 * instead of to a human's item.
 */
export const SpoolMemoryFact = z.looseObject({
  id: z.string(),
  text: z.string(),
  kind: SpoolMemoryKind,
  /** The pass label that wrote it — the same label its timeline events carry,
   *  so a fact can be traced to the consultation that produced it. */
  source: z.looseObject({ pass: z.string() }),
  /**
   * A HUMAN HAS LOOKED. Absent means an agent asserted this and nobody has
   * checked, which is the provenance law applied to memory: "every artifact an
   * agent produced is marked as such until a human has looked at it."
   */
  reviewed: z.boolean().optional(),
  /**
   * The commit this was last EXAMINED AGAINST AND NOT CONTRADICTED — not
   * "proven true". A `howItWorks` fact nothing could be found against has been
   * examined, and examining it again at the same commit reaches the same
   * answer; when the tree moves it is selected again.
   *
   * THE WORDING IS LOAD-BEARING. Read as "proven", the `verify` job would only
   * stamp what a model positively confirmed — and the prompt tells it to stay
   * silent about anything it could not check, so the rest would stay selected
   * forever and the job would re-run every night to learn nothing. The first
   * live run left 3 of 10 facts in exactly that state.
   */
  verifiedAt: z.string().optional(),
  /** Drained rather than deleted. A retired fact is excluded from every prompt
   *  and stays readable on disk, with the reason it stopped being true. */
  retired: z.looseObject({ at: z.string(), why: z.string() }).optional(),
});
export type SpoolMemoryFact = z.infer<typeof SpoolMemoryFact>;

/**
 * THE PROJECT'S DURABLE STATE DIGEST — CAP-9's rehydration source and the spec's
 * "experts write, master reads" made into a file.
 *
 * EVERY FIELD IS PROSE OR A LIST OF PROSE, deliberately. This is a memory for a
 * model to read, not a record for code to branch on: nothing in this tree
 * switches on any field below, and a digest that grew a `status` or a
 * `nextAction` would be a second, agent-writable planner sitting beside the item
 * store — precisely the line "agents may not commit" draws.
 */
export const SpoolExpertDigest = z.looseObject({
  /** The owning project slug. Also the directory name — the store guards it
   *  exactly as it guards an item id. */
  project: z.string(),
  schemaVersion: z.number().default(SPOOL_DIGEST_SCHEMA_VERSION),
  /** Display label of the last pass that wrote it, same class as `captured`. */
  updated: z.string(),
  /** "Where this project is, in a paragraph" — the sit-down overview's "where
   *  each project was left" band reads this and nothing else. */
  summary: z.string().default(""),
  /** How this project works: its own methodology, which for a MIRRORED project
   *  is the foreign tracker's methodology translated ("foreign structures stay
   *  foreign… the expert doubles as translator of that project's
   *  methodology"). */
  methodology: z.string().default(""),
  /** MERGED BY `term`, never replaced wholesale: a definition survives a pass
   *  that did not happen to restate it. Vocabulary is the most durable thing
   *  here and was the most easily lost. */
  glossary: z.array(SpoolDigestTerm).default([]),
  /**
   * What the expert knows, as individually addressable facts.
   *
   * WAS `notes: string[]`, REWRITTEN WHOLE BY EVERY PASS. See `SpoolMemoryFact`
   * for why that had to end. A pass may now ADD facts and PROPOSE retiring one;
   * it may not replace the array, so nothing evaporates because the item being
   * read happened to be about something else.
   *
   * `summary` and `methodology` above are still rewritten wholesale, and should
   * be — an overview is exactly the thing that is correct to regenerate.
   */
  facts: z.array(SpoolMemoryFact).default([]),
});
export type SpoolExpertDigest = z.infer<typeof SpoolExpertDigest>;

/**
 * THE FRONT DOOR'S OWN MEMORY — `spool/memory.json`.
 *
 * The project-less master chat had NO memory at all. Every cross-subject fact,
 * every preference, every decision that is not about one project had nowhere to
 * live, which is why "ask where I stopped" is a tool-calling expedition every
 * single time rather than a read. Same conceptual error the night had: asking a
 * model instead of drawing a record.
 *
 * SAME FACT SHAPE, no `project` key. At the store root beside `lanes.json`
 * rather than at `experts/_self/` — `_self` is a legal slug under the store's
 * own naming rule, so a subject could collide with it.
 */
export const SpoolSelfMemory = z.looseObject({
  schemaVersion: z.number().default(SPOOL_DIGEST_SCHEMA_VERSION),
  updated: z.string(),
  facts: z.array(SpoolMemoryFact).default([]),
});
export type SpoolSelfMemory = z.infer<typeof SpoolSelfMemory>;

// ── experts/<subject>/threads.json ──────────────────────────────────────────
//
// THE UNIT IS THE OPEN QUESTION, NOT THE CAPTURED ITEM.
//
// ── THE EVIDENCE THIS EXISTS, FROM THE STORE ─────────────────────────────────
// The expert found the relationship and had nowhere to put it. On
// `packets/i-31560cdd827b`, its own timeline event reads:
//
//   "Folded in a new, closely-related investigation thread
//    (Supermetrics-vs-direct-API parity)"
//
// `presupuestos sept no cuadran` and `paridad supermetrics vs apis` are ONE
// investigation — does our reported ad data match what the platforms say — and
// the store held them as two rows sharing a `project` STRING. The word "thread"
// is the model's own; it had only a prose timeline to write it into.
//
// The digest shows the same pressure. `facts[]` is one `text: string`, and on
// disk it is carrying five different kinds of knowledge: a cross-reference to
// another item BY TITLE AND DATE (f-legacy-4), a disambiguation (f-legacy-5), a
// note to its own future self (f-legacy-8), an open to-do (f-legacy-9), and a
// hypothesis about a person with a standing instruction (f-legacy-2).
//
// ── WHY THIS IS THE LAWS WORKING, NOT A NEW MECHANISM ────────────────────────
// "Compress, never multiply" finally has teeth. Two captures about one question
// are two rows FOREVER today; as a thread, the second capture makes the thread
// thicker rather than the list longer. The queue stops growing with your input
// and starts growing with your open questions — which get answered.
//
// ── AND ALMOST NOTHING HERE IS NEW ───────────────────────────────────────────
// The question is `SpoolItem.openQuestions`. What is known is `SpoolMemoryFact`
// with its `verifiedAt`. Who is waiting is `SpoolExpectation`. What would settle
// it is `acceptance`. The raw captures are `raw`, never overwritten. The module
// has been building the PARTS of a thread and calling each one an item; what was
// missing is the container and the edges. So this file adds one record that
// REFERENCES what already exists and copies none of it.

export const SPOOL_THREAD_SCHEMA_VERSION = 1;

/**
 * WHO THE THREAD IS STUCK ON — the one thing that decides whether you can move
 * it right now.
 *
 * THREE KINDS AND NOT A PRIORITY. "Waiting on you" is a BLOCKED STATE, the same
 * class of fact as `SpoolDeskCard.needsYou`, which the desk already sorts on for
 * the reason stated there: it is not a ranking. Nothing here orders threads by
 * importance, urgency or a clock.
 */
export const SpoolThreadWaiting = z.looseObject({
  kind: z.enum(["you", "agent", "person"]),
  /** Named when `kind` is "person" — "Ana", "Diego", the Tuesday counterpart.
   *  A NAME THE CAPTURE ALREADY CONTAINED, never a contact record: this module
   *  has no person store and must not grow one by the back door. */
  who: z.string().optional(),
  /** What it is stuck ON, in one short clause — "needs the live tracker". */
  note: z.string().optional(),
});
export type SpoolThreadWaiting = z.infer<typeof SpoolThreadWaiting>;

/**
 * ONE LIVE LINE OF INQUIRY INSIDE A SUBJECT.
 *
 * ── `settled` IS NOT AGENT-DECLARED DONENESS, AND THE DISTINCTION IS THE MOAT ─
 * The moat was never "nothing here is ever done" — it is that NO AGENT MAY
 * DECLARE a thing done. `docs/spool-loops.md` §9 corrected the earlier, wider
 * reading: `SpoolItem.closed` exists, and only the human API writes it, because
 * a human closing their own task is the purest form of "nothing lands without
 * the human" — it IS the human. This field keeps to the same amended law, for
 * three reasons that are checkable rather than rhetorical:
 *
 *   1. IT CARRIES AN ANSWER, NOT A STATE. The field's content is what was found
 *      out. A thread with no answer cannot be settled, so there is nothing here
 *      to flip.
 *   2. NO PASS REACHES IT. `ThreadChanges` — what a proposal pass is allowed
 *      to express — cannot name it, so nothing that decides for itself what to
 *      write can settle. The writers are the explicit human verbs and their
 *      relays: a settle spoken in conversation carrying the human's own answer,
 *      and the close cascade, which records the human's own close ("the user
 *      closed the task") — the human's hand in both cases, never a model's
 *      judgement. The answer requirement below is what keeps both honest.
 *   3. IT ANSWERS A QUESTION; IT DOES NOT COMPLETE WORK. "Does our ad data
 *      match?" resolving to "no, Meta diverges 6.83%" settles the QUESTION and
 *      starts the work. Nothing about a settled thread says anything shipped —
 *      only the human's own close on the ITEM says the task is over.
 *
 * A settled thread is NEVER removed. "No deletion path. Dismissing drains" is
 * the law, and here it turns into the payoff: a subject accumulates a visible
 * record of everything you actually worked out.
 */
export const SpoolThread = z.looseObject({
  id: z.string(),
  /** The owning subject's key — `SpoolSubject.key`, which is also the directory
   *  this file lives under, so the two cannot disagree. */
  subject: z.string(),
  /**
   * THE THING THAT IS NOT KNOWN, phrased as a question.
   *
   * READ WHEN YOU OPEN THE THREAD — never on the map. See `handle`.
   *
   * "paridad supermetrics vs apis" is what you typed; "Does our ad data match
   * what the platforms actually say?" is what it means.
   */
  question: z.string(),
  /**
   * THE SHORT FORM — three to six words. What the map actually draws.
   *
   * ── WHY THIS FIELD HAD TO EXIST ──────────────────────────────────────────
   * The map led with `question` and the result was a wall. The questions a pass
   * writes are analyst prose and correct at it — the live ozom-gv run produced
   * "Which of Hito 1's 8 open items are genuinely unblocked (vs. blocked by
   * another open item or held for JMB/Sergio confirmation) before it closes in
   * two weeks?" — twenty-seven words, three of those per subject, and the ply
   * reduced to six strokes beside a paragraph. The surface's own header promised
   * "prose lives in exactly one place: the thing you opened" and then broke it
   * on the first card.
   *
   * NO AMOUNT OF LAYOUT FIXES THAT. A card cannot be shape-first while its
   * primary element is a sentence, so the short string has to be DATA. This is
   * `fixed` beside `raw` again: two fields, two jobs, and neither standing in
   * for the other.
   *
   * OPTIONAL, AND THE MAP FALLS BACK TO A CLIPPED QUESTION. A thread written
   * before this field existed still draws, and a pass that returns a bad handle
   * is a wording problem rather than a missing row.
   */
  handle: z.string().optional(),
  /** The captures that fed it, by id. A REFERENCE AND NEVER A COPY — `raw` is
   *  never overwritten and must never be duplicated either, or there are two
   *  records of what you said and no rule about which one is true. */
  items: z.array(z.string()).default([]),
  /** `SpoolMemoryFact.id`s from this subject's digest. Also references: the
   *  fact's `verifiedAt` and `retired` are what the ply reads, and a copy here
   *  would go stale the moment the `verify` job runs. */
  facts: z.array(z.string()).default([]),
  waiting: SpoolThreadWaiting.optional(),
  /** Written ONLY by the human verb — see the header. */
  settled: z
    .looseObject({
      at: z.string(),
      /** What was found out. Required: a settle with no answer would be a
       *  status flip wearing this field's name. */
      answer: z.string(),
    })
    .optional(),
  /**
   * AN AGENT PROPOSED THIS GROUPING AND NOBODY HAS LOOKED — the provenance law
   * ("every artifact an agent produced is marked as such until a human has
   * looked at it") applied to the one thing that can go most wrong here.
   *
   * A WRONG THREAD ASSIGNMENT IS WORSE THAN NO THREADS. It is the documented way
   * problem-oriented records fail: a capture filed under the wrong question is a
   * capture you cannot find. So the grouping arrives marked, and stays marked.
   */
  proposed: z.boolean().optional(),
  created: z.string(),
  schemaVersion: z.number().default(SPOOL_THREAD_SCHEMA_VERSION),
});
export type SpoolThread = z.infer<typeof SpoolThread>;

/**
 * THE MARK, AS THREE COUNTS — what the map draws instead of prose.
 *
 * DERIVED AT READ TIME, never stored, for the same reason `SpoolAttachmentTally`
 * is: a stored count is a number that disagrees with what is on screen the
 * moment anything else writes.
 *
 * NOT A PROGRESS BAR. There is no finish line to be honest about — the module
 * refuses one everywhere else and would not earn one here. This is the thread's
 * COMPOSITION: how much is known and checked, how much is asserted but
 * unchecked, how much is still open. A nearly-answered thread LOOKS nearly
 * answered because it has one `open` left, not because anything computed a
 * percentage.
 */
export const SpoolThreadPly = z.object({
  /** Facts examined against the current tree and not contradicted. */
  verified: z.number(),
  /** Facts an agent asserted that nothing has checked. */
  unchecked: z.number(),
  /** Open questions across this thread's items — what is still not known. */
  open: z.number(),
  /** How many of your own raw captures fed it. YOUR words, counted separately
   *  from what was made of them. */
  captures: z.number(),
});
export type SpoolThreadPly = z.infer<typeof SpoolThreadPly>;

/** One thread with everything the map needs, in one read and with no second
 *  join — the rule `SpoolSnapshot` already states for the queue. */
export const SpoolThreadView = z.object({
  thread: SpoolThread,
  ply: SpoolThreadPly,
  /** Just enough of each item to open it AND to say where it came from. NOT the
   *  item: the map draws shape, and shipping 7 KB of prose per row to render a
   *  tick mark is the exact mistake `SpoolSnapshot` makes today. `said` is the
   *  one exception and it earns it — see `SpoolCaptureBrief.said`. */
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      said: z.string().optional(),
      pinned: SpoolPin.optional(),
      /** `true` when the user closed the capture's item — carried so the map
       *  can dim it, the same way it dims a settled thread. */
      closed: z.boolean().optional(),
    }),
  ),
});
export type SpoolThreadView = z.infer<typeof SpoolThreadView>;

/** One subject's map: its threads, and the captures no thread claims yet. */
/** Just enough of a capture to name it and open it. The map draws SHAPE, and
 *  shipping 7 KB of prose to render a tick is the mistake `SpoolSnapshot` makes. */
export const SpoolCaptureBrief = z.object({
  id: z.string(),
  title: z.string(),
  /**
   * YOUR OWN WORDS, verbatim and trimmed to a line.
   *
   * IT RIDES ALONG BECAUSE NOTHING ELSE MAKES THE MAP COMPREHENSIBLE. A surface
   * that said "Ana is waiting on September budget mismatch" gave the reader no
   * way in — the honest question was "where did that come from", and the answer
   * ("ana lo preguntó el jueves", five words, yours) is shorter than the
   * sentence it grounds.
   *
   * SHORT BY NATURE, unlike `fixed` or `draft`. This is the shorthand you
   * actually typed, so carrying it costs a line rather than the 7 KB that made
   * `SpoolSnapshot` a problem. Absent means the item has no raw — a session
   * created it — and a surface says nothing rather than inventing a source.
   */
  said: z.string().optional(),
  /** The user's own day for the capture, when they pinned one — a quote the
   *  map may draw, never an input to its order. */
  pinned: SpoolPin.optional(),
  /** `true` when the user closed the item. The capture stays on the map —
   *  hiding it would be a delete path — and the surface dims it instead. */
  closed: z.boolean().optional(),
});
export type SpoolCaptureBrief = z.infer<typeof SpoolCaptureBrief>;

export const SpoolSubjectThreads = z.object({
  subject: z.string(),
  permits: SpoolSubjectPermits,
  /** The area path PREFIX whose ceiling produced `permits`, when a ceiling
   *  actually lowered the subject's own stated grant (docs/spool-loops.md
   *  §13.7: an area name is a path, "Work / Focaltec", and every prefix's
   *  ceiling clamps down it — most restrictive wins). Absent means `permits`
   *  is exactly the subject's own statement. NEVER assume this equals the
   *  subject's own `area` verbatim — an ancestor segment's ceiling can be
   *  the one that won. */
  clampedBy: z.string().optional(),
  threads: z.array(SpoolThreadView),
  /** Items in this subject that no thread holds. NAMED RATHER THAN HIDDEN: an
   *  unclaimed capture is a resting state, and a map that silently omitted it
   *  would be a map you cannot trust to be complete. */
  loose: z.array(SpoolCaptureBrief),
});
export type SpoolSubjectThreads = z.infer<typeof SpoolSubjectThreads>;

/**
 * THE WHOLE MAP — every subject, plus the captures that belong to none.
 *
 * ── WHY `floating` IS A SIBLING AND NOT A SUBJECT ────────────────────────────
 * FOUND BY LOOKING: `spoolMap()` mapped over the subject registry, so a floating
 * capture — "Call María — invoice", on disk right now — appeared on NO map at
 * all. A default surface with a silent hole in it is worse than one that admits
 * what it cannot show.
 *
 * The fix is NOT a subject called "floating". `deriveSubjects` refuses to mint
 * one and a test asserts it: "floating" is a RENDERING OF ABSENCE
 * (`item.project ?? "floating"`), never a stored value. A floating capture also
 * genuinely has no threads and no permits — threads live at
 * `experts/<key>/threads.json` and there is no key — so folding it into
 * `SpoolSubjectThreads` would hand it two fields it can never fill.
 *
 * So it rides beside the subjects as bare captures, and the surface's offer is
 * "file this", not "map this" — which is the only move that exists for it.
 */
export const SpoolMap = z.object({
  subjects: z.array(SpoolSubjectThreads),
  floating: z.array(SpoolCaptureBrief),
});
export type SpoolMap = z.infer<typeof SpoolMap>;

// ── aperture.json ───────────────────────────────────────────────────────────

/**
 * THE ROOM'S SMART VIEW — which computed scope the wide room is showing.
 *
 * `docs/spool-loops.md` §8: Today and Scheduled are APERTURES, not routes —
 * same room, same capability set, chat as hinge. "everything" is the ordinary
 * wide room. Subject focus is a DEEPER aperture and stays in the focus store;
 * this slot never names a subject.
 *
 * ONE CURRENT VALUE AND NO HISTORY, deliberately — see the engine's
 * `spool/aperture.ts` for why a log of glances is refused.
 */
export const SpoolApertureView = z.enum(["everything", "today", "scheduled"]);
export type SpoolApertureView = z.infer<typeof SpoolApertureView>;

export const SpoolAperture = z.looseObject({
  view: SpoolApertureView,
  schemaVersion: z.number().default(1),
});
export type SpoolAperture = z.infer<typeof SpoolAperture>;

// ── focus.json ──────────────────────────────────────────────────────────────
//
// WHAT YOU ARE ON — the record every surface in this module was missing.
//
// ── WHY NOTHING ELSE HERE COULD ANSWER IT ───────────────────────────────────
// Threads, packets, facts and nights are all about THE WORK. Not one of them is
// about YOU AND THE WORK, so every surface had to render its whole record —
// which is exactly why the answer to "organise this for me" kept arriving as
// more to read. A view cannot decide what you do not need to see if nothing
// knows what you are attending to.
//
// ── THE UNIT IS THE PICKUP POINT, NOT THE DAY AND NOT THE TASK ──────────────
// A day is how you READ this back. Finishing something is what TRIGGERS a
// recompute. What persists between those is one value — where you are in each
// line of work — and that is what this file holds.
//
//   Sat   ozom-gv · September budgets      left mid-way
//   Sun   telar-vnext · Codex transport    left mid-way
//   Mon   ozom-gv · September budgets      ← picked back up
//
// That reading is not stored. It is this array, grouped along a day axis.
//
// ── A SET, SO PARALLEL FOCUS IS NOT A SPECIAL CASE ──────────────────────────
// Every entry with no `ended` is current. Working two subjects at once is two
// open entries, not a mode.

export const SPOOL_FOCUS_SCHEMA_VERSION = 1;

/** Why you stopped being on something. NOT a status on the work — the work's
 *  own state is untouched by this file. "done" means you stopped because you
 *  finished, which is a fact about your attention, not an accept. */
export const SpoolFocusEnd = z.enum(["done", "switched", "paused"]);
export type SpoolFocusEnd = z.infer<typeof SpoolFocusEnd>;

/**
 * ONE STRETCH OF ATTENTION.
 *
 * ── `at` IS A REAL STAMP, AND THAT IS ALLOWED HERE ──────────────────────────
 * Every other time in this store is a display label because §3.2 forbids a
 * RENDERER reading a clock. This one is comparable, and the line still holds:
 * it is read by the code that groups entries into days and by an agent composing
 * a pickup — never by a surface deciding what to draw. What reaches the screen
 * is `label` and `day`, both minted by the store. Nothing sorts, subtracts or
 * compares a time in a component.
 */
export const SpoolFocusEntry = z.looseObject({
  id: z.string(),
  /** The subject you are on. Always present — attention is at least this coarse. */
  subject: z.string(),
  /** The thread, when you have narrowed to one. ABSENT IS NOT VAGUE: "I am on
   *  ozom-gv today" is a real and common stance, and forcing a thread would make
   *  you invent precision you do not have. */
  threadId: z.string().optional(),
  /** WHERE YOU LEFT IT, in your own words. The single most valuable string in
   *  this file — it is what "pick back up from" actually means. */
  note: z.string().optional(),
  label: z.string(),
  /** Store-minted day label ("Saturday"). The grouping axis, already rendered,
   *  so no surface computes one. */
  day: z.string(),
  at: z.number(),
  ended: z
    .looseObject({ label: z.string(), at: z.number(), reason: SpoolFocusEnd, note: z.string().optional() })
    .optional(),
  /**
   * CORRECTIONS SUPERSEDE; THEY NEVER OVERWRITE.
   *
   * "No deletion path. Dismissing drains" applies to your own history too. A
   * focus log you can silently rewrite is one you cannot trust the next time it
   * says "Saturday you were on ozom-gv" — and being able to fix a mis-set focus
   * within the day is exactly when the temptation to rewrite arrives.
   */
  amended: z
    .array(z.looseObject({ label: z.string(), was: z.string(), why: z.string().optional() }))
    .optional(),
  schemaVersion: z.number().default(SPOOL_FOCUS_SCHEMA_VERSION),
});
export type SpoolFocusEntry = z.infer<typeof SpoolFocusEntry>;

/** One day of attention, already labelled — the Sat/Sun/Mon reading. */
export const SpoolFocusDay = z.object({
  day: z.string(),
  entries: z.array(SpoolFocusEntry),
});
export type SpoolFocusDay = z.infer<typeof SpoolFocusDay>;

/**
 * ANYTHING THE SURFACE SAYS, WITH THE WORDS THAT CAUSED IT.
 *
 * ── THE RULE THIS SHAPE ENFORCES ────────────────────────────────────────────
 * "We can't have the system reporting to me things I don't understand."
 *
 * `foldThreads` already refuses to create a thread with no capture behind it —
 * that is what killed aurora's "How do I reach the tracker?", a question the
 * user had no reason to recognise. This is the same rule one level up: a
 * SENTENCE with no evidence behind it is the same defect as a thread with none.
 *
 * `said` IS NOT A LINK TO FOLLOW. It renders BESIDE the derived line, because
 * "you could click to find out where this came from" still means the report
 * itself was opaque. Leading with your own words means there is nothing to
 * trace — you recognise it or you do not, immediately.
 *
 * A LINE WITH NO `said` IS THE SYSTEM TALKING ABOUT ITS OWN BOOKKEEPING, which
 * is exactly the register that cannot be verified by reading it. Those are
 * allowed to exist and surfaces are expected to treat them as weaker.
 */
export const SpoolGrounded = z.object({
  /** What the system made of it. */
  derived: z.string(),
  /** Your own words, when a capture is behind this. */
  said: z.string().optional(),
  /** The capture, so the surface can open it. */
  itemId: z.string().optional(),
  subject: z.string(),
  threadId: z.string().optional(),
});
export type SpoolGrounded = z.infer<typeof SpoolGrounded>;

/**
 * ONE MOVED SENTENCE, ADDRESSED. `text` is the composed sentence — a surface
 * renders it and computes nothing, same as before this carried a subject at
 * all. `subject` is the entry it came from: with several subjects open at
 * once (a person can be on several things — `currentFocus` never ends the
 * others), a room focused on ONE of them has to be able to tell its own
 * subject's movement from every other open subject's, or a focused room
 * quietly narrates whatever else happens to be open. Wide still reads every
 * one; only a focused room filters by it.
 */
export const SpoolMoved = z.object({
  subject: z.string(),
  text: z.string(),
});
export type SpoolMoved = z.infer<typeof SpoolMoved>;

/**
 * WHERE TO PICK UP — computed, never stored.
 *
 * IT RECOMPUTES AT BOUNDARIES, NOT CONTINUOUSLY. You settle something, you close
 * a focus, you come back after a gap, or you ask. A pickup that changed after
 * every small thing would be chatter, which is the opposite of the point.
 */
export const SpoolPickup = z.object({
  /** Open focus entries — what you are on right now. Empty is a real state and
   *  the one the proposal below exists for. */
  current: z.array(SpoolFocusEntry),
  /** What moved on those since you opened them, each addressed to the
   *  subject it came from — see `SpoolMoved`. */
  moved: z.array(SpoolMoved),
  /** Who is waiting, GROUNDED — see `SpoolGrounded`. */
  waiting: z.array(SpoolGrounded),
  /**
   * WHAT TO DO WHEN THERE IS NO CLEAR PATH — offered, never decided.
   *
   * Empty focus, or a finished one with nothing obviously next, is the case
   * where "organise this for me" actually means something. It PROPOSES a shape;
   * §5's "no Telar-authored agenda" survives because you accept it or ignore it
   * and nothing happens either way.
   */
  proposal: z
    .object({
      why: z.string(),
      options: z.array(SpoolGrounded),
    })
    .optional(),
});
export type SpoolPickup = z.infer<typeof SpoolPickup>;

// ── lanes.json ──────────────────────────────────────────────────────────────

/**
 * `items` is an ORDERED ARRAY OF ITEM IDS, not embedded items — deliberately
 * disagreeing with the design-source fixtures, whose lane `items` is the
 * RENDERED join. Storing embedded items would give membership two sources of
 * truth.
 *
 * NO `schemaVersion` FIELD, and the absence is the assertion: a schema version
 * plus migrate-on-read is for stores holding unrecoverable human input, and this
 * file is re-derivable structure. `SpoolItem` below carries one; the asymmetry
 * is deliberate and is asserted in both directions.
 */
export const SpoolLane = z.object({
  /** User-defined. Lanes are DATA, never an enum. */
  key: z.string(),
  label: z.string(),
  /** Coarse and shifting ("work hours", "evenings", "whenever") — never a
   *  schedule. */
  window: z.string(),
  /** Structural provenance: "split from Office — you accepted Mon". A lane
   *  created by an accepted master proposal says so, permanently. */
  note: z.string().optional(),
  /** The ordered stack. Position in THIS array is the item's rank (1-based, via
   *  the store's `rankOf`) — rank is deliberately not persisted per item, or
   *  "reordering rewrites one small file" would be false. */
  items: z.array(z.string()).default([]),
});
export type SpoolLane = z.infer<typeof SpoolLane>;

// ── packets/<item-id>/packet.json ───────────────────────────────────────────

/**
 * The version this build WRITES. The store's `migratePacket` refuses to read
 * anything above it rather than guessing, because a packet holds `raw` verbatim
 * and has no source to be rebuilt from.
 */
export const SPOOL_ITEM_SCHEMA_VERSION = 1;

/**
 * ONE SHAPE FOR ALL ITEMS: a bare one-line todo and a fully ripened work packet
 * are the SAME schema — "a packet is not a different entity; it is an item that
 * grew attachments" (`item-model.md`). So there is no second reader, writer or
 * migration when an item ripens; a nested `packet` record would re-introduce the
 * two-shape split by the back door.
 *
 * THE `{files, mockups}` TALLY IS NOT PERSISTED HERE — it is derived at read
 * time by the store's `attachmentTally`, which is what keeps "growing
 * attachments needs no migration" true by construction.
 *
 * NO AGENT-WRITABLE status, state, done OR accepted FIELD EXISTS ON THIS TYPE.
 * The moat is that no agent may declare a thing done — the tool surface asserts
 * that no tool input shape can spell doneness, and the update path refuses it by
 * name. `closed` below is not a breach of that: it is written by the human API
 * alone (a checkbox under the user's own hand, `docs/spool-loops.md` §9), and a
 * human closing their own task is the moat working, not a hole in it. There is
 * still no status enum and no lifecycle vocabulary: closed present or absent is
 * the whole story.
 */
export const SpoolItem = z.looseObject({
  /** Minted, NEVER derived from position — an id derived from a lane index
   *  breaks the moment the stack reorders. */
  id: z.string(),
  /** Always present, even for a rich packet. */
  title: z.string(),
  /** How it got in ("note", "pasted transcript", "chat", "mirror sync", "loom
   *  event", "session"). A FREE-FORM LABEL, NOT AN ENUM. */
  provenance: z.string(),
  /** When it entered, as a DISPLAY LABEL ("Tue 16:42"). Never a scheduling
   *  input — nothing here parses, compares or sorts on it; order is stack
   *  position, always. */
  captured: z.string(),
  /** The version field, on this store and not on lanes.json. Absent normalises
   *  to 1 inside `migratePacket` BEFORE any comparison — the common case for a
   *  hand-authored packet. */
  schemaVersion: z.number().default(SPOOL_ITEM_SCHEMA_VERSION),
  /** DISCLOSED ADDITION — the RECOVERY HINT of the reconcile rule. lanes.json is
   *  authoritative for membership and order; this is consulted only when the id
   *  appears in no stack (the torn-write case). Optional: absent means unfiled,
   *  a resting state, not an error. */
  lane: z.string().optional(),
  /** DISCLOSED ADDITION — "on the spool desk". A boolean on the item rather than
   *  a second store, per `item-model.md`'s Desk-item description. Cleared by
   *  `updateItem({desk: false})`. */
  desk: z.boolean().optional(),
  /** From `item-model.md`'s Desk-item block: "the master could not file it and
   *  is asking". Renders as a question, not a failure. */
  unplaced: z.boolean().optional(),
  /** ABSENT = FLOATING, and floating is a valid resting state — a project-scoped
   *  slice excludes it rather than treating it as a failure. */
  project: z.string().optional(),
  /** Foreign issue ref, e.g. "#214". Present = Telar holds a view only and the
   *  foreign tracker stays source of truth. */
  mirrored: z.string().optional(),
  deadline: SpoolDeadline.optional(),
  /** The user's placement of this item on a day — see `SpoolPin`. Set and
   *  cleared through the ordinary update path (`pinned: null` clears); a clear
   *  removes the pin, never the item, so "no deletion path" is untouched. */
  pinned: SpoolPin.optional(),
  /**
   * FREE-TEXT LABELS, filterable and searchable — §10.4's cross-cutting axis.
   * The user's vocabulary, never an enum, never a state: a tag says what a
   * thing is about across lanes and subjects, and nothing anywhere may read
   * one as urgency. Settable through create and the ordinary update path;
   * agents may tag only when the user asks, in the user's own words.
   */
  tags: z.array(z.string()).optional(),
  /**
   * THE HUMAN'S OWN CLOSE — the checkbox (`docs/spool-loops.md` §9).
   *
   * ATTRIBUTION IS IMPLICIT BECAUSE ONLY THE HUMAN API CAN SET IT. The verb
   * exists on no tool wall and is refused by name on the generic update path,
   * so a value here can only mean the user's own hand ticked the box. `label`
   * is the store's display label ("Tue 16:42") and `at` the moment it was
   * ticked; reopening REMOVES the field (absence is open) and never deletes
   * anything else — the item, its raw words and its record all stay. Present
   * or absent is the whole vocabulary: no status, no state, no enum.
   */
  closed: z.object({ label: z.string(), at: z.number() }).optional(),
  // `verdict` and `verdictOverride` belong here — see the absence note above.
  /** The conservation valve: decomposition lives INSIDE the item, so breaking
   *  work down never grows the queue count. */
  subtasks: z.array(SpoolSubtask).optional(),
  /** Parent item id, when this item began as a sub-task. "Agents have no
   *  promotion path, proposed or otherwise" — the field exists because the shape
   *  contract requires it, and it is absent from the patch type so no tool can
   *  write it. */
  promotedFrom: z.string().optional(),
  // `tracking` belongs here — see the absence note above.
  // ── the Packet table: the ripening history CAP-6 describes ──
  /** NEVER OVERWRITTEN BY ANY WRITE PATH — "keeping raw beside fixed is
   *  load-bearing: it lets the user check the expert did not drift from what
   *  they meant." The patch type cannot express a change to either field. */
  raw: z.string().optional(),
  rawSource: z.string().optional(),
  /** The expert-written brief that replaced the shorthand. */
  fixed: z.string().optional(),
  /** Criteria the work must meet — this plus `fixed` is the loom's premise. */
  acceptance: z.array(z.string()).optional(),
  /**
   * A PROPOSED APPROACH, written by the night and never by a human.
   *
   * IT SITS BESIDE THE BRIEF RATHER THAN REPLACING IT, for the same reason
   * `fixed` sits beside `raw`: the brief is what the work IS and the draft is
   * one opinion about how to come at it. A draft that overwrote the brief would
   * make an agent's guess indistinguishable from the thing the user agreed to.
   *
   * WRITTEN ONLY BY `applyDraft`, and absent from the patch type like every
   * other ripening field — see `SpoolItemPatch`.
   */
  draft: z.string().optional(),
  /**
   * WHAT THE DRAFT WOULD NEED ANSWERED BEFORE ANYONE STARTED — kept as data
   * rather than folded into `draft`'s prose.
   *
   * These were composed into the draft body under a "What it would need to know
   * first" heading, which made them unreachable to anything but a reader. The
   * definition's morning names "the question it could not answer alone" as one
   * of the things one screen has to show, and a surface cannot show what only
   * exists inside a paragraph. Written only by `applyDraft`, beside `draft`.
   */
  openQuestions: z.array(z.string()).optional(),
  /** Time-commitments the expert mined out of THIS item's capture. Written only
   *  by `applyExpertPass`; absent from the patch type like every other ripening
   *  field. */
  commitments: z.array(SpoolExpectation).optional(),
  timeline: z.array(SpoolTimelineEvent).optional(),
});
export type SpoolItem = z.infer<typeof SpoolItem>;

// ── the read-time projections ───────────────────────────────────────────────
//
// These are not persisted. They are what the store's pure projections return
// and what the surfaces render, and they live here so the queue, the desk rail
// and an in-session tool answer agree about their shape by construction.

/**
 * Why the reason is a string and not an enum: it is human-facing diagnosis
 * surfaced through a tool's own result text, and the set of ways a hand-edited
 * store file can be wrong is not enumerable.
 *
 * `id` IS AN ADDRESS, NOT ALWAYS AN ITEM ID. The channel also carries the lane
 * rows the tolerant reader had to skip, addressed by the row's own `key` when it
 * still has a readable one and by `lanes.json[<index>]` when it does not.
 */
export const SpoolUnreadable = z.object({ id: z.string(), reason: z.string() });
export type SpoolUnreadable = z.infer<typeof SpoolUnreadable>;

/** One rendered queue row: which lane, what rank in it, and the item. */
export const SpoolQueueRow = z.object({ lane: z.string(), rank: z.number(), item: SpoolItem });
export type SpoolQueueRow = z.infer<typeof SpoolQueueRow>;

/**
 * One row of the SUBJECT view — the same item, seen from the other axis.
 *
 * WHY IT IS NOT `SpoolQueueRow`: there, `lane` and `rank` are REQUIRED, because a
 * queue row exists only where a stack holds the id. The subject view shows every
 * readable item, including the unfiled one the reconcile rule leaves in no lane
 * (arm 3), and reusing the queue's shape would force that row to name a lane it
 * is not in. Absent here means "in no stack" — a resting state, not an error, and
 * a renderer that meets it draws no lane chip rather than a wrong one.
 *
 * BOTH FIELDS RIDE ALONG SO THE SURFACE NEEDS NO SECOND JOIN. Grouping by subject
 * does not stop a row wanting to say which lane it sits in; a row carrying only
 * the item would send the client back to `lanes` to find out, which is exactly
 * the "rows that disagree with the lane list" fault the one-call snapshot exists
 * to prevent.
 */
export const SpoolSubjectRow = z.object({
  item: SpoolItem,
  lane: z.string().optional(),
  rank: z.number().optional(),
});
export type SpoolSubjectRow = z.infer<typeof SpoolSubjectRow>;

/**
 * THE PRIMARY GROUPING AXIS: what work is ABOUT, not when you would do it.
 *
 * A lane answers "when and where would I do this" — it is a GTD context, and the
 * spec's own examples are "Office / work hours" and "Evenings". Real work is not
 * divided that way. `ozom-ai/ozom-gv`'s four months are cut by milestone,
 * category and dependency (§6 of `docs/spool-definition.md`), so all 29 of its
 * open issues would land in one lane called Office and the lane axis would carry
 * no information at all. The subject therefore leads, and the lane rides on the
 * row as secondary structure.
 *
 * THIS DELETES NOTHING AND MIGRATES NOTHING. It is a second projection over the
 * same `lanes.json` and the same packets: no stored shape changes, no stack
 * moves, the reconcile rule is untouched, and `SpoolSnapshot.rows` still ships
 * beside it so the lane view keeps working.
 *
 * `project` ABSENT = FLOATING, and floating is a valid resting state
 * (`item-model.md`: "Absent = floating. Floating is a valid resting state, not an
 * error"). Those items get a group of their own rather than being hidden, and it
 * sorts last so the named subjects read first.
 */
export const SpoolSubjectGroup = z.object({
  /** The subject, EXACTLY as the items spell it — `SpoolItem.project` verbatim,
   *  never normalised, slugged or title-cased. §7.2 widens that field into a real
   *  subject record with a permitted-action level; a projection that had minted
   *  its own key would then have to be reconciled with the thing it was standing
   *  in for. */
  project: z.string().optional(),
  rows: z.array(SpoolSubjectRow),
});
export type SpoolSubjectGroup = z.infer<typeof SpoolSubjectGroup>;

/**
 * The right rail's card — "a projection of an item the agents just touched, not
 * a separate store".
 *
 * FIELDS, NOT SENTENCES. This projection once flattened project, mirrored ref
 * and deadline into one `hint` STRING, which made the Desk the only surface
 * where a self-deadline lost its `· self` / `· slid ×N` dashed chip and a
 * mirrored item lost its ref — breaking the cross-surface invariant that those
 * chips render identically everywhere, at the projection layer where no amount
 * of care in the rail could put it back. The card carries the same fields a
 * queue row's item does and the rail renders them with the same components.
 * `hint` survives for the one thing no chip says.
 */
/**
 * HOW FAR AN ITEM HAS RIPENED, as three states a human can act on.
 *
 * Derived from what is on the packet rather than stored: `captured` has only
 * the user's own words, `briefed` has an expert's brief beside them, `drafted`
 * has an approach as well. Nothing here is a status the user sets or an agent
 * transitions — it is a READING of the packet, which is why it cannot become
 * the accept path the module refuses.
 */
export const SpoolDeskStage = z.enum(["captured", "briefed", "drafted"]);
export type SpoolDeskStage = z.infer<typeof SpoolDeskStage>;

export const SpoolDeskCard = z.looseObject({
  id: z.string(),
  title: z.string(),
  project: z.string().optional(),
  mirrored: z.string().optional(),
  deadline: SpoolDeadline.optional(),
  /** The user's own day for it, carried so the desk draws the same pin chip
   *  every other surface does — a field, never a countdown. */
  pinned: SpoolPin.optional(),
  hint: z.string().optional(),
  unplaced: z.boolean().optional(),
  /**
   * WHAT THE CARD IS ABLE TO SAY ABOUT ITSELF, and the reason the desk stopped
   * being inert. A rail that showed only a title and a project told the user
   * nothing they did not already know, so there was no reason to look at it and
   * nothing to do from it.
   */
  stage: SpoolDeskStage.default("captured"),
  /**
   * THE ONE THING ONLY THIS HUMAN CAN DO, in their own terms, or absent when
   * the answer is "nothing — it is the agents' turn".
   *
   * PHRASED AS WHAT TO DO, NEVER AS A QUESTION. The desk previously rendered
   * "unplaced — what is it?", which is the assistant interrogating the user
   * about their own capture; the tone law admits provenance and instruction,
   * not interrogation.
   */
  needsYou: z.string().optional(),
  /** What a proposed approach could not answer alone — carried whole rather
   *  than counted, because §8's morning shows the QUESTION and not a pointer to
   *  where the question lives. */
  openQuestions: z.array(z.string()).optional(),
  /** `done`/`total`, present only when the item was broken down. */
  subtasks: z.object({ done: z.number(), total: z.number() }).optional(),
  /**
   * PASSED THROUGH FROM THE ITEM, so the surfaces can draw the Done shelf and
   * keep the active slices honest. The card STAYS IN THE PAYLOAD when closed —
   * dropping it here would be a delete path wearing a filter's name, and the
   * conservation count would silently disagree with what is on screen. The web
   * filters and renders; this projection only reports.
   */
  closed: z.object({ label: z.string(), at: z.number() }).optional(),
});
export type SpoolDeskCard = z.infer<typeof SpoolDeskCard>;

/** The `{files, mockups}` tally, derived from attachment names at read time. */
export const SpoolAttachmentTally = z.object({ files: z.number(), mockups: z.number() });
export type SpoolAttachmentTally = z.infer<typeof SpoolAttachmentTally>;

/**
 * Everything the queue surface renders, in ONE read.
 *
 * ONE CALL RATHER THAN FOUR, because the four are not independent: `rows` is a
 * join over `lanes` and the items, and `unreadable` is the diagnostic channel
 * for the faults that join DROPS. A client that fetched them separately could
 * render a queue whose rows disagree with its lane list, and — worse — could
 * show a shrunken queue with no sign that anything was wrong.
 *
 * NO PER-LANE COUNT FIELD. The count a human reads beside a lane header is the
 * number of rows rendered under it, which includes an adopted orphan the stored
 * stack has forgotten. Sending a second, stored count would be a number that
 * disagrees with what is on screen.
 *
 * BOTH AXES SHIP FROM ONE READ, for the same reason: `rows` and `subjects` are
 * two projections of the same items and the same stacks, and a client that
 * fetched them in two calls could show a subject group holding an item the queue
 * has already lost, with no sign that the two disagreed.
 */
export const SpoolSnapshot = z.object({
  lanes: z.array(SpoolLane),
  rows: z.array(SpoolQueueRow),
  /** The same readable items grouped by SUBJECT — the primary axis, per
   *  `SpoolSubjectGroup`. Every readable item appears in exactly one group, so
   *  the rows here total `totalItems` while `rows` above totals only the FILED
   *  ones; the two counts differing is the unfiled remainder, not a fault. */
  subjects: z.array(SpoolSubjectGroup),
  desk: z.array(SpoolDeskCard),
  /** Everything the store could not make sense of — malformed packets AND the
   *  lane rows a tolerant read had to skip. The queue footer says this out
   *  loud; a client that drops it makes tolerance indistinguishable from loss. */
  unreadable: z.array(SpoolUnreadable),
  /** Every readable item, filed or not — so the footer can state the
   *  conservation law with a live number rather than a caption. */
  totalItems: z.number(),
  /** The other half of that law: how many of them an agent filed. */
  agentsAdded: z.number(),
});
export type SpoolSnapshot = z.infer<typeof SpoolSnapshot>;

/**
 * One item, with what only the store can say about it.
 *
 * `lane` AND `rank` COME FROM THE STACKS, never from the item's own `lane`
 * hint: that field is a recovery hint the reconcile rule consults only when an
 * id is in no stack, and rendering it as the item's location would show a
 * hand-edited move as not having happened. Both are absent for an unfiled item,
 * which is a resting state and not an error.
 */
export const SpoolItemDetail = z.object({
  item: SpoolItem,
  lane: z.string().optional(),
  rank: z.number().optional(),
  attachments: z.array(z.string()),
  tally: SpoolAttachmentTally,
});
export type SpoolItemDetail = z.infer<typeof SpoolItemDetail>;

// ── the expert pass ─────────────────────────────────────────────────────────

/**
 * What one consultation cost.
 *
 * PRESENT OR ABSENT, never zeroed. A provider that reported nothing is not the
 * same as a call that was free, and a caller totalling a night of passes has to
 * be able to tell the two apart.
 */
export const SpoolExpertUsage = z.looseObject({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreate: z.number(),
  }),
  costUsd: z.number().optional(),
  turns: z.number().optional(),
});
export type SpoolExpertUsage = z.infer<typeof SpoolExpertUsage>;

/**
 * THE RESULT OF ASKING A PROJECT'S EXPERT TO READ ONE ITEM.
 *
 * A UNION WITH A REASON, NOT A THROW, and the whole surface depends on it: a
 * floating item, a project name the store cannot address, a project this machine
 * has not registered, a model that never answered — every one of those is an
 * ANSWER to "can the expert read this?" carrying a sentence that names the next
 * move. A client renders the sentence; it does not invent one from a status
 * code.
 *
 * NOTHING IN THE SUCCESS ARM CAN COMMIT. `applied` reports what the store wrote
 * — a brief, acceptance criteria, a timeline note, mined commitments — and
 * there is no field for a status, a lane, a start or an acceptance, because the
 * expert has no verb that could produce one.
 */
export const SpoolExpertOutcome = z.discriminatedUnion("ok", [
  z.looseObject({
    ok: z.literal(true),
    project: z.string(),
    applied: z.looseObject({
      item: SpoolItem,
      /** How many timeline events this pass appended. */
      events: z.number(),
      commitments: z.number(),
      /** The pass's own label, minted once by the store's clock, so the digest
       *  and this pass's timeline events agree. */
      at: z.string(),
    }),
    digest: SpoolExpertDigest,
    /** Whether the expert started from a digest or from nothing. Reported so a
     *  surface can say "first pass" honestly rather than implying memory it did
     *  not have. */
    cold: z.boolean(),
    /** The checkout the pass ran against, or absent when this machine has none.
     *  `cold` is about the digest, not the tree — without this a surface cannot
     *  say the expert judged the item without ever seeing the project. */
    cwd: z.string().optional(),
    usage: SpoolExpertUsage.optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SpoolExpertOutcome = z.infer<typeof SpoolExpertOutcome>;

// ── the night ───────────────────────────────────────────────────────────────

/**
 * WHY A NIGHT IS A QUEUE OF SMALL JOBS AND NOT ONE LONG AGENT.
 *
 * The account can run out mid-way. That is not an edge case to handle later —
 * it is the ordinary end of a night, and it decides the whole shape. One
 * long-running agent that stops halfway has produced something unfinished that
 * nothing can resume and nobody can trust. A queue of individually atomic jobs
 * that stops halfway has produced N finished results and N pending ones, and
 * "resume" means nothing more than running the pending ones next time.
 *
 * So every job is one structured call over one item, written to disk the moment
 * it lands. A crash, a rate limit, a laptop lid closing — each costs at most the
 * single job in flight, and never anything already recorded.
 */
export const SpoolNightJobKind = z.enum([
  /** Run the item's project expert over it: shorthand becomes a brief. */
  "ripen",
  /** Propose an approach for an item whose brief is already written. */
  "draft",
  /**
   * RE-CHECK WHAT A SUBJECT REMEMBERS against its checkout — the only job kind
   * that is about a SUBJECT rather than an item, and the only maintenance the
   * night performs.
   *
   * ITS PREDICATE IS FALSIFIED BY ITS OWN OUTPUT, which is what lets it exist at
   * all: it selects `howItWorks` facts not yet checked against the current HEAD,
   * and stamps them with that HEAD. Run it twice on an unchanged tree and the
   * second run has nothing to do. "Go learn more about the project" has no such
   * property and is the reason maintenance cannot be open-ended — see the
   * runner's "why it cannot keep digging".
   */
  "verify",
]);
export type SpoolNightJobKind = z.infer<typeof SpoolNightJobKind>;

/**
 * `refused` IS NOT `failed`, and the distinction is the honest half of the
 * morning report.
 *
 * A refusal is the system working: the item is floating and an expert belongs to
 * a project, so there is nothing to do until a human says which subject it is.
 * A failure is the system not working. Collapsing them would either hide work
 * the user must do, or cry wolf about a night that went fine.
 */
export const SpoolNightJobState = z.enum(["pending", "done", "refused", "failed"]);
export type SpoolNightJobState = z.infer<typeof SpoolNightJobState>;

export const SpoolNightJob = z.looseObject({
  id: z.string(),
  kind: SpoolNightJobKind,
  /**
   * The item this job worked, when it worked one.
   *
   * OPTIONAL BECAUSE `verify` IS ABOUT A SUBJECT. Putting a subject key in here
   * would have been cheaper and would have been a lie: the morning report links
   * a job to a packet by this field, and a link that opens nothing is worse than
   * an absent one.
   */
  itemId: z.string().optional(),
  /** The subject this job worked, for the kinds that work one. */
  subject: z.string().optional(),
  /** Carried so a report can name what was worked without re-reading every
   *  packet — and so a job whose item was later edited still says what it
   *  worked on. */
  title: z.string(),
  state: SpoolNightJobState.default("pending"),
  /** One line for the morning: what changed, or why nothing did. */
  note: z.string().optional(),
  /**
   * WHAT THIS JOB COULD NOT ANSWER ALONE.
   *
   * ON THE JOB AND NOT ONLY ON THE ITEM, because §8 makes the morning report
   * responsible for "the question it could not answer alone" — and a surface has
   * to fold ITS OWN RECORD. `NightSurface` was deriving this by filtering
   * `SpoolDeskCard[]`, which made the night a second renderer of the DESK's
   * projection: two surfaces drawing one fact, and the night showing questions
   * from passes it never ran.
   *
   * `applyDraft` already writes these to the packet, and that stays — the item
   * is where a question LIVES. This is the night's record of which of them ITS
   * OWN jobs produced, which is a different and smaller set.
   */
  openQuestions: z.array(z.string()).optional(),
  usage: SpoolExpertUsage.optional(),
});
export type SpoolNightJob = z.infer<typeof SpoolNightJob>;

/**
 * WHY THE NIGHT ENDED. Every one of these is a resting state rather than an
 * error; the report says which, because "it stopped" without a reason is the
 * thing that makes an unattended system untrustworthy.
 */
export const SpoolNightStopReason = z.enum([
  /** The account said no. Jobs stay pending; the next run continues them. */
  "rate-limited",
  /** This night's ceiling was reached. The user set it; it is not a fault. */
  "budget",
  /** A turn started somewhere. The night yields the account rather than
   *  competing with the person for it. */
  "human-active",
  /** Nothing left to do — the only reason that means the night FINISHED. */
  "nothing-to-do",
  /** Repeated failures. Stopping beats spending the rest of the night
   *  rediscovering the same broken thing. */
  "failing",
  "cancelled",
]);
export type SpoolNightStopReason = z.infer<typeof SpoolNightStopReason>;

export const SpoolNight = z.looseObject({
  id: z.string(),
  state: z.enum(["running", "stopped", "done"]).default("running"),
  /** Display label of when it opened, minted by the store's clock like every
   *  other label in this subtree. NOT a timestamp for sorting or arithmetic. */
  opened: z.string(),
  jobs: z.array(SpoolNightJob).default([]),
  stop: z
    .looseObject({
      reason: SpoolNightStopReason,
      /** The sentence the report shows. Never a status code. */
      note: z.string(),
      /** Epoch ms the provider said it would accept work again, when it said
       *  so. AGENT-FACING ONLY: it decides when a runner may try again and
       *  never reaches a surface — a clock may drive an agent, never a
       *  renderer. */
      resumeAfter: z.number().optional(),
    })
    .optional(),
  /** What the night cost, totalled as it went so a stopped night still says. */
  usage: SpoolExpertUsage.optional(),
});
export type SpoolNight = z.infer<typeof SpoolNight>;

// ── work in flight ──────────────────────────────────────────────────────────

/**
 * ONE PIECE OF AGENT WORK, WHILE IT IS HAPPENING.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * A consultation runs fifteen to twenty-two turns and costs real money, and the
 * only thing representing it was a `busy` boolean inside one React component.
 * That boolean cannot survive a navigation, cannot be seen from a second
 * surface, cannot be cancelled, and — the part that mattered — cannot stop a
 * second pass, because a reload clears it. The expert route's own header admits
 * this: "the surface's busy state is what prevents the second".
 *
 * Every other kind of work in this app has a body: a turn has a state, a
 * rolling step window and an elapsed clock. The Spool spends more per action
 * than a turn does and had none of it.
 *
 * ── IT IS NOT PERSISTED, AND THAT IS DELIBERATE ──────────────────────────────
 * A pass in flight is not the user's data — if the daemon dies the pass died
 * with it, and a record saying otherwise would be a lie the next morning. What
 * a pass PRODUCED is durable already, on the item's own ripening timeline,
 * which is where a human looks. So this is an in-memory window over the present
 * moment and a short tail of what just settled — no second archive, nothing
 * accumulating on disk, which is the store's whole posture.
 */
export const SpoolWorkKind = z.enum([
  /** A project expert reading one item — shorthand becomes a brief. */
  "expert",
  /** An approach proposed for an item whose brief is already written. */
  "draft",
  /** A whole SUBJECT mapped into the open questions it is made of. The first
   *  kind here that is not about one item — see `itemId` below. */
  "threads",
]);
export type SpoolWorkKind = z.infer<typeof SpoolWorkKind>;

/**
 * WHO ASKED. The morning report reads differently depending on the answer:
 * work you started is work you were present for, and work the night started is
 * the thing you are being told about for the first time.
 */
export const SpoolWorkOrigin = z.enum(["you", "night"]);
export type SpoolWorkOrigin = z.infer<typeof SpoolWorkOrigin>;

/** Mirrors `SpoolNightJobState` on purpose — a refusal is not a failure here
 *  either, and the two records are read side by side in the same surface. */
export const SpoolWorkState = z.enum(["running", "done", "refused", "failed"]);
export type SpoolWorkState = z.infer<typeof SpoolWorkState>;

export const SpoolWork = z.looseObject({
  id: z.string(),
  kind: SpoolWorkKind,
  /**
   * OPTIONAL, BECAUSE NOT ALL WORK IS ABOUT AN ITEM.
   *
   * `SpoolNightJob.itemId` learned this first, for `verify`: a job about a
   * SUBJECT has no packet to open, and a surface that assumed one rendered a
   * button that opened nothing — "live, and silently inert", which is the defect
   * that file names. A `threads` pass is the same shape. Absent means look at
   * `subject`.
   */
  itemId: z.string().optional(),
  /** The subject, when the work is about one rather than about an item. Exactly
   *  one of `itemId` / `subject` is meaningful, and `address` below is what the
   *  registry actually dedupes on so the two cannot drift. */
  subject: z.string().optional(),
  /** Carried so a surface can name the work without re-reading its packet, and
   *  so a settled entry still says what it worked on after an edit. For a
   *  subject-scoped pass this is the subject's own name. */
  itemTitle: z.string(),
  project: z.string().optional(),
  origin: SpoolWorkOrigin,
  /** Display label, minted by the store's clock like every other label here.
   *  NOT a timestamp: nothing sorts or subtracts it. */
  started: z.string(),
  state: SpoolWorkState.default("running"),
  /**
   * THE LATEST STEP, and only the latest.
   *
   * A rolling window rather than a transcript: the whole history of a
   * twenty-turn pass is not something anyone reads, and keeping it would make
   * this the journal it explicitly is not. `n` counts steps so a surface can
   * say how far along without implying a percentage of a total nobody knows.
   */
  step: z.object({ n: z.number(), label: z.string() }).optional(),
  /** One line naming how it ended, or why it did not. */
  note: z.string().optional(),
  usage: SpoolExpertUsage.optional(),
});
export type SpoolWork = z.infer<typeof SpoolWork>;

// ── experts/<subject>/look.json — reconcile-on-look ─────────────────────────
//
// THE SPOOL'S LAST LOOK AT A SUBJECT'S TERRAIN. `docs/spool-loops.md` §4:
// whenever the Spool has a reason to look, it reads the terrain through the
// tools it already has, diffs against its memory, and files what changed as
// OBSERVATIONS in plain words. The world is truth; this file holds the look.
//
// PULL ONLY. Nothing here is written by a timer, a webhook or a poll — a look
// runs when a human's arrival or focus asks for one, over HTTP, and never
// otherwise. The trust the doc names ("context that cannot be verified fresh is
// worse than no context") comes from the record saying WHEN it last looked, and
// from a surface quoting that label with attribution — which §3.2 permits.

export const SPOOL_LOOK_SCHEMA_VERSION = 1;

/**
 * ONE ROW OF THE WORLD AS `gh` REPORTED IT — the baseline the next look diffs
 * against. Everything here is QUOTED from GitHub's own answer: `updatedAt` is
 * the tracker's stamp, never one this store minted, and nothing renders it —
 * it exists so the next diff can happen at all.
 */
export const SpoolLookRef = z.looseObject({
  kind: z.enum(["issue", "pull"]),
  number: z.number(),
  title: z.string(),
  /** GitHub's own state word — OPEN / CLOSED / MERGED — passed through, never
   *  re-derived. */
  state: z.string(),
  /** The tracker's own stamp, quoted for the diff. Agent-facing only. */
  updatedAt: z.string(),
  url: z.string().optional(),
  /** The milestone's title, when the tracker filed it under one. */
  milestone: z.string().optional(),
  assignees: z.array(z.string()).default([]),
  author: z.string().optional(),
  /** Pull requests only: GitHub's review decision, so a change in it is a
   *  diffable fact rather than a guess. */
  reviewDecision: z.string().optional(),
});
export type SpoolLookRef = z.infer<typeof SpoolLookRef>;

/** What an observation points at, so a surface can open the thing it names. */
export const SpoolObservationRef = z.object({
  kind: z.enum(["issue", "pull"]),
  number: z.number(),
  url: z.string().optional(),
  title: z.string().optional(),
});
export type SpoolObservationRef = z.infer<typeof SpoolObservationRef>;

/**
 * ONE THING THAT MOVED SINCE THE LAST LOOK, as a finished plain sentence —
 * "PR #420 merged since your last look." Composed DETERMINISTICALLY by the
 * reconcile, never by a model, so every one is checkable against the two
 * world states that produced it.
 *
 * `acknowledged` DRAINS, NEVER DELETES. "Noted" marks the row and keeps it —
 * the record of what the Spool told you is part of the record.
 *
 * `seenAt` IS A REAL STAMP AND `seen` IS THE LABEL, the same split
 * `SpoolFocusEntry` already carries: the number is for agents and for grouping
 * code, the label is what a surface may quote with attribution ("seen 7:40").
 * No renderer reads the number.
 */
export const SpoolObservation = z.looseObject({
  id: z.string(),
  text: z.string(),
  refs: z.array(SpoolObservationRef).default([]),
  /** Display label minted by the store's clock, same class as `captured`. */
  seen: z.string(),
  /** Epoch ms. Agent-facing only — a clock may drive an agent, never a
   *  renderer. */
  seenAt: z.number(),
  acknowledged: z.boolean().optional(),
});
export type SpoolObservation = z.infer<typeof SpoolObservation>;

export const SpoolLook = z.looseObject({
  subject: z.string(),
  schemaVersion: z.number().default(SPOOL_LOOK_SCHEMA_VERSION),
  /** Display label of the last look — "looked Sat 07:40", quoted with
   *  attribution wherever it renders. */
  lastLooked: z.string(),
  /** Epoch ms of the same moment. Agent-facing only. */
  lastLookedAt: z.number(),
  /** The raw world state the NEXT look diffs against. Stored whole because a
   *  diff with no baseline can only invent 29 spurious "new issue" lines. */
  world: z.object({
    issues: z.array(SpoolLookRef).default([]),
    pulls: z.array(SpoolLookRef).default([]),
  }),
  /** Every observation ever produced, acknowledged ones included — dismissing
   *  drains, nothing here deletes. */
  observations: z.array(SpoolObservation).default([]),
});
export type SpoolLook = z.infer<typeof SpoolLook>;

/**
 * THE ANSWER TO "LOOK AT THIS SUBJECT" — honest in all four states.
 *
 *   · terrain + fresh look        → `fresh: true`, the look just reconciled.
 *   · terrain + gh failed         → `fresh: false`, the STALE look (when one
 *     exists) plus `error` carrying gh's own diagnosis. The room never comes
 *     down because the network did.
 *   · no terrain                  → `note` says so. NOT an error: a subject
 *     with no terrain is first-class, there is simply nowhere to look.
 *   · read of a stored look       → `fresh: false`, no error, no gh run.
 */
/**
 * ONE LINE OF THE MOVEMENT DIGEST — compress-never-multiply applied to
 * observations (§10's volume work). A group of unacknowledged observations
 * folded into one plain sentence ("Hito 1 · Agosto — 8 PRs merged, 7 issues
 * closed"), carrying the ids it stands for so "noted" can drain the whole
 * group in one gesture. Composed deterministically from the stored look —
 * never by a model — and derived at read time, never stored.
 */
export const SpoolLookDigestLine = z.object({
  text: z.string(),
  observationIds: z.array(z.string()),
});
export type SpoolLookDigestLine = z.infer<typeof SpoolLookDigestLine>;

export const SpoolLookOutcome = z.object({
  subject: z.string(),
  terrain: SpoolTerrain.optional(),
  look: SpoolLook.optional(),
  /** The unacknowledged observations, grouped and compressed — one line per
   *  group. Additive: absent when there is nothing waiting. */
  digest: z.array(SpoolLookDigestLine).optional(),
  /** True only when this response reflects a reconcile that just ran. */
  fresh: z.boolean(),
  /** Why the reconcile could not run, when it could not. The stale look above
   *  is still the best available answer, and this names its staleness. */
  error: z.string().optional(),
  /** The no-terrain case, said out loud rather than left to be inferred from
   *  three absent fields. */
  note: z.string().optional(),
});
export type SpoolLookOutcome = z.infer<typeof SpoolLookOutcome>;

// ── briefed arrival ─────────────────────────────────────────────────────────

/**
 * EVERYTHING A SESSION NEEDS TO ARRIVE PREPARED, composed deterministically
 * from stored data — no model call, ever. `docs/spool-loops.md` loop 2: "'Work
 * on this' lands the user in a real Telar session that is already briefed: the
 * packet, the raw words, the dependency chain, and the delta since the user's
 * last look."
 *
 * THE ENGINE COMPOSES; THE WEB DELIVERS. The briefing lands in the composer as
 * a DRAFT the human sends themselves — nothing is spent and nothing starts
 * until they do, which keeps the moat where it is. That is why this is a read,
 * not a verb: it creates no session and queues no turn.
 *
 * `project` IS THE RESOLUTION, NOT A REQUIREMENT. Present when the item's
 * subject maps to a registered Telar project on this machine; absent when it
 * does not — which includes every no-terrain, no-checkout subject, and is an
 * ordinary answer the web renders honestly rather than a failure.
 */
export const SpoolBriefing = z.object({
  itemId: z.string(),
  title: z.string(),
  /** The item's subject key. Absent = floating. */
  subject: z.string().optional(),
  /** The registered Telar project the subject resolves to, when one does. */
  project: z.object({ id: z.string(), name: z.string() }).optional(),
  /** The composed briefing text, ready to be a composer draft. Every date or
   *  time inside it is a QUOTE with attribution, per §3.2. */
  briefing: z.string(),
  /** The delta half, as data — so a surface can render the observations with
   *  their refs instead of re-parsing the prose. */
  freshness: z
    .object({
      /** The look's own label — "as of the look at Sat 07:40". */
      looked: z.string(),
      /** The unacknowledged observations for the item's subject. */
      observations: z.array(SpoolObservation),
    })
    .optional(),
});
export type SpoolBriefing = z.infer<typeof SpoolBriefing>;

// ── the lobby and the subject's room (§13) ──────────────────────────────────
//
// TWO READS, BOTH PURE COMPOSITION OVER WHAT ALREADY EXISTS. No new store, no
// model call — the lobby ranks subjects by facts `subjects.json`,
// `threads.json`, `looks/*` and the items already carry; the brief re-reads
// the same per-subject slice `SpoolBriefing` already composes, once per
// subject instead of once per item. §13.2: "a subject earns a card by having
// a session running, needing you, or having moved; everything else folds to
// a quiet line."

/**
 * WHAT MOVED, AS A COUNT AND ONE SENTENCE — never a list of every observation.
 * The count is every observation the latest look produced and nobody has
 * acknowledged yet (`SpoolObservation.acknowledged`); the line is the FIRST of
 * the look's own compressed digest lines, quoted with the look's own label —
 * "As of the look at Sat 07:40: …" — so a card never states a time it did not
 * read off the store.
 */
export const SpoolLobbyMoved = z.object({
  count: z.number(),
  line: z.string().optional(),
});
export type SpoolLobbyMoved = z.infer<typeof SpoolLobbyMoved>;

/**
 * THE SOONEST DAY WITH A PIN, IN THIS SUBJECT — never "upcoming", never
 * "overdue". `day` is the pin's own `YYYY-MM-DD`, quoted verbatim; `label` is
 * the weekday name derived from THAT stored date (the same `dayLabel` a focus
 * entry's own day comes from), never from the system clock. Present only when
 * the caller supplied `today` — without it there is no clock-free way to say
 * which of a subject's pins is "next" rather than merely "a pin".
 */
export const SpoolLobbyNextPin = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  label: z.string(),
});
export type SpoolLobbyNextPin = z.infer<typeof SpoolLobbyNextPin>;

/**
 * ONE LOBBY CARD'S FACTS — every subject gets a row; `folded` is what tells a
 * surface whether to draw a card or fold the row into its area's quiet line.
 *
 * `sessionLive` IS THREE-VALUED, HONESTLY. `true`/`false` when the subject
 * resolves to a registered Telar project (the same link `SpoolBriefing`
 * already resolves — `SpoolSubject.projectId` first, the subject's own key
 * against a project's name second) and that project's sessions were checked
 * for a live turn; `null` when the subject names no registered project at
 * all, which is the ordinary case for a terrain-less or checkout-less subject
 * and not a fault to paper over with a guessed `false`.
 */
export const SpoolLobbySubject = z.object({
  key: z.string(),
  name: z.string(),
  area: z.string().optional(),
  color: SpoolSubjectColor.optional(),
  /** The same manual position `SpoolSubject.rank` carries, ridden along so a
   *  drag surface can compute drop positions without a second fetch of the
   *  registry. Absent means unranked — sorts after every ranked sibling in
   *  this same area. */
  rank: z.number().optional(),
  /** Stuck-on-you threads, plus unacknowledged observations, plus items
   *  pinned to `today` (zero when the caller sent none) — one scalar a
   *  surface sorts and folds on, never a sentence in itself. */
  needsYou: z.number(),
  moved: SpoolLobbyMoved,
  sessionLive: z.boolean().nullable(),
  nextPin: SpoolLobbyNextPin.optional(),
  /** `true` exactly when none of `needsYou`, `moved.count` or `sessionLive`
   *  earn this subject a card — §13.2's fold rule, computed once here so no
   *  two surfaces can disagree about which subjects speak. */
  folded: z.boolean(),
});
export type SpoolLobbySubject = z.infer<typeof SpoolLobbySubject>;

/** One area header — its name, its stated ceiling as a RAW FACT (never a
 *  composed "N subjects, nothing needs you" rollup; that sentence is the
 *  web's to write from the subjects beneath it), and its subjects. */
export const SpoolLobbyArea = z.object({
  name: z.string(),
  ceiling: SpoolSubjectPermits.optional(),
  subjects: z.array(SpoolLobbySubject),
});
export type SpoolLobbyArea = z.infer<typeof SpoolLobbyArea>;

/**
 * MISSION CONTROL, WHOLE. Areas alphabetical with their subjects; subjects
 * with no area ride at the end, unareaed — the same convention `subjectSlice`
 * uses for floating items. `total`/`live`/`needing` counters are deliberately
 * ABSENT: a rollup line is a composed sentence per §13.2's "let the web
 * compose", not a number this route hands over pre-summed.
 */
export const SpoolLobby = z.object({
  areas: z.array(SpoolLobbyArea),
  unareaed: z.array(SpoolLobbySubject),
});
export type SpoolLobby = z.infer<typeof SpoolLobby>;

/** One open thread, as much as the brief needs to render it and open it —
 *  never the whole `SpoolThread`, the same "just enough" discipline
 *  `SpoolThreadView.items` already keeps. */
export const SpoolBriefOpenThread = z.object({
  threadId: z.string(),
  question: z.string(),
  handle: z.string().optional(),
  /** Who it is stuck on — present only for `waitingOnOthers`, where the
   *  person's own name is the whole point of the row. */
  who: z.string().optional(),
  note: z.string().optional(),
});
export type SpoolBriefOpenThread = z.infer<typeof SpoolBriefOpenThread>;

/**
 * ONE CANDIDATE FOR "NEXT" — cited, never bare. `source` says WHY this item
 * is here in the caller's own vocabulary ("pinned to 2026-08-19", "briefed,
 * rank 2 in Office") so the brief never asserts an order it cannot justify by
 * pointing at a stored fact.
 */
export const SpoolBriefNextItem = z.object({
  itemId: z.string(),
  title: z.string(),
  source: z.string(),
});
export type SpoolBriefNextItem = z.infer<typeof SpoolBriefNextItem>;

/** A compost CANDIDATE — facts only, per §13.3.5: "these three look dead —
 *  say the word" is the brief's ONE sentence about them; the item itself
 *  states nothing beyond what it is. */
export const SpoolBriefDeadItem = z.object({
  itemId: z.string(),
  title: z.string(),
});
export type SpoolBriefDeadItem = z.infer<typeof SpoolBriefDeadItem>;

/**
 * THE RE-ENTRY BRIEF — everything a subject's room needs to open on, in one
 * read. Composed, deterministic, no model call — the same discipline
 * `SpoolBriefing` already holds for one item, widened to a whole subject.
 *
 * `sinceYourLook` IS THE STORED LOOK OUTCOME, WHOLE. Reusing `SpoolLookOutcome`
 * rather than a bespoke shape means this route never calls `gh` — the same
 * `fresh: false` a stored-only read always carries (see `SpoolLookOutcome`'s
 * own note) is the honest freshness label here, and the four-state contract
 * (fresh look / stale look with error / no terrain / stored look) never has to
 * be re-stated in a second shape that could drift from the first.
 *
 * `pickup` IS THIS SUBJECT'S SLICE OF `SpoolPickup`, not a second computation:
 * `current` and `moved` are `SpoolPickup.current`/`.moved` filtered to this
 * subject's own entries, so a room open on one subject cannot narrate another
 * subject's focus.
 */
export const SpoolBrief = z.object({
  subject: z.string(),
  pickup: z.object({
    current: z.array(SpoolFocusEntry),
    moved: z.array(SpoolMoved),
  }),
  sinceYourLook: SpoolLookOutcome,
  open: z.object({
    stuckOnYou: z.array(SpoolBriefOpenThread),
    waitingOnOthers: z.array(SpoolBriefOpenThread),
  }),
  /** Up to 3, derived — never invented. Pinned-to-`today` rows first (only
   *  when the caller sent one), then briefed/drafted rows in the same chain
   *  order `subjectSlice` already gives their lane. */
  next: z.array(SpoolBriefNextItem).max(3),
  notes: z.object({
    count: z.number(),
    latestTitle: z.string().optional(),
  }),
  /** Capped at 3 — the "say the word" candidates, never the whole compost
   *  heap in one read. */
  deadItems: z.array(SpoolBriefDeadItem).max(3),
});
export type SpoolBrief = z.infer<typeof SpoolBrief>;

/**
 * ONE TAG, AS A ROW IN THE WAREHOUSE — the engine's `spoolTags` projection over
 * `SpoolItem.tags` and `SpoolNote.tags`. There is no tag record on disk (see
 * `apps/engine/src/spool/tags.ts`): this is a read-time count, so `items` and
 * `notes` can never drift from what a filtered items/notes read would show.
 */
export const SpoolTagUsage = z.object({
  tag: z.string(),
  items: z.number(),
  notes: z.number(),
});
export type SpoolTagUsage = z.infer<typeof SpoolTagUsage>;
