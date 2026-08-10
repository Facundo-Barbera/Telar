// THE EPHEMERAL PER-PROJECT EXPERT — SPEC-organization-workspace CAP-9, story
// 5.8. One call, one process, no memory between them: everything the expert
// knows about its project arrives from `experts/<project>/digest.yaml` on disk,
// and everything it learns leaves through that same file.
//
// ── WHY THIS IS AN `agent()` CALL AND NOT AN SDK SUB-AGENT ───────────────────
// The obvious dispatch is the harness's own spawn tool: the chat route already
// carries sub-agent machinery (canUseTool's `agentID`, the parent-tool-use-id
// flattening, per-subagent tabs), and apps/web/lib/master-chat.ts predicted in
// writing that "when the per-project experts of story 8 arrive they are the
// first frames with a `parent`". That prediction is not honoured, deliberately,
// and the spec's own words are why:
//
//   "Sub-agent scope is INVERTED here. Sub-agents normally inherit the caller's
//    project; in this module the master has NO project and each expert it calls
//    is scoped to its own. Any agent plumbing that assumes a sub-agent inherits
//    the caller's project breaks the master." (SPEC.md.)
//
// A harness sub-agent is exactly that plumbing. It runs inside the caller's
// query: the caller's `cwd` (for the master, `workspace/home` — an empty
// directory belonging to no project), the caller's resolved tool policy, the
// caller's MCP mounts, the caller's permission mode. There is no per-spawn
// scope to hand it, so a "project expert" spawned that way would be a project
// expert in name and a master-shaped agent in fact — and its tool calls would
// arrive at the master's own permission surface, where the store's guardrails
// are written for a session with no project.
//
// `agent()` (engine.ts) takes its scope as ARGUMENTS: cwd, tools, restrictTools,
// model, and a forced result schema. So an expert gets its own project's root as
// a working directory, a read-only capability wall, and a typed result — and the
// master's turn is untouched by it. It is also the mechanism Ultra already uses
// for its own child agents, which is why the chat route's comment can say those
// "are spawned in-process by the executor and never reach this channel".
//
// EPHEMERAL BY CONSTRUCTION, and it is structural rather than promised: there is
// no module-scope state in this file — no cache, no registry, no map of live
// experts, no handle a caller could keep. `runExpertPass` reads the digest,
// composes a prompt, awaits one call, writes, and returns. The process ends with
// the call. workspace-expert.test.ts proves the "cold" half by building the
// prompt in a FRESH PROCESS that has only the digest, and asserting it is
// byte-identical to the one this process builds.
//
// ── DETERMINISTIC CONTROL FLOW IN CODE, INTELLIGENCE IN THE LEAVES ───────────
// The model returns a STRUCTURED RESULT and writes nothing. Every disk write in
// a pass is performed here, by store.ts's audited verbs (applyExpertPass,
// writeExpertDigest) — which is why the expert needs no write tools at all, why
// the Human-Accept Moat is untouched (no verb it can reach accepts, completes or
// deletes anything), and why a pass that dies mid-way leaves the packet exactly
// as it was.
import { z } from "zod";
import { agent, type AgentOpts } from "../engine";
import type { AccountProfile } from "../schemas";
import { ExpertDigest, type Item, type ItemVerdict } from "./schema";
import {
  applyExpertPass,
  expertDigestPath,
  getWorkspaceItem,
  readExpertDigest,
  writeExpertDigest,
  type ExpertPassResult,
} from "./store";

// ── what the expert must return ──────────────────────────────────────────────

// The forced result shape — engine.ts's `agent()` turns this into the `out` MCP
// server's `emit_result` tool, so a pass either produces this or produces null.
//
// NOTHING HERE CAN COMMIT. There is no field for a status, an acceptance, a
// start, a lane change or a promotion: the widest thing an expert can say is
// "this is what the fragment means, this is how I would run it, and here is what
// I heard the user promise someone". NFR-OW-2's "prepare, never commit" is
// enforced by the SHAPE of the answer rather than by a check on it.
export const ExpertResult = z.object({
  fixed: z
    .string()
    .describe(
      "The shorthand fragment rewritten as a brief someone could execute from, in this project's own terms. Do not restate the raw text; decompress it.",
    ),
  acceptance: z
    .array(z.string())
    .describe("Criteria the finished work must meet. Concrete and checkable; [] if you genuinely have none."),
  verdict: z
    .enum(["session", "loom"])
    .describe(
      "How this should be executed: 'session' for exploratory or small work a human drives in a chat, 'loom' for work with a stable objective that can be planned and verified. ADVISORY — a human may override you and their choice is final.",
    ),
  reasoning: z
    .string()
    .describe("One line: why that verdict. The user reads this on the packet timeline before deciding whether to override it."),
  note: z
    .string()
    .describe("One line naming what you changed about the brief, for the ripening timeline."),
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
    .describe("How this project works — its conventions, and for a mirrored project the foreign tracker's methodology translated. Carry the existing text forward unless you learned something."),
  glossary: z
    .array(z.object({ term: z.string(), means: z.string() }))
    .describe("The project's shorthand, spelled out. The WHOLE glossary, not just additions — it replaces the stored one."),
  notes: z
    .array(z.string())
    .describe("Durable notes your next cold self should have. The whole list; it replaces the stored one."),
});
export type ExpertResult = z.infer<typeof ExpertResult>;

// ── the rehydration prompt ───────────────────────────────────────────────────

// PURE, and it is the load-bearing function in this file. CAP-9's success
// condition is "an expert invoked COLD produces project-correct interpretation
// of a fragment using ONLY the on-disk digest", so what the model is handed has
// to be a total function of (digest, item) — no session history, no caller
// context, no ambient state. That makes it testable without a model, and it is
// what the cold-process test compares across two processes.
//
// THE DIGEST COMES FIRST AND THE FRAGMENT SECOND, deliberately: the expert reads
// who it is before it reads what it was asked, which is the whole difference
// between an expert and a generic agent looking at the same sentence.
export function expertPrompt(input: {
  project: string;
  digest: ExpertDigest | null;
  item: Item;
}): string {
  const { project, digest, item } = input;
  const lines: string[] = [];
  lines.push(`You are the ${project} expert.`);
  lines.push(
    `You are spawned per call and you keep nothing between calls: the digest below is everything you remember about ${project}, and the digest you return is everything you will remember next time.`,
  );
  lines.push("");
  lines.push(`## ${project} — your digest`);
  if (!digest) {
    // The honest first-pass state. Told plainly rather than papered over,
    // because an expert that believes it has context it does not have will
    // decompress shorthand by inventing meaning for it.
    lines.push(
      "There is no digest yet — this is your first pass on this project. Say what you can from the fragment alone, and write the digest you wish you had had.",
    );
  } else {
    lines.push(`Last written: ${digest.updated}`);
    if (digest.summary) lines.push("", "### Where it stands", digest.summary);
    if (digest.methodology) lines.push("", "### How this project works", digest.methodology);
    if (digest.glossary.length > 0) {
      lines.push("", "### Its shorthand");
      for (const t of digest.glossary) lines.push(`- ${t.term} — ${t.means}`);
    }
    if (digest.notes.length > 0) {
      lines.push("", "### Notes to yourself");
      for (const n of digest.notes) lines.push(`- ${n}`);
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
  // THE OVERRIDE IS STATED TO THE MODEL, not merely enforced behind it. The gate
  // in applyExpertPass holds regardless, but an expert told the human already
  // decided can spend its verdict line on WHY it disagrees — which is the
  // sentence the packet timeline exists to carry — instead of arguing with a
  // write that will not happen.
  if (item.verdictOverride && item.verdict) {
    lines.push(
      "",
      `The user set this item's verdict to "${item.verdict}" themselves. That is final and you cannot change it. Give your own reading anyway — it is recorded on the timeline beside theirs, and disagreeing is useful.`,
    );
  }
  lines.push("");
  lines.push("## What to do");
  lines.push(
    "Read the capture as this project's expert would: decompress its shorthand, translate its methodology, and say what the work actually is. Then judge whether it should run as a session or as a loom, and mine any time-commitment the user made to someone inside the capture. Finally, rewrite your digest so your next cold self starts where you are now.",
  );
  lines.push(
    "You may read the project's files. You may not change anything: nothing you return starts, completes or accepts work, and the user looks at all of it before any of it counts.",
  );
  return lines.join("\n");
}

// ── the pass ─────────────────────────────────────────────────────────────────

// The read-only capability wall. RESTRICTED rather than merely un-granted:
// `agent()` runs at `permissionMode: "bypassPermissions"`, under which
// `allowedTools` does not gate AVAILABILITY — without `restrictTools` the whole
// claude_code preset (Write/Edit/Bash/Agent) stays loaded and an expert could
// edit the project it was invoked to read. The Verifier sets the same pair for
// the same reason; see engine.ts's `restrictTools`.
const EXPERT_TOOLS = ["Read", "Grep", "Glob"] as const;

// DEFENCE IN DEPTH, AND IT IS VERIFIER.TS'S OWN SIX NAMES RATHER THAN A LIST
// INVENTED HERE. Redundant with `restrictTools` today and kept anyway, for the
// two reasons AD-2 already states for the judge: an explicit SDK disallow wins
// over ANY allow rule, and a built-in that lands under a NEW name (the reason
// "MultiEdit" is on the list) is available the day it ships unless something
// names it. It matters more here than there: the verifier's `cwd` is a scratch
// evidence directory, while an expert's is the USER'S OWN CHECKOUT of the
// project it is expert in — the one tree in this whole capability that a human
// would notice being edited.
//
// "Agent" IS THE LOAD-BEARING NAME. A harness sub-agent spawned from inside a
// pass is exactly the plumbing this file's header refuses (it would inherit the
// EXPERT's cwd and policy, and SPEC.md's inverted-scope rule is about who
// scopes whom), and it would quietly make "no expert process persists between
// calls" a claim about only the outermost one.
const EXPERT_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"] as const;

// Explicit, never inherited. Per the repo's own workflow rule, a fan-out that
// does not name its model gets whatever the SDK defaults to, which is a silent
// choice nobody made. Callers may override per call.
const EXPERT_MODEL = "sonnet";

// STATED, NOT INHERITED, and generous on purpose. engine.ts's default is 30; a
// number left unwritten is a ceiling nobody chose. The asymmetry that decides
// the direction to err in is `runExpertPass`'s own: a pass that runs out of
// turns emits no structured result, and this file then writes NOTHING — so a
// tight cap does not return a shorter answer, it loses the whole pass AND the
// money already spent reaching that turn. 40 is the Verifier's ceiling, and an
// expert reading a strange repo to decompress one line of shorthand is the same
// order of work.
const EXPERT_MAX_TURNS = 40;

export type ExpertPassRequest = {
  itemId: string;
  // The project this expert IS. Passed explicitly — never derived from a caller's
  // session, which is the inversion this whole file exists to respect.
  project: string;
  // The project's working root, when it has one. OPTIONAL: a mirrored or
  // unregistered project may have no checkout on this machine, and CAP-9's claim
  // is that the DIGEST is enough. Absent means the expert reasons from the
  // digest and the packet alone.
  cwd?: string;
  // NO `model` KEY, DELIBERATELY (fix-round correction — there was one, and no
  // production path could spell it). `EXPERT_MODEL` is the whole answer: the one
  // caller of this function is consultExpert, whose options are an account, a
  // test seam and an abort, and a per-call model override that only a test can
  // reach is the kind of parameter a later story threads out of TOOL INPUT — at
  // which point a model the operator never chose runs on the user's checkout.
  // Add it back when something other than a test needs it, with the wall around
  // it decided at the same time.
  account?: AccountProfile;
  abort?: AbortController;
};

export type ExpertPassOutcome =
  | {
      ok: true;
      project: string;
      // The store's own report of what was written, including whether a human
      // override held the verdict back.
      applied: ExpertPassResult;
      verdict: ItemVerdict;
      verdictHeld: boolean;
      digest: ExpertDigest;
      // Whether the expert started from a digest or from nothing. Reported so a
      // surface can say "first pass" honestly rather than implying memory it did
      // not have.
      cold: boolean;
      // The checkout the pass actually ran against, echoed back, or undefined
      // when this machine has none. REPORTED FOR THE SAME REASON `cold` IS: a
      // pass with no cwd read no files, and `cold` is about the digest, not about
      // the tree — so without this a caller narrating a consultation cannot tell
      // the user the expert judged their item without ever seeing the project.
      cwd?: string;
    }
  | { ok: false; reason: string };

// THE FLOATING REFUSAL, AS ONE VALUE FOR THE WHOLE STACK (fix-round correction).
// Two layers notice a floating item — this file, and apps/web's consultExpert,
// which refuses before it spends a registry lookup — and until this function
// existed they carried the same sentence as two byte-identical string literals
// across a package boundary, pinned by nothing stronger than `toContain
// ("floating")` on each side. Rewording one copy would have left every suite
// green while the two layers told the user different things.
//
// A FUNCTION AND NOT A TEMPLATE CONSTANT, because the sentence names the item:
// "it belongs to no project" is the fact, and the title is what makes it
// actionable in a chat that mentioned three items.
export function floatingExpertRefusal(title: string): string {
  return (
    `"${title}" is floating — it belongs to no project, and an expert is a project's own. ` +
    `File it into a project first, or leave it floating and ask the user.`
  );
}

// The dispatch seam. `invoke` defaults to the real model call; a test injects a
// stub and drives every branch of the pass without a subprocess. Same shape
// runner/lease.ts uses for its own DI seam, and the reason is the same: the one
// non-deterministic step is on its own line.
export type ExpertDeps = {
  invoke: (prompt: string, req: ExpertPassRequest) => Promise<ExpertResult | null>;
};

// THE WALL AS A VALUE, not as an argument list buried in a call. Extracted for
// one reason: every claim this file's header makes about an expert — read-only,
// unconfigurable, un-nested, model named out loud — is a property of this object,
// and a property nothing can assert on is a property that drifts. A test reads it
// without a provider; `liveInvoke` is then one line with nothing left to get
// wrong. PURE: a total function of the request, no ambient reads.
export function expertAgentOptions(req: ExpertPassRequest): AgentOpts<typeof ExpertResult.shape> {
  return {
    schema: ExpertResult,
    label: `expert:${req.project}`,
    // See EXPERT_MODEL — named, and NOT overridable per call (see the request
    // shape): there is no caller-supplied model anywhere on this path.
    model: EXPERT_MODEL,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    tools: [...EXPERT_TOOLS],
    // See EXPERT_TOOLS — availability, not just approval.
    restrictTools: true,
    // See EXPERT_DENIED_TOOLS — belt and braces over the same wall.
    disallowedTools: [...EXPERT_DENIED_TOOLS],
    // See EXPERT_MAX_TURNS — stated because an exhausted pass writes nothing.
    maxTurns: EXPERT_MAX_TURNS,
    // Zero ambient config discovery, for buildMasterProfile's reason: an expert
    // is not a session the operator configured, and a repo's own `.claude`
    // settings could hand it hooks and MCP servers Telar never mounted.
    settingSources: [],
    ...(req.account ? { account: req.account } : {}),
    ...(req.abort ? { abort: req.abort } : {}),
    // Not "loom-build" and not "ultra": an enrichment pass is background
    // organization work and must never take a slot ahead of work a human is
    // waiting on. "other" is the lowest-weight class with no precedence.
    admissionClass: "other",
  };
}

const liveInvoke: ExpertDeps["invoke"] = (prompt, req) => agent(prompt, expertAgentOptions(req));

// ONE CALL, ONE PASS. Returns a reason instead of throwing for every case a
// caller can do something about — the MCP tool surface turns each of these into
// a sentence the model reads back to the user.
export async function runExpertPass(
  req: ExpertPassRequest,
  deps: ExpertDeps = { invoke: liveInvoke },
): Promise<ExpertPassOutcome> {
  const item = getWorkspaceItem(req.itemId);
  if (!item) return { ok: false, reason: `No workspace item found with id "${req.itemId}".` };
  if (!item.project) {
    // A FLOATING ITEM HAS NO EXPERT, and that is a resting state rather than an
    // error (item-model.md: "Absent = floating. Floating is a valid resting
    // state, not an error"). There is no generic fallback expert: the whole
    // capability is "the project's own expert can read what a generic agent
    // cannot", so a generic pass would be the thing CAP-9 exists instead of.
    return { ok: false, reason: floatingExpertRefusal(item.title) };
  }
  if (item.project !== req.project) {
    // The caller named one project and the item belongs to another. Refused
    // rather than silently re-scoped: an expert answering about a project it is
    // not is the cross-project leak the tool surface's scoping exists to prevent.
    return {
      ok: false,
      reason: `"${req.itemId}" belongs to ${item.project}, not ${req.project}.`,
    };
  }

  // THE DIGEST'S ADDRESS IS CHECKED BEFORE THE MONEY IS SPENT (fix-round
  // correction). `Item.project` is a free string with no slug guard — the queue's
  // PATCH route will happily file an item under "My Project" — while a digest
  // lives at `experts/<project>/digest.yaml` and `expertDigestDir` refuses any
  // name it cannot address. Without this check that mismatch surfaced at the
  // LAST step of the pass, after the model call and after the packet write, as a
  // throw out of `writeExpertDigest`: money spent, half the pass on disk, and a
  // caller told nothing was written.
  //
  // IT ASKS THE STORE RATHER THAN RE-SPELLING ITS REGEX. `expertDigestPath` is
  // the owner of that rule and throws for exactly what the write would throw
  // for, so the two cannot drift.
  try {
    expertDigestPath(req.project);
  } catch (e) {
    return {
      ok: false,
      reason:
        `"${req.project}" is not a project name this store can address on disk (${e instanceof Error ? e.message : String(e)}). ` +
        `An expert's memory lives at workspace/experts/<project>/digest.yaml, so the name has to be a plain slug — letters, digits, "_", "." or "-". ` +
        `Rename the project on this item first; nothing was written and no expert was called.`,
    };
  }

  // COLD START. Read at the top of the pass and nowhere else: everything the
  // expert knows comes from this one read.
  const digest = readExpertDigest(req.project);
  const prompt = expertPrompt({ project: req.project, digest, item });

  const result = await deps.invoke(prompt, req);
  if (!result) {
    // The model produced no structured result (a cancelled turn, a turn limit, a
    // provider failure). NOTHING IS WRITTEN — a half-pass that recorded a brief
    // with no verdict, or a digest with no pass behind it, is worse than no pass
    // at all, and the next pass starts cold from the same disk state.
    return { ok: false, reason: `The ${req.project} expert returned no result; nothing was written.` };
  }

  // PACKET FIRST, DIGEST SECOND. The packet is the user's own item and the
  // digest is re-derivable, so a crash in the gap costs the expert's memory of
  // one pass, never the enrichment a human is waiting to look at.
  const applied = applyExpertPass(req.itemId, {
    fixed: result.fixed,
    acceptance: result.acceptance,
    verdict: result.verdict,
    reasoning: result.reasoning,
    note: result.note,
    commitments: result.commitments,
  });
  if (!applied) {
    return { ok: false, reason: `No workspace item found with id "${req.itemId}".` };
  }

  // THE ONE STEP THAT CAN FAIL AFTER A WRITE HAS ALREADY LANDED, so it is the one
  // step that catches (fix-round correction — it used to throw straight through a
  // committed packet write, and the tool surface above then told the user
  // "Nothing was written", which was false, and invited a retry that appends the
  // mined commitments a second time).
  //
  // The reason it returns says exactly what is on disk and what is not, and warns
  // off the blind retry: `applyExpertPass` APPENDS commitments and timeline
  // events by design (the user's packet is the audit trail), so a repeat is not
  // idempotent. The enrichment itself is intact and needs no repair — only the
  // expert's memory of this pass is lost, which is the asymmetry the packet-first
  // ordering above was chosen for.
  let written: ExpertDigest;
  try {
    written = writeExpertDigest(
      ExpertDigest.parse({
        project: req.project,
        // The pass's own label, minted by the store's clock the same way every
        // other display label in this subtree is — never a caller's string, and
        // never re-derived from the timeline it was stamped onto.
        updated: applied.at,
        summary: result.summary,
        methodology: result.methodology,
        glossary: result.glossary,
        notes: result.notes,
      }),
    );
  } catch (e) {
    return {
      ok: false,
      reason:
        `The ${req.project} expert's enrichment DID land on "${req.itemId}" — the brief, its verdict, the reasoning and any mined commitment are on the packet — but the expert's own digest could not be written: ${e instanceof Error ? e.message : String(e)}. ` +
        `Nothing needs repairing on the item; the expert simply starts its next pass cold. Do not repeat the pass to "finish" it — a repeat appends its mined commitments and timeline events again.`,
    };
  }

  return {
    ok: true,
    project: req.project,
    applied,
    verdict: result.verdict,
    verdictHeld: applied.verdictHeld,
    digest: written,
    cold: digest === null,
    // Echoed, never re-derived: the caller resolved it, the pass ran with it, and
    // a surface narrating the pass has to be able to say the expert had no tree.
    ...(req.cwd ? { cwd: req.cwd } : {}),
  };
}
