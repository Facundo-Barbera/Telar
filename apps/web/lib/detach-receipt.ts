// THE DETACH RECEIPT — one grammar, every surface that ever detaches a loom.
//
// SPEC-organization-workspace/SPEC.md (CAP-11) states it as a constraint, not a
// preference: "The detach receipt grammar is universal — one mono line,
// identical whether it fires from a birth session, the queue's batch weave, or
// a packet's handoff." Before this story the line existed only in the demo
// gallery, three times, in three different phrasings (birth/birth.tsx:142,
// workspace/packet.tsx:175, workspace/queue.tsx:248). This module is the one
// place that composes it, and components/common/detach-receipt.tsx is the one
// place that renders it — so "identical" is true by construction rather than by
// three authors agreeing.
//
// PURE, AND DELIBERATELY IMPORT-FREE. It is called from a route handler
// (workspace-handoff.ts, server) AND from a client component (the queue's batch
// bar, the packet's "Its turn came", the session transcript's birth marker).
// @telar/core is server-only, so nothing here may reach for it; everything this
// needs arrives as counts and flags the caller already has.
//
// WHAT THE LINE MAY SAY. Four segments, in this order, joined with " · ":
//   loom created — <loomId>
//   premise = <what the loom was given to do>      (optional)
//   context = <what it was given to do it with>    (optional)
//   detached from <origin>
// The two optional middles are what make the birth session's line — "loom
// created — loom/x · detached from this session" — the SAME line as the
// workspace's, rather than a different one that happens to rhyme: a session
// hands over a whole conversation and has no tally to name, so it names
// neither. The head and the tail are never optional, because they carry the two
// facts the receipt exists for: a loom now exists, and it is no longer here.

export type DetachReceipt = {
  // The loom's id as the surfaces show it. Never a URL — the link is the
  // renderer's business, and a receipt that reads as a link stops being a
  // receipt.
  loomId: string;
  premise?: string;
  context?: string;
  // "this session" | "the workspace" today. A free string because the sentence
  // is "detached from <somewhere>" and a union here would have to be widened by
  // every future surface that detaches — the grammar is the invariant, not the
  // list of places.
  origin: string;
  // The SECOND line: quieter, surface-specific, and never part of the mono
  // grammar above. This is where "the rows stay in the queue and leave when it
  // lands and you accept" lives, so that clause cannot drift into the one line
  // every surface shares.
  note?: string;
};

const DETACH_HEAD = "loom created — ";

export function detachReceiptLine(receipt: DetachReceipt): string {
  return [
    `${DETACH_HEAD}${receipt.loomId}`,
    receipt.premise ? `premise = ${receipt.premise}` : null,
    receipt.context ? `context = ${receipt.context}` : null,
    `detached from ${receipt.origin}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

// ── the birth session (apps/web/components/session/session-view.tsx) ──────────
//
// A session that starts a loom emits exactly this. No premise/context segments:
// see the header — the handover is the conversation itself, and inventing a
// tally for it would be the surface guessing.
export function birthDetachReceipt(loomId: string): DetachReceipt {
  return { loomId, origin: "this session" };
}

// ── the workspace's two handoffs (packet, and the queue's batch) ──────────────

export type WeaveMembers = {
  // How many items the loom carries. 1 = a packet's own handoff; N = the
  // queue's batch weave. ONE function for both, because CAP-11's "both
  // handoffs" is a single grammar with a count in it, not two receipts.
  items: number;
  // How many of them carry an expert-written brief (Item.fixed) and how many
  // carry acceptance criteria. Named honestly rather than assumed: a bare
  // one-liner woven straight off the queue has neither, and the receipt has to
  // be able to say so — "premise = the fixed brief + acceptance criteria" over
  // an item that has neither would be the receipt lying about what the loom
  // was given.
  fixed: number;
  acceptance: number;
  // Attachment files across every member (store.ts's attachmentTally, summed).
  attachments: number;
};

// "the fixed brief + acceptance criteria" / "2 items' briefs" / "the title
// alone" — what the loom was actually handed.
export function premiseLabel(m: WeaveMembers): string {
  const criteria = m.acceptance > 0 ? " + acceptance criteria" : "";
  if (m.items === 1) {
    return m.fixed > 0 ? `the fixed brief${criteria}` : `the title and the raw capture${criteria}`;
  }
  const briefs = m.fixed === m.items ? "briefs" : "briefs and raw captures";
  return `${m.items} items' ${briefs}${criteria}`;
}

export function contextLabel(m: WeaveMembers): string {
  if (m.attachments === 0) return "no attachments";
  return m.attachments === 1 ? "1 attachment" : `${m.attachments} attachments`;
}

// The quiet second line. Both clauses are CAP-11's own sentences: the row stays
// in the queue and leaves only when the loom lands AND the human accepts, and
// this module stops at the detach boundary ("preparation runs on the loom's own
// graph" — the demo packet's own words for it).
export function trackingNote(items: number): string {
  const rows =
    items === 1
      ? "the packet stays in the queue as the loom's origin receipt · it leaves when the loom lands and you accept"
      : `all ${items} rows stay in the queue tracking the loom · they leave when it lands and you accept`;
  return `${rows} · preparation runs on the loom's own graph`;
}

export function weaveDetachReceipt(loomId: string, members: WeaveMembers): DetachReceipt {
  return {
    loomId,
    premise: premiseLabel(members),
    context: contextLabel(members),
    origin: "the workspace",
    note: trackingNote(members.items),
  };
}

// THE SAME RECEIPT, SEEN LATER — a surface that finds `Item.tracking` already
// set and was not the mount that wove it.
//
// IT DROPS THE TWO MIDDLE SEGMENTS ON PURPOSE, and this is the reason the
// grammar has them optional at all (see the header): a weave's premise/context
// tally describes what the loom was handed AT THAT MOMENT, and the only things
// a later visit can see are the packet's fields TODAY. Re-deriving the tally
// from them — which the packet view did in the first pass — silently rewrites
// history the moment someone adds an attachment or an expert fixes the brief:
// the row would claim the loom got a fixed brief it never saw. Nothing durable
// records the original tally (Item.tracking is a weak ref by AD-8, not an
// archive), so the honest line is the one that states only what is still true:
// a loom exists, and this row detached to it.
export function trackedDetachReceipt(loomId: string, items: number): DetachReceipt {
  return { loomId, origin: "the workspace", note: trackingNote(items) };
}
