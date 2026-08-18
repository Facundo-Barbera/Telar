/**
 * THE EPHEMERAL PER-PROJECT EXPERT — CAP-9. One call, one process, no memory
 * between them: everything the expert knows about its project arrives from
 * `spool/experts/<project>/digest.json`, and everything it learns leaves through
 * that same file.
 *
 * Ported from `packages/core/src/workspace/expert.ts`. Two things changed and
 * both are named at the bottom of this header.
 *
 * ── WHY THIS IS A STRUCTURED CALL AND NOT A SUB-AGENT ────────────────────────
 * The spec's own words, and they are the reason the whole module has a seam
 * here at all:
 *
 *   "Sub-agent scope is INVERTED here. Sub-agents normally inherit the caller's
 *    project; in this module the master has NO project and each expert it calls
 *    is scoped to its own. Any agent plumbing that assumes a sub-agent inherits
 *    the caller's project breaks the master."
 *
 * A harness sub-agent is exactly that plumbing: it runs inside the caller's
 * query, with the caller's cwd, tool policy and permission surface. Spawned from
 * the master — whose cwd is an empty directory belonging to no project — a
 * "project expert" would be a project expert in name and a master-shaped agent
 * in fact. `structuredAgent` takes its scope as ARGUMENTS, so an expert gets its
 * own project's root, a read-only wall, and a typed result.
 *
 * ── EPHEMERAL BY CONSTRUCTION, NOT BY PROMISE ────────────────────────────────
 * There is no module-scope state in this file: no cache, no registry, no map of
 * live experts, no handle a caller could keep. `runExpertPass` reads the digest,
 * composes a prompt, awaits one call, writes, and returns.
 *
 * ── DETERMINISTIC CONTROL FLOW HERE, INTELLIGENCE IN THE LEAF ────────────────
 * The model returns a structured result and writes nothing. Every disk write is
 * performed here, through the store's audited verbs — which is why the expert
 * needs no write tools at all, why the human-accept moat is untouched, and why a
 * pass that dies midway leaves the packet exactly as it was.
 *
 * ── THE TWO DEVIATIONS FROM THE DONOR ────────────────────────────────────────
 *  1. NO VERDICT. The donor's expert judged "session or loom" and explained
 *     itself in a `reasoning` line. Looms are not in this app, so the judgement
 *     had one reachable answer and the field is gone rather than degraded — see
 *     `protocol/spool.ts`'s absence note and issue #93. What replaces it, when
 *     something does, is a readiness judgement rather than a routing one; that
 *     belongs with the dispatch loop in `docs/spool-definition.md` §7.4, and it
 *     must arrive with the permission model rather than ahead of it.
 *  2. THE WALL IS NOT SPELLED HERE. The donor named its own tool list, deny
 *     list, model and turn ceiling. Those are now `agent.ts`'s defaults, because
 *     they were never expert-specific — they are what ANY structured call gets,
 *     and one copy is what keeps the next caller from inventing a weaker one.
 */
import { z } from "zod";
import { structuredAgent, type StructuredAgentResult } from "../agent";
import type { SpoolExpertDigest, SpoolItem } from "@telar/engine-client";
import { SpoolExpertDigest as DigestSchema } from "@telar/engine-client";
import {
  applyExpertPass,
  expertDigestPath,
  getSpoolItem,
  readExpertDigest,
  mergeExpertDigest,
  type ExpertPassResult,
  type SpoolPaths,
} from "./store";

// ── what the expert must return ──────────────────────────────────────────────

/**
 * The forced answer shape. `agent.ts` turns this into `emit_result`'s input
 * schema, so a pass either produces this or produces nothing.
 *
 * NOTHING HERE CAN COMMIT. There is no field for a status, an acceptance, a
 * start, a lane change, or a promotion. The widest thing an expert can say is
 * "this is what the fragment means, this is how I would run it, and here is what
 * I heard the user promise someone". Prepare-never-commit is enforced by the
 * SHAPE of the answer rather than by a check on it — which is why this schema is
 * the security boundary and not merely a parsing convenience.
 */
export const ExpertResult = z.object({
  fixed: z
    .string()
    .describe(
      "The shorthand fragment rewritten as a brief someone could execute from, in this project's own terms. Do not restate the raw text; decompress it.",
    ),
  acceptance: z
    .array(z.string())
    .describe("Criteria the finished work must meet. Concrete and checkable; [] if you genuinely have none."),
  note: z.string().describe("One line naming what you changed about the brief, for the ripening timeline."),
  commitments: z
    .array(
      z.object({
        text: z.string().describe("The commitment in the capture's own words — quote, never paraphrase."),
        when: z
          .string()
          .describe("When it was promised for, as coarse human text: 'Thursday', 'next week'. Never a date you computed."),
      }),
    )
    .describe(
      "Time-commitments spoken INSIDE this capture ('we'll sync Thursday', 'I'll send it by Friday'). [] when the capture contains none — do not invent one, and do not mine the deadline the item already carries.",
    ),
  summary: z
    .string()
    .describe("Where this project stands now, in a short paragraph, for your next cold self. Rewrites the digest's summary."),
  methodology: z
    .string()
    .describe(
      "How this project works — its conventions, and for a mirrored project the foreign tracker's methodology translated. Carry the existing text forward unless you learned something.",
    ),
  glossary: z
    .array(z.object({ term: z.string(), means: z.string() }))
    .describe(
      "The project's shorthand, spelled out. Return the whole glossary — a term you restate keeps its place, a term you redefine is updated, and a term you omit is KEPT rather than dropped.",
    ),
  /**
   * NEW FACTS ONLY — and that word is doing the work.
   *
   * This was `notes: string[]`, described as "the whole list; it replaces the
   * stored one", which is exactly how a fact learned three passes ago about a
   * corner of the project this item does not touch quietly disappeared.
   */
  facts: z
    .array(
      z.object({
        text: z.string().describe("One durable fact, in a sentence."),
        kind: z
          .enum(["howItWorks", "person", "decision", "environment"])
          .describe(
            "howItWorks: how the code or the process works — checkable against the tree, and it goes stale when the tree moves. person: who is involved and how; nobody but the user can confirm it. decision: what was decided and why. environment: what is reachable right now — a login, a checkout, a tracker. Be honest with this one: environment facts EXPIRE, and marking a passing condition as durable is how you tell your future self a lie.",
          ),
      }),
    )
    .describe(
      "Facts you learned THIS pass that were not already in what you know. Only new ones — everything already stored is kept whether you restate it or not. [] is the ordinary answer for a pass that learned nothing new.",
    ),
  retire: z
    .array(
      z.object({
        id: z.string().describe("The id of a stored fact, exactly as it was given to you."),
        why: z.string().describe("What makes it no longer true. Recorded beside it permanently."),
      }),
    )
    .describe(
      "Stored facts that have stopped being true — a file that moved, a login that now works, a guess that was wrong. Nothing is deleted: a retired fact is kept with your reason and left out of future prompts. [] when everything you were given still holds. Do not retire a `person` fact; only the user can correct those.",
    ),
});
export type ExpertResult = z.infer<typeof ExpertResult>;

// ── the rehydration prompt ───────────────────────────────────────────────────

/**
 * PURE, and it is the load-bearing function in this file. CAP-9's success
 * condition is "an expert invoked COLD produces project-correct interpretation
 * of a fragment using ONLY the on-disk digest", so what the model is handed has
 * to be a total function of (digest, item): no session history, no caller
 * context, no ambient state, no clock. That is what makes it assertable without
 * a model, and the suite compares it across two fresh processes.
 *
 * THE DIGEST COMES FIRST AND THE FRAGMENT SECOND, deliberately: the expert reads
 * who it is before it reads what it was asked, which is the whole difference
 * between an expert and a generic agent looking at the same sentence.
 */
export function expertPrompt(input: { project: string; digest: SpoolExpertDigest | null; item: SpoolItem }): string {
  const { project, digest, item } = input;
  const lines: string[] = [];
  lines.push(`You are the ${project} expert.`);
  lines.push(
    `You are spawned per call and you keep nothing between calls: the digest below is everything you remember about ${project}, and the digest you return is everything you will remember next time.`,
  );
  lines.push("");
  lines.push(`## ${project} — your digest`);
  if (!digest) {
    // The honest first-pass state, told plainly rather than papered over: an
    // expert that believes it has context it does not have will decompress
    // shorthand by inventing meaning for it.
    lines.push(
      "There is no digest yet — this is your first pass on this project. Say what you can from the fragment alone, and write the digest you wish you had had.",
    );
  } else {
    lines.push(`Last written: ${digest.updated}`);
    if (digest.summary) lines.push("", "### Where it stands", digest.summary);
    if (digest.methodology) lines.push("", "### How this project works", digest.methodology);
    if (digest.glossary.length > 0) {
      lines.push("", "### Its shorthand");
      for (const term of digest.glossary) lines.push(`- ${term.term} — ${term.means}`);
    }
    /**
     * FACTS, NOT NOTES — and RETIRED ONES ARE NOT HERE.
     *
     * A retired fact stays on disk with its reason and is left out of every
     * prompt, which is the entire point of retiring one: the aurora digest's
     * "no locally reachable codebase — searched thoroughly this time" was an
     * agent telling its future self not to look, and until it could be left out
     * of the prompt there was no way to stop it doing so.
     *
     * UNREVIEWED FACTS ARE MARKED. The provenance law — "every artifact an
     * agent produced is marked as such until a human has looked at it" — is
     * worth as much pointed at the model as pointed at the user: a fact no
     * human ever confirmed should not be reasoned from with the same
     * confidence as one you did.
     */
    const live = digest.facts.filter((fact) => !fact.retired);
    if (live.length > 0) {
      lines.push("", "### What you know");
      for (const fact of live) {
        const unchecked = fact.reviewed ? "" : " *(you asserted this; nobody has confirmed it)*";
        // THE ID IS RENDERED because `retire` addresses by it. A model asked to
        // retire a fact it was shown without an address can only describe one,
        // and a retraction matched on prose is a retraction that hits the wrong
        // fact the first time two of them read alike.
        lines.push(`- (${fact.id}) [${fact.kind}] ${fact.text}${unchecked}`);
      }
    }
  }
  lines.push("");
  lines.push("## The item");
  lines.push(`Title: ${item.title}`);
  lines.push(`Captured: ${item.captured} · ${item.provenance}`);
  if (item.mirrored) {
    lines.push(
      `Mirrored: ${item.mirrored} — this project's own tracker is the source of truth. Telar holds a view; translate, never impose.`,
    );
  }
  if (item.deadline) {
    lines.push(
      `Deadline: ${item.deadline.label} · ${item.deadline.kind}${item.deadline.slips ? ` · slid ${item.deadline.slips}×` : ""}`,
    );
  }
  if (item.raw) {
    lines.push("", "### The capture, verbatim");
    // Only when there IS a source. A ternary falling back to "" put a blank line
    // between the heading and the capture for every item without one — prompt
    // noise, deterministic, and the kind that reads as a missing value.
    if (item.rawSource) lines.push(`(from ${item.rawSource})`);
    lines.push(item.raw);
  }
  if (item.fixed) {
    lines.push("", "### The brief as it stands");
    lines.push(item.fixed);
    if (item.acceptance?.length) {
      lines.push("Acceptance:");
      for (const a of item.acceptance) lines.push(`- ${a}`);
    }
  }
  if (item.subtasks?.length) {
    lines.push("", "### Sub-tasks inside it");
    for (const s of item.subtasks) lines.push(`- [${s.done ? "x" : " "}] ${s.title}`);
  }
  // THE VERDICT-OVERRIDE PARAGRAPH STOOD HERE. It told the model the human had
  // already decided so it could spend its reasoning line on WHY it disagreed,
  // rather than arguing with a write that would not happen. It returns with the
  // verdict; see this file's header.
  lines.push("");
  lines.push("## What to do");
  lines.push(
    "Read the capture as this project's expert would: decompress its shorthand, translate its methodology, and say what the work actually is. Then mine any time-commitment the user made to someone inside the capture. Finally, rewrite your digest so your next cold self starts where you are now.",
  );
  lines.push(
    "You may read the project's files. You may not change anything: nothing you return starts, completes or accepts work, and the user looks at all of it before any of it counts.",
  );
  /**
   * THE NO-CLOCK LAW, STATED FOR THE WHOLE ANSWER AND NOT JUST FOR ONE FIELD.
   *
   * FOUND BY DRIVING IT, and the gate could not have caught it. `commitments.when`
   * carried "never a date you computed" in its own description, and the first
   * real pass obeyed that field exactly — then wrote "Ana asked last Thursday
   * (2026-08-13)" into `fixed`, which is free prose with nothing in front of it.
   * The date was resolved from the model's own sense of today, stored in the
   * packet, and rendered on the page: a clock reaching the human, which is the
   * single thing the law forbids.
   *
   * A PER-FIELD RULE TAUGHT THE MODEL TO MOVE THE DATE, not to drop it. The
   * instruction has to bind the answer.
   *
   * IT FORBIDS RESOLVING, NOT MENTIONING, and the second live pass is why. A
   * blanket "never write a date" also banned "the reference doc (2026-08-12)
   * says the check was never run" — a date the expert QUOTED from a file it
   * read, which is provenance the user wants and which no clock produced. The
   * harm is a relative word turned into a specific day, and an assistant
   * asserting what today is; both are named, and quoting is allowed with
   * attribution so the useful half survives.
   */
  lines.push(
    "You do not know what today is. Never turn the user's own time words into a calendar date: \"Thursday\", \"before the close\", \"next week\" must survive in your answer exactly as they said them, in every field. You may quote a date that is written in a document you read, as long as you attribute it to that document — but never compute one, and never state or imply the current date.",
  );
  return lines.join("\n");
}

// ── the pass ─────────────────────────────────────────────────────────────────

export type ExpertPassRequest = {
  itemId: string;
  /** The project this expert IS. Passed explicitly — never derived from a
   *  caller's session, which is the inversion this file exists to respect. */
  project: string;
  /** The project's working root, when it has one. OPTIONAL: a mirrored or
   *  unregistered project may have no checkout on this machine, and CAP-9's
   *  claim is that the DIGEST is enough. Absent means the expert reasons from
   *  the digest and the packet alone. */
  cwd?: string;
  env?: Record<string, string | undefined>;
  binaryPath?: string;
  abort?: AbortController;
  /** Passed straight through to `structuredAgent` so a pass that runs for
   *  minutes can say where it is. Nothing here records it — see `spool/work.ts`
   *  for who listens and why this file stays a pure pass. */
  onStep?: (step: { n: number; label: string }) => void;
};

export type ExpertPassOutcome =
  | {
      ok: true;
      project: string;
      /** The store's own report of what was written. */
      applied: ExpertPassResult;
      digest: SpoolExpertDigest;
      /** Whether the expert started from a digest or from nothing. Reported so a
       *  surface can say "first pass" honestly rather than implying memory it
       *  did not have. */
      cold: boolean;
      /** The checkout the pass actually ran against, echoed back, or undefined
       *  when this machine has none — a caller narrating a consultation has to
       *  be able to say the expert judged the item without ever seeing the
       *  project. */
      cwd?: string;
      /** What it cost. An assistant that runs passes unattended has to be able
       *  to say what a night of them came to. */
      usage?: Extract<StructuredAgentResult<unknown>, { ok: true }>["usage"];
    }
  | { ok: false; reason: string };

/**
 * THE FLOATING REFUSAL AS ONE VALUE FOR THE WHOLE STACK. Two layers notice a
 * floating item — this file, and whatever tool surface refuses before spending a
 * registry lookup — and carrying the sentence as two literals across a boundary
 * means rewording one leaves every suite green while the layers tell the user
 * different things.
 *
 * A FUNCTION AND NOT A CONSTANT, because the sentence names the item: "it
 * belongs to no project" is the fact, and the title is what makes it actionable
 * in a chat that mentioned three of them.
 */
export function floatingExpertRefusal(title: string): string {
  return (
    `"${title}" is floating — it belongs to no project, and an expert is a project's own. ` +
    `File it into a project first, or leave it floating and ask the user.`
  );
}

/** The dispatch seam. A test injects a stub and drives every branch of the pass
 *  without a subprocess — same shape, and same reason, as `agent.ts`'s own. */
export type ExpertDeps = {
  invoke: (prompt: string, req: ExpertPassRequest) => Promise<StructuredAgentResult<ExpertResult>>;
};

const liveInvoke: ExpertDeps["invoke"] = (prompt, req) =>
  structuredAgent(prompt, {
    schema: ExpertResult,
    label: `expert:${req.project}`,
    // Tools, deny list, model and turn ceiling are `agent.ts`'s defaults. See
    // deviation 2 in this file's header: they were never expert-specific.
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.binaryPath ? { binaryPath: req.binaryPath } : {}),
    ...(req.abort ? { abort: req.abort } : {}),
    ...(req.onStep ? { onStep: req.onStep } : {}),
  });

/**
 * ONE CALL, ONE PASS. Returns a reason instead of throwing for every case a
 * caller can do something about — a tool surface turns each of these into a
 * sentence the model reads back to the user.
 */
export async function runExpertPass(
  paths: SpoolPaths,
  req: ExpertPassRequest,
  deps: ExpertDeps = { invoke: liveInvoke },
): Promise<ExpertPassOutcome> {
  const item = getSpoolItem(paths, req.itemId);
  if (!item) return { ok: false, reason: `No spool item found with id "${req.itemId}".` };
  if (!item.project) {
    // A FLOATING ITEM HAS NO EXPERT, and that is a resting state rather than an
    // error. There is no generic fallback expert: the whole capability is "the
    // project's own expert reads what a generic agent cannot", so a generic pass
    // would be the thing CAP-9 exists instead of.
    return { ok: false, reason: floatingExpertRefusal(item.title) };
  }
  if (item.project !== req.project) {
    // Refused rather than silently re-scoped: an expert answering about a
    // project it is not is the cross-project leak the tool surface's scoping
    // exists to prevent.
    return { ok: false, reason: `"${req.itemId}" belongs to ${item.project}, not ${req.project}.` };
  }

  /**
   * THE DIGEST'S ADDRESS IS CHECKED BEFORE THE MONEY IS SPENT. `SpoolItem.project`
   * is a free string with no slug guard — the queue will happily file an item
   * under "My Project" — while a digest lives at `experts/<project>/digest.json`
   * and the store refuses a name it cannot address. Without this check the
   * mismatch surfaces at the LAST step, after the model call and after the
   * packet write: money spent, half the pass on disk, and a caller told nothing
   * was written.
   *
   * IT ASKS THE STORE RATHER THAN RE-SPELLING ITS RULE, so the two cannot drift.
   */
  try {
    expertDigestPath(paths, req.project);
  } catch (error) {
    return {
      ok: false,
      reason:
        `"${req.project}" is not a project name this store can address on disk (${error instanceof Error ? error.message : String(error)}). ` +
        `An expert's memory lives at spool/experts/<project>/digest.json, so the name has to be a plain slug — letters, digits, "_", "." or "-". ` +
        `Rename the project on this item first; nothing was written and no expert was called.`,
    };
  }

  // COLD START. Read at the top of the pass and nowhere else: everything the
  // expert knows comes from this one read.
  const digest = readExpertDigest(paths, req.project);
  const prompt = expertPrompt({ project: req.project, digest, item });

  const result = await deps.invoke(prompt, req);
  if (!result.ok) {
    /**
     * NOTHING IS WRITTEN. A half-pass that recorded a brief with no digest
     * behind it is worse than no pass at all, and the next pass starts cold from
     * the same disk state.
     *
     * THE RUNNER'S OWN SENTENCE IS PASSED THROUGH rather than replaced with a
     * generic one: it already distinguishes "never answered" from "answered in
     * the wrong shape" from "there is no Claude here", and those are three
     * different things for a user to do next.
     */
    return { ok: false, reason: result.reason };
  }

  // PACKET FIRST, DIGEST SECOND. The packet is the user's own item and the
  // digest is re-derivable, so a crash in the gap costs the expert's memory of
  // one pass, never the enrichment a human is waiting to look at.
  const applied = applyExpertPass(paths, req.itemId, {
    fixed: result.value.fixed,
    acceptance: result.value.acceptance,
    note: result.value.note,
    commitments: result.value.commitments,
  });
  if (!applied) return { ok: false, reason: `No spool item found with id "${req.itemId}".` };

  /**
   * THE ONE STEP THAT CAN FAIL AFTER A WRITE HAS ALREADY LANDED, so it is the
   * one step that catches. The reason it returns says exactly what is on disk
   * and what is not, and warns off the blind retry: `applyExpertPass` APPENDS
   * commitments and timeline events by design, so a repeat is not idempotent.
   */
  let written: SpoolExpertDigest;
  try {
    /**
     * MERGED, NOT OVERWRITTEN. This handed `writeExpertDigest` a fresh object
     * built entirely from the model's answer, which meant every pass rebuilt the
     * project's whole memory through the lens of one item — see
     * `mergeExpertDigest` for the three failures that produced.
     */
    written = mergeExpertDigest(paths, req.project, {
      // The pass's own label, minted by the store's clock the same way every
      // other display label in this subtree is — never re-derived here, so the
      // digest, its facts' provenance and the timeline events of one pass all
      // carry the same label.
      at: applied.at,
      summary: result.value.summary,
      methodology: result.value.methodology,
      glossary: result.value.glossary,
      facts: result.value.facts,
      retire: result.value.retire,
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        `The ${req.project} expert's enrichment DID land on "${req.itemId}" — the brief, the note and any mined commitment are on the packet — but the expert's own digest could not be written: ${error instanceof Error ? error.message : String(error)}. ` +
        `Nothing needs repairing on the item; the expert simply starts its next pass cold. Do not repeat the pass to "finish" it — a repeat appends its mined commitments and timeline events again.`,
    };
  }

  return {
    ok: true,
    project: req.project,
    applied,
    digest: written,
    cold: digest === null,
    // Echoed, never re-derived.
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
