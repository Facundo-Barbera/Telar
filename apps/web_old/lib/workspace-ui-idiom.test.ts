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
// Not a component — the generic item route, scanned by the story 5.8 arm at the
// bottom of this file because the one thing keeping `verdict` out of an HTTP
// write is a list in it.
const ITEM_ROUTE = "app/api/workspace/items/[id]/route.ts";
const QUEUE = "components/workspace/queue-view.tsx";
const PACKET = "components/workspace/packet-view.tsx";
// Story 5.7's two: the master surface and its Desk rail, hand-ported from
// lib/demo-gallery/workspace/home.tsx exactly as the three above were ported
// from queue.tsx/packet.tsx — same prototype, same palette hazard, same scan.
const MASTER = "components/workspace/master-chat.tsx";
const DESK = "components/workspace/desk-rail.tsx";
const PAGES = [
  // The ROOT is the master chat (story 5.7 moved the queue down a segment, per
  // ui-contract.md's "the queue does not pretend to be its own destination").
  "app/(legacy)/workspace/page.tsx",
  "app/(legacy)/workspace/queue/page.tsx",
  "app/(legacy)/workspace/[id]/page.tsx",
];
const ALL = [CHIPS, QUEUE, PACKET, MASTER, DESK, ...PAGES];

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
  for (const file of [CHIPS, QUEUE, PACKET, MASTER, DESK]) {
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
    // "Hue lives on the icon only; chips stay neutral outlines" (ui-contract.md
    // §5). VerdictChip's `bg-primary/10` is the single sanctioned fill and is
    // semantic-neutral, not a status colour.
    //
    // THE SCAN WAS WIDENED IN STORY 5.5, and only back to what the law actually
    // says. It used to ban every `bg-|border-|text-` state token in the whole
    // file, which was exact while no chip ICON CARRIED A STATE HUE — the file
    // already had five icon elements before this story (`WrenchIcon`,
    // `CheckIcon`, `CircleDotIcon`, `MessageSquareIcon`, `ListTodoIcon`,
    // measured against the pre-story chips.tsx), and every one of them was
    // neutral or muted, so the blanket ban cost nothing. Then TrackingChip
    // arrived (`<WorkflowIcon className="size-2.5 text-info" />`), which is the
    // law's own permitted case, and a blanket ban would have forced a colourless
    // icon or, worse, a deleted test. So the two halves are now scanned
    // separately: a FILL or an OUTLINE in a state hue is banned outright,
    // anywhere; a state TEXT colour is legal on a lucide icon element and
    // nowhere else. A chip container that reaches for `text-warning` still
    // fails, which is the case the original was written to catch.
    const STATE = "(?:info|verify|success|warning|destructive)";
    // Self-closing lucide elements — `<XIcon className="… text-info" />`. The
    // hue's ONLY legal home in this file.
    const ICON_ELEMENT = /<[A-Z][A-Za-z0-9]*Icon\b[^>]*\/>/g;
    const src = stripComments(read(CHIPS));

    expect(src).not.toMatch(new RegExp(`\\b(?:bg|border)-${STATE}\\b`));
    const bodies = src.replace(ICON_ELEMENT, "");
    expect(bodies).not.toMatch(new RegExp(`\\btext-${STATE}\\b`));

    // ANTI-VACUITY. Without this, deleting every icon from the file would make
    // the second assertion pass for the wrong reason, and a typo'd element
    // pattern would silently strip nothing (or everything).
    expect(src.match(ICON_ELEMENT)?.length ?? 0).toBeGreaterThan(0);
    expect(bodies.length).toBeLessThan(src.length);
    // DISCRIMINATORS: the pair really does separate the icon from the body.
    const chipBody = '<span className="rounded-full border border-border text-success">x</span>';
    expect(chipBody.replace(ICON_ELEMENT, "")).toMatch(new RegExp(`\\btext-${STATE}\\b`));
    const hueOnIcon = '<CheckIcon className="size-3 text-success" />';
    expect(hueOnIcon.replace(ICON_ELEMENT, "")).not.toMatch(new RegExp(`\\btext-${STATE}\\b`));
    expect('<span className="bg-warning/10" />').toMatch(new RegExp(`\\b(?:bg|border)-${STATE}\\b`));
  });

  test("no surface re-spells a chip inline — every one imports the one module", () => {
    // Cross-surface invariant 1: "deadline, verdict, project and provenance
    // render identically on every surface". That is satisfied structurally,
    // by there being one definition site, and it stops being satisfied the
    // moment a surface inlines its own span instead.
    //
    // DESK IS IN THIS LIST NOW, and it is the file the list was widened for:
    // the rail shipped a hand-spelled `rounded-md bg-muted … font-mono` project
    // tag — ProjectChip minus `floating`, minus the mirrored dot-icon — beside
    // a deadline the projection had flattened into prose, so a self-deadline
    // lost its dashed outline and its `· self · slid ×N`. Both halves are
    // fixed: core's deskSlice emits FIELDS, and the rail renders them with
    // these components.
    for (const file of [QUEUE, PACKET, DESK]) {
      expect(read(file)).toContain('from "@/components/workspace/chips"');
    }
    expect(read(QUEUE)).toContain("<VerdictChip");
    expect(read(PACKET)).toContain("<VerdictChip");
    expect(read(DESK)).toContain("<ProjectChip");
    expect(read(DESK)).toContain("<DeadlineChip");
    // The inline span it used to be, in the spelling it had.
    expect(read(DESK)).not.toMatch(/className="rounded-md bg-muted px-1\.5 py-0\.5 font-mono/);
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

  test("the master surface wears the app's header and the shell's own transcript", () => {
    // Its chrome budget is deliberately tiny: PageHeader for the top bar, and
    // then the shared `Conversation` shell for everything below it. A second
    // hand-rolled chat window is exactly what SPEC.md forbids here.
    const src = read(MASTER);
    expect(src).toContain('from "@/components/common/page-header"');
    expect(src).toContain('from "@/components/conversation"');
    expect(src).toContain("<PageHeader");
  });

  test("the desk rail waits, fails and recovers in the shared vocabulary", () => {
    const src = read(DESK);
    expect(src).toContain('from "@/components/ui/skeleton"');
    expect(src).toContain("<Skeleton");
    expect(src).not.toMatch(/animate-pulse/);
    // THE FAILURE HALF WAS MISSING, and its absence had a visible cost: a rail
    // whose FIRST read failed skipped the skeleton, had no cards and no empty
    // copy, and rendered one 10px destructive line at the bottom of a scroll
    // container — a failed load that reads as a cleared desk, on the surface
    // where nothing is ever deleted. Same two states its siblings have:
    // EmptyState + retry with nothing on screen, the shared destructive Alert
    // over data that is still good.
    expect(src).toContain('from "@/components/common/empty-state"');
    expect(src).toContain('from "@/components/ui/alert"');
    expect(src).toContain("<EmptyState");
    expect(src).toContain('<Alert variant="destructive"');
  });

  test("both workspace tabs are real links now, and chat is the ROOT", () => {
    // Chat rendered inert through story 5.5 because it had no page. It has one
    // (app/workspace/page.tsx), so the segmented control must no longer carry a
    // disabled half — a tab that looks like a tab and does nothing is the exact
    // affordance the inert version was apologising for.
    //
    // AND THE HREFS ARE THE SHELL SENTENCE, not a preference: ui-contract.md
    // makes the workspace "one top-level destination with two tabs — Chat
    // (front door) and Queue (the drawer behind it)", so chat holds
    // `/workspace` and the queue is nested beneath it. Nesting chat under the
    // queue would state the relationship backwards in the URL bar and in the
    // sidebar's one workspace entry.
    const src = read(CHIPS);
    expect(src).toContain('href="/workspace"');
    expect(src).toContain('href="/workspace/queue"');
    expect(src).not.toContain('href="/workspace/chat"');
    expect(src).not.toContain('aria-disabled="true"');
    expect(src).not.toContain("cursor-not-allowed");
    expect(src).toMatch(/aria-current=\{active === "chat" \? "page" : undefined\}/);
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
    // …and it goes to the QUEUE, which is where a packet was opened from and
    // is no longer the root (story 5.7 moved it to /workspace/queue). A back
    // link that lands on the chat is not a back link.
    expect(src).toContain('render={<Link href="/workspace/queue"');
    // And no re-spelling of the shared field's focus geometry.
    expect(src).not.toContain("focus:ring-ring/30");
  });

  test("icon buttons use the size variant that means size-7, not an override", () => {
    expect(read(QUEUE)).not.toMatch(/size="icon"\s+className="size-7"/);
    expect(read(QUEUE)).toContain('size="icon-sm"');
  });
});

// ── story 5.8 / CAP-9 — the verdict's one human door ────────────────────────
//
// A SOURCE SCAN, for this file's own stated reason: there is no DOM harness
// here, and what is guarded is which ENDPOINT a click reaches — a fact about
// the file, not about a rendered pixel. The endpoint's own behaviour is proved
// in lib/workspace-verdict-route.test.ts, and the durability it writes
// (`verdictOverride`, and a later expert pass refusing to re-flip it) on real
// disk in packages/core/test/workspace-expert.test.ts. What is missing without
// this arm is the middle link: that the button a human presses goes to the verb
// that makes their choice durable, rather than to the generic patch route,
// which would write a verdict the next pass may overwrite.
describe("a human's verdict is durable from the surface down", () => {
  test("the packet view posts to the verdict route, and never patches a verdict", () => {
    const src = read(PACKET);
    expect(src).toContain("/verdict");
    expect(src).toMatch(/postJson\(\s*`\/api\/workspace\/items\/\$\{item\.id\}\/verdict`/);
    // Both halves of the choice exist, so "override" is a real alternative and
    // not a one-way agreement button.
    expect(src).toContain('["session", "loom"]');
    // AND NOT THROUGH THE GENERIC PATCH VERB. app/api/workspace/items/[id]'s
    // PATCHABLE_KEYS withholds `verdict` deliberately; a surface that reached
    // for it would be writing the field without the flag.
    expect(src).not.toMatch(/"PATCH",\s*\{\s*verdict/);
  });

  test("the generic patch route WITHHOLDS `verdict`, asserted rather than commented", () => {
    // THE THIRD DOOR TO THE FIELD, and until this arm it was guarded by prose
    // alone. core's PATCHABLE still contains `verdict` and `updateItem(id,
    // {verdict})` succeeds whenever `verdictOverride` is unset, so the only thing
    // stopping an HTTP write is this route's narrower list — whose own header
    // records that it "previously copied store.ts's full 8-key PATCHABLE
    // verbatim". The regression has happened once, and story 5.4 is instructed to
    // widen this very list for `deadline`, which is the moment someone re-copies
    // the eight.
    //
    // WHY IT IS WORSE THAN A BYPASS: a verdict written this way lands with no
    // `verdictOverride`, and VerdictChoice renders that as `· expert` — the UI
    // would attribute the human's own write to the expert, and the next pass would
    // silently re-flip it.
    const keys = /const PATCHABLE_KEYS = new Set\(\[([^\]]*)\]\)/.exec(read(ITEM_ROUTE));
    expect(keys).not.toBeNull();
    // Anti-vacuity: this really is the list the route filters on.
    expect(keys![1]).toContain('"title"');
    expect(keys![1]).not.toContain("verdict");
  });

  test("the verdict click re-reads through the shared refresh event, not through a second load", () => {
    // PacketView's own `telar:refresh` listener calls `load()`, so a component
    // that ALSO took an `onChanged` callback fired two concurrent GETs at a
    // force-dynamic route per click, resolving in arbitrary order — harmless only
    // while the write stays faster than the read. Dispatch-only is the in-file
    // majority idiom (`addSubtask`, `toggleSubtask`).
    const src = read(PACKET);
    expect(src).toContain('dispatchTelarRefresh({ domains: ["workspace"] })');
    expect(src).not.toMatch(/<VerdictChoice[^/>]*onChanged/);
  });

  test("the surface says WHOSE verdict it is — the suffix grammar, not a second chip", () => {
    const src = read(PACKET);
    // `· yours` / `· expert`, in the register DeadlineChip already speaks
    // (`· self`, `· slid ×N`). Without it an advisory reading and a durable
    // human choice render as the same two words.
    expect(src).toContain("verdictOverride");
    expect(src).toContain("yours");
    expect(src).toContain("expert");
    // The chip itself is unchanged and still comes from the one module —
    // ui-contract.md's chip grammar is frozen, so the provenance rides BESIDE
    // it rather than inside it.
    expect(src).toContain("<VerdictChip");
    expect(read(CHIPS)).not.toContain("verdictOverride");
  });

  test("no agent-facing surface writes a verdict at all", () => {
    // NFR-OW-2 as it applies to CAP-9: the expert PROPOSES a verdict through an
    // enrichment pass, and only a human's own click makes one durable. The tool
    // surface's whole consultation input is an item id, so there is no tool
    // anywhere that can spell a verdict — asserted here against the file, and
    // against the pinned inventory in invariants.test.ts.
    const mcp = read("lib/workspace-mcp.ts");
    expect(mcp).toContain("consult_expert");
    expect(mcp).not.toMatch(/verdict:\s*z\./);
    expect(mcp).not.toContain("setItemVerdict");
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
    for (const file of [CHIPS, QUEUE, PACKET, MASTER, DESK]) {
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
    //
    // MASTER IS NOT IN THIS LIST and cannot be: it owns no hoverable control of
    // its own — its composer is the shared PromptInput kit and its transcript
    // is the shell's — so requiring a `hover:` there would force a decorative
    // one into a file whose whole design is that it configures rather than
    // draws. It stays in the ramp/radius/motion scans, where absence is not a
    // precondition.
    for (const file of [CHIPS, QUEUE, PACKET, DESK]) {
      const src = read(file);
      const hovers = src.match(/className=(?:"|\{cn\()[^;]*?hover:/g)?.length ?? 0;
      expect(hovers).toBeGreaterThan(0);
      expect(src).toContain("transition-colors");
    }
    // …and the exemption is CONDITIONAL, not a hole: the claim above is that
    // MASTER draws no hoverable control, so the scan holds it to that. The day
    // it grows one it rejoins the rule rather than keeping a pass it was
    // granted for a shape it no longer has.
    const master = read(MASTER);
    if (/className=(?:"|\{cn\()[^;]*?hover:/.test(master)) {
      expect(master).toContain("transition-colors");
    }
  });
});
