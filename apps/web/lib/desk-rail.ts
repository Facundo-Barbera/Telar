// THE DESK'S TWO RULES, AS FUNCTIONS (story 5.7, SPEC-organization-workspace
// CAP-3).
//
// The rail itself is components/workspace/desk-rail.tsx; what lives here is the
// part a test can drive without a DOM — which is, precisely, the two sentences
// the capability is made of:
//
//   1. "Referring to a desk item in conversation updates it IN PLACE (card
//      stays put, marked as just-updated)." A card the master just touched is
//      border-highlighted where it already sits. So the rail needs to know WHICH
//      cards changed between two reads, and it must derive that WITHOUT
//      reordering anything: `deskTouched` returns a set of ids and never a list
//      to render, because a function that returned an ordering could put a
//      touched card at the top — which is exactly the movement the capability
//      forbids. The render order is the store's order, always.
//
//   2. "Dismissing removes it from the desk and it is findable in the queue. No
//      path deletes an item." Dismissal is a PATCH of one field, and the patch
//      is a named constant here so the "no delete path anywhere" law is a thing
//      a test can assert about the rail rather than a thing a reviewer has to
//      re-read the fetch call to believe. There is no DELETE route on
//      app/api/workspace/items/[id] to call even if someone wanted to.
//
// AND THE RAIL'S OWN STATE MACHINE, for the same reason (5.7's review): the
// rail reads on mount AND on every `telar:refresh(workspace)`, so a turn
// settling and a dismiss overlap trivially, and `deskTouched` being provably
// pure buys nothing if a STALE response can land last and become the baseline
// the next diff is measured against — the highlight would then fire on cards
// nobody touched and miss the ones the master did. Ordering, staleness and
// error latching are therefore decided by the reducer below, where a bun test
// can drive them, and the component is left holding only the fetch.
//
// `DeskCard` is core's projection (deskSlice), reached through workspace-api's
// getQueueView().desk. Type-only import: @telar/core is server-only and this
// module is bundled into the client (project-context.md's client-bundle rule).

import type { DeskCard } from "@telar/core";

/** The dismiss write, in full. `desk: false` DRAINS the card to the queue: the
 *  item keeps its id, its lane, its rank, its packet and its attachments — it
 *  simply stops being on the desk. Nothing about this is a deletion, and the
 *  rail's footer says so in words where the human can read it. */
export const DESK_DISMISS_PATCH = { desk: false } as const;

/**
 * Everything about a card that can visibly change. Deliberately NOT the id:
 * this is the value half of "did this card change", and the id is the key half.
 *
 * `unplaced` is in it because a card going from a question to a filed item is
 * the single most worth-noticing edit on this rail — the master answered the
 * thing it could not place.
 */
export function deskCardFingerprint(card: DeskCard): string {
  return JSON.stringify([
    card.title,
    card.project ?? "",
    card.mirrored ?? "",
    // The deadline's own three visible parts: a re-labelled, re-kinded or
    // freshly SLIPPED deadline is an edit the human asked about by name.
    card.deadline ? [card.deadline.label, card.deadline.kind, card.deadline.slips ?? 0] : "",
    card.hint ?? "",
    card.unplaced === true,
  ]);
}

/**
 * Which cards the last read changed — new ones, and ones whose content moved.
 *
 * FIRST READ HIGHLIGHTS NOTHING. `prev === null` means "the rail just mounted",
 * and a rail that lit up every card on arrival would be announcing the desk
 * rather than the edit — on a surface whose whole contract is that it never
 * announces anything (ui-contract.md §1, "pull-based, it never notifies").
 *
 * A DISMISSED CARD IS NOT A TOUCH. It is gone from `next` entirely, so it
 * cannot be in the returned set — the highlight is for cards that are still
 * here and changed, not for an absence.
 */
export function deskTouched(
  prev: readonly DeskCard[] | null | undefined,
  next: readonly DeskCard[],
): ReadonlySet<string> {
  if (!prev) return new Set();
  const before = new Map(prev.map((c) => [c.id, deskCardFingerprint(c)]));
  const touched = new Set<string>();
  for (const card of next) {
    const was = before.get(card.id);
    if (was === undefined || was !== deskCardFingerprint(card)) touched.add(card.id);
  }
  return touched;
}

// ── the rail's state, as a reducer ──────────────────────────────────────────

/** The shape GET /api/workspace/queue answers with, narrowed to what the rail
 *  reads: the desk projection and the queue's own total, for the footer link. */
export type DeskView = { desk: DeskCard[]; totalItems: number };

export type DeskState = {
  /** The newest read this rail has ISSUED. Monotonic; the component mints it. */
  issued: number;
  /** The read currently ON SCREEN. A response older than this is dropped. */
  shown: number;
  view: DeskView | null;
  /** The baseline the next diff is measured against — the desk as last SHOWN,
   *  never as last received, which is the same distinction `shown` makes and
   *  the reason both live in one reducer instead of a ref beside it. */
  previous: DeskCard[] | null;
  touched: ReadonlySet<string>;
  error: string | null;
  /** The card whose dismiss is in flight, or null. */
  dismissing: string | null;
};

export const INITIAL_DESK_STATE: DeskState = {
  issued: 0,
  shown: 0,
  view: null,
  previous: null,
  touched: new Set(),
  error: null,
  dismissing: null,
};

/** A read starts. `seq` is the caller's monotonic ticket and is what makes the
 *  two outcomes below decidable. Nothing else changes: a read in flight must
 *  not blank the rail, clear the highlight or retract a standing error. */
export function beginDeskRead(state: DeskState, seq: number): DeskState {
  return seq > state.issued ? { ...state, issued: seq } : state;
}

/**
 * A read answered.
 *
 * STALE READS ARE DROPPED, AND THAT IS ABOUT THE BASELINE, NOT THE PIXELS. Two
 * overlapping reads can answer out of order; if the older one landed last it
 * would show a desk that has already moved on AND become `previous`, so the
 * next diff would compare the new desk against a desk that never was — the
 * highlight lands on cards nobody touched. `shown` only ever moves forward.
 */
export function applyDeskRead(state: DeskState, seq: number, view: DeskView): DeskState {
  if (seq <= state.shown) return state;
  return {
    ...state,
    shown: seq,
    view,
    previous: view.desk,
    touched: deskTouched(state.previous, view.desk),
    // A read that arrived is the answer to every complaint about reading.
    error: null,
  };
}

/**
 * A read failed. WHAT IS ON SCREEN STAYS ON SCREEN — a rail that blanked itself
 * on a dropped request would look like the desk had been cleared, which on a
 * surface where nothing is ever deleted is the most alarming thing it could
 * show. Only the NEWEST issued read may complain: a straggler's failure must
 * not raise an error over a fresher read that is still in flight or already
 * shown.
 */
export function failDeskRead(state: DeskState, seq: number, message: string): DeskState {
  if (seq !== state.issued || seq <= state.shown) return state;
  return { ...state, error: message };
}

/** A dismiss starts. It also clears the standing error: the human just acted,
 *  and a complaint about the previous action must not be read as the verdict on
 *  this one. */
export function beginDismiss(state: DeskState, id: string): DeskState {
  return { ...state, dismissing: id, error: null };
}

/** A dismiss failed. The card is still on the desk (nothing was written), and
 *  the rail says why. */
export function failDismiss(state: DeskState, message: string): DeskState {
  return { ...state, error: message };
}

/** The dismiss settled, either way. The refresh that follows a SUCCESSFUL one
 *  is what removes the card — this only releases the control. */
export function endDismiss(state: DeskState): DeskState {
  return { ...state, dismissing: null };
}
