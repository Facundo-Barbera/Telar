// The handoff layer (story 5.5, CAP-11) — "prepare the premise, hand it over,
// stop at the detach boundary".
//
// TWO HANDOFFS, ONE FUNCTION. SPEC.md asks for "a single ripened packet handed
// to a session, and a selected batch woven as one loom". They are the same
// operation with a different member count: one loom carries the batch, the
// receipt grammar takes a count (lib/detach-receipt.ts), and Item.tracking is
// stamped on every member either way. Writing them as two functions would give
// the batch and the packet two chances to disagree about what a premise is.
//
// ── WHERE THIS STOPS, AND WHY IT IS A HARD EDGE ──────────────────────────────
// stories.yaml: "This module stops at the detach boundary: never write loom
// state and never done a loom from here." So:
//   - createDraftLoom, NEVER startLoomFromBundle. A draft loom exists on disk
//     (draft:true, state "queued") so the god-view can render the bundle, and
//     it is NOT dispatched — the commit that spends is §M.6's, behind the
//     human's own click on the loom side. "Plan loom from this packet" is the
//     button's honest name: this plans one.
//   - No state assignment anywhere in this file, no accept, no done. grep it.
//   - No un-track path. The rows leave the queue when the loom LANDS and the
//     human ACCEPTS, neither of which happens here (see store.ts's trackLoom).
//
// ── AND WHERE THE HUMAN PICKS IT UP (this is not a dead end) ─────────────────
// A draft written here is NOT startable from here, by the rule above — but it
// has to be startable by SOMEONE or the weave is a trap, and a draft is missing
// the one thing startLoomFromBundle requires that no packet can supply: a
// falsifiable spec/contract.json (dispatcher.ts's CONTRACT GATE). Neither this
// module nor any tool may author that; a Verification Contract is a claim about
// how the work will be PROVEN, which is the planner's conversation with the
// human, not a field on a packet.
//
// So the continuation is the loom side's own existing door, reached by the
// deep link every surface here already renders (`/looms/<id>`): the loom page
// shows a draft as a draft and offers "Continue planning", which opens the Loom
// Session at /looms/plan/<project>?loom=<id> BOUND TO THIS DRAFT. That session
// reads the bundle this weave wrote, proposes the contract, and calls
// start_loom behind the human's own Approve click (§M.6). The workspace hands
// over premise + context and stops; the loom side commits.
//
// ── WHAT THE LOOM IS ACTUALLY HANDED ─────────────────────────────────────────
// item-model.md: "At handoff the packet IS the briefing: premise = `fixed` +
// `acceptance`, context = attachments. Nothing is re-authored." So the premise
// written into objective.md is composed out of the packet's own fields
// verbatim, and this file authors no new prose about the work itself — only the
// headings that separate one member from the next.
//
// ATTACHMENT BYTES ARE NOT COPIED, AND NEITHER IS THEIR PATH. writeBundleFile
// takes a string, the attachments beside a packet are arbitrary files (mockups
// are images), and a byte-copy into loomDir would be this module reaching
// further into loom internals than the boundary above allows. The first pass
// compromised by naming the packet's absolute directory — which is WORSE than
// saying nothing: AD-5 / INV-11b put TELAR_HOME/workspace outside every
// session's working root, and a loom mounts no workspace MCP server, so that
// pointer is unfollowable under Codex's path-based sandbox and is the exact
// isolation leak INV-11b forbids under Claude. context.md therefore NAMES each
// attachment and says plainly that the bytes stayed in the human's workspace
// and are not in this bundle. The receipt's "context = N attachments"
// (ui-contract.md §4's frozen wording) is a tally of what the packet carried,
// which is what the human reading the queue needs it to mean.
import {
  attachmentTally,
  createDraftLoom,
  getLoom,
  getWorkspaceItem,
  isTerminalWorkUnitState,
  readPacketAttachments,
  trackLoom,
  updateDraftObjectiveFromBundle,
  writeBundleFile,
  type Item,
} from "@telar/core";
import {
  weaveDetachReceipt,
  type DetachReceipt,
  type WeaveMembers,
} from "@/lib/detach-receipt";
import { bullets } from "@/lib/session-briefing";

// Thrown for every refusal below. The MESSAGE IS THE PRODUCT: it lands on an
// approval card the model reads back to the user, and on the queue's batch bar
// as an inline alert, so every one of them says what happened and what the human
// can do instead ("start a session instead" is a real alternative on both
// surfaces, and the refusals point at it).
export class HandoffRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffRefused";
  }
}

export type WeavePlan = {
  items: Item[];
  project: string;
  title: string;
  // objective.md's contents — the premise, composed from the packets' own
  // fields.
  premise: string;
  // context.md's contents — what the loom was given to work with.
  context: string;
  members: WeaveMembers;
  // The master's one-line reason the selection coheres, when a proposal made
  // one. A human's own selection in the queue has none, and the surface then
  // shows the count alone rather than inventing a rationale.
  reason?: string;
  // Ids whose EXISTING tracking ref this plan is entitled to overwrite, because
  // the loom it names is gone or dead (see staleTracking below). Empty on the
  // ordinary weave; store.ts's trackLoom refuses a re-point for anything not in
  // here, so this list is the whole of the exception.
  replacing: string[];
};

// One member's slice of the premise. `fixed` when the expert has written it,
// otherwise the raw capture — item-model.md keeps raw beside fixed precisely so
// a handoff can be honest about which one it had.
function premiseSection(item: Item, heading: string): string {
  const body = item.fixed?.trim() || item.raw?.trim() || "(no brief was written — the title is all there is)";
  const parts = [`${heading} ${item.title}`, "", body];
  if (item.acceptance?.length) {
    parts.push("", "Acceptance criteria:", bullets(item.acceptance));
  }
  return parts.join("\n");
}

function contextSection(item: Item, attachments: string[], heading: string): string {
  const parts = [`${heading} ${item.title}`, "", `workspace item: \`${item.id}\``];
  if (item.project) parts.push(`project: ${item.project}`);
  if (item.deadline) parts.push(`deadline: ${item.deadline.label} (${item.deadline.kind})`);
  if (item.subtasks?.length) {
    parts.push("", "Sub-tasks the packet already carries:");
    parts.push(bullets(item.subtasks.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.title}`)));
  }
  if (attachments.length) {
    // NAMED, NOT LOCATED, AND NOT HANDED OVER. See the header: the bytes stay
    // in the human's workspace, which is outside every session's working root
    // by construction, so a path here would be a pointer this loom cannot
    // follow. Saying so is the honest version — a loom that needs one asks.
    parts.push("", `Attachments the packet carries (${attachments.length}):`);
    parts.push(bullets(attachments));
    parts.push(
      "",
      "These files are NOT in this bundle: they sit beside the packet in the human's workspace, which is outside this loom's working root. Work from their names; ask the human for one if you need its contents.",
    );
  } else {
    parts.push("", "No attachments.");
  }
  return parts.join("\n");
}

// Is an existing tracking ref DEAD — i.e. can its loom never land and never be
// accepted, so the row it marks could never leave the queue on its own?
//
// TWO CASES, AND BOTH ARE ABOUT THE LOOM, NOT THE PACKET: the loom is gone
// (deleted from the god-view — AD-8's weak reference now dangling), or it is
// terminal in a way that is not `done` (halted / failed / skipped). `done` is
// deliberately NOT dead: that loom LANDED, and the row leaves when the human
// accepts it, which is the sentence CAP-11 is made of. A live loom in any
// non-terminal state is not dead either — it is still weaving on a premise
// built from this packet.
//
// This is the ONLY reader of loom state in this module, and it reads: it never
// writes one (the boundary in the header still holds).
function staleTracking(item: Item): boolean {
  const loomId = item.tracking?.loomId;
  if (!loomId) return false;
  const loom = getLoom(loomId);
  if (!loom) return true;
  return isTerminalWorkUnitState(loom.state) && loom.state !== "done";
}

// Read the members and compose everything the weave will write — WITHOUT
// WRITING ANY OF IT.
//
// IT IS THE PURE HALF, NOT A PREVIEW ENDPOINT, and the difference matters
// because an earlier pass of this story claimed both. The human-side approval
// is the click itself ("Weave as one loom"); the agent-side one is the shared
// ApprovalCard, which renders `weave_batch`'s own INPUT (the ids and the
// reason) before the tool runs — neither of them reads a plan. So there is no
// GET /api/workspace/weave (see that route's header for the same argument from
// the other side), and this function's callers are weaveItems and its tests.
// Keeping it separate is still worth it: every refusal below is proved to fire
// before a single byte is written, which is what "nothing was woven" in those
// messages is allowed to mean.
export function planWeave(itemIds: string[], opts?: { reason?: string; title?: string }): WeavePlan {
  const ids = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new HandoffRefused("Nothing was selected — name at least one workspace item to weave.");
  }

  const items: Item[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const item = getWorkspaceItem(id);
    if (item) items.push(item);
    else missing.push(id);
  }
  if (missing.length) {
    throw new HandoffRefused(
      `No workspace item found with id ${missing.map((m) => `"${m}"`).join(", ")}. Nothing was woven.`,
    );
  }

  // ALREADY WOVEN IS A REFUSAL, NOT AN OVERWRITE. The first loom is still
  // weaving on a premise built from this packet; a second one would leave the
  // queue tracking only the newer of the two (store.ts's trackLoom refuses the
  // re-point, and a weave whose stamp silently failed would be worse than one
  // that never happened).
  //
  // UNLESS THAT LOOM IS DEAD (staleTracking above). A loom the human cancelled,
  // one that failed, or one deleted from the god-view can never land and can
  // never be accepted — so its members could never leave the queue AND could
  // never be woven again, which turns a mark into a life sentence over an event
  // that already ended badly. Those rows are re-weavable, and the ids ride along
  // in `replacing` so store.ts's re-point refusal is lifted for exactly them.
  // This is also the repair path for a batch whose stamping loop was cut in
  // half by a crash: cancel the half-tracked draft, weave again.
  const woven = items.filter((i) => i.tracking?.loomId);
  const stale = woven.filter(staleTracking);
  const live = woven.filter((i) => !stale.includes(i));
  if (live.length) {
    throw new HandoffRefused(
      `${live.map((i) => `"${i.title}"`).join(", ")} already ${live.length === 1 ? "tracks" : "track"} ` +
        `loom ${live.map((i) => i.tracking!.loomId).join(", ")}. A row leaves the queue when its loom lands and you accept — ` +
        `it is not re-woven in the meantime. (Cancel that loom if it should not run, and the row can be woven again.)`,
    );
  }

  // A LOOM BELONGS TO ONE PROJECT. A floating item (item-model.md: "absent =
  // floating, and floating is a valid resting state") has no repo to weave in,
  // and a mixed selection has two — both are the human's call to make, not a
  // guess this layer gets to take.
  const projects = [...new Set(items.map((i) => i.project ?? ""))];
  if (projects.includes("")) {
    const floating = items.filter((i) => !i.project).map((i) => `"${i.title}"`);
    throw new HandoffRefused(
      `${floating.join(", ")} ${floating.length === 1 ? "is" : "are"} floating — no project, so there is no repo for a loom to weave in. ` +
        `File it to a project first, or start a session instead.`,
    );
  }
  if (projects.length > 1) {
    throw new HandoffRefused(
      `That selection spans ${projects.length} projects (${projects.join(", ")}). One loom weaves in one project — ` +
        `split the selection, or start a session for each.`,
    );
  }
  const project = projects[0]!;

  // ONE READ PER MEMBER, and both consumers are fed from it: the receipt's
  // tally and context.md's list. Reading the directory twice (once here, once
  // inside the context composition) meant 2N reads for an N-item batch and, if
  // a file landed between them, a receipt that counted one thing while the
  // manifest named another.
  const attachments = new Map(items.map((i) => [i.id, readPacketAttachments(i.id)]));
  const tallies = items.map((i) => attachmentTally(attachments.get(i.id)!));
  const members: WeaveMembers = {
    items: items.length,
    fixed: items.filter((i) => i.fixed?.trim()).length,
    acceptance: items.filter((i) => i.acceptance?.length).length,
    attachments: tallies.reduce((n, t) => n + t.files + t.mockups, 0),
  };

  const title =
    opts?.title?.trim() ||
    (items.length === 1 ? items[0]!.title : `${items[0]!.title} + ${items.length - 1} more`);

  const single = items.length === 1;
  const premise = [
    `# ${title}`,
    "",
    opts?.reason?.trim() ? `${opts.reason.trim()}\n` : "",
    single
      ? premiseSection(items[0]!, "##")
      : items.map((i) => premiseSection(i, "##")).join("\n\n"),
    "",
    "---",
    "",
    // The one sentence this file authors about the work, and it is a boundary
    // statement rather than a brief: the loom must not treat the workspace as a
    // place it can write back to.
    "This premise was handed over from the Telar workspace. The workspace items above stay in the human's queue, tracking this loom; they leave it when this loom lands and the human accepts. Nothing in the workspace is yours to change.",
  ]
    .filter((part) => part !== "")
    .join("\n");

  const context = [
    `# Context handed over with ${single ? "this packet" : `these ${items.length} packets`}`,
    "",
    items
      .map((i, n) => contextSection(i, attachments.get(i.id)!, single ? "##" : `## ${n + 1}.`))
      .join("\n\n"),
  ].join("\n");

  return {
    items,
    project,
    title,
    premise,
    context,
    members,
    ...(opts?.reason?.trim() ? { reason: opts.reason.trim() } : {}),
    replacing: stale.map((i) => i.id),
  };
}

export type WeaveResult = {
  loomId: string;
  url: string;
  receipt: DetachReceipt;
  // The ids now marked as tracking the loom — the rows that STAY in the queue.
  tracked: string[];
  title: string;
  project: string;
};

// The effect half. Order matters and is the same order every two-file write in
// this store uses: make the thing that can fail first (the loom and its
// bundle), stamp the packets second. A crash in the gap leaves a draft loom
// nobody is tracking — reachable by its deep link, never started, cancellable —
// where the other order would leave rows tracking a loom that does not exist.
//
// `account` IS THE HUMAN THE LOOM IS BILLED TO, and it is passed by the tool
// path (workspace-mcp.ts hands it the chat's own server-resolved account, the
// same value loom-mcp.ts's start_loom uses for `by`) and deliberately NOT by
// the HTTP route, which has no session identity to read and must not invent one
// from a request body. Omitted, createDraftLoom falls back to the project
// manifest's account — the same default every other project-scoped loom takes.
export function weaveItems(
  itemIds: string[],
  opts?: { reason?: string; title?: string; account?: string },
): WeaveResult {
  const plan = planWeave(itemIds, opts);

  let loomId: string;
  try {
    loomId = createDraftLoom({
      project: plan.project,
      title: plan.title,
      objective: plan.premise,
      ...(opts?.account ? { account: opts.account } : {}),
    }).id;
  } catch (e) {
    // getProject throws for a project that is not in the registry — an item can
    // name a project the human later un-registered.
    throw new HandoffRefused(
      `Could not plan a loom in "${plan.project}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  writeBundleFile(loomId, "objective.md", plan.premise);
  writeBundleFile(loomId, "context.md", plan.context);
  // objective.md is the single source of truth for a draft's objective/title
  // (docs/loom-model.md §5) — the same reconcile draft_bundle_file performs, so
  // a woven loom and a session-drafted one read identically in the god-view.
  updateDraftObjectiveFromBundle(loomId);

  const stamp = trackLoom(
    plan.items.map((i) => i.id),
    { loomId, label: plan.title },
    { replacing: plan.replacing },
  );

  // A PARTIAL STAMP IS A FAILURE, SAID OUT LOUD. trackLoom reports the ids it
  // could not mark (the packet vanished between the plan and the stamp, or
  // another weave in the same window got there first) instead of throwing, and
  // an earlier pass of this function read only `tracked` — so a batch could come
  // back with a receipt claiming "all N rows stay in the queue tracking the
  // loom" while some of them tracked a different loom entirely, and the model
  // was told the same. That is the orphaning store.ts's re-point refusal exists
  // to prevent, re-created one layer up by ignoring it.
  //
  // The draft loom is NOT unwound: it holds the full premise, every surface
  // reaches it by id, and deleting it here would be this module writing loom
  // state. The message names it so the human can open it, and says which rows
  // did and did not get the mark.
  if (stamp.missing.length || stamp.alreadyTracking.length) {
    const parts: string[] = [];
    if (stamp.alreadyTracking.length) {
      parts.push(
        `${stamp.alreadyTracking.map((a) => `${a.id} (already tracking ${a.loomId})`).join(", ")}`,
      );
    }
    if (stamp.missing.length) parts.push(`${stamp.missing.join(", ")} (no readable packet)`);
    throw new HandoffRefused(
      `Loom ${loomId} was planned with all ${plan.items.length} ${plan.items.length === 1 ? "item" : "items"} in its premise, but ` +
        `only ${stamp.tracked.length} of them could be marked as tracking it: ${parts.join("; ")}. ` +
        `Open /looms/${loomId} to read or cancel it — cancelling frees the marked rows to be woven again.`,
    );
  }

  return {
    loomId,
    url: `/looms/${loomId}`,
    receipt: weaveDetachReceipt(loomId, plan.members),
    tracked: stamp.tracked.map((i) => i.id),
    title: plan.title,
    project: plan.project,
  };
}
