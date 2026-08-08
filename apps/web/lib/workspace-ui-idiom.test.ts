// The Workspace surfaces speak the app's visual idiom, and the state-colour
// vocabulary stays closed across every surface migrated onto it — a static
// scan, in the style and for the reason dock-migration.test.ts and
// spawn-reveal.test.ts give for theirs: there is no DOM harness in this repo,
// and none of what is guarded here is observable from behaviour anyway. A raw
// `sky-500` renders perfectly; it just renders in a palette the app does not
// own.
//
// WHY THESE FILES NEED A GUARD MORE THAN MOST. Every class name under
// components/workspace/ was hand-copied by eye from the design prototypes in
// lib/demo-gallery/workspace/**, which that directory's rule 7 forbids
// importing. Hand-copying is exactly the mechanism by which a foreign palette
// and an off-scale radius enter a codebase, and the prototypes are explicitly
// NOT the palette source — only the geometry. Nothing but a scan stands between
// the next port and the drift.
//
// WHAT IS DELIBERATELY NOT HERE: spacing, layout, and copy. Those are judgement
// calls a test would freeze rather than protect. What is here is the closed
// vocabulary — the colour tokens, the radius scale, the shared chrome, and the
// one-chip-grammar invariant — where "closed" is the whole point.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

const CHIPS = "components/workspace/chips.tsx";
const QUEUE = "components/workspace/queue-view.tsx";
const PACKET = "components/workspace/packet-view.tsx";
const PAGES = ["app/workspace/page.tsx", "app/workspace/[id]/page.tsx"];
const ALL = [CHIPS, QUEUE, PACKET, ...PAGES];

// THE FILES THE STATE-TOKEN MIGRATION ACTUALLY TOUCHED. Scanning only the
// workspace surfaces was a guard aimed at the wrong wall: none of those three
// files ever carried a ramp, so the scan could not fail, while every file that
// DID carry one — the badge, the rail, the tone maps, the dock — sat outside
// it. These are in, and they are in as a set on purpose: they render beside
// each other (rail and badge are three lines apart on six surfaces; TONE_ICON
// and its ULTRA_TONE_CLASS copy are one screen apart), so a ramp reappearing in
// any one of them puts two palettes on one screen, which is the specific bug
// this vocabulary exists to prevent. The rest of the app still has ramps and is
// deliberately NOT listed — see the inventory in globals.css.
const MIGRATED = [
  "components/common/state-badge.tsx",
  "components/common/list-controls.tsx",
  "components/looms/utils.ts",
  "components/looms/status.tsx",
  "components/looms/loom-card.tsx",
  "components/looms/blocked-escalation.tsx",
  "components/conversation/marker.tsx",
  "components/dock/dock.tsx",
  "components/session/session-row.tsx",
  "components/session/session-loom.tsx",
  "components/session/tool-step.tsx",
  "components/session/ultra-anchor.tsx",
  "components/session/working-indicator.tsx",
  "components/session/workspace-environment.tsx",
  "components/session/workspace-git-pane.tsx",
  "components/session/workspace-inspector.tsx",
];

// Every Tailwind default ramp. Hue in this app comes from the five state
// tokens (--info / --verify / --success / --warning / --destructive) or from
// --primary, never from a numbered ramp — and the workspace prototypes' own
// palette is called out as an anti-pattern, so these are precisely the strings
// a re-port would carry across.
const RAMP =
  /\b(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})\b/;

// COMMENTS ARE NOT CODE, and several of these files earn their keep by naming
// the ramps they refuse to use — ultra-anchor.tsx quotes the demo gallery's
// `bg-sky-500/10 text-sky-300` as the anti-pattern it ports geometry away from,
// tool-step.tsx records what its spinner used to be. Stripping comments first
// is what lets those explanations survive a scan that would otherwise punish
// the most useful lines in the file.
//
// LINE COMMENTS FIRST, then block comments, and the order is load-bearing:
// ultra-anchor.tsx's prose says "components/session/**", and a `/**` inside a
// `//` line is enough to make a block-comment strip swallow forty lines of real
// code — including the very map the tone-drift assertion below reads. (`[^:]`
// keeps `https://` out of it.)
const stripComments = (src: string) =>
  src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

// Indigo is the ONE sanctioned non-token hue: the weave marker is deliberately
// outside the state palette so a woven loom in needs-review never shows two
// competing signals (loom-card.tsx, list-controls.tsx both say so). It is
// exempt from the ramp scan and gets its own rule below instead.
const INDIGO = /\bindigo-(?:50|\d{3})\b/g;

describe("the state vocabulary is closed: tokens, never raw Tailwind ramps", () => {
  for (const file of [...ALL, ...MIGRATED]) {
    test(`${file} names no numbered colour ramp`, () => {
      const hit = stripComments(read(file)).replace(INDIGO, "").match(RAMP);
      expect(hit?.[0] ?? null).toBeNull();
    });
  }

  test("the weave marker's indigo exception is never dark-only", () => {
    // `text-indigo-300` on its own is a light-mode bug, not a palette choice:
    // a 300 step over an indigo-500/10 fill is near-invisible on white. The
    // exception is allowed to be indigo; it is not allowed to be legible in
    // one theme. Both copies of WeaveChip pair a light value with `dark:`.
    for (const file of ["components/common/list-controls.tsx", "components/looms/loom-card.tsx"]) {
      const src = stripComments(read(file));
      expect(src).toContain("dark:text-indigo-300");
      expect(src).not.toMatch(/(?<!dark:)text-indigo-300/);
    }
  });

  test("the state rail speaks the badge's vocabulary, not a second one", () => {
    // stateRailClass and StateBadge render in the SAME element, three lines
    // apart, on six surfaces. The rail's whole contract is that it is a thin
    // local variant of the badge's map — so every hue it can emit has to be a
    // token, and `blocked` has to fold into --warning exactly as the badge
    // folds it. A rail that kept an amber/orange split preserved a distinction
    // the badge had already deleted.
    const rail = stripComments(read("components/looms/utils.ts"));
    for (const token of ["bg-info", "bg-verify", "bg-success", "bg-warning", "bg-destructive"]) {
      expect(rail).toContain(token);
    }
    expect(rail).toMatch(/case "needs-review":\s*case "blocked":\s*return "bg-warning";/);
  });

  test("the two copies of the tone map agree", () => {
    // ultra-anchor.tsx's ULTRA_TONE_CLASS declares itself a duplicate of
    // looms/status.tsx's TONE_ICON (it cannot import it — components/session
    // has zero imports from components/looms, on purpose). A declared
    // duplicate that has drifted is worse than either copy, and they DID
    // drift: one migrated to tokens, the other kept `text-emerald-600
    // dark:text-emerald-400`. Both shared tones, asserted on both sides.
    const tone = stripComments(read("components/looms/status.tsx"));
    const ultra = stripComments(read("components/session/ultra-anchor.tsx"));
    for (const src of [tone, ultra]) {
      expect(src).toMatch(/done:\s*"text-success"/);
      expect(src).toMatch(/attention:\s*"text-warning"/);
      expect(src).toMatch(/danger:\s*"text-destructive"/);
    }
  });

  test("the native checkboxes route their tick through --primary", () => {
    // A bare <input type="checkbox"> paints its checked box in the USER
    // AGENT's accent colour — Safari blue — which is the one raw colour a
    // surface cannot spell out in a class list and therefore the one the ramp
    // scan above can never catch. `accent-primary` is the fix; this asserts no
    // checkbox is ever added without it.
    //
    // Counted per DECLARATION, not per occurrence of the string: both files
    // also *discuss* `accent-primary` in prose, so a bare tally of the token
    // would pass on a file whose comments outnumber its checkboxes.
    for (const file of [QUEUE, PACKET]) {
      const src = read(file);
      const boxes = [...src.matchAll(/type="checkbox"/g)];
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        // The className lives inside the same JSX element — the next `/>`.
        const element = src.slice(box.index!, src.indexOf("/>", box.index!));
        expect(element).toContain("accent-primary");
      }
    }
  });
});

describe("workspace surfaces stay on the radius scale", () => {
  // containers lg/xl/2xl/3xl · rows/chips md · pills full · sm for the 14px
  // checkbox, where md would round a box nearly to a circle. Bare `rounded`
  // (0.25rem) is off the scale entirely and is what the demo source used.
  // Comment-stripped, for the same reason the ramp scan is: chips.tsx's header
  // has to be able to quote the demo's `rounded border-border/60` as the thing
  // it deliberately does NOT copy.
  for (const file of [CHIPS, QUEUE, PACKET]) {
    test(`${file} has no bare \`rounded\``, () => {
      expect(stripComments(read(file))).not.toMatch(/\brounded(?=["'\s])/);
    });
  }
});

describe("the chip grammar is frozen, and lives in exactly one module", () => {
  test("chips.tsx keeps every rendering rule ui-contract.md §'Chip grammar' names", () => {
    const src = read(CHIPS);
    // Deadline: external solid, self dashed, `· self`, `· slid ×N`.
    expect(src).toContain('deadline.kind === "self"');
    expect(src).toContain("border-dashed border-border");
    expect(src).toContain("· self");
    expect(src).toContain("· slid ×");
    // Verdict: an arrow and a tinted fill.
    expect(src).toContain("→ {verdict}");
    expect(src).toContain("bg-primary/10");
    // Project: mono name, mirrored ref, `floating` when absent.
    expect(src).toContain("floating");
    expect(src).toContain("{mirrored}");
    // Provenance: a quiet mono outline, no icon set.
    expect(src).toMatch(/ProvenanceTag[\s\S]{0,400}font-mono/);
  });

  test("the quiet-colour law holds: no chip BODY carries a state hue", () => {
    // Hue lives on an icon only. VerdictChip's `bg-primary/10` is the single
    // sanctioned exception and is semantic-neutral, not a status colour — so
    // the four state tokens must not appear as a chip fill or outline here at
    // all. (This is the law the restyle had to work inside: rounding and type
    // scale were fair game, chip colour was not.)
    const src = read(CHIPS);
    expect(src).not.toMatch(/\b(?:bg|border|text)-(?:info|verify|success|warning|destructive)\b/);
  });

  test("no surface re-spells a chip inline — both import the one module", () => {
    // Cross-surface invariant 1: "deadline, verdict, project and provenance
    // render identically on every surface". That is satisfied structurally,
    // by there being one definition site, and it stops being satisfied the
    // moment a surface inlines its own span instead.
    for (const file of [QUEUE, PACKET]) {
      expect(read(file)).toContain('from "@/components/workspace/chips"');
    }
    expect(read(QUEUE)).toContain("<VerdictChip");
    expect(read(PACKET)).toContain("<VerdictChip");
  });

  test("production never imports the demo prototypes", () => {
    // demo-gallery rule 7: design source, read-only, never wired in. The chips
    // are a hand-port precisely because this import is forbidden.
    //
    // The IMPORT is what is banned, not the NAME: chips.tsx opens by citing
    // lib/demo-gallery/workspace/shared.tsx as the thing it was ported from,
    // and that citation is the most useful line in the file. So this matches
    // the module-specifier position only.
    for (const file of ALL) {
      expect(read(file)).not.toMatch(/(?:from|import\()\s*["'][^"']*demo-gallery/);
    }
  });
});

describe("workspace surfaces compose the shared chrome instead of re-rolling it", () => {
  test("both surfaces wear PageHeader, EmptyState and the shared state primitives", () => {
    for (const file of [QUEUE, PACKET]) {
      const src = read(file);
      expect(src).toContain('from "@/components/common/page-header"');
      expect(src).toContain('from "@/components/common/empty-state"');
      expect(src).toContain('from "@/components/ui/skeleton"');
      // A refresh that fails with data already on screen raises the shared
      // destructive Alert. The packet view used to set that state and render
      // nothing from it — the stale packet simply stopped updating.
      expect(src).toContain('from "@/components/ui/alert"');
      expect(src).toContain('<Alert variant="destructive"');
    }
  });

  test("the queue's toolbar is the shared list-controls set, with lane counts", () => {
    const src = read(QUEUE);
    expect(src).toContain('from "@/components/common/list-controls"');
    expect(src).toContain("<SearchField");
    expect(src).toContain("<GroupHeader");
    // ui-contract.md §3 asks for "lane filter chips with counts" — through the
    // shared Chip's own `count` slot, not baked into the label string.
    expect(src).toContain("count={l.rows.length}");
  });

  test("the packet view uses the shared Button and Input, not hand-rolled ones", () => {
    const src = read(PACKET);
    expect(src).toContain('from "@/components/ui/input"');
    expect(src).toContain("<Input");
    // The back affordance is a Button rendering a Link — one focus ring for
    // the whole app, rather than an anchor re-spelling ghost's hover.
    expect(src).toContain('render={<Link href="/workspace"');
    // And no re-spelling of the shared field's focus geometry.
    expect(src).not.toContain("focus:ring-ring/30");
  });

  test("icon buttons use the size variant that means size-7, not an override", () => {
    expect(read(QUEUE)).not.toMatch(/size="icon"\s+className="size-7"/);
    expect(read(QUEUE)).toContain('size="icon-sm"');
  });
});

describe("motion stays CSS-only", () => {
  test("no framer/motion import, and no globally-disabled animate-in", () => {
    // globals.css records both: motion/react is replaced by CSS the app owns
    // — a @keyframes where the effect is a loop (the telar-shimmer precedent),
    // a plain transition where it is a one-shot fade/slide
    // (workspace-inspector.tsx, which argues the distinction at length and is
    // deliberately NOT a keyframe) — always behind `motion-safe:`. Separately,
    // tw-animate-css's animate-in/out is disabled app-wide over a WebKit
    // crash, which is itself why a fade-up from zero opacity must not be a
    // keyframe.
    for (const file of [CHIPS, QUEUE, PACKET]) {
      const src = read(file);
      expect(src).not.toContain('from "motion/react"');
      expect(src).not.toContain('from "framer-motion"');
      expect(src).not.toMatch(/\banimate-(?:in|out)\b/);
    }
  });

  test("the hoverable controls declare a transition", () => {
    // The app's hover convention is `hover:bg-muted/60`-or-`/40` PLUS
    // `transition-colors` (ultra-rail.tsx, subagent-rail.tsx). A hover with no
    // transition is the tell of a hand-port.
    for (const file of [CHIPS, QUEUE, PACKET]) {
      const src = read(file);
      const hovers = src.match(/className=(?:"|\{cn\()[^;]*?hover:/g)?.length ?? 0;
      expect(hovers).toBeGreaterThan(0);
      expect(src).toContain("transition-colors");
    }
  });
});
