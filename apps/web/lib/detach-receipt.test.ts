// The detach receipt's grammar (story 5.5 / CAP-11).
//
// WHY THIS FILE EXISTS AT ALL, given the module is forty lines of string
// concatenation: CAP-11 states the receipt as a UNIVERSALITY constraint — "one
// mono line, identical to the one a birth session emits" — and a universality
// claim is exactly the kind that decays silently. Nothing about the types stops
// a later surface from composing its own line; what stops it is that the ONE
// line every surface renders is pinned here, character for character, against
// the demo gallery's own text (birth/birth.tsx:142, workspace/packet.tsx:175,
// workspace/queue.tsx:248 — the three phrasings this module replaced).
//
// PURE, SO NO MOCKS. lib/detach-receipt.ts imports nothing, which is itself
// load-bearing (a client component renders it, and @telar/core is server-only)
// — the bare `import` below is the proof: if the module ever reaches for core,
// this file stops running rather than quietly passing.
//
// THE LAST DESCRIBE IS A STATIC SCAN, which is why `node:fs` appears below
// despite the purity note above: "identical on every surface" is a claim about
// the SURFACES, and no amount of testing this module proves a fourth one did
// not go and write its own line. The scan is the only shape that can.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  birthDetachReceipt,
  contextLabel,
  detachReceiptLine,
  premiseLabel,
  trackingNote,
  weaveDetachReceipt,
  type WeaveMembers,
} from "./detach-receipt";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

const members = (m: Partial<WeaveMembers> = {}): WeaveMembers => ({
  items: 1,
  fixed: 1,
  acceptance: 1,
  attachments: 0,
  ...m,
});

describe("the line itself — head, optional middles, tail", () => {
  test("a birth session's line is EXACTLY the demo's, and it is the whole grammar with the middles omitted", () => {
    // birth/birth.tsx:142, verbatim. This is the line CAP-11 calls "the one a
    // birth session emits" — every other surface's must be the same sentence
    // with more in the middle, never a different sentence.
    expect(detachReceiptLine(birthDetachReceipt("loom/exports-series"))).toBe(
      "loom created — loom/exports-series · detached from this session",
    );
    // No note: a session hands over the conversation and has no row to track.
    expect(birthDetachReceipt("loom/x").note).toBeUndefined();
    expect(birthDetachReceipt("loom/x").premise).toBeUndefined();
    expect(birthDetachReceipt("loom/x").context).toBeUndefined();
  });

  test("the workspace's line is the SAME head and the SAME tail shape, with the two middles filled", () => {
    const line = detachReceiptLine(weaveDetachReceipt("loom/exports-series", members({ items: 2, fixed: 2, attachments: 3 })));
    expect(line).toBe(
      "loom created — loom/exports-series · premise = 2 items' briefs + acceptance criteria · context = 3 attachments · detached from the workspace",
    );
    // THE UNIVERSALITY CLAIM, asserted rather than described: the two lines
    // share a head and a tail-shape, and differ only by inserted segments.
    const birth = detachReceiptLine(birthDetachReceipt("loom/exports-series"));
    expect(line.startsWith("loom created — loom/exports-series · ")).toBe(true);
    expect(birth.startsWith("loom created — loom/exports-series · ")).toBe(true);
    expect(line.split(" · ").at(-1)).toBe("detached from the workspace");
    expect(birth.split(" · ").at(-1)).toBe("detached from this session");
  });

  test("the head and the tail are never droppable — the two facts a receipt exists for", () => {
    const bare = detachReceiptLine({ loomId: "loom/x", origin: "somewhere new" });
    expect(bare).toBe("loom created — loom/x · detached from somewhere new");
    expect(bare.split(" · ").length).toBe(2);
    // A surface that supplies only one middle gets three segments, not a
    // placeholder for the other — the middles are genuinely optional and are
    // never rendered empty ("premise =  · ").
    expect(detachReceiptLine({ loomId: "loom/x", premise: "the fixed brief", origin: "the workspace" })).toBe(
      "loom created — loom/x · premise = the fixed brief · detached from the workspace",
    );
    expect(detachReceiptLine({ loomId: "loom/x", context: "no attachments", origin: "the workspace" })).toBe(
      "loom created — loom/x · context = no attachments · detached from the workspace",
    );
  });

  test("the id is rendered raw — a receipt that reads as a link stops being a receipt", () => {
    // The surfaces link the WHOLE row; the line never carries a URL, and this
    // is the pin that keeps `/looms/<id>` (workspace-handoff's `url`) out of it.
    expect(detachReceiptLine(birthDetachReceipt("loom/x"))).not.toContain("/looms/");
    expect(detachReceiptLine(weaveDetachReceipt("loom/x", members()))).not.toContain("/looms/");
  });
});

describe("premiseLabel — what the loom was actually handed", () => {
  test("one packet: the label names which of the two briefs existed", () => {
    // item-model.md keeps `raw` beside `fixed` so a handoff can be honest about
    // which one it had. A bare capture woven straight off the queue must not
    // claim a fixed brief.
    expect(premiseLabel(members({ fixed: 1, acceptance: 1 }))).toBe("the fixed brief + acceptance criteria");
    expect(premiseLabel(members({ fixed: 1, acceptance: 0 }))).toBe("the fixed brief");
    expect(premiseLabel(members({ fixed: 0, acceptance: 0 }))).toBe("the title and the raw capture");
    expect(premiseLabel(members({ fixed: 0, acceptance: 1 }))).toBe(
      "the title and the raw capture + acceptance criteria",
    );
  });

  test("a batch: the count leads, and a partly-ripened selection says so", () => {
    expect(premiseLabel(members({ items: 3, fixed: 3, acceptance: 3 }))).toBe("3 items' briefs + acceptance criteria");
    // TWO OF THREE HAVE A BRIEF — the label widens rather than rounding up.
    expect(premiseLabel(members({ items: 3, fixed: 2, acceptance: 0 }))).toBe("3 items' briefs and raw captures");
    expect(premiseLabel(members({ items: 2, fixed: 0, acceptance: 1 }))).toBe(
      "2 items' briefs and raw captures + acceptance criteria",
    );
  });
});

describe("contextLabel and the tracking note", () => {
  test("attachments are counted, pluralised, and honestly zero", () => {
    expect(contextLabel(members({ attachments: 0 }))).toBe("no attachments");
    expect(contextLabel(members({ attachments: 1 }))).toBe("1 attachment");
    expect(contextLabel(members({ attachments: 7 }))).toBe("7 attachments");
  });

  test("the note carries CAP-11's row clause — and it lives OUTSIDE the shared line", () => {
    // "Member rows STAY in the queue marked as tracking the loom and leave only
    // when it lands AND the human accepts." That sentence is surface-specific
    // (a birth session has no row), so it is a second line and never a segment
    // — otherwise the "identical" line would not be identical.
    for (const n of [1, 4]) {
      expect(trackingNote(n)).toContain("lands and you accept");
      expect(trackingNote(n)).toContain("preparation runs on the loom's own graph");
    }
    expect(trackingNote(1)).toContain("stays in the queue");
    expect(trackingNote(4)).toContain("all 4 rows stay in the queue");
    // The clause is nowhere in the mono line. ("acceptance criteria" IS in it —
    // that is the premise segment naming what the loom was handed, which is why
    // the pin below is the clause and not the bare stem.)
    const line = detachReceiptLine(weaveDetachReceipt("loom/x", members({ items: 4 })));
    expect(line).not.toContain("you accept");
    expect(line).not.toContain("queue");
    expect(weaveDetachReceipt("loom/x", members({ items: 4 })).note).toBe(trackingNote(4));
  });

  test("weaveDetachReceipt fills exactly the two middles and nothing else", () => {
    const r = weaveDetachReceipt("loom/x", members({ items: 2, fixed: 1, acceptance: 0, attachments: 2 }));
    expect(r).toEqual({
      loomId: "loom/x",
      premise: "2 items' briefs and raw captures",
      context: "2 attachments",
      origin: "the workspace",
      note: trackingNote(2),
    });
  });
});

// ── the universality claim, as a MECHANISM rather than a promise ─────────────
//
// CAP-11 words it as a constraint on every surface at once: "the detach receipt
// grammar is universal — one mono line, identical whether it fires from a birth
// session, the queue's batch weave, or a packet's handoff". The tests above pin
// what THIS module composes. These pin that nothing else composes anything: one
// author of the sentence, one renderer of it, and all three surfaces on both.
//
// A DIRECTORY WALK, not a hand-listed set of files, because the failure mode is
// a surface that does not exist yet — story 5.3's master chat is the next one,
// and it must fail here rather than ship a fourth phrasing.

const SCAN_ROOTS = ["app", "components", "lib"];
const COMPOSER = "lib/detach-receipt.ts";
const RENDERER = "components/common/detach-receipt.tsx";
// The three surfaces CAP-11 names, in its own order.
const SURFACES = [
  "components/session/session-view.tsx",
  "components/workspace/queue-view.tsx",
  "components/workspace/packet-view.tsx",
];

// Comments may QUOTE the line — chips.tsx's neighbours earn their keep that way,
// and the two modules here open by citing the demo phrasings they replaced. Line
// comments first, then blocks: the order is load-bearing for the same reason
// workspace-ui-idiom.test.ts gives (a `/**` inside a `//` swallows real code).
const stripComments = (src: string) =>
  src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

function sources(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(rel, WEB_ROOT), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      // demo-gallery is READ-ONLY DESIGN SOURCE (that directory's rule 7) and
      // still holds the three original phrasings on purpose — they are the
      // prototypes this module was ported from, not production drift.
      if (entry.isDirectory()) {
        if (entry.name === "demo-gallery" || entry.name === "node_modules") continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(child.slice(2));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(`./${root}`);
  return out;
}

describe("one composer, one renderer, three surfaces", () => {
  test("no production module outside lib/detach-receipt.ts writes the receipt's own words", () => {
    const files = sources();
    // ANTI-VACUITY: the walk really found the tree it claims to scan.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(COMPOSER);
    expect(files).toContain(RENDERER);
    for (const surface of SURFACES) expect(files).toContain(surface);

    const offenders = files.filter(
      (f) => f !== COMPOSER && /loom created|detached from/.test(stripComments(read(f))),
    );
    expect(offenders).toEqual([]);
    // …and the words really are in the one file that is allowed to hold them,
    // so the filter above is excluding something rather than matching nothing.
    expect(stripComments(read(COMPOSER))).toContain("loom created — ");
    expect(stripComments(read(COMPOSER))).toContain("detached from ");
  });

  test("every surface that detaches renders the shared component — none draws its own", () => {
    // The renderer is the only production module allowed to call the composer
    // into JSX; a surface that spelled `<p>{detachReceiptLine(...)}</p>` would
    // have the same words in a different type scale, which is precisely the
    // drift "identical" forbids.
    for (const surface of SURFACES) {
      const src = read(surface);
      expect(src).toContain('from "@/components/common/detach-receipt"');
      expect(src).toContain("<DetachReceipt");
    }
    expect(read(RENDERER)).toContain("detachReceiptLine(receipt)");
    const drawers = sources().filter(
      (f) => f !== RENDERER && /<DetachReceipt[\s/>]/.test(stripComments(read(f))),
    );
    expect(drawers.sort()).toEqual([...SURFACES].sort());
  });

  test("the composer stays import-free, which is what lets a client component render it", () => {
    // @telar/core is server-only (project-context.md's client-bundle rule) and
    // the queue, the packet view and the session transcript are all "use
    // client". The module having NO imports at all is the strongest form of
    // that guarantee, and it is cheap to keep.
    expect(stripComments(read(COMPOSER))).not.toMatch(/^\s*import\s/m);
    expect(read(RENDERER)).not.toContain("@telar/core");
  });
});
