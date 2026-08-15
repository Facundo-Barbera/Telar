// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Spool's UI contract, asserted as source text.
 *
 * WHY SOURCE TEXT AND NOT A RENDER. There is no DOM test harness in this app,
 * and the claims here are structural rather than visual: "there is ONE chip
 * module", "the tracking mark is not a link", "the footer's numbers are
 * interpolated rather than typed". Each of those is decidable by reading the
 * file, and each is a rule a future edit could break silently — a second
 * `DeadlineChip` defined inside the packet view would look fine on screen and
 * would quietly end the cross-surface invariant it violates.
 *
 * Ported in spirit from `apps/web_old/lib/workspace-ui-idiom.test.ts`.
 */
const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
/**
 * Source with its line breaks collapsed.
 *
 * NEEDED BECAUSE THE THING BEING ASSERTED IS A SENTENCE THE USER READS, and JSX
 * wraps it wherever the formatter decides. Matching the raw text would pin the
 * line width of a paragraph rather than its words, and would go red the next
 * time anything near it changed length.
 */
const flat = (name: string) => read(name).replace(/\s+/g, " ");
/**
 * Source with its comments stripped.
 *
 * THE COMMENTS THAT EXPLAIN AN ABSENCE HAVE TO NAME IT. Every removal below is
 * documented where it happened — that is the whole point of writing it down —
 * so a scan that read prose would fire on the explanation and teach the next
 * person to delete it. Only code is checked.
 */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const surfaces = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => ({ name: f, source: read(f) }));

describe("the chip grammar is defined once and imported everywhere", () => {
  test("every chip has exactly one definition site, and it is chips.tsx", () => {
    // Cross-surface invariant 1: deadline, verdict, project and provenance
    // render identically on every surface. That is satisfied by there being ONE
    // definition, not by four surfaces being careful.
    const chips = ["DeadlineChip", "ProjectChip", "ProvenanceTag"];
    for (const chip of chips) {
      const definitions = surfaces().filter((f) => f.source.includes(`export function ${chip}`));
      expect(definitions.map((d) => d.name)).toEqual(["chips.tsx"]);
    }
  });

  test("a surface that renders a chip imports it rather than spelling one", () => {
    for (const { name, source } of surfaces()) {
      if (name === "chips.tsx") continue;
      if (!/<(DeadlineChip|ProjectChip|ProvenanceTag)\b/.test(source)) continue;
      expect(source, `${name} renders a chip without importing the shared module`).toContain(
        '@/components/spool/chips',
      );
    }
  });
});

describe("the chip grammar itself", () => {
  const chips = read("chips.tsx");

  test("a self-deadline is dashed, suffixed `· self`, and states its slip count", () => {
    expect(chips).toContain("border-dashed");
    expect(chips).toContain("· self");
    expect(chips).toContain("· slid ×");
    // An external one is solid — the discriminator, without which "dashed" is
    // simply how every deadline renders.
    expect(chips).toContain("border-border bg-muted/40");
  });

  test("an absent project renders the word `floating`, not an empty space", () => {
    // Floating is a valid resting state, not a missing value. Rendering nothing
    // would make "no project yet" and "this chip failed to load" identical.
    expect(chips).toContain("floating");
  });

  test("NOTHING LOOM-SHAPED SURVIVES ANYWHERE ON THESE SURFACES", () => {
    // Looms are a planned feature that does not work. Every affordance naming
    // one is gone rather than disabled — a control that never responds is a
    // worse lie than an absence — and this is what stops one drifting back in
    // one surface at a time.
    //
    // WHEN LOOMS LAND, THIS TEST IS THE FIRST THING TO CHANGE. It is deliberately
    // the loudest failure in the suite for exactly that reason.
    // WORD BOUNDARIES, AND NOT A BARE SUBSTRING. The first spelling of this
    // fired on `tracking-wider` — a Tailwind utility on a section label — which
    // is the kind of false positive that gets a test deleted rather than fixed.
    const forbidden = /\b(looms?|weaves?|weaving|verdicts?|verdictOverride|trackLoom|SpoolLoomRef)\b/i;
    for (const { name, source } of surfaces()) {
      const match = forbidden.exec(code(source));
      expect(match?.[0], `${name} still references "${match?.[0]}" in code`).toBeUndefined();
    }
  });

  test("the quiet-colour law holds, and nothing is tinted now the verdict is gone", () => {
    // Hue on the icon only; chip containers stay neutral outlines. The single
    // sanctioned exception was the verdict's `bg-primary/10`, and it left with
    // the verdict — so today the correct number of tinted containers is zero.
    const tinted = new Set(code(chips).match(/bg-(primary|info|success|warning|destructive)\/\d+/g) ?? []);
    expect([...tinted]).toEqual([]);
  });
});

describe("the queue states its laws with live numbers, not captions", () => {
  const queue = read("queue-view.tsx");

  test("the conservation line interpolates both counts off the same read", () => {
    expect(queue).toContain("{view.totalItems}");
    expect(flat("queue-view.tsx")).toContain("agents added {view.agentsAdded}");
    expect(flat("queue-view.tsx")).toContain("the count never grows from breakdown");
  });

  test("the diagnostic channel is rendered, so tolerance is never silent loss", () => {
    // A lane row the store could not read is SKIPPED and reported. A queue that
    // dropped the report would show a shrunken list with no sign anything was
    // wrong.
    expect(queue).toContain("view.unreadable.length > 0");
    expect(queue).toContain("could not be read");
  });

  test("rank is stack position, and the row offers no clock", () => {
    expect(queue).toContain("Move up");
    expect(queue).toContain("Move down");
    for (const forbidden of ["due in", "overdue", "days left", "setInterval", "Date.now"]) {
      expect(queue, `the queue must not reach for "${forbidden}" — no clock anywhere`).not.toContain(forbidden);
    }
  });

  test("there is no delete affordance anywhere on the surface", () => {
    // "No deletion path." Retiring a LANE is not deleting an item, and it is the
    // only thing the trash glyph is wired to.
    expect(queue).not.toMatch(/Delete item|delete this item|removeItem/i);
    expect(queue).toContain("Retire lane");
  });

  test("every promotion is a human click behind a confirm, and there is no other path", () => {
    // THE INVARIANT IS HUMAN-ONLY, NOT ONCE-ONLY. Both the queue and the packet
    // offer it, exactly as the donor does — what must hold is that every site is
    // a person's own click. The first spelling of this asserted a single call
    // site and went red the moment the packet view landed, which would have
    // pushed a real surface to drop a real affordance to satisfy a test.
    const callers = surfaces().filter((f) => f.source.includes("/promote"));
    expect(callers.map((f) => f.name).sort()).toEqual(["packet-view.tsx", "queue-view.tsx"]);
    for (const { name, source } of callers) {
      expect(source, `${name} promotes without asking`).toMatch(/confirm\([\s\S]{0,120}?[Pp]romote/);
    }
  });

  test("a lane split is gated behind the human, and records its provenance permanently", () => {
    expect(queue).toContain("/api/spool/lanes/split");
    // A lane created by an accepted proposal says so, permanently.
    expect(queue).toContain("you accepted it");
  });
});

describe("the shell says what is built and what is not", () => {
  test("both surfaces wear ONE top bar, and neither builds its own", () => {
    /**
     * TWO HALVES OF ONE DESTINATION MUST NOT INTRODUCE THEMSELVES DIFFERENTLY.
     * They did: the queue wore the full page chrome — sidebar trigger, title, a
     * live count, an action — while the chat rendered a bare tab group with no
     * header at all, so its tabs floated at the top of the viewport with no
     * hairline under them and no way to reach the sidebar.
     *
     * ASSERTED AS "NEITHER SPELLS ITS OWN", not "both look alike", because
     * sameness by inspection is what drifted in the first place. There is one
     * component; the surfaces pass it a description and their own actions.
     */
    for (const surface of ["queue-view.tsx", "master-chat.tsx"]) {
      const source = code(read(surface));
      expect(source, `${surface} does not use the shared header`).toContain("<SpoolHeader");
      expect(source, `${surface} builds page chrome of its own`).not.toContain("<PageHeader");
      expect(source, `${surface} mounts the tab group directly`).not.toContain("<SpoolTabs");
    }
    // And the shared bar is the only place the tabs are mounted at all.
    const mounts = surfaces().filter((f) => code(f.source).includes("<SpoolTabs"));
    expect(mounts.map((f) => f.name)).toEqual(["header.tsx"]);
  });

  test("the header describes the surface, and never counts anything at the user", () => {
    // A description states what is already on this screen. A number telling you
    // there is something ELSEWHERE to attend to is the badge the module refuses.
    const header = code(read("header.tsx"));
    expect(header).not.toMatch(/Badge|unread|notification/i);
    // The chat has nothing to count, so it says what it is.
    expect(flat("master-chat.tsx")).toContain("No project — so it can answer across all of them.");
  });

  test("both tabs are live, and the chat is the ROOT while the queue is beneath it", () => {
    /**
     * THIS TEST USED TO ASSERT THE OPPOSITE, and that was its job: it pinned the
     * Chat tab as an inert span for as long as no master session existed, so
     * that whoever landed the surface would be told to come here. It fired the
     * day the chat shipped.
     *
     * WHAT IT GUARDS NOW IS THE ORDER, which is the module's argument in one
     * route. Arriving at a queue teaches that this is a task list you maintain;
     * arriving at a conversation teaches that it is something you talk to and
     * the list is what it remembers. `/spool` must be the chat.
     */
    const tabs = code(read("tabs.tsx"));
    expect(tabs).not.toContain("aria-disabled");
    expect(tabs).not.toContain("not built yet");
    expect(tabs.match(/<Link/g)?.length).toBe(2);
    expect(tabs).toContain('href="/spool"');
    expect(tabs).toContain('href="/spool/queue"');
    // And the page at the root really is the chat, not merely linked as one.
    const root = fs.readFileSync(path.join(dir, "..", "..", "app", "spool", "page.tsx"), "utf8");
    expect(root).toContain("MasterChat");
  });

  test("there is ONE front door — no route creates a second master", () => {
    // CAP-1's whole mechanism: the master is ENSURED, never created. A "new
    // master chat" affordance would turn the front door into a list of them.
    const chat = code(read("master-chat.tsx"));
    expect(chat).toContain("/api/spool/master");
    expect(chat).not.toMatch(/createSession|new master|New chat/i);
  });

  test("the desk drains and never deletes, and says so where the action is", () => {
    // The module has no delete path anywhere. A rail whose only verb reads
    // "dismiss" tells the same lie the store refuses to.
    const rail = code(read("desk-rail.tsx"));
    expect(rail).toContain("desk: false");
    expect(rail).not.toMatch(/method:\s*"DELETE"/);
    expect(flat("desk-rail.tsx")).toContain("it stays in the queue");
  });

  test("the desk shows its cards, never a count of them", () => {
    // A number visible before you look is a badge with extra steps.
    const rail = code(read("desk-rail.tsx"));
    expect(rail).not.toMatch(/\.length\}/);
    expect(rail).not.toMatch(/Badge|unread/i);
  });

  test("nothing in the Spool notifies, badges or counts at the user", () => {
    // The module's first law: it answers when arrived at. The sidebar entry
    // carries no count for the same reason.
    const sidebar = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    const spoolButton = sidebar.slice(sidebar.indexOf("function SpoolButton"));
    const untilNext = spoolButton.slice(0, spoolButton.indexOf("function SettingsButton"));
    expect(untilNext).not.toMatch(/Badge|count|unread/i);
  });
});

describe("the expert is offered honestly", () => {
  test("its refusal renders ON the page and stays, rather than in a modal", () => {
    // Every refusal the expert produces names the next move ("file it into a
    // project first"). `alert()` is where a sentence goes to die — the user
    // dismisses it and the instruction is gone — so this action deliberately
    // does not route through the packet's generic `mutate` helper.
    const packet = code(read("packet-view.tsx"));
    const consult = packet.slice(packet.indexOf("const consult ="), packet.indexOf("const addSubtask ="));
    expect(consult).toContain("setConsultNote");
    expect(consult).not.toContain("alert(");
  });

  test("the one action that spends money is a quiet outline, never the page's primary", () => {
    // The filled primary on this page is the handoff — the thing the packet
    // exists for. A button that bills the user must not outrank it.
    const packet = flat("packet-view.tsx");
    const button = packet.slice(packet.indexOf("Ask the expert") - 400, packet.indexOf("Ask the expert"));
    expect(button).toContain('variant="outline"');
  });

  test("it says what the expert will and will not touch, before it is clicked", () => {
    const packet = flat("packet-view.tsx");
    expect(packet).toContain("It changes nothing else.");
    // And when the item is floating, the caption is the instruction rather than
    // a disabled button with no explanation.
    expect(packet).toContain("An expert belongs to a project. File this item into one first.");
  });

  test("a first pass is disclosed, so the surface never implies memory it lacked", () => {
    const packet = flat("packet-view.tsx");
    expect(packet).toContain("the expert had no memory of this project");
  });

  test("the consultation has its own busy state — it is minutes, not milliseconds", () => {
    // Sharing `busy` with the sub-task writes would either freeze the whole
    // packet for the length of a model turn or let a second click bill twice.
    const packet = code(read("packet-view.tsx"));
    expect(packet).toContain("const [consulting, setConsulting]");
    expect(packet).toMatch(/disabled=\{consulting \|\| busy\}/);
  });
});

describe("the queue groups by subject, and the lane is a lens over it", () => {
  test("subject is the ARRIVAL axis, and the toggle is not remembered", () => {
    /**
     * THE MODULE'S CENTRAL CLAIM AS OF THE REDEFINITION. A lane answers "when
     * would I do this"; a subject answers "what is this about", and real work
     * divides the second way — ozom-gv's four months are cut by milestone,
     * category and dependency, so every one of its issues would land in one
     * lane and the lane axis would carry no information.
     *
     * NOT PERSISTED, deliberately: the default is the module's opinion, and a
     * remembered toggle would let one session's experiment quietly become the
     * arrival state forever.
     */
    const queue = code(read("queue-view.tsx"));
    expect(queue).toContain('useState<QueueAxis>("subject")');
    expect(queue).not.toMatch(/localStorage|sessionStorage/);
  });

  test("lanes are demoted, never deleted — every human lane verb survives", () => {
    // The whole reason a second axis was added rather than the store rewritten:
    // the split, rename, retire and hand-ordering are the structure the user
    // made, and they live on the lane.
    const queue = code(read("queue-view.tsx"));
    // The four verbs as the surface actually spells them — a rename goes through
    // a local `rename` callback, not a `renameLane` symbol, and asserting the
    // name this file does not use would have been a test passing on a typo.
    expect(queue).toContain("const rename = useCallback");
    expect(queue).toContain("const retire = useCallback");
    expect(queue).toContain("const split = useCallback");
    expect(queue).toContain("/reorder");
    expect(queue).toContain("<LaneSection");
  });

  test("a subject group offers no reorder, because it does not own the stack", () => {
    // Order within a subject is INHERITED from the lane stacks the projection
    // walks. An arrow here would have to guess which lane's stack it meant.
    const queue = code(read("queue-view.tsx"));
    const section = queue.slice(queue.indexOf("function SubjectSection"), queue.indexOf("export function QueueView"));
    expect(section).toContain("canMoveUp={false}");
    expect(section).toContain("canMoveDown={false}");
  });

  test("an item belonging to no subject is named `floating`, never left blank", () => {
    // Floating is a valid resting state. An unlabelled group reads as a
    // rendering fault, which is the one thing it is not.
    const queue = code(read("queue-view.tsx"));
    const section = queue.slice(queue.indexOf("function SubjectSection"), queue.indexOf("export function QueueView"));
    expect(section).toContain('group.project ?? "floating"');
  });
});
