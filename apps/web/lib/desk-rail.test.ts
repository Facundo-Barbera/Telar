// The Desk's two rules, tested as rules (story 5.7, SPEC CAP-3).
//
// CAP-3's success condition is two sentences, and each one is a property this
// file pins — half in lib/desk-rail.ts's pure functions, half as a scan of the
// rail's own source, because "there is no delete path" is a claim about what
// the file does NOT contain and no behaviour can demonstrate an absence.
//
//   · "Referring to a desk item in conversation updates it in place (card stays
//     put, marked as just-updated)" → deskTouched marks; nothing orders.
//   · "Dismissing removes it from the desk and it is findable in the queue. No
//     path deletes an item." → the dismiss write is a PATCH of one field, and
//     no DELETE is spelled anywhere on the surface.
//
// AND THE STATE MACHINE AROUND BOTH, which the first cut of this file left to
// source-string scans: `deskTouched` being pure is worth nothing if the rail
// feeds it a stale read, so the ordering rules are now driven directly through
// the reducer in lib/desk-rail.ts (a scan asserting the ABSENCE of one spelling
// of blanking — `setView(null)` — proved nothing about blanking, and is gone).
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DeskCard } from "@telar/core";
import {
  applyDeskRead,
  beginDeskRead,
  beginDismiss,
  DESK_DISMISS_PATCH,
  deskCardFingerprint,
  deskTouched,
  endDismiss,
  failDeskRead,
  failDismiss,
  INITIAL_DESK_STATE,
  type DeskState,
  type DeskView,
} from "@/lib/desk-rail";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");
const stripComments = (src: string) =>
  src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const RAIL = "components/workspace/desk-rail.tsx";

const card = (id: string, over: Partial<DeskCard> = {}): DeskCard =>
  ({ id, title: `item ${id}`, ...over }) as DeskCard;

const view = (cards: DeskCard[], totalItems = cards.length): DeskView => ({
  desk: cards,
  totalItems,
});

/** A rail that has shown one read — the state every ordering test starts from. */
const shown = (cards: DeskCard[]): DeskState =>
  applyDeskRead(beginDeskRead(INITIAL_DESK_STATE, 1), 1, view(cards));

describe("a touched card is marked where it already sits", () => {
  test("the first read highlights nothing", () => {
    // A rail that lit up every card on arrival would be ANNOUNCING the desk on
    // a surface whose contract is that it never announces anything.
    const desk = [card("a"), card("b")];
    expect([...deskTouched(null, desk)]).toEqual([]);
    expect([...deskTouched(undefined, desk)]).toEqual([]);
  });

  test("an unchanged read marks nothing", () => {
    const before = [card("a"), card("b", { project: "aurora" })];
    const after = [card("a"), card("b", { project: "aurora" })];
    expect([...deskTouched(before, after)]).toEqual([]);
  });

  test("a retitled card is touched; its neighbours are not", () => {
    const before = [card("a"), card("b"), card("c")];
    const after = [card("a"), card("b", { title: "call María — Friday" }), card("c")];
    expect([...deskTouched(before, after)]).toEqual(["b"]);
  });

  test("every visible field counts, including the question a card stopped being", () => {
    const before = [card("a", { unplaced: true, hint: "from the call" })];
    for (const change of [
      { unplaced: false, hint: "from the call" },
      { unplaced: true, hint: "aurora's invoice export" },
      { unplaced: true, hint: "from the call", project: "aurora" },
    ]) {
      expect([...deskTouched(before, [card("a", change)])]).toEqual(["a"]);
    }
  });

  test("every field a CHIP renders counts too — mirrored ref and deadline included", () => {
    // The projection carries fields, not sentences (deskSlice), so the
    // fingerprint has to read the same fields the chips draw. A self-deadline
    // that just SLID is the edit CAP-7 exists for: the card must light up.
    const base = card("a", { project: "aurora", deadline: { label: "Thu", kind: "self" } });
    for (const change of [
      { mirrored: "#214" },
      { deadline: { label: "Fri", kind: "self" as const } },
      { deadline: { label: "Thu", kind: "external" as const } },
      { deadline: { label: "Thu", kind: "self" as const, slips: 1 } },
    ]) {
      expect([...deskTouched([base], [card("a", { ...base, ...change })])]).toEqual(["a"]);
    }
  });

  test("a newly filed card is touched", () => {
    expect([...deskTouched([card("a")], [card("a"), card("b")])]).toEqual(["b"]);
  });

  test("a dismissed card is an absence, never a highlight", () => {
    // It is gone from the next read entirely — the rail highlights cards that
    // are still here and changed, not the space where one used to be.
    expect([...deskTouched([card("a"), card("b")], [card("a")])]).toEqual([]);
  });

  test("the id is the key, not part of the value", () => {
    // Otherwise every card would compare unequal to every other and the whole
    // desk would light up on any read.
    expect(deskCardFingerprint(card("a"))).not.toContain('"a"');
    expect(deskCardFingerprint(card("a", { title: "x" }))).toBe(
      deskCardFingerprint(card("zzz", { title: "x" })),
    );
  });

  test("the answer is a SET — the rule cannot express a reordering", () => {
    const touched = deskTouched([card("a")], [card("a"), card("b")]);
    expect(touched).toBeInstanceOf(Set);
    // A returned list would be a rendering order, and a rendering order is
    // exactly the thing CAP-3 forbids this rule from producing ("the card
    // stays put"). Structural, and deliberately so.
    expect(Array.isArray(touched)).toBe(false);
  });
});

describe("dismiss drains, and nothing anywhere deletes", () => {
  test("the write is one field, and it is `desk`", () => {
    expect(DESK_DISMISS_PATCH).toEqual({ desk: false });
    expect(Object.keys(DESK_DISMISS_PATCH)).toEqual(["desk"]);
    // Not a status, not an `archived`, not a tombstone: the item keeps its id,
    // lane, rank and packet, and the queue is where it lands.
    expect(JSON.stringify(DESK_DISMISS_PATCH)).toBe('{"desk":false}');
  });

  test("the rail dismisses with a PATCH of that constant and nothing else", () => {
    const src = stripComments(read(RAIL));
    expect(src).toContain("DESK_DISMISS_PATCH");
    expect(src).toContain('method: "PATCH"');
    expect(src).toContain("/api/workspace/items/");
  });

  test("the rail names no DELETE, in any spelling", () => {
    // THE LAW STATED AS AN ABSENCE (SPEC: "No path deletes an item"). There is
    // no DELETE handler on app/api/workspace/items/[id] to call — this keeps
    // the client honest about not inventing a caller for one.
    const src = stripComments(read(RAIL));
    expect(src).not.toMatch(/method:\s*["']DELETE["']/);
    expect(src).not.toMatch(/\bdelete[A-Z]/);
    expect(src).not.toMatch(/\bremoveItem\b|\bdeleteItem\b/);
  });

  test("the ✕ is reachable by keyboard — the reveal is opacity, never `hidden`", () => {
    // A `display:none` element is not focusable and is not in the
    // accessibility tree, so `hidden … focus-visible:flex` (the prototype's
    // spelling) is dead CSS: it can never fire, and dismiss — this surface's
    // ONLY write — would be mouse-only. The app's own reveal idiom everywhere
    // else (session-row.tsx, tab-strip.tsx, prompt-input.tsx) is opacity,
    // precisely because it keeps the control in the tree.
    const src = stripComments(read(RAIL));
    const button = src.slice(src.indexOf("<button"), src.indexOf("</button>"));
    expect(button).toContain("aria-label=");
    expect(button).toContain("opacity-0");
    expect(button).toContain("focus-visible:opacity-100");
    expect(button).toContain("group-hover/desk:opacity-100");
    expect(button).not.toMatch(/\bhidden\b/);
    expect(button).not.toContain("group-hover/desk:flex");
  });

  test("the drain is stated in words where the human can read it", () => {
    // Cross-surface invariant 4: "dismiss drains, never deletes — stated in the
    // UI wherever the action exists". Both places: the rail's footer, and the
    // control's own label for anyone arriving by keyboard or screen reader.
    const src = read(RAIL);
    expect(src).toContain("dismissing a card sends it here — nothing is deleted");
    expect(src).toMatch(/aria-label=.*nothing is deleted/);
    expect(src).toMatch(/title="Dismiss — sends it to the queue, nothing is deleted"/);
  });
});

describe("overlapping reads cannot corrupt what the rail shows, or what it compares against", () => {
  test("a read in flight changes nothing on screen", () => {
    const state = shown([card("a")]);
    const reading = beginDeskRead(state, 2);
    expect(reading.view).toBe(state.view);
    expect(reading.touched).toBe(state.touched);
    expect(reading.issued).toBe(2);
  });

  test("the newest answer wins, and a straggler is dropped whole", () => {
    // Two reads overlap — a settling turn and a dismiss both ask. If the older
    // answer landed last it would show a desk that has already moved on AND
    // become the baseline, so the NEXT diff would light up cards nobody
    // touched. `shown` only moves forward.
    let s = shown([card("a")]);
    s = beginDeskRead(s, 2);
    s = beginDeskRead(s, 3);
    s = applyDeskRead(s, 3, view([card("a"), card("b")])); // the newer one answers first
    expect(s.view!.desk.map((c) => c.id)).toEqual(["a", "b"]);
    expect([...s.touched]).toEqual(["b"]);

    const stale = applyDeskRead(s, 2, view([card("a")]));
    expect(stale).toBe(s); // not the view, not the baseline, not the highlight

    // …and the next read still diffs against read 3, which is what is on screen.
    const next = applyDeskRead(beginDeskRead(s, 4), 4, view([card("a"), card("b")]));
    expect([...next.touched]).toEqual([]);
  });

  test("a straggler's FAILURE cannot raise an error over a fresher read", () => {
    let s = shown([card("a")]);
    s = beginDeskRead(s, 2);
    s = beginDeskRead(s, 3);
    expect(failDeskRead(s, 2, "aborted")).toBe(s);
    expect(failDeskRead(s, 3, "HTTP 500").error).toBe("HTTP 500");
    // And once a newer read has LANDED, the older failure is moot.
    const landed = applyDeskRead(s, 3, view([card("a")]));
    expect(failDeskRead(landed, 3, "HTTP 500")).toBe(landed);
  });

  test("a failed refresh keeps what is on screen, and a read that lands clears the complaint", () => {
    // A rail that blanked itself on a dropped request would look like the desk
    // had been cleared — which, on a surface where nothing is ever deleted, is
    // the single most alarming thing it could show.
    let s = shown([card("a"), card("b")]);
    s = failDeskRead(beginDeskRead(s, 2), 2, "HTTP 503");
    expect(s.view!.desk.map((c) => c.id)).toEqual(["a", "b"]);
    expect(s.error).toBe("HTTP 503");

    s = applyDeskRead(beginDeskRead(s, 3), 3, view([card("a"), card("b")]));
    expect(s.error).toBeNull();
  });

  test("a failed FIRST load leaves no view, so the rail can say so instead of looking empty", () => {
    const s = failDeskRead(beginDeskRead(INITIAL_DESK_STATE, 1), 1, "HTTP 500");
    expect(s.view).toBeNull();
    expect(s.error).toBe("HTTP 500");
  });

  test("the first read highlights nothing, however many reads follow", () => {
    let s = applyDeskRead(beginDeskRead(INITIAL_DESK_STATE, 1), 1, view([card("a"), card("b")]));
    expect([...s.touched]).toEqual([]);
    s = applyDeskRead(beginDeskRead(s, 2), 2, view([card("a"), card("b", { title: "moved" })]));
    expect([...s.touched]).toEqual(["b"]);
  });
});

describe("a dismiss in flight", () => {
  test("it marks its own card and clears the previous complaint", () => {
    const failed = failDismiss(shown([card("a"), card("b")]), "HTTP 500");
    const busy = beginDismiss(failed, "b");
    expect(busy.dismissing).toBe("b");
    // The human just acted; a complaint about the LAST action must not read as
    // the verdict on this one.
    expect(busy.error).toBeNull();
  });

  test("a failure says why and leaves the card where it is", () => {
    const s = failDismiss(beginDismiss(shown([card("a")]), "a"), "lane is read-only");
    expect(s.error).toBe("lane is read-only");
    expect(s.view!.desk.map((c) => c.id)).toEqual(["a"]); // nothing was written
    expect(endDismiss(s).dismissing).toBeNull();
  });
});

describe("the rail reads the workspace's one projection, and never notifies", () => {
  test("it reads getQueueView().desk over the queue route", () => {
    const src = stripComments(read(RAIL));
    expect(src).toContain('fetch("/api/workspace/queue")');
    // getQueueView()'s own `desk` slice, read straight off the response — no
    // second projection on the client, so the rail and the queue cannot
    // disagree about what is on the desk.
    expect(src).toContain("view?.desk");
  });

  test("it renders the store's order and derives none of its own", () => {
    // CAP-3's "the card stays put": the only ordering on this rail is the one
    // the store handed it.
    const src = stripComments(read(RAIL));
    expect(src).toContain("cards.map((card)");
    expect(src).not.toMatch(/\.sort\(|\.reverse\(|localeCompare/);
  });

  test("it refreshes on the shared event and polls nothing", () => {
    const src = stripComments(read(RAIL));
    expect(src).toContain('refreshIncludes(e, "workspace")');
    expect(src).toContain("TELAR_REFRESH_EVENT");
    expect(src).not.toMatch(/setInterval|setTimeout\(/);
    // No badge, no ping, no push — "the surface never notifies".
    expect(src).not.toMatch(/Notification|new Audio|navigator\.vibrate/);
  });

  test("an unplaced card is dashed with an amber question — hue on the icon only", () => {
    // ui-contract.md §2, under the quiet-colour law.
    const src = stripComments(read(RAIL));
    expect(src).toContain("border-dashed");
    expect(src).toMatch(/<HelpCircleIcon[^>]*text-warning[^>]*\/>/);
    // And the card body itself stays a neutral outline. `destructive` is the
    // failure idiom (EmptyState/Alert), which is chrome and not a card.
    const bodies = src.replace(/<[A-Z][A-Za-z0-9]*Icon\b[^>]*\/>/g, "");
    const cardRow = bodies.slice(bodies.indexOf("function DeskCardRow"), bodies.indexOf("function DeskRailBody"));
    expect(cardRow).not.toMatch(/\b(?:bg|border|text)-(?:info|verify|success|warning|destructive)\b/);
  });

  test("a failed first load reads as a failure, not as an empty desk", () => {
    // Its siblings' idiom (queue-view.tsx): EmptyState + a retry when there is
    // nothing on screen, the shared destructive Alert when there is.
    const src = stripComments(read(RAIL));
    expect(src).toContain('from "@/components/common/empty-state"');
    expect(src).toContain('from "@/components/ui/alert"');
    expect(src).toContain("<EmptyState");
    expect(src).toContain('<Alert variant="destructive"');
    // The retry actually re-reads.
    expect(src).toMatch(/onClick=\{\(\) => void load\(\)\}/);
  });
});

describe("the Desk speaks the one chip grammar, it does not re-spell it", () => {
  test("the project tag and the deadline come from components/workspace/chips", () => {
    // Cross-surface invariant 1 — "deadline, verdict, project and provenance
    // render identically on every surface" — is satisfied structurally, by
    // there being ONE definition site that every surface imports, and it stops
    // being satisfied the moment a surface inlines its own span. That is what
    // this rail did: a hand-spelled `rounded-md bg-muted … font-mono` tag,
    // which was ProjectChip minus `floating`, minus the mirrored dot-icon, and
    // beside a deadline flattened to prose with no `· self` and no `· slid ×N`.
    const src = stripComments(read(RAIL));
    expect(src).toContain('from "@/components/workspace/chips"');
    expect(src).toContain("<ProjectChip");
    expect(src).toContain("<DeadlineChip");
    // `floating` is ProjectChip's answer for a project-less item, so the chip
    // is rendered UNCONDITIONALLY — a `card.project && <ProjectChip …>` would
    // silently drop that half of the rule again.
    expect(src).toMatch(/<ProjectChip name=\{card\.project\} mirrored=\{card\.mirrored\} \/>/);
    expect(src).not.toMatch(/card\.project && <ProjectChip/);
    // And no chip is re-spelled inline beside them.
    expect(src).not.toMatch(/<span[^>]*font-mono[^>]*>\s*\{card\.(?:project|mirrored)\}/);
  });
});
