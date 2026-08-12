// The workspace PROTOTYPES speak the app's current idiom — a static scan, the
// mirror image of lib/workspace-ui-idiom.test.ts and written in its style for
// its reasons (no DOM harness in this repo, and none of this is observable from
// behaviour anyway: a `text-emerald-600` renders perfectly, it just renders in
// a palette the app does not own).
//
// WHY A GUARD ON A DIRECTORY THAT SHIPS NOTHING. These four files are the
// design source-of-truth for the Workspace module (ui-contract.md's opening
// line says so), and the production surfaces were hand-ported FROM them by eye,
// which that test's own header calls "exactly the mechanism by which a foreign
// palette and an off-scale radius enter a codebase". The existing scan guards
// the destination. Nothing guarded the source — so the prototypes were free to
// keep drawing the pre-token app forever, and each new port would carry a
// little of it across. The two scans together close the loop: the app may not
// drift from the design, and the design may not drift from the app.
//
// WHAT IS DELIBERATELY NOT HERE: content and copy. The prototypes' words ARE
// the contract's words and belong to ui-contract.md, not to a regex; freezing
// them here would make every legitimate spec change look like a test failure.
// What is here is the closed vocabulary, the import DIRECTION, and the handful
// of places where the prototypes are now obliged to render production code
// rather than a second drawing of it.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const HERE = new URL("./", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, HERE), "utf8");

const HOME = "home.tsx";
const QUEUE = "queue.tsx";
const PACKET = "packet.tsx";
const SESSION = "session.tsx";
const SHARED = "shared.tsx";
const FIXTURES = "fixtures.ts";
// The four surfaces ui-contract.md freezes, plus their shared vocabulary.
const SURFACES = [HOME, QUEUE, PACKET, SESSION];
const ALL = [...SURFACES, SHARED];

// Same expression as lib/workspace-ui-idiom.test.ts's, and the sameness is the
// point: one definition of "a colour this app does not own", applied to the
// design source and the shipped surface alike.
const RAMP =
  /\b(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})\b/;

// COMMENTS ARE NOT CODE. Several of these files earn their keep by naming the
// exact ramp or off-scale radius they refuse to use any more — shared.tsx's
// header quotes `border-border/60`, packet.tsx's quotes `text-[9px]` — and
// stripping comments first is what lets those explanations survive a scan that
// would otherwise punish the most useful lines in the file. Line comments
// first, then blocks: a `/**` inside a `//` is enough to make a block strip
// swallow forty lines of real code (`[^:]` keeps `https://` out of it).
const stripComments = (src: string) =>
  src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the prototypes are on the app's colour vocabulary", () => {
  for (const file of ALL) {
    test(`${file} names no numbered colour ramp`, () => {
      const hit = stripComments(read(file)).match(RAMP);
      expect(hit?.[0] ?? null).toBeNull();
    });
  }

  test("the state hues that ARE here live on an icon, never on a chip or card body", () => {
    // The quiet-colour law (ui-contract.md §5 preamble): "hue lives on the icon
    // only, chips stay neutral outlines". The prototypes' two amber moments —
    // the Desk's unplaced card and the capture receipt's unplaceable line — are
    // exactly the law's permitted case: `text-warning` on a lucide element,
    // with the container left a neutral outline. A FILL or an OUTLINE in a
    // state hue is banned outright.
    const STATE = "(?:info|verify|success|warning|destructive)";
    // Self-closing lucide elements — the hue's ONLY legal home. The bare
    // `<Icon />` alternative is the codebase's own alias idiom for a lucide
    // component passed as a prop (`icon: Icon`, exactly as GroupHeader and
    // EmptyState destructure theirs), so a card that takes its glyph from its
    // caller is still scanned as an icon and not as a body.
    // (No `s` flag, and none needed: `[^>]` already spans newlines, and this
    // app's tsc target predates it.)
    const ICON_ELEMENT = /<(?:[A-Z][A-Za-z0-9]*Icon|Icon)\b[^>]*?\/>/g;
    for (const file of ALL) {
      const src = stripComments(read(file));
      expect(src).not.toMatch(new RegExp(`\\b(?:bg|border)-${STATE}\\b`));
      expect(src.replace(ICON_ELEMENT, "")).not.toMatch(new RegExp(`\\btext-${STATE}\\b`));
    }
    // ANTI-VACUITY: the law is only interesting if a hue is actually present.
    // If the amber ever disappears from the Desk, this fails and someone reads
    // the paragraph above rather than a silently green scan.
    const home = stripComments(read(HOME));
    expect(home).toContain("text-warning");
    expect(home.replace(ICON_ELEMENT, "").length).toBeLessThan(home.length);
    // DISCRIMINATORS: the strip really does separate the icon from the body,
    // for both element spellings.
    const body = '<span className="rounded-full border border-border text-success">x</span>';
    expect(body.replace(ICON_ELEMENT, "")).toMatch(new RegExp(`\\btext-${STATE}\\b`));
    for (const el of [
      '<CheckIcon className="size-3 text-success" />',
      '<Icon className={cn("size-3", warn ? "text-warning" : "")} />',
    ]) {
      expect(el.replace(ICON_ELEMENT, "")).not.toMatch(new RegExp(`\\btext-${STATE}\\b`));
    }
  });
});

describe("the prototypes are on the app's radius and type scale", () => {
  for (const file of ALL) {
    // containers lg/xl/2xl/3xl · rows/chips md · pills full · sm for the 14px
    // checkbox. Bare `rounded` (0.25rem) is off the scale entirely and is
    // precisely what the demo source used to hand the production port.
    test(`${file} has no bare \`rounded\` and no off-scale radius literal`, () => {
      const src = stripComments(read(file));
      expect(src).not.toMatch(/\brounded(?=["'\s])/);
      expect(src).not.toMatch(/\brounded-\[\d/);
    });

    // 10px is the app's smallest step (SectionLabel, the mono tallies, the
    // proposal badges). 9px was the prototypes' own invention and was the
    // least legible thing on two surfaces — including, in packet.tsx, the
    // `proposal` badge that cross-surface invariant 6 exists to make visible.
    test(`${file} does not invent a type step below the app's 10px`, () => {
      expect(stripComments(read(file))).not.toMatch(/text-\[\s*[0-9]px\s*\]/);
    });
  }
});

describe("the chip grammar has ONE definition site, and it is production's", () => {
  test("shared.tsx re-exports components/workspace/chips rather than re-spelling it", () => {
    const src = read(SHARED);
    expect(src).toMatch(/export\s*\{[\s\S]*?\}\s*from\s*"@\/components\/workspace\/chips"/);
    for (const chip of ["DeadlineChip", "ProjectChip", "ProvenanceTag", "ToolPill", "VerdictChip"]) {
      expect(src).toContain(chip);
    }
    // …and does not define them a second time underneath the re-export.
    for (const chip of ["DeadlineChip", "ProjectChip", "VerdictChip"]) {
      expect(stripComments(src)).not.toContain(`function ${chip}`);
    }
  });

  test("every surface that shows a chip gets it from ./shared", () => {
    // Cross-surface invariant 1 — "deadline, verdict, project and provenance
    // render identically on every surface" — satisfied structurally rather than
    // by four authors agreeing, which is the same argument the production scan
    // makes about queue-view and packet-view.
    for (const file of [QUEUE, PACKET, SESSION]) {
      expect(read(file)).toContain('from "./shared"');
      expect(read(file)).toContain("<VerdictChip");
    }
  });

  test("the import arrow points demo → production, never the reverse", () => {
    // demo-gallery rule 7 forbids PRODUCTION importing a prototype (asserted
    // from the other side in lib/workspace-ui-idiom.test.ts). The opposite
    // arrow is not merely allowed, it is how a prototype stays honest — so this
    // asserts the prototypes really do reach into the app, and that none of
    // them has quietly grown a copy of a component instead.
    const reaches = ALL.filter((f) => /from "@\/components\//.test(read(f)));
    expect(reaches.length).toBe(ALL.length);
  });
});

describe("the detach receipt is composed, never spelled", () => {
  // Cross-surface invariant 2: "one line, one grammar — identical from birth
  // session, batch weave, or packet handoff". lib/detach-receipt.ts exists
  // because three prototypes each writing the sentence is a promise, not a
  // mechanism; two of those three were these files.
  for (const file of [QUEUE, PACKET]) {
    test(`${file} renders the shared receipt off the shared composer`, () => {
      const src = read(file);
      expect(src).toContain('from "@/components/common/detach-receipt"');
      expect(src).toContain("weaveDetachReceipt(");
      expect(src).toContain("<DetachReceipt");
    });

    test(`${file} holds no hand-written copy of the receipt sentence`, () => {
      const src = stripComments(read(file));
      expect(src).not.toContain("loom created");
      expect(src).not.toContain("detached from the workspace");
    });
  }
});

describe("the surfaces mirror their production twins", () => {
  test("the queue wears the shared list controls and the app's chrome", () => {
    const src = read(QUEUE);
    expect(src).toContain('from "@/components/common/list-controls"');
    expect(src).toContain("<SearchField");
    expect(src).toContain("<GroupHeader");
    expect(src).toContain('from "@/components/common/page-header"');
    // ui-contract.md §3 asks for "lane filter chips with counts" — through the
    // shared Chip's own `count` slot, exactly as queue-view.tsx does it.
    expect(src).toContain("count={l.items.length}");
  });

  test("every checkbox routes its tick through --primary", () => {
    // A bare <input type="checkbox"> paints its checked box in the USER
    // AGENT's accent (Safari blue) — the one raw colour a class list cannot
    // spell, and therefore the one the ramp scan above can never catch. The
    // prototypes used to dodge it by drawing a span with a CheckIcon in it,
    // which is how the production port ended up re-deciding the question.
    const src = read(QUEUE);
    const boxes = [...src.matchAll(/type="checkbox"/g)];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      const element = src.slice(box.index!, src.indexOf("/>", box.index!));
      expect(element).toContain("accent-primary");
    }
  });

  test("no surface hand-rolls a button or a bubble the app already owns", () => {
    // `<button className="… bg-primary …">` and `rounded-2xl bg-muted` were the
    // two shapes this pass deleted: the app's Button owns the focus ring, and
    // components/ai-elements/message.tsx owns the bubble.
    for (const file of SURFACES) {
      const src = stripComments(read(file));
      expect(src).not.toMatch(/<button[^>]*bg-primary/);
      expect(src).not.toContain("rounded-2xl");
    }
    expect(read(PACKET)).toContain('from "@/components/ui/button"');
    expect(read(SESSION)).toContain("<MessageContent");
  });
});

describe("the master chat is drawn by the real Conversation shell", () => {
  // ui-contract.md §1, in as many words: "the master chat IS a session — user
  // turns wear the production message bubble idiom, built on the shared
  // `Conversation` shell".
  test("home.tsx configures the shell's four slots through @/components/conversation", () => {
    const src = read(HOME);
    expect(src).toContain('from "@/components/conversation"');
    expect(src).toContain("<Conversation");
    for (const slot of ["items=", "kinds=", "composer=", "rail=", "header="]) {
      expect(src).toContain(slot);
    }
  });

  test("its rich surfaces are REGISTERED kinds, and every id is `workspace:`", () => {
    // AD-13 admits no unnamespaced ids, and `workspace` is already a member of
    // registry.ts's closed MODULE_NAMESPACES — so naming the four surfaces here
    // is the design output a later owner adapter implements, not decoration.
    const src = read(HOME);
    expect(src).toContain("createItemKindRegistry([");
    expect(src).toContain("...BUILTIN_KINDS");
    const ids = [...stripComments(src).matchAll(/^\s*id: "([^"]+)",$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith("workspace:")).toBe(true);
    // The four ui-contract.md §1 names, by name.
    for (const id of [
      "workspace:briefing",
      "workspace:gap",
      "workspace:witness",
      "workspace:receipt",
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe("the two store-vs-mockup divergences survive the re-skin", () => {
  // packages/core/src/workspace/schema.ts and store.ts both CITE this fixture
  // file as the shape they deliberately disagree with. A re-skin that
  // "tidied" either one would delete the only authority those comments have —
  // and in the subtasks case, the only shape the 0 → 1 migration rung exists
  // to read.
  test("WsLane.items stays EMBEDDED items, not an array of ids", () => {
    const src = read(FIXTURES);
    expect(src).toMatch(/items:\s*WsItem\[\];/);
    expect(stripComments(src)).not.toMatch(/items:\s*string\[\]/);
  });

  test("WsItem.subtasks stays id-less — that is migration version 0", () => {
    expect(read(FIXTURES)).toMatch(/subtasks\?:\s*\{\s*title: string;\s*done\?: boolean\s*\}\[\]/);
  });

  test("both divergences are still explained in the file that carries them", () => {
    // Comments, read UNSTRIPPED on purpose: the note is the artefact here.
    const src = read(FIXTURES);
    expect(src).toContain("TWO DIVERGENCES FROM THE STORE");
    expect(src).toContain("divergence 1");
    expect(src).toContain("divergence 2");
  });
});

describe("the module's laws hold on the prototypes too", () => {
  test("no clock anywhere (NFR-OW-11 / invariant 5)", () => {
    // Timestamps are LABELS. A prototype that reached for a wall clock would
    // make the mockups the one place in the module where something ticks.
    for (const file of [...ALL, FIXTURES]) {
      const src = stripComments(read(file));
      expect(src).not.toContain("Date.now(");
      expect(src).not.toContain("new Date(");
      expect(src).not.toContain("setInterval(");
    }
  });

  test("agent honesty is on screen (invariant 6)", () => {
    expect(read(HOME)).toContain("0 started");
    expect(read(QUEUE)).toContain("agents added 0");
    // "proposals are visibly dashed" — the badge and the card, both.
    expect(read(PACKET)).toContain("border-dashed");
    expect(read(PACKET)).toContain("proposal");
  });

  test("dismiss drains, never deletes (invariant 4) — and says so", () => {
    const src = read(HOME);
    expect(src).toContain("dismissing a card sends it here — nothing is deleted");
  });

  test("motion stays CSS-only", () => {
    for (const file of ALL) {
      const src = read(file);
      expect(src).not.toContain('from "motion/react"');
      expect(src).not.toContain('from "framer-motion"');
      expect(src).not.toMatch(/\banimate-(?:in|out)\b/);
    }
  });
});

// ── the sent-to-loom mark ───────────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS. The re-skin re-exported five of chips.tsx's six chips
// and dropped TrackingChip in silence, so ui-contract.md §3's last bullet —
// "after a weave the member rows stay in the queue, MARKED as tracking the
// loom" — survived only as a SENTENCE (detach-receipt.ts's trackingNote, in
// the receipt's quiet second line) and not as the mark itself. A prototype
// that states the rule in prose and does not draw it is exactly the drift the
// re-export was meant to end, and the scans above could not see it: nothing
// there fails when a component is simply absent.

// The production chip module the prototypes draw from. Read across the tree on
// purpose — the assertion below is that two files say the same thing, which no
// scan of one of them can make.
const CHIPS = readFileSync(
  new URL("../../../components/workspace/chips.tsx", HERE),
  "utf8",
);

// The body of `export function NAME(` up to its closing brace. Crude and
// sufficient: every component in both files is written flush-left, so a `}` in
// column 0 that ENDS a line closes the function — `}: {` and `}) {` (a
// multi-line prop destructure, which SectionLabel has) both continue theirs.
const block = (src: string, name: string) => {
  const start = src.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("the queue draws the sent-to-loom mark, not just its sentence", () => {
  test("shared.tsx carries a TrackingChip at all", () => {
    // ANTI-VACUITY for everything below: if the mark leaves the shared
    // vocabulary again, this is the test that says so in one line.
    expect(read(SHARED)).toContain("export function TrackingChip(");
  });

  test("the row renders it, in the production twin's own slot", () => {
    const src = read(QUEUE);
    expect(src).toContain("TrackingChip,");
    expect(src).toContain('from "./shared"');
    const body = stripComments(src);
    expect(body).toContain("<TrackingChip");
    // Slot, left to right: the packet tallies, then the mark, then provenance.
    // queue-view.tsx's ItemRow puts it in exactly that gap, and the chips are
    // only "identical wherever an item appears" if their ORDER is too.
    const mark = body.indexOf("<TrackingChip");
    expect(body.indexOf("<PaperclipIcon")).toBeLessThan(mark);
    expect(mark).toBeLessThan(body.indexOf("<ProvenanceTag"));
  });

  test("its class list and title are chips.tsx's, character for character", () => {
    // The one legitimate way to hold a second copy of a production component
    // is to be able to PROVE it is the same copy. Same argument as
    // WorkspaceTabs above it in shared.tsx: the two may disagree about exactly
    // one thing, and a test names which.
    const demo = block(read(SHARED), "TrackingChip");
    const prod = block(CHIPS, "TrackingChip");
    const classOf = (src: string) => src.match(/className="([^"]+)"\s*$/m)?.[1] ?? null;
    expect(classOf(demo)).toBe(classOf(prod));
    expect(classOf(demo)).not.toBeNull();
    // Both title branches, and the label the chip renders.
    for (const line of [
      "`Sent to loom ${loomId} — “${label}” · this row stays here until the loom lands and you accept it`",
      "`Sent to loom ${loomId} — this row stays here until the loom lands and you accept it`",
      "at loom",
    ]) {
      expect(prod).toContain(line);
      expect(demo).toContain(line);
    }
    // The grammar itself: neutral outline body, hue on the ICON alone, and
    // `--info` not `--success` — a green tick would read as the acceptance only
    // a human can give (AD-8).
    expect(demo).toContain('<WorkflowIcon className="size-2.5 text-info" />');
  });

  test("the ONE divergence is the element: a gallery stage never navigates", () => {
    const demo = block(read(SHARED), "TrackingChip");
    expect(block(CHIPS, "TrackingChip")).toContain("<Link");
    expect(demo).toContain("<span");
    expect(demo).not.toContain("<Link");
    expect(demo).not.toContain("href");
    // …and the whole file stays off next/link, like every other prototype.
    for (const file of ALL) expect(read(file)).not.toContain('from "next/link"');
  });

  test("the mark is snapshotted at weave time, not derived from the selection", () => {
    // CAP-11's actual claim: the rows STAY, marked. `Clear` empties the
    // selection and takes the batch bar with it — if the mark were
    // `woven ? selection : ∅` it would vanish with the bar, and the prototype
    // would be drawing the one thing the contract says does not happen. It is
    // also the honest shape: trackLoom writes Item.tracking per row.
    const src = stripComments(read(QUEUE));
    expect(src).toContain("setTracked(new Set(selection))");
    // Nothing filters the woven rows out of the list they are rendered from.
    expect(src).not.toMatch(/filter\([^)]*tracked/);
  });
});

describe("the section label has one definition site", () => {
  test("no surface re-spells SectionLabel's class list by hand", () => {
    // It is `mb-2` short of the shared one, in a file that already imports it
    // — a copy that matches today and can only diverge later, which is the
    // exact failure mode the re-export exists to prevent. The fix was a
    // `className` prop, not a second h2.
    const REGISTER = /text-\[10px\] font-medium uppercase tracking-wider text-muted-foreground\/70/;
    for (const file of SURFACES) {
      expect(stripComments(read(file))).not.toMatch(REGISTER);
    }
    // Present exactly once, in the module that owns it.
    const shared = stripComments(read(SHARED)).match(new RegExp(REGISTER, "g")) ?? [];
    expect(shared.length).toBe(1);
  });

  test("the override goes through cn(), so the register is inherited not restated", () => {
    const label = block(read(SHARED), "SectionLabel");
    expect(label).toContain("className?: string");
    expect(label).toContain("cn(");
    expect(read(HOME)).toContain("<SectionLabel className=");
  });
});
