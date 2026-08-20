import { z } from "zod";

/**
 * THE CANVAS — a surface the assistant composes, rather than one it fills in.
 *
 * ── WHAT THIS IS TESTING ────────────────────────────────────────────────────
 * Every Spool surface so far has been a FIXED LAYOUT fed by data: a person wrote
 * the regions, decided what goes in each, and the agent's only job was to
 * produce rows. Seven passes at that failed the same way — the screen could only
 * ever be as good as the arrangement someone guessed at in advance, and no
 * arrangement is right for both "you have one thing on" and "you have been away
 * a week".
 *
 * So: give the composition itself to the agent. You say "good morning, what have
 * we got today" and it DRAWS the answer — headings, questions, the words you
 * said, an offer — choosing what deserves space today. The chat is a sidebar
 * because talking is how you steer it, not what you came for.
 *
 * ── WHY THE BLOCKS ARE A CLOSED SET AND NOT MARKUP ──────────────────────────
 * The obvious version of this hands the model HTML or markdown. That would throw
 * away the entire vocabulary — the ply as an underline, a capture as a scrap, a
 * proposal as something visibly dashed and ignorable — and hand back a wall of
 * text, which is the exact complaint that started this.
 *
 * So the model does not choose HOW anything looks. It chooses WHAT IS ON THE
 * SCREEN and WHERE, from objects whose form is already decided. It is composing
 * with a typeface it cannot alter.
 *
 * ── AND THE LAWS STILL BIND ─────────────────────────────────────────────────
 * A block is a VIEW. Drawing one writes nothing to the store — no packet, no
 * thread, no focus entry — so §4's "compress, never multiply" has nothing to
 * bite on: the canvas is a rendering of the store and is thrown away when the
 * next question is asked. `said` carries your literal words for the same reason
 * `SpoolGrounded` does — anything the assistant asserts should sit under the
 * words that caused it, and a canvas is the surface where that matters most,
 * because here the assistant chose to bring it up.
 *
 * IT IS ALSO NOT A CLOCK. Nothing here holds a timestamp. A block that wants to
 * say when something happened carries a store-minted label as a string.
 */

export const SPOOL_CANVAS_SCHEMA_VERSION = 1;

/**
 * HOW WIDE, in a two-column grid. The only geometry the model gets.
 *
 * NOT x/y COORDINATES. A free canvas sounds more expressive and renders worse:
 * the model has no idea how tall its own text will be, so absolute placement
 * produces overlaps and gaps on every viewport but the one it imagined. A span
 * in a grid is the largest amount of layout control that cannot look broken.
 */
export const SpoolCanvasSpan = z.union([z.literal(1), z.literal(2)]);
export type SpoolCanvasSpan = z.infer<typeof SpoolCanvasSpan>;

/** Common to every block. `id` is the model's own handle for it — drawing the
 *  same id twice REPLACES, which is how a canvas gets refined in place rather
 *  than growing a second copy of everything. */
const base = {
  id: z.string().min(1),
  span: SpoolCanvasSpan.optional(),
};

/** A section title. The one place the assistant may name a region — and it has
 *  to earn it by being about TODAY rather than about the schema. */
export const SpoolCanvasHeading = z.object({
  ...base,
  kind: z.literal("heading"),
  text: z.string(),
  note: z.string().optional(),
});

/** A sentence the assistant is saying on the canvas rather than in the chat.
 *  This is what makes it a briefing instead of a dashboard. */
export const SpoolCanvasText = z.object({
  ...base,
  kind: z.literal("text"),
  text: z.string(),
  /** Draw it as the lead line — larger, first. At most one should be. */
  lead: z.boolean().optional(),
});

/** A container. Nothing nests, so this names a group whose members follow it. */
export const SpoolCanvasSubject = z.object({
  ...base,
  kind: z.literal("subject"),
  name: z.string(),
  note: z.string().optional(),
  /** True while a pass is working on it, so the canvas can carry the per-object
   *  pace the fixed surfaces already do. */
  working: z.string().optional(),
});

/** A question, with how much of it is known — the ply, as an underline. */
export const SpoolCanvasThread = z.object({
  ...base,
  kind: z.literal("thread"),
  label: z.string(),
  known: z.number().optional(),
  unanswered: z.number().optional(),
  /** A THIRD PARTY only. "waiting on you" was on every row of a real render and
   *  a mark that is always on is not a mark. */
  waiting: z.string().optional(),
  settled: z.boolean().optional(),
  /** Makes the block a control: clicking it starts on this. */
  subject: z.string().optional(),
  threadId: z.string().optional(),
});

/** Your literal words. The most protected string in the store. */
export const SpoolCanvasCapture = z.object({
  ...base,
  kind: z.literal("capture"),
  said: z.string(),
  provenance: z.string().optional(),
  itemId: z.string().optional(),
});

/** An offer. Ignoring it costs nothing and it is drawn so that it looks like it.
 *  `said` is what you actually wrote; `because` is the assistant's reading of
 *  it, and it hangs underneath rather than replacing it. */
export const SpoolCanvasProposal = z.object({
  ...base,
  kind: z.literal("proposal"),
  because: z.string(),
  said: z.string().optional(),
  subject: z.string().optional(),
  threadId: z.string().optional(),
});

/** A claim, where it came from, and whether anything checked it. */
export const SpoolCanvasFact = z.object({
  ...base,
  kind: z.literal("fact"),
  text: z.string(),
  source: z.string().optional(),
  checked: z.boolean().optional(),
});

export const SpoolCanvasBlock = z.discriminatedUnion("kind", [
  SpoolCanvasHeading,
  SpoolCanvasText,
  SpoolCanvasSubject,
  SpoolCanvasThread,
  SpoolCanvasCapture,
  SpoolCanvasProposal,
  SpoolCanvasFact,
]);
export type SpoolCanvasBlock = z.infer<typeof SpoolCanvasBlock>;

/**
 * THE WHOLE SURFACE, AND WHY IT IS READ RATHER THAN PUSHED.
 *
 * §3.3 — pull, never push. The client asks for the canvas and gets whatever it
 * is right now; `rev` rises on every change so a poll can skip a render it has
 * already seen. Nothing here is a subscription, and a client that stops asking
 * costs the daemon nothing.
 */
export const SpoolCanvasState = z.object({
  rev: z.number(),
  blocks: z.array(SpoolCanvasBlock),
  /** Composing, or settled. `building` is what makes the surface visibly alive:
   *  blocks arrive one at a time while this is true. */
  status: z.enum(["idle", "building", "done", "failed"]),
  /** What the composer is doing right now — the step line, per canvas. */
  step: z.string().optional(),
  /** What it said when it finished. The chat's side of the same turn. */
  say: z.string().optional(),
  /** Set when `status` is `failed`, in the voice the module uses everywhere:
   *  what did not happen, and that nothing was written. */
  reason: z.string().optional(),
  schemaVersion: z.number(),
});
export type SpoolCanvasState = z.infer<typeof SpoolCanvasState>;

/** One exchange in the sidebar. The canvas is the answer; this is the thread of
 *  what was asked, so you can see how you got here. */
export const SpoolCanvasTurn = z.object({
  id: z.string(),
  asked: z.string(),
  said: z.string().optional(),
  label: z.string(),
});
export type SpoolCanvasTurn = z.infer<typeof SpoolCanvasTurn>;
