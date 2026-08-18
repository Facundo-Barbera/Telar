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

describe("the store's laws are stated with live numbers, not captions", () => {
  /**
   * TWO SURFACES HAVE RETIRED UNDER THESE LAWS — the queue page, then the
   * queue fold — and the laws moved each time rather than dying: the stance's
   * footer now carries the conservation pair and the diagnostic channel,
   * because it is the one surface everything arrives at.
   */
  const stance = read("stance.tsx");

  test("the conservation line interpolates both counts off the same read", () => {
    expect(stance).toContain("{totals.totalItems}");
    expect(flat("stance.tsx")).toContain("agents added {totals.agentsAdded}");
    expect(flat("stance.tsx")).toContain("the count never grows from breakdown");
  });

  test("the diagnostic channel is rendered, so tolerance is never silent loss", () => {
    // A lane row the store could not read is SKIPPED and reported. A room that
    // dropped the report would show a shrunken stance with no sign anything
    // was wrong.
    expect(stance).toContain("totals.unreadable.length > 0");
    expect(stance).toContain("could not be read");
  });

  test("there is no delete affordance anywhere in the room", () => {
    // "No deletion path." Nothing here deletes an item, and no verb pretends to.
    for (const name of ["stance.tsx", "tray.tsx"]) {
      expect(read(name)).not.toMatch(/Delete item|delete this item|removeItem/i);
    }
  });

  test("every promotion is a human click behind a dialog, and there is no other path", () => {
    /**
     * THE INVARIANT IS HUMAN-ONLY, NOT ONCE-ONLY. The tray's packet face is
     * the one place that offers it now the packet page is a deep link — what
     * must hold is that every site is a person's own click.
     *
     * IT USED TO ASSERT `confirm(`, and that spelling went red the day the
     * browser dialogs were replaced. The gate did not weaken; it got stronger,
     * because a `ConfirmDialog` has room to say what promoting DOES and
     * `confirm()` never did. So the assertion follows the mechanism rather than
     * the function name.
     */
    const callers = surfaces().filter((f) => f.source.includes("/promote"));
    expect(callers.map((f) => f.name).sort()).toEqual(["tray.tsx"]);
    for (const { name, source } of callers) {
      expect(source, `${name} promotes without asking`).toContain("<ConfirmDialog");
      // …and the dialog states the consequence rather than just asking.
      expect(flat(name), `${name} asks without saying what promoting does`).toContain("becomes an item of its own");
    }
  });

  test("the Spool speaks the design system, not the browser", () => {
    /**
     * THE GAP THIS CLOSED, MEASURED: sixteen `prompt`/`confirm`/`alert` calls on
     * these two surfaces against two in `components/session` and zero everywhere
     * else, while thirteen other surfaces already used the app's own dialogs.
     *
     * WHY IT MATTERED BEYOND LOOKS. A native dialog cannot be themed, blocks the
     * main thread while a transcript is streaming behind it, has no room to
     * explain, loses what you typed on the way to a second question — and
     * `alert()` is where a refusal's sentence goes to die.
     */
    for (const { name, source } of surfaces()) {
      const body = code(source);
      expect(body, `${name} still opens a browser prompt`).not.toMatch(/[^.\w]prompt\(/);
      expect(body, `${name} still opens a browser confirm`).not.toMatch(/[^.\w]confirm\(/);
      expect(body, `${name} still opens a browser alert`).not.toMatch(/[^.\w<]alert\(/);
    }
  });

  test("no surface reaches a retired route", () => {
    /**
     * §13.3 RETIRED THREE DESTINATIONS — the composed canvas, the shapes
     * scratch page, and the queue page. A link to a deleted route is live and
     * silently broken, which is the exact defect this suite names elsewhere as
     * "live, and silently inert" — so the absence is asserted, and so is the
     * absence of the routes themselves.
     */
    for (const { name, source } of surfaces()) {
      // A lookahead, not a bare substring: `@/components/spool/queue-surface`
      // is the inventory fold's own import and must keep passing.
      const match = /\/spool\/(queue|v2|shapes)(?![\w-])/.exec(code(source));
      expect(match?.[0], `${name} still links to the retired ${match?.[0]}`).toBeUndefined();
    }
    for (const gone of ["queue", "v2", "shapes"]) {
      expect(fs.existsSync(path.join(dir, "..", "..", "app", "spool", gone))).toBe(false);
    }
  });
});

describe("the shell says what is built and what is not", () => {
  test("the screen wears ONE top bar, and neither half builds its own", () => {
    /**
     * TWO HALVES OF ONE DESTINATION MUST NOT INTRODUCE THEMSELVES DIFFERENTLY.
     * The stance screen owns the shared header; the conversation and the
     * inventory are halves and folds, so neither spells page chrome of its
     * own — asserted as "neither spells its own", not "both look alike",
     * because sameness by inspection is what drifted in the first place.
     */
    expect(code(read("stance.tsx"))).toContain("<SpoolHeader");
    for (const surface of ["tray.tsx", "master-chat.tsx"]) {
      const source = code(read(surface));
      expect(source, `${surface} builds page chrome of its own`).not.toContain("<PageHeader");
      expect(source, `${surface} wears a second top bar`).not.toContain("<SpoolHeader");
    }
    /**
     * AND THE TAB GROUP IS GONE ENTIRELY. Chat|Queue existed because the queue
     * was a second page; both halves now stand on one screen, so a tab strip
     * would name a destination and a tool as siblings.
     */
    expect(surfaces().filter((f) => code(f.source).includes("SpoolTabs"))).toEqual([]);
  });

  test("navigation does not move when you navigate", () => {
    /**
     * ASSERTED AS "THE SLOT DOES NOT EXIST", not "nobody passes one". A slot one
     * caller must never use and another may is a rule with nothing enforcing it.
     */
    const header = code(read("header.tsx"));
    expect(header).not.toMatch(/actions\?:/);
    expect(header).not.toContain("actions={");
  });

  test("the header describes the surface, and never counts anything at the user", () => {
    // A description states what is already on this screen. A number telling you
    // there is something ELSEWHERE to attend to is the badge the module refuses.
    const header = code(read("header.tsx"));
    expect(header).not.toMatch(/Badge|unread|notification/i);
    // The screen says what it holds; the chat half says what it is.
    // RETARGETED 2026-08-18 for §13: the old register ("what needs you,
    // what is in its hands, and what has settled") named the STANCE's four
    // bands — but the front door is the Lobby now, not the stance, and the
    // Lobby's own job is re-entry across subjects: where you left off, what
    // the world did meanwhile, and what still needs you. The subtitle moved
    // with the front door.
    expect(flat("stance.tsx")).toContain("Where you left off, what moved, and what needs you.");
    expect(flat("master-chat.tsx")).toContain("No project — so it can answer across all of them.");
  });

  /**
   * THE SPOOL IS ONE VIEW: queue left, conversation middle, panel right.
   *
   * THIS TEST USED TO PIN THE CHAT|QUEUE TABS, and before that it pinned the
   * Chat tab as an inert span for as long as no master session existed. Each
   * time it fired the day the thing it was waiting for shipped, which is its
   * job. What it guards now is the shape that replaced them.
   */
  test("a stance line summons the tray, and never navigates", () => {
    /**
     * THE CHANGE THAT MAKES IT ONE ROOM. Opening a packet used to cost a full
     * page; it is now a face in the middle column, so the stance and the
     * conversation never move. No route to a packet exists inside the room —
     * the only packet URL left is the deep link, and it lands back here.
     */
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("<SpoolTray");
    expect(stance).not.toMatch(/href=\{?`\/spool\//);
    const deepLink = fs.readFileSync(path.join(dir, "..", "..", "app", "spool", "[id]", "page.tsx"), "utf8");
    expect(deepLink).toContain("redirect(`/spool?item=");
  });

  test("the permit grant survived every retired surface, and is reachable", () => {
    // §7.6 is standing state the human authored, and the room's whole answer
    // to per-night consent leans on it — a grant nobody can reach is not a
    // grant. It is a tray face, summoned from a subject's shield.
    expect(code(read("tray.tsx"))).toContain("<PermitsChip");
    expect(code(read("stance.tsx"))).toContain("onPermits");
  });

  test("the root really is the room — stance, tray, conversation", () => {
    const root = fs.readFileSync(path.join(dir, "..", "..", "app", "spool", "page.tsx"), "utf8");
    expect(root).toContain("SpoolStance");
    // One screen: the stance renders the chat and the tray, not links to them.
    expect(code(read("stance.tsx"))).toContain("<MasterChat");
    // The shared sidebar is untouched — the Spool does not reach outside itself.
    const app = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    expect(app).not.toMatch(/QueueSurface|SpoolQueueSidebar|SpoolTray/);
  });

  test("there is ONE front door — no route creates a second master", () => {
    // CAP-1's whole mechanism: the master is ENSURED, never created. A "new
    // master chat" affordance would turn the front door into a list of them.
    const chat = code(read("master-chat.tsx"));
    expect(chat).toContain("/api/spool/master");
    expect(chat).not.toMatch(/createSession|new master|New chat/i);
  });

  test("the desk drains and never deletes, and says so where the action is", () => {
    // The module has no delete path anywhere. The drain verb outlived the desk
    // surface — it lives on the tray's packet face, and still says what it
    // does not do.
    const tray = code(read("tray.tsx"));
    expect(tray).toContain("desk: false");
    expect(tray).not.toMatch(/method:\s*"DELETE"/);
    expect(flat("tray.tsx")).toContain("it stays in the queue");
  });

  test("nothing in the Spool notifies, badges or counts at the user", () => {
    /**
     * RETARGETED 2026-08-18 (loops §11): `SpoolButton` — the footer entry this
     * test used to slice out — retired when the wordmark became the place
     * switcher. Its "no count on it" law travels with the job: the switcher
     * (which now carries the Spool entry) and the warehouse nav (which now
     * carries the Areas tree's per-subject numbers) are what this law must
     * hold against instead, so both are read directly rather than sliced
     * between two function names that may drift again.
     */
    const sidebar = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    const switcherStart = sidebar.indexOf("function PlaceSwitcher");
    expect(switcherStart).toBeGreaterThan(-1);
    const switcherBody = code(sidebar.slice(switcherStart, sidebar.indexOf("function SettingsButton")));
    expect(switcherBody).not.toMatch(/Badge|unread|notification/i);
    // The Areas tree's numbers describe the subject they sit on ("what needs
    // you"), never a push about something elsewhere — quiet text, no pill.
    const nav = code(read("warehouse-nav.tsx"));
    expect(nav).not.toMatch(/Badge|unread|notification/i);
  });

  test("the wordmark is the place switcher, and the retired Spool button is gone", () => {
    /**
     * loops §11: "Telar and Spool are different, but part of the same
     * system — overlap one on top of the other." The wordmark that always
     * named the app becomes the control that names which half you are in.
     * CHROME, NOT ROUTING: the switcher only reads the pathname to decide
     * which entry is current; picking one navigates.
     */
    const sidebar = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    expect(sidebar).toContain("function PlaceSwitcher");
    expect(sidebar).toContain('router.push("/")');
    expect(sidebar).toContain('router.push("/spool")');
    expect(sidebar).toContain("inSpool");
    // The footer's Spool destination retired — the switcher is its one home.
    expect(sidebar).not.toContain("function SpoolButton");
    expect(code(sidebar)).not.toMatch(/<SpoolButton\b/);
    // The new glyph is drawn in the SAME line-icon family as the Spool
    // mark it sits beside in the menu — no bespoke SVG, and no `--spool`
    // hue on Telar's own entry: colour marks the place, not the neutral one.
    expect(sidebar).toContain("TypeIcon");
    const switcherBody2 = sidebar.slice(sidebar.indexOf("function PlaceSwitcher"), sidebar.indexOf("function SidebarEmpty"));
    // Every `TypeIcon` use in the switcher is bare — Telar's own entry never
    // wears the room's hue, only the Spool entry beside it does.
    for (const use of switcherBody2.match(/<TypeIcon[^/]*\/>/g) ?? []) {
      expect(use).not.toContain("text-spool");
    }
  });

  test("the Spool's place puts the warehouse nav where the sessions list was", () => {
    /**
     * loops §11: LEFT sidebar = the warehouse nav on `/spool` — search,
     * apertures, an Areas → subjects tree, lanes, tag filters — replacing
     * Telar's own sessions-and-projects rail rather than sitting beside it
     * as a fourth column. The switcher in the header stays constant; only
     * the body below it is place-conditional.
     */
    const sidebar = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    expect(sidebar).toContain("SpoolWarehouseNav");
    expect(sidebar).toContain("inSpool ? (");
    const nav = code(read("warehouse-nav.tsx"));
    expect(nav).toContain("SpoolSearchControl");
    // §13.2: the aperture buttons retired with the wide stance. The rail's
    // three fixed rooms are Lobby, Today and Scheduled — floor plan, not a
    // squint over one inventory.
    expect(nav).toContain('"Lobby"');
    expect(nav).toContain('"Today"');
    expect(nav).toContain('"Scheduled"');
    expect(nav).toContain("Areas");
    expect(nav).toContain("groupLinesByArea");
    // The nav drives the room's OWN state through the published store — never
    // a second `useState` forking the aperture or the filter it already owns.
    expect(nav).toContain("useSpoolRoom");
    expect(nav).toContain("useSpoolRoomControls");
    for (const { name, source } of surfaces()) {
      if (name === "warehouse-nav.tsx") continue;
      expect(code(source), `${name} invents an "Other" group`).not.toMatch(/["'`>]Other["'`<]/);
    }
  });

  test("§13 retired the aperture-as-state toolbar — filters are a room's own transient chips, never a second copy in the app root", () => {
    /**
     * RETARGETED FOR §13. The old toolbar's smart-scope buttons and quick
     * filters DID NOT MOVE to the sidebar — they retired outright. Today and
     * Scheduled became ROOMS (navigation, via `goToday`/`goScheduled`), not
     * an aperture click inside a persistent toolbar; the quick filters
     * became a subject room's own transient state, scoped to its Tasks tab,
     * never a fact the app root or the sidebar holds.
     */
    const stance = code(read("stance.tsx"));
    expect(stance).not.toMatch(/aria-pressed=\{smart === entry\}/);
    expect(stance).not.toContain("setSmart");
    expect(stance).not.toContain("const [filter, setFilter] = useState");
    // The room's own filter state lives in room.tsx, not the app root — one
    // home, and it is the subject room's Tasks tab.
    const room = code(read("room.tsx"));
    expect(room).toContain("const [filter, setFilter] = useState");
    expect(room).toContain("stuck on me");
    expect(room).toMatch(/>\s*unfiled\s*</);
    expect(room).toContain("#{tag}");
    // The clear affordance is visible and singular — one ✕, not a chip per
    // filter that individually toggles off.
    expect(room).toContain("clear ✕");
  });

  test("navigation does not move WITHIN a place — switching places is the one exception, named", () => {
    /**
     * loops §11 bends the law rather than breaking it: "navigation does not
     * move" always meant the room never grew a route for something that was
     * already state in it. Moving between Telar and Spool is a real
     * navigation — two different front doors — so the law needed the
     * qualifier once a second place existed to navigate BETWEEN.
     */
    expect(flat("../app-sidebar.tsx")).toContain("CHROME, NOT ROUTING");
    const header = code(read("header.tsx"));
    expect(header).not.toMatch(/actions\?:/);
    expect(header).not.toContain("actions={");
  });
});

/**
 * THE EXPERT CONTROL MOVED, AND THESE MOVED WITH IT.
 *
 * It lived inline in `packet-view.tsx` behind a local `consulting` boolean.
 * Every claim below still holds and two of them hold in a stronger place —
 * "a second click cannot bill twice" is now enforced by the ENGINE rather than
 * by a component's state, which a reload used to defeat, and "a first pass is
 * disclosed" is now a sentence the daemon writes onto the work record rather
 * than one the page infers.
 *
 * The tests are re-pointed rather than deleted, because what they protect is
 * the contract and not the address.
 */
describe("the expert is offered honestly", () => {
  test("its refusal renders ON the control and stays, rather than in a modal", () => {
    // Every refusal the expert produces names the next move ("file it into a
    // project first"). `alert()` is where a sentence goes to die — the user
    // dismisses it and the instruction is gone.
    const body = code(read("packet-body.tsx"));
    const control = body.slice(body.indexOf("export function ExpertControl"));
    expect(control).toContain("setRefusal");
    expect(control).not.toContain("alert(");
  });

  test("the one action that spends money is a quiet outline, never a page's primary", () => {
    // The filled primary on the packet page is the handoff — the thing the
    // packet exists for. A button that bills the user must not outrank it.
    const body = flat("packet-body.tsx");
    const button = body.slice(body.indexOf("Ask the expert") - 400, body.indexOf("Ask the expert"));
    expect(button).toContain('variant="outline"');
  });

  test("it says what the expert will and will not touch, before it is clicked", () => {
    const body = flat("packet-body.tsx");
    expect(body).toContain("It changes nothing else.");
    // And when the item is floating, the caption is the instruction rather than
    // a disabled button with no explanation.
    expect(body).toContain("An expert belongs to a project. File this item into one first.");
  });

  /**
   * THE DISCLOSURE MOVED TO THE ENGINE, and that is the honest place for it: a
   * pass now settles into a record the surface reads, so the sentence has to be
   * written where the outcome is known rather than re-derived by whichever
   * screen happened to be watching. The claim is unchanged — a surface must
   * never imply memory the expert did not have.
   */
  test("a first pass is disclosed, so no surface implies memory it lacked", () => {
    const state = fs.readFileSync(path.join(dir, "../../../engine/src/state.ts"), "utf8");
    expect(state).toContain("had no memory of this project");
  });

  /**
   * THE GUARANTEE THAT USED TO BE A BOOLEAN. "Two clicks are two passes; the
   * surface's busy state is what prevents the second" was the route's own
   * admission, and it was true only until a reload — so the guard moved into the
   * process that spends the money.
   *
   * ASSERTED IN TWO PLACES because it takes both to hold: the control must not
   * offer to start a pass that is already running, and the engine must refuse
   * one even if something else asks.
   */
  test("a second pass cannot be started, and it is the engine that says so", () => {
    const control = code(read("packet-body.tsx"));
    expect(control).toContain("const running = work.runningFor(item.id)");
    /**
     * THE BUTTON IS NOT RENDERED AT ALL while a pass is live — a disabled
     * button is still a button, and this one used to bill twice. So the live
     * arm of the ternary carries the stop control and the idle arm carries the
     * ask, and neither is reachable from the other's state.
     */
    const live = control.slice(control.indexOf("{running ? ("), control.indexOf(") : ("));
    expect(live).toContain("Stop this pass");
    expect(live).not.toContain("Ask the expert");
    expect(control.slice(control.indexOf(") : ("))).toContain("Ask the expert");

    const registry = fs.readFileSync(path.join(dir, "../../../engine/src/spool/work.ts"), "utf8");
    expect(registry).toContain("runningFor");
    const state = fs.readFileSync(path.join(dir, "../../../engine/src/state.ts"), "utf8");
    expect(state).toContain("Nothing was started twice.");
  });

  /**
   * A MINUTES-LONG CALL HAS TO SAY WHERE IT IS. The old control showed a
   * spinner for twenty turns and nothing else; "Read reconciliation.ts" is what
   * tells you it is on the right track rather than merely alive.
   */
  test("a pass in flight reports its step and can be stopped", () => {
    const control = flat("packet-body.tsx");
    expect(control).toContain("running.step");
    expect(control).toContain("work.cancel(running.id)");
  });
});

/**
 * THE STANCE — §13's one screen, asserted as source text.
 *
 * The bands' vocabulary is OWNERSHIP AND STATE, never the memory model's
 * taxonomy; every line leads with the human's own words; and the whole page is
 * drawn from records with no model call. Each of those is a rule a future edit
 * could break silently, which is what this suite is for.
 */
describe("the stance answers the three arrival questions, in order", () => {
  const stance = read("stance.tsx");

  test("four bands, in the triage order, and no taxonomy vocabulary at band level", () => {
    const bands = ["Needs you", "In its hands", "Waiting on others", "Settled"];
    const positions = bands.map((band) => stance.indexOf(`title="${band}"`));
    for (const [i, band] of bands.entries()) {
      expect(positions[i], `the "${band}" band is missing`).toBeGreaterThan(-1);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("every line leads with the human's own words, and summons the packet", () => {
    // `said` before `title`, always — the packet page's rule, generalised,
    // because it is the one surface that already read well.
    expect(code(stance)).toContain("said ?? title");
    // Detail stays inside the item: a line summons the tray on that packet
    // rather than growing an inline expansion of the taxonomy.
    expect(code(stance)).toContain("onOpen(itemId)");
  });

  test("it is drawn from records, never asked of a model", () => {
    // The night surface's law, applied to the whole front page: no turn is
    // submitted to render the stance. Its reads are the map, the focus log,
    // night.json, the desk and the work record.
    const body = code(stance);
    expect(body).not.toMatch(/submitTurn|newRunId/);
    for (const record of ["/api/spool/threads", "/api/spool/focus", "/api/spool/night", "/api/spool"]) {
      expect(body).toContain(`fetch("${record}")`);
    }
  });

  test("the night's plan is a record — nothing on the screen approves", () => {
    // §11.3: the plan is frozen when the night starts and shown next to what
    // came of it. An Approve control would reintroduce the old moat —
    // approving a promise instead of a diff.
    expect(code(stance)).not.toMatch(/approve/i);
  });

  test("the clock is read only through the sanctioned helper, and nothing goes red", () => {
    /**
     * RETARGETED 2026-08-16 for §3.2 AS AMENDED (the workbench pass). The old
     * law here was "no clock reaches the renderer", asserted as the absence of
     * `new Date`. The amendment narrows the ban to what it was aiming at: a
     * renderer may now read the clock FOR EXACTLY ONE PURPOSE — knowing which
     * day is today so the user's own dates draw in the right place — and that
     * purpose lives in ONE helper, `lib/spool-today.ts`, which carries the
     * citation. So the assertion moves rather than dies: the stance holds no
     * clock read of its own and takes today from the helper; every other time
     * on the screen is still a store-minted label; and the quietness rule is
     * untouched — no state colour, because a front page that can go red is a
     * front page that shouts on arrival.
     */
    const body = code(stance);
    expect(body).not.toMatch(/new Date|Date\.now|toLocale|resumeAfter/);
    expect(body).toContain('from "@/lib/spool-today"');
    expect(body).not.toMatch(/text-(destructive|warning|success)\b/);
    expect(body).not.toMatch(/bg-(destructive|warning|success)\b/);
  });

  test("one focal point, ranked in code, and the chores fold to one line", () => {
    /**
     * THIRTEEN ROWS OF IDENTICAL GRAY IS THE QUEUE AGAIN. The band ranks in
     * code (tiers on the entry, sorted, never a model call), gives exactly its
     * first entry card treatment, folds filing into one expandable line, and
     * caps what shows.
     *
     * RETARGETED FOR THE APERTURE (loops §6): `<FocalCard ` used to count 1.
     * The wide and focused apertures are exclusive branches of one ternary on
     * `scope`, and each renders exactly one focal point — so the source holds
     * two render sites and the screen still holds one card. What the count
     * now guards is "one per aperture", which is the same law in a room with
     * two postures. `<SubjectLabel` (the wide flat view's sub-header) became
     * `<SubjectLine` — wide no longer groups items under subjects, it renders
     * one line PER subject.
     *
     * RETARGETED AGAIN 2026-08-16 (loops §8.3): the Today smart scope is a
     * third exclusive branch of the same aperture ternary and renders its own
     * single focal card — three render sites, still exactly one card on any
     * screen. The Scheduled scope carries none on purpose: pins are the
     * user's own dates, and a "most important pin" would be the system
     * ranking the user's calendar.
     */
    const body = code(stance);
    /**
     * RETARGETED 2026-08-17 (the confrontation pass): the three render sites
     * grew a conditional `onSettle` prop and the formatter broke them onto
     * their own lines, so the old `"<FocalCard "` spelling (trailing space)
     * stopped matching JSX that now ends the line at the tag name. The law is
     * unchanged — three exclusive branches, one card on any screen — so the
     * match follows the tag boundary rather than the whitespace.
     */
    expect((body.match(/<FocalCard[\s/>]/g) ?? []).length).toBe(3);
    expect(body).toContain("a.tier - b.tier");
    expect(body).toContain("<SubjectLine");
    expect(body).toContain("<HousekeepingFold");
    expect(flat("stance.tsx")).toContain("need filing");
    expect(flat("stance.tsx")).toContain("and {hidden} more");
  });

  test("one item, one band — the precedence is enforced, not hoped for", () => {
    // Waiting-on-person beats in-its-hands beats needs-you: anything a claimed
    // thread reaches — the thread or any capture that fed it — is excluded
    // from Needs you by set membership, whichever record also mentions it.
    const body = code(stance);
    expect(body).toContain("claimedThreads");
    expect(body).toContain("claimedItems");
    expect(body).toContain('waiting?.kind === "person"');
  });

  test("a line's chat verb is wired, never a dead hint", () => {
    // "A hint that does nothing when clicked is worse than none." Every verb a
    // line teaches goes through the suggest channel into the composer next
    // door, where the human presses send — prefilled, never auto-sent.
    const body = code(stance);
    expect(body).toContain("onSuggest");
    expect(body).toContain("prefill={suggestion}");
    // And the chat's openers come from this same derivation, drawn from state.
    expect(body).toContain("deriveOpeners");
    expect(body).toContain("openers={openers}");
  });

  test("the room mark appears where it is sanctioned, and on no second band", () => {
    /**
     * Of --spool's five allowed places, two are on this screen: the "needs
     * you" mark and the pulse of a pass in flight. One band wears the mark.
     *
     * RETARGETED FOR THE APERTURE: two render sites now, one per exclusive
     * branch — so the count is 2 and the stronger claim is asserted instead:
     * every `<Band mark` in the file is the "Needs you" band. No second band
     * TITLE ever wears the dot, whichever aperture is up.
     *
     * RETARGETED AGAIN 2026-08-16: the Today scope is a third exclusive
     * branch with its own "Needs you" band, so three sites — and the loop
     * below still holds the real law: only "Needs you" ever wears the mark.
     * Scheduled's band does not, because a list of your own pins makes no
     * claim on you.
     */
    expect((code(stance).match(/<Band mark /g) ?? []).length).toBe(3);
    for (const use of code(stance).match(/<Band mark title="[^"]*"/g) ?? []) {
      expect(use).toBe('<Band mark title="Needs you"');
    }
    expect(code(stance)).toContain("animate-spin text-spool");
    // Tuned as a MARK: the only bg-spool is the dot, never a wash or a tint.
    for (const use of code(stance).match(/[\w/-]*bg-spool[\w/-]*/g) ?? []) {
      expect(use).toBe("bg-spool");
    }
    expect(code(stance)).not.toMatch(/bg-spool\/\d/);
  });
});

describe("focus is the room's aperture, and it scopes threads too — not only items", () => {
  const stance = read("stance.tsx");
  const body = code(stance);

  test("every thread-bearing slice the model exports is subject-scoped through inScope", () => {
    /**
     * THE BUG THIS GUARDS: a stance focused on one subject once rendered
     * another subject's threads, because `threads` is built by flattening
     * EVERY `map.subjects` entry (never intersected with `scope`) before the
     * onPerson/withAgent/settled slices are cut from it. Item-level reads
     * (`needs`, `done`) and thread-level reads (`onPerson`, `withAgent`,
     * `settled`) all have to pass through the same `inScope` filter, or the
     * items narrow while the threads beside them do not.
     */
    const returnBlock = body.slice(body.indexOf("return {", body.indexOf("function deriveStance")));
    for (const field of [
      "needs: inScope(needsAll)",
      "onPerson: inScope(onPersonAll)",
      "withAgent: inScope(withAgentAll)",
      "settled: inScope(settledAll)",
      "done: inScope(doneAll)",
    ]) {
      expect(returnBlock, `${field} — a thread or item slice escaped the aperture`).toContain(field);
    }
  });

  test("settled threads render only under Settled, never inside In its hands", () => {
    // "In its hands" is whose TURN it is — live agent work — and a settled
    // thread's turn is over. The focused branch is the second "In its
    // hands" site; the first is wide, which never renders threads at all.
    const inItsHands = body.slice(body.lastIndexOf('title="In its hands"'), body.indexOf('title="Waiting on others"'));
    expect(inItsHands).not.toContain("settled.map");
    expect(inItsHands).not.toContain("thread.settled?.answer");
    expect(inItsHands).toContain("withAgent.map");

    const settledBand = body.slice(body.indexOf('title="Settled"'), body.indexOf("<DoneShelf", body.indexOf('title="Settled"')));
    expect(settledBand).toContain("settled.map");
    expect(settledBand).toContain("thread.settled?.answer");
    // The band's own count is the same list it renders — never stuck at 0
    // while rows sit somewhere else.
    expect(settledBand).toContain("{settled.length}");
  });

  test("unfiled items from other subjects do not surface once the room is focused", () => {
    // Housekeeping (floating captures, unplaced desk cards) carries no
    // subject at all — under a subject's own aperture that is never THIS
    // subject's filing, so the fold and its "N things need filing" opener
    // go quiet rather than surfacing every other subject's stray captures.
    expect(body).toContain("housekeeping: scope ? [] : housekeeping");
  });

  test("the pickup's moved lines are scoped too — several subjects can be open at once", () => {
    /**
     * THE SECOND LIVE BUG: `currentFocus` never ends a prior open entry (a
     * person really can be on several subjects at once), so
     * `pickup.moved` carries every open subject's composed sentences. A
     * room "Focused on telar-vnext" once rendered another open subject's
     * "answered: …" line under ITS "In its hands" band, because the moved
     * strip skipped `inScope` entirely. Each line is addressed now
     * (`SpoolMoved`), and the model has to filter on it like everything
     * else — same function, same law, no second filter invented for it.
     */
    const returnBlock = body.slice(body.indexOf("return {", body.indexOf("function deriveStance")));
    expect(returnBlock).toContain("moved: inScope(focus?.pickup.moved ?? [])");
    // And the render site quotes the addressed line's own text, not the
    // whole object and not a re-composed string.
    expect(body).toContain("{line.text}");
  });
});

/**
 * THE TRAY'S OWN CONTRACT — §13.4. Summoned, never resident, one face.
 */
describe("the tray is summoned, never resident", () => {
  test("one face at a time — no tab strip, no accumulation", () => {
    /**
     * TABS SAY "THESE THINGS ARE ALWAYS HERE", and the room's claim is the
     * opposite: detail is summoned and dismissed. So the tray holds ONE face
     * value and renders no tablist — a second summon replaces the first.
     */
    const tray = code(read("tray.tsx"));
    expect(tray).not.toContain('role="tablist"');
    expect(tray).not.toMatch(/tabs\s*:/);
    expect(tray).toContain("face: TrayFace");
  });

  test("it can always be dismissed, back to two columns", () => {
    const tray = code(read("tray.tsx"));
    expect(tray).toContain('aria-label="Close the tray"');
    // And closing is state, not navigation — the stance owns it.
    expect(code(read("stance.tsx"))).toContain("onClose={() => setTray(null)}");
  });

  test("it paints its own background, so the room's ground does not bleed through", () => {
    /**
     * RETARGETED 2026-08-17 (the visual pass): the column's ground moved from
     * `bg-background` to the RAIL token. The law is unchanged — the tray
     * paints an opaque ground of its own — and the new value is what makes it
     * furniture: `bg-sidebar` is a real step off the canvas in BOTH schemes,
     * where background-on-background was invisible in dark mode.
     */
    const stance = code(read("stance.tsx"));
    const column = stance.slice(stance.indexOf("<SpoolTray") - 600, stance.indexOf("<SpoolTray"));
    expect(column).toContain("bg-sidebar");
  });

  test("the packet face is the SHARED body, not a second copy", () => {
    /**
     * THE DUPLICATE THIS ENDS, third address for it. The panel once drew
     * `item.draft` while the page did not; two renderers of one object, each
     * missing what the other had. The tray imports the sections and re-spells
     * none of them.
     */
    const tray = code(read("tray.tsx"));
    expect(tray).toContain('from "@/components/spool/packet-body"');
    expect(tray).not.toMatch(/function (BornAs|ProposedApproach|RipeningTimeline|ExpertControl)\(/);
    // The night and memory faces are the existing folds, rendered whole.
    expect(tray).toContain("<NightSurface");
    expect(tray).toContain("<MemorySurface");
  });
});

/**
 * THE ROOM IS THE RE-ENTRY MACHINE'S OWN STATE — `docs/spool-loops.md` §13,
 * the floor plan that superseded "scope is the room's own aperture". The
 * `scope` slot the earlier laws pinned is now DERIVED from `room`, a closed
 * kind (`lobby | today | scheduled | subject`), still moved immediately by
 * a click — never a live derivation.
 */
describe("the room is state, and the Lobby is the landing — never seeded from the focus log", () => {
  const stance = read("stance.tsx");

  test("every arrival starts at the Lobby — the focus log's newest open entry no longer seeds the room", () => {
    /**
     * RETARGETED 2026-08-18, DRIVEN LIVE: an earlier pass under loops §8.1
     * ("a glance is not work") seeded `room` from the focus log's newest
     * open entry on arrival — so `/spool` opened straight into whichever
     * subject a person was last on, rather than the Lobby. That is exactly
     * backwards under §13: "the lobby IS the landing," ranking across
     * subjects so the human decides where to go next rather than the room
     * silently replaying the last click. So there is no seed effect left at
     * all — `room` is plain state, `{ kind: "lobby" }` on mount, and only
     * `goSubject`/`goToday`/`goScheduled`/`goLobby` or the aperture's
     * one-way wire ever move it.
     */
    const body = code(stance);
    expect(body).toContain('const [room, setRoom] = useState<SpoolRoomState>({ kind: "lobby" })');
    expect(body).toContain('const scope = room.kind === "subject" ? room.key : undefined');
    // The bug this once was: no effect anywhere reads the focus log's
    // "newest open entry" to move `room`. The log is still read (the
    // pickup line, the reconcile-on-arrival effect) — never to seed a room.
    expect(body).not.toContain("scopeSeeded");
    expect(body).not.toMatch(/pickup\.current \?\? \[\]\)\.at\(-1\)\??\.subject/);
    expect(body).not.toMatch(/localStorage/);
  });

  test("a click moves the room immediately — it does not wait on the log's own idea of newest", () => {
    // `goSubject` sets the room's own state before the focus-log POST lands,
    // so a click on an already-open subject (a no-op on the log) still
    // moves the room. `goLobby`/`goToday`/`goScheduled` are the same law for
    // the other three floor-plan rooms — plain state, no fetch gates them.
    const body = code(stance);
    const goSubjectBody = body.slice(body.indexOf("const goSubject"), body.indexOf("const today ="));
    expect(goSubjectBody).toContain('setRoom({ kind: "subject", key: subject })');
    expect(goSubjectBody.indexOf('setRoom({ kind: "subject"')).toBeLessThan(
      goSubjectBody.indexOf('fetch("/api/spool/focus"'),
    );
    expect(body).toContain('const goLobby = useCallback(() => setRoom({ kind: "lobby" }), [])');
    expect(body).toContain('const goToday = useCallback(() => setRoom({ kind: "today" }), [])');
    expect(body).toContain('const goScheduled = useCallback(() => setRoom({ kind: "scheduled" }), [])');
  });

  test("the fold line's calm is checked, not hoped", () => {
    // "Nothing in them blocks you" is a claim this code verifies per folded
    // subject — a folded subject with tier-1 entries must say so instead.
    const body = code(stance);
    expect(body).toContain("blocking: needsAll.filter");
    expect(flat("stance.tsx")).toContain("blocks you");
    expect(code(stance)).toContain("has ${f.blocking}");
  });

  test("every turn carries the room — in the payload, never in the transcript", () => {
    /**
     * RETARGETED 2026-08-17 (the visual pass). The context line still rides
     * inside `input` — the turn payload has no context field, the engine
     * depends on the prefix being SENT, and the journal keeps it. What
     * changed is the RENDER: the transcript strips the leading `[room: …]`
     * line from a displayed turn, because a machine line painted as the
     * user's own words was the room showing its plumbing. Both halves are
     * pinned — the send path unchanged, the strip present at the display
     * sites (the transcript and the queued strip).
     */
    // RETARGETED FOR §13: the context line's bracket now leads with which
    // FLOOR-PLAN ROOM is open (`room=lobby|today|scheduled|<subject key>`),
    // not a `scope=`/`smart=` pair — §13 folded both into the one room kind.
    expect(code(stance)).toContain("[room: room=");
    expect(code(read("master-chat.tsx"))).toContain("context ? `${context}\\n${text}` : text");
  });

  test("the transcript strips the machine-context prefix, and only at render", () => {
    /**
     * NEW LAW, 2026-08-17: no `[room:` is ever VISIBLE. The strip is a
     * display-time replace of the known shape — one bracketed line, then a
     * newline — applied where turns are shown (the transcript's SessionTurn
     * and the composer's queued strip), never to what is stored or sent.
     */
    const chat = code(read("master-chat.tsx"));
    expect(chat).toContain("const ROOM_PREFIX = /^\\[room: [^\\n]*\\]\\n/");
    // The transcript site: the displayed turn's prompt, stripped in place.
    expect(chat).toContain("prompt: turn.prompt.replace(ROOM_PREFIX");
    // The queued strip: same words the transcript would show, same strip.
    expect(chat).toContain("shownPrompt(turn.prompt)");
    // And the strip must not touch the send path — the prefix is applied
    // AFTER the draft leaves the box, exactly as before.
    expect(chat).not.toContain("shownPrompt(text");
    expect(chat).not.toContain("shownPrompt(draft");
  });
});

/**
 * THE MORNING IS DRAWN, NOT ASKED — the conceptual fix this surface exists for.
 *
 * A night ran, cost a dollar, wrote a brief and an approach, and no screen said
 * so. The only way to find out was to type a question into the chat and have a
 * model call `spool_list_items` and summarise: slow, priced, and different every
 * time. Every fact it needed was already on disk.
 */
describe("the night has a surface, and it draws rather than asks", () => {
  test("it reads records and never spends a token to report", () => {
    const night = code(read("night-surface.tsx"));
    // Its reads are the night record and the work record. There is no turn
    // submitted, no session, no prompt.
    expect(night).toContain('fetch("/api/spool/night")');
    expect(night).not.toMatch(/submitTurn|newRunId|prompt/i);
  });

  test("a refusal is told apart from a failure, because they mean opposite things", () => {
    /**
     * "This item is floating so it has no expert" is the system WORKING and
     * naming the one thing only the user can do. Collapsing it into failure
     * would either hide that work or cry wolf about a night that went fine.
     */
    const night = code(read("night-surface.tsx"));
    expect(night).toMatch(/refused:\s*\{[^}]*HandIcon/);
    expect(night).toMatch(/failed:\s*\{[^}]*TriangleAlertIcon/);
  });

  test("it always says why the night ended, and what it cost", () => {
    // "It stopped" with no reason is what makes an unattended system
    // untrustworthy; an assistant that spends money must be able to say how much.
    const night = code(read("night-surface.tsx"));
    expect(night).toContain("night.stop.note");
    expect(night).toContain("night.usage.costUsd");
  });

  test("no clock reaches the renderer", () => {
    /**
     * §3.2 exactly: a clock may be read by an agent deciding what to do, never
     * by a renderer deciding what to draw. `opened` is a display label the store
     * minted; `stop.resumeAfter` is the one real timestamp in the record and is
     * agent-facing, so it must never be rendered.
     */
    const night = code(read("night-surface.tsx"));
    expect(night).not.toMatch(/new Date|Date\.now|toLocale|resumeAfter/);
  });

  test("the trigger is a quiet outline and says what it will not do", () => {
    // It spends money, so it does not outrank anything — the same rule "Ask the
    // expert" follows. And the module's posture is stated where the click is.
    const night = flat("night-surface.tsx");
    const button = night.slice(night.indexOf("Work on this now") - 300, night.indexOf("Work on this now"));
    expect(button).toContain('variant="outline"');
    expect(night).toContain("It starts nothing, ships nothing");
  });
});

/**
 * MEMORY IS CORRECTABLE, AND CORRECTING IT IS NOT DELETING.
 *
 * The verb exists in the store; without a screen it is unreachable, and a
 * retraction path nobody can walk is not a retraction path. What this suite
 * guards is that the surface keeps the law it is built on rather than quietly
 * becoming a delete button.
 */
describe("the memory surface drains, and never deletes", () => {
  test("a retired fact is still shown, with the reason it was drained", () => {
    // "No deletion path. Dismissing drains." Hiding a drained fact would make
    // retirement indistinguishable from the deletion this store refuses.
    const memory = code(read("memory-surface.tsx"));
    expect(memory).toContain("fact.retired.why");
    expect(memory).toMatch(/line-through/);
    // And it must not filter them out before rendering.
    expect(memory).not.toMatch(/facts\.filter\([^)]*!\w*\.retired/);
  });

  test("nothing on it says delete, or offers to", () => {
    const memory = flat("memory-surface.tsx");
    expect(memory).not.toMatch(/\bdelete\b/i);
    expect(memory).not.toMatch(/method: "DELETE"/);
  });

  test("draining requires a reason, and the control says so before it refuses", () => {
    // The reason is the durable half — a drained fact keeps it forever, so a
    // blank one turns the record of why something stopped being true into a
    // shrug. The button is disabled rather than the request failing.
    const memory = code(read("memory-surface.tsx"));
    expect(memory).toContain("disabled={busy || !why.trim()}");
    expect(flat("memory-surface.tsx")).toContain("What stopped being true?");
  });

  test("an unreviewed fact is marked as an agent's assertion", () => {
    // The provenance law: "every artifact an agent produced is marked as such
    // until a human has looked at it."
    expect(flat("memory-surface.tsx")).toContain("an agent said this");
  });
});

/**
 * §7.6 IS A GRANT YOU MADE, NOT A STATUS. It counts nothing and reports nothing
 * to attend to, so it must not render like something that does.
 */
describe("the permit control is a grant, not a badge", () => {
  test("it carries no count and no status colour", () => {
    const permits = code(read("permits.tsx"));
    expect(permits).not.toMatch(/\.length\}/);
    expect(permits).not.toMatch(/Badge/i);
    /**
     * THE CHIP ITSELF, not the file. A failed PATCH renders `text-destructive`
     * and should — that is an error, which is exactly what the state vocabulary
     * is for. What must never carry a status colour is the GRANT: it reports
     * nothing to attend to, and nothing in this module goes red for a standing
     * choice the user made.
     */
    const chip = permits.slice(permits.indexOf("<DropdownMenuTrigger"), permits.indexOf("</DropdownMenu>"));
    expect(chip).not.toMatch(/text-(destructive|warning|success)\b/);
  });

  test("it says what each level actually gates, in the user's words", () => {
    const permits = flat("permits.tsx");
    expect(permits).toContain("Turns your shorthand into a brief. Proposes nothing.");
    expect(permits).toContain("Also proposes an approach");
  });

  test("`propose` is offered and disclosed as unreachable rather than hidden", () => {
    // Hiding it means discovering the vocabulary later as a boolean; offering it
    // silently promises something that does not happen.
    expect(flat("permits.tsx")).toContain("nothing reaches this yet");
  });

  test("the clamp is shown, never silent — stated beside effective, in plain words", () => {
    /**
     * Loops §8.1: an area's ceiling clamps every member subject's EFFECTIVE
     * permit while the STATED grant stays the user's own. A face that showed
     * only one of the two would either hide policy (stated only) or silently
     * rewrite the user's choice (effective only). So the permits face reads
     * both — stated from the subjects route, effective from the threads map,
     * quoted rather than recomputed — and says the difference as a sentence
     * that names the area. No colour, no alarm: a ceiling is standing policy
     * the user stated, not a state to attend to.
     */
    const tray = read("tray.tsx");
    const body = code(tray);
    expect(body).toContain('fetch("/api/spool/subjects")');
    expect(body).toContain('fetch("/api/spool/threads")');
    // The sentence's shape: `draft — clamped to read by “Personal”’s ceiling`.
    expect(flat("tray.tsx")).toContain("clamped to {acts} by &ldquo;{subject.area}&rdquo;&rsquo;s ceiling");
    // And it renders in the quiet voice — no status colour reaches it.
    expect(body).not.toMatch(/clamped[^<]*text-(destructive|warning|success)/);
  });

  test("a ceiling is stated by the user's hand, and never auto-PATCHed", () => {
    /**
     * "Stated, never assumed" — the provenance rule, enforced structurally:
     * exactly ONE site writes `/api/spool/areas/`, it is the change handler's
     * callee, and no effect reaches it. An area with no stored record renders
     * as "no ceiling" instead of being written into existence — the face
     * completes the picture by SAYING the absence, not by filling it in.
     */
    const body = code(read("tray.tsx"));
    expect((body.match(/fetch\(`\/api\/spool\/areas\//g) ?? []).length).toBe(1);
    expect(body).toMatch(/fetch\(`\/api\/spool\/areas\/\$\{encodeURIComponent\(name\)\}`,\s*\{\s*method: "PATCH"/);
    // The one caller of the write is the select's own onChange.
    expect((body.match(/setCeiling\(/g) ?? []).length).toBe(1);
    expect(body).toMatch(/onChange=\{\(event\) =>\s*setCeiling\(/);
    // "no ceiling" is a rendering of absence, offered as the withdraw option
    // too — `null` on the wire, a corrected statement rather than a deletion.
    expect(flat("tray.tsx")).toContain("no ceiling");
    // The union is shown — areas that exist only as a subject's filed word
    // still get a control — without a record being minted to show them.
    expect(body).toContain('fetch("/api/spool/areas")');
    // Stating a ceiling costs no model call: the tray-wide no-turn law is
    // asserted with the swatch test, and the proxy passes to the engine verb.
    const route = fs.readFileSync(
      path.join(dir, "..", "..", "app", "api", "spool", "areas", "[name]", "route.ts"),
      "utf8",
    );
    expect(route).toContain("setSpoolAreaCeiling");
  });
});

/**
 * THE WORLD IS LOOKED AT, NEVER SUBSCRIBED TO — `docs/spool-loops.md` §4.
 *
 * The trust failure this closes: the store was a snapshot from the day it was
 * populated, and a surface that hides its staleness is the database the user
 * said they didn't want. So the room reads its STORED looks with the arrival
 * snapshot, paints instantly, and reconciles by PULL — on arrival and on
 * focus, the two reasons a person would glance — never by a timer.
 */
describe("the world is looked at, never subscribed to", () => {
  const stance = read("stance.tsx");

  test("the stored looks ride the snapshot, and the reconcile is pull-only", () => {
    const body = code(stance);
    // The arrival read: stored, cheap, honestly stale.
    expect(body).toContain('fetch("/api/spool/looks")');
    // The pull: POST, fired by a reason (arrival, focus) and by nothing else.
    expect(body).toMatch(/fetch\("\/api\/spool\/look",\s*\{\s*method: "POST"/);
    // NO TIMER EVER POLLS THE WORLD. The chat next door ticks to tail a live
    // transcript; the ROOM's own file holds no interval at all.
    expect(body).not.toContain("setInterval");
  });

  test("freshness is quoted with attribution, never computed", () => {
    // `lastLooked` is the store's own label ("looked Sat 13:24") and the only
    // form a renderer touches; `lastLookedAt`/`seenAt` are the epoch stamps,
    // agent-facing only. The no-clock test above already bans `new Date` —
    // this pins the other half: the room never even reads the numbers.
    const body = code(stance);
    expect(body).toContain("lastLooked");
    expect(body).not.toContain("lastLookedAt");
    expect(body).not.toContain("seenAt");
    // And a failed look is words, not a state colour — the same quietness the
    // colour tests above enforce screen-wide.
    expect(flat("stance.tsx")).toContain("couldn't look:");
    expect(flat("stance.tsx")).toContain("stale since");
  });

  test("an observation drains through Noted, and nothing deletes", () => {
    // "Noted" POSTs the ack route, which MARKS the row and keeps it — the
    // record of what the Spool told you is part of the record. No verb on the
    // surface removes an observation.
    const body = code(stance);
    expect(body).toContain("/ack");
    expect(body).toContain("acknowledged");
    expect(flat("stance.tsx")).toContain("Noted");
    expect(body).not.toMatch(/method:\s*"DELETE"/);
  });

  test("an observation line teaches at most two verbs", () => {
    /**
     * Loops §5: "each moved thing carries at most two verbs — one that opens
     * work on it, one that acknowledges it." A third verb is how a world fact
     * starts inflating into a claim on the user. Counted on the component's
     * own slice, so a verb added anywhere inside it fails here.
     */
    const body = code(stance);
    const start = body.indexOf("function ObservationLine");
    const line = body.slice(start, body.indexOf("\nfunction ", start + 1));
    expect((line.match(/<button/g) ?? []).length).toBe(2);
    // World facts, not claims: observations never join the needs derivation.
    expect(line).not.toContain("needsAll");
  });

  test("wide is for choosing: one line per subject, never the flattened bands", () => {
    /**
     * Loops §6, committed. Wide compresses each subject to one line — its
     * name, whose turn it is there in counts, its freshness — and the full
     * grammar is what focusing buys. The calm case is SAID, not left blank,
     * because an empty cell and "nothing needs you" are different answers.
     */
    const body = code(stance);
    expect(body).toContain("<SubjectLine");
    expect(flat("stance.tsx")).toContain("nothing needs you");
    // Movement renders WITH its subject — under the line (wide) or in the
    // "Since your last look" strip (focused) — never as a fifth band.
    expect(flat("stance.tsx")).toContain("Since your last look");
    expect(body).not.toContain('title="Moved"');
    // And the chat is told what the room knows about the world, on the same
    // one context line as everything else.
    expect(body).toContain("looks=");
  });

  test("focus shows the subject's actual items, under the lanes' own words", () => {
    /**
     * THE DEFECT THIS PINS: twelve filed items with no work-state claims
     * belonged to no band, so the residence rendered four nearly-empty bands
     * — the original "all my tasks collapsed into one thing" complaint,
     * re-created. Loops §6: focused shows "one subject's actual items in full
     * grammar". So the residence carries a quiet inventory section, grouped
     * by lane, whose header QUOTES the lane's stored `label` and `window` —
     * a window is coarse prose, never a schedule this code reads — and whose
     * rows summon the packet like every other line in the room.
     */
    const body = code(stance);
    expect(body).toContain('title="Waiting its turn"');
    expect(body).toContain("lane.label");
    expect(body).toContain("lane.window");
    expect(flat("stance.tsx")).toContain("not filed in any lane");
    // One item, one place — the section is gated by the same precedence sets
    // as the bands, so a claimed item never repeats under it.
    expect(body).toContain("claimedByBands");
  });

  test("your focus is the aperture, never the agent's hands", () => {
    // "You're on ozom-gv" is a fact about YOUR attention; the focus strip at
    // the top is its one renderer. Repeating the pickup entry inside "In its
    // hands" dressed the user's own attention up as agent work.
    const body = code(read("stance.tsx"));
    expect(body).not.toContain('"your focus"');
    expect(body).not.toContain("your focus —");
  });
});

/**
 * BRIEFED ARRIVAL COMES FROM THE ENGINE — `docs/spool-loops.md` loop 2.
 *
 * The web used to compose the opening text client-side from the packet's own
 * fields, which meant the delta since the last look could never be in it: the
 * web had the packet, the engine had the look. One composer now, where both
 * halves live — and the moat is unmoved: the text lands as a composer DRAFT
 * the human sends themselves.
 */
describe("the briefing is composed by the engine, and spent by the human", () => {
  const tray = read("tray.tsx");

  test("the handoff fetches the engine's briefing and composes nothing locally", () => {
    const body = code(tray);
    expect(body).toContain("/briefing");
    // The retired client-side composer must not creep back in.
    expect(body).not.toContain("spool-briefing");
    expect(body).not.toContain("spoolBriefing(");
  });

  test("nothing is spent until the human sends", () => {
    // The briefing is WRITTEN AS A DRAFT and navigated to — no session is
    // created here, no turn is queued, and the disclosure stays on the button.
    const body = code(tray);
    expect(body).toContain("writeDraft(undefined, briefing.project.id, briefing.briefing)");
    expect(flat("tray.tsx")).toContain("nothing runs until you click");
  });

  test("a subject says where it lives, and stating terrain is a chat move", () => {
    // The face shows the terrain and the look's own label when they exist, and
    // when they do not it teaches the chat verb rather than growing a form —
    // `spool_set_terrain` is the master's move, so there is no second write
    // path to drift from it.
    expect(flat("tray.tsx")).toContain("lives in");
    expect(flat("tray.tsx")).toContain("tell the chat where this lives");
    expect(code(tray)).not.toMatch(/terrain:\s*\{/);
  });
});

/**
 * A SUBJECT'S ROOM OPENS ON ITS BRIEF — §13.3, driven live 2026-08-18.
 *
 * The pickup line's first draft quoted `SpoolFocusEntry.label` — a
 * STORE-MINTED TIME ("Tue 12:36") — as the thing the human "was on", because
 * `label` was the field that always exists. A timestamp is not a fact about
 * WHAT you were doing; rendering it as the pickup answered a question nobody
 * asked. The fix ranks each entry's own words — `note` first, the resolved
 * open thread's `handle`/`question` second — and drops an entry rather than
 * falling back to its label.
 */
describe("the pickup line quotes what you were doing, never a bare time label", () => {
  const room = read("room.tsx");

  test("the label is never the fallback — note, then the resolved open thread, then nothing", () => {
    const body = code(room);
    // `pickupWords` prefers the entry's own note…
    expect(body).toContain("if (e.note) return e.note");
    // …else resolves the entry's threadId against the brief's OWN open
    // lists (never a second fetch, never the whole thread object) …
    expect(body).toContain("openThreads.find((t) => t.threadId === e.threadId)");
    expect(body).toContain("thread?.handle ?? thread?.question");
    // …and the render site never falls back to a bare focus-entry label —
    // `lane.label` (an unrelated UI label) is fine, `e.label`/`entry.label`
    // off a pickup entry is not.
    expect(body).not.toMatch(/e\.note \?\? e\.label/);
    expect(body).not.toMatch(/\be\.label\b/);
    expect(body).not.toMatch(/\bentry\.label\b/);
  });

  test("an unresolvable entry drops the whole pickup line rather than inventing one", () => {
    // Three states, told apart: no current focus entries at all ("Nothing
    // open here yet"), entries with resolvable words ("You were on …"), and
    // entries that resolve to nothing — which renders NEITHER of the other
    // two sentences, an empty fact rather than a fabricated one.
    const flatRoom = flat("room.tsx");
    expect(flatRoom).toContain("Nothing open here yet.");
    expect(flatRoom).toContain("You were on {pickupWords.map");
    expect(code(room)).toMatch(/pickupWords\.length > 0 \? \([\s\S]*?\) : null/);
  });
});

/**
 * A SUBJECT'S ROOM SUPPRESSES ITS OWN REDUNDANT CHROME — §13, driven live
 * 2026-08-18. The embedded `Stance` (the Tasks tab) renders on a subject-
 * scoped model, which used to paint the SAME "Focused on X / Show
 * everything" strip the root's focused aperture always drew, and the same
 * folded-subjects "meanwhile: …" periphery — both stating a fact the rail
 * and the room's own brief header already state, one of them restating
 * OTHER subjects' movement, which is now the Lobby's job.
 */
describe("a subject room's embedded Stance carries no second copy of chrome the room already speaks", () => {
  const stance = code(read("stance.tsx"));

  test("the focused strip and the folded periphery are gated on `embedded`, off only inside a room", () => {
    expect(stance).toContain("embedded?: boolean");
    expect(stance).toMatch(/\{scope && !embedded && \(/);
    expect(stance).toContain("{!embedded && <FoldedLine folded={folded} onWiden={onWiden} />}");
  });

  test("the subject room's own Tasks tab renders Stance embedded — Today/Scheduled at the root do not", () => {
    const room = code(read("room.tsx"));
    const tasksTab = room.slice(room.indexOf("{tab === \"tasks\""), room.indexOf("{tab === \"board\""));
    expect(tasksTab).toMatch(/embedded\s*\n?\s*\/>/);
    // The root's two day-shaped rooms reuse the SAME component unembedded —
    // `scope` is undefined there regardless, but the prop is honestly absent
    // rather than defaulting the same way by coincidence.
    const dayRooms = stance.slice(
      stance.indexOf('room.kind === "today" || room.kind === "scheduled"'),
      stance.indexOf('room.kind === "subject" && ('),
    );
    expect(dayRooms).not.toContain("embedded");
  });
});

/**
 * THE WORKBENCH — `docs/spool-loops.md` §7, under §3.2 AS AMENDED 2026-08-16.
 *
 * Three pieces, one principle: your hand and its hand are the same ink. The
 * board and the calendar are POSTURES of the one room, the hand-made task goes
 * through the human API with zero model involvement, and the calendar draws
 * the user's own dates — quoting, never wielding. Each of those is a rule a
 * future edit could break silently, which is what this suite is for.
 */
describe("the workbench — one room, three postures, the human's own dates", () => {
  const lib = (name: string) => fs.readFileSync(path.join(dir, "..", "..", "lib", name), "utf8");

  test("the sanctioned today-helper exists, and cites the amendment it lives under", () => {
    /**
     * The amendment's whole mechanism: a renderer may read the clock for
     * EXACTLY ONE PURPOSE — knowing which day is today — and that read lives
     * in one file that says which law permits it. A helper without the
     * citation is just a clock with a nicer name.
     */
    const helper = lib("spool-today.ts");
    expect(helper).toContain("§3.2");
    expect(helper).toContain("AMENDED");
    expect(helper).toContain("2026-08-16");
    expect(helper).toContain("export function todayDay");
  });

  test("the workbench renderers hold no clock of their own", () => {
    // The calendar and the stance take today FROM the helper; the board needs
    // no clock at all (order is stack position); the form takes its day from
    // the user's own input. None of them reads one directly — the ban on
    // `new Date` in renderers survives the amendment everywhere but the
    // helper itself.
    expect(code(read("calendar.tsx"))).toContain('from "@/lib/spool-today"');
    for (const name of ["board.tsx", "calendar.tsx", "add-task.tsx"]) {
      expect(code(read(name)), `${name} reads a clock of its own`).not.toMatch(/new Date|Date\.now|toLocale/);
    }
  });

  test("the postures are one route — state in the room, never a second door", () => {
    // Loops §7, folded into §13: "the stance, the board and the calendar
    // are one room's postures, not routes." §13 renamed the switch from the
    // app root's `posture` to a subject room's own `tab` (Tasks/Board/
    // Calendar/Notes) — still component state, owned by `room.tsx` now that
    // postures only exist inside a subject's room, and no surface links to
    // one as a destination.
    const room = code(read("room.tsx"));
    expect(room).toContain("setTab");
    for (const { name, source } of surfaces()) {
      // A quote right before the path — a URL, not the component imports
      // (`@/components/spool/board`) that are exactly how postures stay state.
      expect(code(source), `${name} treats a posture as a route`).not.toMatch(/["'`]\/spool\/(board|calendar|stance)/);
    }
    for (const name of ["board.tsx", "calendar.tsx"]) {
      const body = code(read(name));
      expect(body, `${name} navigates`).not.toMatch(/router\.push|href=/);
    }
  });

  test("the hand-made task goes through the human API, with zero model involvement", () => {
    // §7.1: a plain form writing straight to the store. The form path holds
    // no turn, no run, no session — the chat notices the item the same way it
    // notices everything else: it is simply there in the snapshot.
    const form = code(read("add-task.tsx"));
    expect(form).toContain('"/api/spool/items"');
    expect(form).toContain('method: "POST"');
    expect(form).not.toMatch(/submitTurn|newRunId|createSession/);
    // And the proxy route forwards the composed fields rather than dropping
    // them — a form that posted a pin into a route that discarded it would be
    // live and silently inert.
    const route = fs.readFileSync(path.join(dir, "..", "..", "app", "api", "spool", "items", "route.ts"), "utf8");
    for (const field of ["project", "lane", "deadline", "pinned"]) {
      expect(route, `the items route drops ${field}`).toContain(field);
    }
  });

  test("the drag is the platform's own — no library was added for it", () => {
    // The app's one drag idiom is native HTML5 (cf right-panel.tsx's
    // reference drags). A dnd dependency would be a second grammar for the
    // same gesture.
    const pkg = fs.readFileSync(path.join(dir, "..", "..", "package.json"), "utf8");
    expect(pkg).not.toMatch(/dnd|sortable|draggable/i);
    for (const name of ["board.tsx", "calendar.tsx"]) {
      expect(code(read(name))).toContain("dataTransfer");
    }
  });

  test("the board's two gestures are the engine's two verbs", () => {
    // Card → other column re-files (`PATCH {lane}` — an unknown lane comes
    // back refused, and the sentence renders in place); drop on a card
    // re-ranks through the lane's reorder route with the FULL stored stack.
    const board = code(read("board.tsx"));
    expect(board).toContain('"PATCH", { lane: target.key }');
    expect(board).toContain("/reorder");
    expect(board).toContain("setRefused");
  });

  test("the calendar quotes the user's dates, and never editorializes time", () => {
    /**
     * §3.2 as amended, the standing half: what remains banned FOREVER is
     * countdowns, overdue-red, badges, and any date the user did not state.
     * The grid places `pinned` days only; deadline labels and lane windows
     * stay chips and prose exactly where they already were — never parsed
     * into grid positions.
     */
    for (const name of ["board.tsx", "calendar.tsx"]) {
      const body = code(read(name));
      expect(body, `${name} editorializes time`).not.toMatch(/\boverdue\b|\bcountdown\b|\bbadge\b/i);
      expect(body, `${name} shouts`).not.toMatch(/(text|bg|border)-(destructive|warning)\b/);
    }
    const calendar = code(read("calendar.tsx"));
    expect(calendar).toContain("pinned");
    expect(calendar).not.toMatch(/Date\.parse|parse\w*\(.*deadline/);
  });

  test("unpin says where the item goes, and a slipped pin keeps the quiet voice", () => {
    // "Unpin — it goes back to its lane": clearing a pin is `{pinned: null}`
    // and never reads as deletion. A slipped pin is recorded honestly, not
    // punished — the amendment's own sentence, no red anywhere near it.
    expect(flat("calendar.tsx")).toContain("unpin — it goes back to its lane");
    expect(flat("calendar.tsx")).toContain("it&apos;s still here");
    expect(code(read("calendar.tsx"))).toContain("pinned: null");
  });

  test("the stance feels the pin, in the user's own voice", () => {
    // Loops §7: the room surfaces a pin when its day comes — you interrupting
    // yourself, not the system knocking. Tier 2, beside your commitments;
    // today's wording and the slipped wording are both the amendment's.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("you pinned this to today");
    expect(stance).toContain("it's still here");
    expect(stance).toContain("formatDay");
  });

  test("the chat is told which room is up — the posture itself is retired from the context line", () => {
    /**
     * RETARGETED FOR §13. Postures now only exist INSIDE a subject's room
     * (Tasks/Board/Calendar/Notes, owned by `room.tsx`'s own `tab` state)
     * rather than as a root-level switch every context line carried — so
     * there is no `posture` left at the root to report. What the context
     * line reports instead is the coarser, still-true fact: which
     * FLOOR-PLAN ROOM is open (`room=`, per the test above) — enough for
     * "file this" to resolve, and honest about the fact that a tab flip
     * inside a subject's room is not itself reported to the chat.
     */
    const stance = code(read("stance.tsx"));
    expect(stance).not.toContain("posture");
    expect(stance).toContain("room=${roomLabel}");
  });
});

/**
 * IDENTITY SAYS WHOSE, NEVER HOW URGENT — `docs/spool-loops.md` §8.
 *
 * Areas and colors are groupings-as-identity: a subject's hue and group name
 * are the USER'S, constant, never derived from state and never a status
 * light. The smart scopes are computed apertures of the same room. Each law
 * below is one a future edit could break silently — a hue recruited as an
 * overdue mark, an invented "Other" group, a Today that quietly became a
 * route or a focus commitment.
 */
describe("identity is whose, never how urgent", () => {
  const css = () => fs.readFileSync(path.join(dir, "..", "..", "app", "globals.css"), "utf8");

  test("the eight identity hues exist in both themes, under their stated law", () => {
    const sheet = css();
    for (const token of ["plum", "sea", "moss", "amber", "slate", "rose", "sky", "sand"]) {
      // Two declarations per token — :root and .dark — like --spool.
      expect((sheet.match(new RegExp(`--subject-${token}:`, "g")) ?? []).length, `--subject-${token}`).toBe(2);
    }
    // The law travels with the values, in so many words, and it names its
    // relationship to the ramp rule rather than quietly sitting beside it.
    expect(sheet.replace(/\s+/g, " ")).toContain("IDENTITY, NEVER STATE");
    expect(sheet.replace(/\s+/g, " ")).toContain("never used for urgency");
    expect(sheet.replace(/\s+/g, " ")).toContain("This is NOT a sixth ramp");
    // And they are deliberately NOT bridged into @theme: no `bg-subject-*`
    // utility exists, so a state conditional cannot reach a hue by class.
    expect(sheet).not.toContain("--color-subject-");
  });

  test("the color helper is a pure token→var map, off the engine's own closed enum", () => {
    const helper = fs.readFileSync(path.join(dir, "subject-color.ts"), "utf8");
    // The mapping is the CSS variable and nothing else — no hex, no state,
    // no clock, no item ever enters it.
    expect(helper).toContain("var(--subject-");
    expect(helper).toContain("SpoolSubjectColor.options");
    expect(code(helper)).not.toMatch(/fetch|new Date|Date\.now|#[0-9a-fA-F]{3}/);
    expect(code(helper)).not.toMatch(/deadline|pinned|tier|needsYou|slipped|urgent/i);
    // Absent or unknown collapses to ONE neutral value — a fallback dot, so
    // an uncoloured subject reads as ordinary rather than as broken.
    expect(helper).toContain("NEUTRAL");
  });

  test("no surface spells a raw --subject-* var — the helper is the only door", () => {
    // The identity hues never appear in a state position, enforced at the
    // root: no renderer can compose `--subject-*` into a needs/urgency
    // conditional because no renderer holds the string at all.
    for (const { name, source } of surfaces()) {
      expect(code(source), `${name} reaches an identity token directly`).not.toContain("--subject-");
    }
    // And the helper's callers are pinned: the shared dot and the tray's
    // swatch control. A third caller is a review question, not a convenience.
    const callers = surfaces().filter((f) => code(f.source).includes("subjectColorVar("));
    expect(callers.map((f) => f.name).sort()).toEqual(["chips.tsx", "tray.tsx"]);
  });

  test("the dot is identity only — it takes no state and cannot be recruited as one", () => {
    // SubjectDot's whole input is a color token and a className. No item, no
    // date, no tier reaches it, so `slipped` and `needsYou` CANNOT tint it —
    // the same-quiet-voice rule for slipped pins holds by construction.
    const chips = code(read("chips.tsx"));
    const start = chips.indexOf("export function SubjectDot");
    const dot = chips.slice(start, chips.indexOf("export function", start + 1));
    expect(dot).toContain("{ color, className }");
    expect(dot).not.toMatch(/deadline|pinned|tier|needsYou|slipped|urgent|item\./i);
  });

  test("area headers come from stored values only — no invented group, ever", () => {
    // Loops §8's provenance rule: groupings are the user's vocabulary. The
    // area-less tail renders under NO header; an "Other" would be the system
    // naming a group the user never made.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("groupByArea");
    expect(stance).toContain("line.area");
    for (const { name, source } of surfaces()) {
      expect(code(source), `${name} invents an "Other" group`).not.toMatch(/["'`>]Other["'`<]/);
    }
  });

  test("Today and Scheduled are rooms, not routes", () => {
    // §8.3 under §6's laws, folded into §13: Today and Scheduled are states
    // of the one room — now two of the four kinds `room` can hold, entered
    // via `goToday`/`goScheduled` (plain setState) rather than a separate
    // `smart` scope. No href names them, and entering one never navigates.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain('const goToday = useCallback(() => setRoom({ kind: "today" })');
    expect(stance).toContain('const goScheduled = useCallback(() => setRoom({ kind: "scheduled" })');
    for (const { name, source } of surfaces()) {
      expect(code(source), `${name} treats a smart scope as a route`).not.toMatch(/["'`]\/spool\/(today|scheduled)/);
    }
    // And the chat is told which room is up, on the same context line.
    expect(stance).toContain("room=${roomLabel}");
  });

  test("smart scopes never touch the engine's focus store", () => {
    /**
     * The focus log records SUBJECT focus only — it is the record the chat's
     * pickup quotes back, and "you glanced at today" is not that kind of
     * fact. So exactly ONE site POSTs the focus route (`focusOn`, the
     * subject aperture), and the reasoning is pinned as prose because the
     * next editor will be tempted to "unify" the two apertures into it.
     * RETARGETED for §8.1's slot: the scopes now write the APERTURE route,
     * and the law they must keep is unchanged — they still never write focus.
     */
    // A POST regex, not the bare path: the room's snapshot legitimately GETs
    // the focus log — what is counted is who WRITES it.
    const stance = read("stance.tsx");
    expect((code(stance).match(/fetch\("\/api\/spool\/focus",\s*\{\s*method: "POST"/g) ?? []).length).toBe(1);
    expect(flat("stance.tsx")).toContain("deliberately never written to the engine's focus store");
  });

  test("the aperture slot is now READ-ONLY from the UI's side — a one-way wire, not a shared read/write slot", () => {
    /**
     * RETARGETED FOR §13. Loops §8.1 had the chat's `spool_set_aperture` and
     * the hand's own clicks writing the SAME slot — a two-way wire. §13
     * ends the UI's half of that: every click now navigates `room` directly
     * (see the previous test), and the slot is written ONLY by the engine
     * side (the chat's tool, or a future agent surface) — this room merely
     * FOLLOWS it. `lastAppliedAperture` is the ref that tells an external
     * write (the slot changed since this component last acted on it) apart
     * from this component's own prior read, so the UI's navigation never
     * echoes back into the slot it only listens to.
     */
    const stance = read("stance.tsx");
    const body = code(stance);
    // The slot still rides the room's one snapshot read…
    expect(body).toContain('fetch("/api/spool/aperture")');
    // …but no click in this file PUTs it any more — the write half of the
    // wire is gone from the UI entirely.
    expect(body).not.toMatch(/fetch\("\/api\/spool\/aperture",\s*\{\s*method: "PUT"/);
    expect(body).toContain("lastAppliedAperture");
    expect(body).not.toMatch(/localStorage/);
    // The engine's own PUT route is untouched — the chat's tool still has
    // a door in, the UI simply no longer walks through it.
    const route = fs.readFileSync(
      path.join(dir, "..", "..", "app", "api", "spool", "aperture", "route.ts"),
      "utf8",
    );
    expect(route).toContain("SpoolApertureView.options.includes");
    expect(route).toContain("export async function PUT");
  });

  test("subject focus covers the room without touching the aperture slot", () => {
    /**
     * The precedence §8.1 fixed, still true under §13: subject focus is the
     * DEEPER aperture — entering a subject's room does not write the
     * aperture slot at all (nothing to clear; the UI's writes retired
     * above), and leaving the subject room again shows whatever `room` was
     * before, not a re-derived read of the slot.
     */
    const stance = read("stance.tsx");
    const body = code(stance);
    // The one aperture write site left anywhere is the external, one-way
    // effect above — `goSubject` (entering a subject's room) never touches
    // the slot at all.
    const goSubjectBody = body.slice(body.indexOf("const goSubject"), body.indexOf("const today ="));
    expect(goSubjectBody).not.toContain("/api/spool/aperture");
    expect(goSubjectBody).not.toContain("setLastAppliedAperture");
    expect(body).toContain("room=${roomLabel}");
  });

  test("Scheduled's day grammar is the sanctioned helper's, and slipped pins keep the quiet voice", () => {
    // Day headers are `formatDay`'s pure format of days the user stated —
    // "Tue 18 Aug" — and the slipped group leads, under an honest sentence
    // in the amendment's own register: recorded, never punished, no red.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("formatDay(group.day)");
    expect(stance).toContain("formatDay(row.day)");
    expect(flat("stance.tsx")).toContain("pinned to days that have passed — still here");
    // Slipped first is a claim the derivation makes in code, not in hope.
    expect(stance).toContain("scheduledSlipped");
  });

  test("the swatch control PATCHes the subject record, and never submits a turn", () => {
    // The workbench principle, again: the hand and the chat are the same
    // ink. Picking a color or stating an area writes the same store the
    // chat's tools write — through the proxy's identity arm — and costs no
    // model call. A refusal is the engine's sentence, inline and quiet.
    const tray = code(read("tray.tsx"));
    expect(tray).toContain("/api/spool/subjects/");
    expect(tray).toContain("patchIdentity({ color: token })");
    expect(tray).toContain("patchIdentity({ color: null })");
    expect(tray).not.toMatch(/submitTurn|newRunId|createSession/);
    // And the proxy's identity arm passes through to the engine's own verb.
    const route = fs.readFileSync(
      path.join(dir, "..", "..", "app", "api", "spool", "subjects", "[key]", "route.ts"),
      "utf8",
    );
    expect(route).toContain("setSpoolSubjectIdentity");
  });
});

/**
 * THE WORLD CONFRONTS THE CLAIM — the join that lets an observation ("PR #418
 * merged since your last look") meet the claim-thread still stuck on you about
 * the same numbered thing. Two records, one row: the observation annotates the
 * claim UNDER it, in the store's own words, and the human gains ONE verb —
 * Settle — behind the dialog. The system never settles anything itself.
 */
describe("the world confronts the claim, and only the human settles", () => {
  const stance = read("stance.tsx");

  test("the annotation quotes the stored words and the seen label, nothing composed", () => {
    // The sentence carries the observation's own `text` and `seen` fields,
    // interpolated verbatim — no clock, no re-phrasing, no urgency word.
    expect(flat("stance.tsx")).toContain(
      "the world may have moved past this — {confront.text} (seen {confront.seen})",
    );
    // And the join stores exactly the observation's fields, not a sentence of
    // this file's own composition.
    expect(code(stance)).toContain("entry.confront = { text: hit.text, seen: hit.seen }");
  });

  test("the match keeps the number's boundary, and the claim keeps its band and tier", () => {
    // The packet-match idiom: `#41` must not claim `#412`. And the join is an
    // ANNOTATION pass only — it pushes nothing into the needs derivation and
    // rewrites no tier, because a confronted claim still needs you until YOU
    // settle it.
    const body = code(stance);
    const start = body.indexOf("const namedBy");
    expect(start).toBeGreaterThan(-1);
    const join = body.slice(start, body.indexOf("const lookFor"));
    expect(join).toContain("(?![0-9])");
    expect(join).not.toContain("needsAll.push");
    expect(join).not.toContain("tier:");
    // Reading only — acknowledging stays the Noted verb's job.
    expect(join).not.toContain("acknowledged: true");
  });

  test("settling is a human's two clicks, through the dialog, with the answer shown first", () => {
    const body = code(stance);
    /**
     * RETARGETED 2026-08-18 (loops §10's volume work): the count was 1 — the
     * single settle dialog's confirm. Settle-all-answered added a SECOND
     * thread-route write site, and it is the same law twice: the bulk site is
     * `confirmSettleMany`, reachable only through ITS dialog's confirm, and
     * it POSTs the bulk `settle-many` route — never a loop over the single
     * one. Both sites are dialog confirms; nothing settles on a row click.
     */
    expect((body.match(/fetch\(`\/api\/spool\/threads\/\$\{/g) ?? []).length).toBe(2);
    expect(body).toContain("/settle-many`");
    expect(body).toContain("onConfirm={confirmSettleMany}");
    // Word-bounded since 2026-08-18: `confirmSettleMany` would otherwise
    // count here, and it is the OTHER dialog's confirm, pinned separately.
    expect((body.match(/confirmSettle\b/g) ?? []).length).toBe(2); // the definition, and onConfirm
    expect(body).toContain("onConfirm={confirmSettle}");
    expect(body).toContain("<ConfirmDialog");
    // The row's verb only SUMMONS the question — it fills state, sends nothing.
    expect(body).toContain("setSettling({ subject: entry.subject, threadId: entry.threadId");
    // The send is the settle verb the engine requires an answer for, and the
    // dialog says what settling IS in the store's own terms.
    expect(body).toContain("settle: { answer: settleAnswer }");
    expect(flat("stance.tsx")).toContain("settling records what was found out, not that it is over");
  });

  test("the answer is recorded, not invented — prefilled from the observation, editable by the human", () => {
    const body = code(stance);
    // The prefill composes from the observation's stored text and seen label…
    expect(body).toContain("`${entry.confront.text} (seen ${entry.confront.seen})`");
    // …and stays the human's to edit before the one send.
    expect(body).toContain("value={settleAnswer}");
    expect(body).toContain("setSettleAnswer(event.target.value)");
  });

  test("Settle is the hand's on every thread-backed claim — and never a verb to nowhere", () => {
    /**
     * RETARGETED 2026-08-17 (§9.4, the parity rule). This used to pin
     * `entry.confront && entry.threadId` — Settle appeared only when the
     * world had CONFRONTED the claim, which left the ordinary case
     * chat-only. The gate is now the THREAD alone, at every wire site; the
     * half of the old law that survives is the no-thread half — a tier-3
     * prepared card has nothing to settle, so `askSettle` refuses without a
     * thread and no verb renders. The prefill degrades honestly: the
     * observation's stored words when one exists (pinned above), empty
     * otherwise — never a sentence this code invents.
     */
    const body = code(stance);
    expect(body).toContain("entry.threadId ? { onSettle: () => onSettle(entry) }");
    expect(body).toContain("focal.threadId ? { onSettle: () => onSettle(focal) }");
    expect(body).toContain("if (!entry.threadId) return;");
    // Empty, not invented, when no observation confronts the claim.
    expect(body).toContain('entry.confront ? `${entry.confront.text} (seen ${entry.confront.seen})` : ""');
  });
});

/**
 * THE WAREHOUSE IS WORKED BY HAND — loops §7's principle applied to the
 * shelving itself. Lanes are the user's furniture: minted, renamed and retired
 * from the board through the HUMAN-ONLY routes (no tool surface reaches them),
 * and an item's filing moves from its packet face through the same PATCH the
 * chat's tools use. Zero model calls anywhere in it.
 */
describe("the warehouse is worked by hand, through the human routes", () => {
  const board = read("board.tsx");

  test("minting a lane is the affordance's form — one POST site, on the board alone", () => {
    const body = code(board);
    expect((body.match(/"\/api\/spool\/lanes",\s*"POST"/g) ?? []).length).toBe(1);
    const posters = surfaces().filter((f) => /\/api\/spool\/lanes",\s*"POST"/.test(code(f.source)));
    expect(posters.map((f) => f.name)).toEqual(["board.tsx"]);
    // The affordance opens the form; only the form's confirm submits.
    expect(body).toContain("<LaneFormDialog");
    expect(flat("board.tsx")).toContain("New lane");
  });

  test("a rename is the label only — the key never moves", () => {
    expect(code(board)).toContain("withWindow={false}");
    expect(code(board)).toContain('"PATCH", { label: values.label }');
  });

  test("retiring goes through the dialog, and the dialog tells the store's truth", () => {
    // The engine refuses to retire a lane that still holds items and never
    // evicts one — the dialog says exactly that (drain wording, no "delete"
    // verb offered), and the refusal's sentence surfaces rather than being
    // swallowed: it comes back as a 200 result and is rendered as the error.
    const body = code(board);
    expect(body).toContain("<ConfirmDialog");
    expect(flat("board.tsx")).toContain("retiring never evicts anything on your behalf");
    expect(flat("board.tsx")).toContain("nothing is deleted");
    expect(body).toContain("data.ok === false");
  });

  test("the packet's filing controls PATCH the human API, and never submit a turn", () => {
    const tray = code(read("tray.tsx"));
    // One write helper, aimed at the item's own PATCH route.
    expect(tray).toContain('await send(`/api/spool/items/${encodeURIComponent(id)}`, "PATCH", patch)');
    // The four filing moves, each a stated field — and the pin's clear is the
    // calendar's own `pinned: null`, a move and never a deletion.
    expect(tray).toContain("file({ lane: next })");
    expect(tray).toContain("file({ project: next })");
    expect(tray).toContain("file({ deadline: { label, kind:");
    expect(tray).toContain("file(day ? { pinned: { day } } : { pinned: null })");
    // The raw fragment is untouchable from here — no control names it.
    expect(tray).not.toMatch(/file\(\{\s*raw/);
    // And a refusal is the quiet inline sentence, in the engine's words.
    expect(tray).toContain("filingRefused");
  });
});

/**
 * THE HAND CLOSES — `docs/spool-loops.md` §9, the checkbox amendment.
 *
 * The old law read "SpoolItem carries no done field ON PURPOSE — the absence
 * is the whole moat", and it overcorrected exactly as the clock law did: the
 * moat ever needed only that NO AGENT may declare a thing done, and it took
 * the user's own hand with it. What this suite guards is the amended shape:
 * the close verb is the hand's alone (dedicated route, no tool path, no
 * generic PATCH), one gesture ends everything (no dialog — §9.2:
 * "bureaucracy after a checkbox is how trackers die"), closed drains to a
 * visible shelf and never deletes, and — clause 4, retroactive — every verb
 * the chat has, the hand gets on the rows where a person looks for it.
 */
describe("the hand closes — the checkbox amendment (§9)", () => {
  const lib = (name: string) => fs.readFileSync(path.join(dir, "..", "..", "lib", name), "utf8");
  const route = (...parts: string[]) =>
    fs.readFileSync(path.join(dir, "..", "..", "app", "api", "spool", ...parts), "utf8");

  test("ONE checkbox, defined with the chip grammar, and it is round and quiet", () => {
    // Cross-surface invariant, same mechanism as every chip: one definition
    // site, imported everywhere it renders, so the stance row, board card,
    // calendar line and packet face cannot drift apart.
    const definitions = surfaces().filter((f) => f.source.includes("export function CloseCheckbox"));
    expect(definitions.map((d) => d.name)).toEqual(["chips.tsx"]);
    const chips = code(read("chips.tsx"));
    const start = chips.indexOf("export function CloseCheckbox");
    const box = chips.slice(start, chips.indexOf("export function", start + 1));
    // Round — the app's feel, and Reminders' — and neutral: the tick is the
    // foreground, never a state hue.
    expect(box).toContain("rounded-full");
    expect(box).not.toMatch(/text-(destructive|warning|success)\b/);
    // ONE GESTURE: the click calls onToggle directly. No dialog is reachable
    // from inside the control — §9.2's law, structurally.
    expect(box).toContain("onToggle()");
    expect(box).not.toMatch(/Dialog|confirm/i);
  });

  test("the checkbox POSTs the dedicated close route, and never the generic PATCH", () => {
    /**
     * `closed` is refused BY NAME on the item PATCH — the engine welded that
     * shut so no tool-reachable path can spell it — and the web must not
     * re-open it: every tick goes through the ONE shared helper, whose only
     * verbs are the dedicated POSTs.
     */
    const helper = code(lib("spool-close.ts"));
    expect(helper).toContain("/close`");
    expect(helper).toContain("/reopen`");
    expect(helper).toContain('method: "POST"');
    expect(helper).not.toContain('"PATCH"');
    // No surface writes `closed` into any request body of its own.
    for (const { name, source } of surfaces()) {
      expect(code(source), `${name} spells closed into a write`).not.toMatch(/JSON\.stringify\([^)]*closed/);
    }
    // And the proxies forward to the engine's dedicated verbs.
    expect(route("items", "[id]", "close", "route.ts")).toContain("closeSpoolItem");
    expect(route("items", "[id]", "reopen", "route.ts")).toContain("reopenSpoolItem");
  });

  test("no confirmation guards the close — a checkbox that asks is not a checkbox", () => {
    /**
     * §9.2, quoted: "A human closing a task has answered every question the
     * system had about it; bureaucracy after a checkbox is how trackers
     * die." So the one-gesture law is pinned where the writes are: the
     * shared helper carries the law in prose, and no surface routes a close
     * or reopen through a ConfirmDialog — the calls sit in plain handlers,
     * and the ConfirmDialogs that exist (promote, retire, settle) name other
     * verbs.
     */
    expect(lib("spool-close.ts").replace(/\s+/g, " ")).toContain("bureaucracy after a checkbox is how trackers die");
    for (const { name, source } of surfaces()) {
      const body = code(source);
      if (!body.includes("closeItemByHand") && !body.includes("reopenItemByHand")) continue;
      // No dialog title anywhere asks about closing or reopening.
      expect(flat(name), `${name} asks before closing`).not.toMatch(/Close this (item|task)\?|Reopen this/);
    }
  });

  test("every active derivation filters closed, and the payload keeps it", () => {
    // Conservation is the ENGINE's (views keep closed items); the ACTIVE
    // slices are the web's to filter — §9.3's split, pinned per surface.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("if (row.item.closed) continue;"); // pins + prepared
    expect(stance).toContain("!f.closed"); // floating chores
    expect(stance).toContain("card.closed"); // desk cards
    expect(stance).toContain("row.item.pinned && !row.item.closed"); // scheduled
    expect(code(read("board.tsx"))).toContain("!row.item.closed");
    expect(code(read("calendar.tsx"))).toContain("!row.item.closed");
    expect(code(read("tray.tsx"))).toContain("!r.item.closed");
    // The conservation line is untouched — it still counts everything.
    expect(stance).toContain("{totals.totalItems}");
  });

  test("the Done shelf drains and never deletes, and reopen is reachable from every closed rendering", () => {
    /**
     * §9.3: "closed items leave the active desk into a visible Done shelf."
     * Each surface that drops a closed item also RENDERS it — the stance's
     * shelf, the board's per-lane fold, the calendar rail's fold, the
     * subject face's fold, the packet header — with its ticked box, and the
     * untick IS the reopen: instant, dialog-free, through the same helper.
     */
    expect(flat("stance.tsx")).toContain("Done — {rows.length}");
    expect(flat("stance.tsx")).toContain("Closed drains here and never deletes");
    expect(flat("stance.tsx")).toContain("“closed {row.closedLabel}”"); // the store's label, quoted
    expect(flat("board.tsx")).toContain("{rows.length} done");
    expect(flat("calendar.tsx")).toContain("{doneRows.length} done");
    for (const name of ["stance.tsx", "board.tsx", "calendar.tsx", "tray.tsx"]) {
      expect(code(read(name)), `${name} shows closed items with no way back`).toContain("reopenItemByHand");
    }
  });

  test("Done is a fold, never a fifth band — the register keeps its four", () => {
    // The band vocabulary is WHOSE TURN IS IT, and "done" is not a turn: it
    // is the record of turns that ended. The four-band test above pins the
    // register; this pins the negative — no Band ever wears a Done title.
    expect(code(read("stance.tsx"))).not.toMatch(/<Band[^>]*title="Done/);
  });

  test("the cascade's sentence is quoted from the engine, never invented", () => {
    /**
     * Closing settles the item's open threads ENGINE-side ("the user closed
     * the task" — the honest recorded answer). The web's one sentence
     * interpolates exactly what came back: the count, and any refusal
     * reasons verbatim in quotes. Nothing settled, nothing said.
     */
    const helper = lib("spool-close.ts");
    expect(helper).toContain("settledThreads?.length ?? 0");
    expect(helper).toContain("closed — 1 question it was carrying settled with it");
    expect(helper).toContain("questions it was carrying settled with it");
    expect(helper).toContain("refused.map((r) => `“${r.reason}”`)");
    expect(code(helper)).toContain("return parts.length > 0 ? parts.join(\"; \") : null;");
    // Rendered in the quiet inline idiom wherever a close can happen.
    for (const name of ["stance.tsx", "board.tsx", "calendar.tsx", "tray.tsx"]) {
      expect(code(read(name)), `${name} drops the cascade's answer`).toContain("closeNote");
    }
  });

  test("the parity rule: the row's verbs live on the row, and submit no turns", () => {
    /**
     * §9.4, clause 4: "every verb the chat has, the hand gets as a visible
     * control — and the room's verbs live on the rows where a person looks
     * for them, not only inside trays." The right rail carries Pin… (a
     * native date input — picking the day IS stating it, one PATCH of
     * `pinned`) and Settle… (which only SUMMONS the dialog; the one settle
     * write stays the dialog's confirm, counted elsewhere in this suite).
     */
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("function RowVerbs");
    expect(stance).toContain('aria-label="Pin to a day"');
    expect(stance).toContain("Settle…");
    expect(stance).toContain("JSON.stringify({ pinned: { day } })");
  });

  test("the packet's chat verbs have hand controls — open a question, mark waiting — and no model is called", () => {
    const tray = read("tray.tsx");
    expect(flat("tray.tsx")).toContain("Ask a question about this");
    expect(flat("tray.tsx")).toContain("Mark waiting on someone");
    const body = code(tray);
    // The two writes go to the human thread routes, straight to the store.
    expect(body).toContain("/open`");
    expect(body).toContain("{ waiting }");
    expect(body).not.toMatch(/submitTurn|newRunId|createSession/);
    // The question and the waiting words are the USER'S typed input — the
    // no-thread waiting case composes from `note` or names who, never from a
    // model's sentence.
    expect(body).toContain("question: note.trim() || `waiting on ${name}`");
    // And the proxies exist and forward to the engine's own verbs.
    expect(route("threads", "[subject]", "open", "route.ts")).toContain("openSpoolThread");
    expect(route("threads", "[subject]", "[threadId]", "route.ts")).toContain("setSpoolThreadWaiting");
  });

  test("the agents' wall still cannot close — the verb is only on the human routes", () => {
    // The moat, restated the amended way: no agent may declare a thing done.
    // The engine proves the tool wall's absence; what the web pins is that
    // the ONLY close spellings here are the dedicated human proxies.
    const state = fs.readFileSync(path.join(dir, "../../../engine/src/state.ts"), "utf8");
    expect(state).toContain("closeSpoolItem");
    const writers = surfaces().filter((f) => /\/close|\/reopen/.test(code(f.source)));
    // No surface spells the route by hand — the helper is the one door.
    expect(writers).toEqual([]);
  });
});

/**
 * THE SHELF, THE SEARCH, THE SOCKET AND THE VOLUME — loops §10, plus the
 * §8-volume items its final paragraph names: the digest, the bulk verbs and
 * the selection model. The moat is unmoved by all of it — nothing here lands
 * anything without the hand — and the new laws are pinned the same way the
 * old ones are: structurally, where the next edit would break them silently.
 */
describe("the digest replaces the flood, and moves below Needs you", () => {
  const stance = read("stance.tsx");

  test("movement renders as the engine's digest lines, quoted, expandable to the observations", () => {
    const body = code(stance);
    // ONE renderer for the compression, and it draws the ENGINE's lines —
    // nothing in the room counts, groups or re-words movement.
    expect(body).toContain("function MovementDigest");
    expect(body).toContain("look.digest.map");
    expect(body).toContain("{group.text}");
    // Expansion resolves the SAME ObservationLine — the two-verb law above
    // keeps holding because the component is the same component.
    const start = body.indexOf("function MovementDigest");
    const slice = body.slice(start, body.indexOf("\nfunction ", start + 1));
    expect(slice).toContain("<ObservationLine");
    // "Noted all" drains the GROUP's own ids through the bulk ack — one
    // gesture, one request, never a loop over the single route.
    expect(slice).toContain("onAckAll(subject, group.observationIds)");
    expect(body).toContain("/ack-all`");
  });

  test("the focused strip sits BELOW the Needs you band — what needs the hand outranks what happened", () => {
    /**
     * Loops §10's placement law. The strip used to render ABOVE the bands;
     * the volume pass moved it under "Needs you" in the focused aperture,
     * because the band that asks for the hand must paint first and the news
     * waits under it. Pinned by source order inside the focus branch: the
     * strip comes after the LAST "Needs you" band opening (the focused one)
     * and before that branch's "In its hands".
     */
    // Measured on comment-stripped source: the file's doc comments narrate
    // the strip too, and prose is not placement.
    const body = code(stance);
    const at = body.indexOf("Since your last look");
    expect(at).toBeGreaterThan(body.lastIndexOf('<Band mark title="Needs you">'));
    expect(at).toBeLessThan(body.lastIndexOf('title="In its hands"'));
    // The reasoning travels as prose, where the next editor is.
    expect(flat("stance.tsx")).toContain("what needs the hand outranks what happened");
    // The freshness line and the honest error line stay — quoted, no colour.
    expect(code(stance)).toContain("<FreshnessLine look={scopeLook}");
  });
});

describe("the bulk verbs go through their bulk routes, and never loop the single ones", () => {
  const stance = read("stance.tsx");

  test("close-many is the shared helper's one request, never closeItemByHand in a loop", () => {
    // RETARGETED FOR §13: "the selection model + bulk verbs survive inside
    // Tasks tab" — the whole selection machine, `closeSelected` included,
    // moved from the app root into `room.tsx`'s `SubjectRoom`, since
    // selection only ever exists inside a subject's room now.
    const room = code(read("room.tsx"));
    const closeSel = room.slice(room.indexOf("const closeSelected"), room.indexOf("const patchSelected"));
    expect(closeSel).toContain("closeItemsByHand(selected)");
    expect(closeSel).not.toContain("closeItemByHand(");
    const helper = code(fs.readFileSync(path.join(dir, "..", "..", "lib", "spool-close.ts"), "utf8"));
    expect(helper).toContain('"/api/spool/items/close-many"');
  });

  test("settle-many is ONE dialog, one confirm site, one bulk POST per subject", () => {
    const body = code(stance);
    // Exactly one confirm site writes the bulk settle…
    expect((body.match(/onConfirm=\{confirmSettleMany\}/g) ?? []).length).toBe(1);
    expect(body).toContain("/settle-many`");
    // …the loop it holds is over SUBJECTS (the route is per-subject), and
    // the single-thread route is never called from it.
    const confirm = body.slice(body.indexOf("const confirmSettleMany"), body.indexOf("const closeNote"));
    expect(confirm).toContain("for (const [subject, settles] of bySubject)");
    expect(confirm).not.toContain("settle: { answer");
    // The control only SUMMONS: askSettleAll fills state and sends nothing.
    const ask = body.slice(body.indexOf("const askSettleAll"), body.indexOf("const confirmSettleMany"));
    expect(ask).not.toContain("fetch(");
    // The dialog SHOWS each prefilled answer — the existing composition,
    // the confrontation observation's stored words — before the one send.
    expect(body).toContain("answer: `${e.confront.text} (seen ${e.confront.seen})`");
    expect(body).toContain("{row.answer}");
    expect(flat("stance.tsx")).toContain("settle them all");
  });

  test("the proxies exist and forward to the engine's bulk and shelf verbs", () => {
    const route = (...parts: string[]) =>
      fs.readFileSync(path.join(dir, "..", "..", "app", "api", "spool", ...parts), "utf8");
    expect(route("items", "close-many", "route.ts")).toContain("closeSpoolItems");
    expect(route("threads", "[subject]", "settle-many", "route.ts")).toContain("settleSpoolThreadsMany");
    expect(route("looks", "[subject]", "ack-all", "route.ts")).toContain("acknowledgeSpoolObservations");
    expect(route("search", "route.ts")).toContain("spoolSearch");
    expect(route("mcp-info", "route.ts")).toContain("spoolMcpInfo");
    expect(route("notes", "route.ts")).toContain("createSpoolNote");
    expect(route("notes", "[id]", "route.ts")).toContain("updateSpoolNote");
    expect(route("notes", "[id]", "retire", "route.ts")).toContain("retireSpoolNote");
  });
});

describe("the selection model — gathering is view state, the bar's verbs are store writes", () => {
  const stance = read("stance.tsx");

  test("ONE hotspot, defined with the chip grammar, square beside the round tick, and it writes nothing", () => {
    // Same mechanism as every chip: one definition site, so a stance row, a
    // board card and a Done row cannot drift apart.
    const definitions = surfaces().filter((f) => f.source.includes("export function SelectHotspot"));
    expect(definitions.map((d) => d.name)).toEqual(["chips.tsx"]);
    const chips = code(read("chips.tsx"));
    const start = chips.indexOf("export function SelectHotspot");
    const box = chips.slice(start, chips.indexOf("export function", start + 1));
    // Square where the close checkbox is round — the two gestures must be
    // tellable apart, because one closes and one only gathers.
    expect(box).toContain("rounded-[4px]");
    expect(box).not.toContain("rounded-full");
    // Gathers only: no route is reachable from inside the control.
    expect(box).not.toContain("fetch(");
    // Shift rides the click for range — read once, here, for every surface.
    expect(box).toContain("event.shiftKey");
  });

  test("the bar's verbs never submit turns, and refusals aggregate into one quiet sentence", () => {
    const body = code(stance);
    const bar = body.slice(body.indexOf("function SelectionBar"), body.indexOf("export function SpoolStance"));
    // The bar itself holds NO write — it only calls the room's handlers.
    expect(bar).not.toContain("fetch(");
    expect(bar).not.toMatch(/submitTurn|newRunId|createSession/);
    // RETARGETED FOR §13: the handlers `SelectionBar` calls — `patchSelected`,
    // `clearSelection` — moved to `room.tsx` along with the rest of the
    // selection model. Lane, pin and tag are per-item PATCHes of the same
    // human surface every packet control speaks; the refusals come back as
    // ONE sentence, the engine's reasons verbatim in quotes.
    const room = code(read("room.tsx"));
    const patchSel = room.slice(room.indexOf("const patchSelected"), room.indexOf("const laneSelected"));
    expect(patchSel).toContain('method: "PATCH"');
    expect(patchSel).toContain("refusals.push(`“${");
    // Tag… is ADDITIVE — the new word joins the item's OWN stored tags.
    expect(room).toContain("existing.includes(tag) ? existing : [...existing, tag]");
    // Clearing a selection touches memory only — nothing was done to undo.
    const clear = room.slice(room.indexOf("const clearSelection"), room.indexOf("const closeSelected"));
    expect(clear).not.toContain("fetch(");
  });
});

describe("the quick filters are a squint, never a fact", () => {
  /**
   * RETARGETED FOR §13: the whole squint moved from the app root into
   * `room.tsx`'s own transient state — "filters become transient chips
   * above tab content, local state only." The one-way-back affordance is
   * DIFFERENT under §13: rather than a "filtered — N hidden" caption, each
   * active chip is its own toggle (click again to release it) plus one
   * shared "clear ✕" that drops every filter at once — still one way back,
   * spelled differently now that the squint is a room's local state rather
   * than the whole page's.
   */
  const room = read("room.tsx");

  test("filter state is component state — no engine write, no localStorage", () => {
    const body = code(room);
    expect(body).toContain("const [filter, setFilter] = useState");
    // The aperture-slot test already bans localStorage file-wide; this pins
    // the WHY for filters — glances aren't work — as prose where the next
    // editor is, and pins that no setFilter path reaches a route.
    expect(flat("room.tsx")).toContain("glances aren't work");
    expect(body).not.toMatch(/localStorage/);
    // A filtered view has the one way back: a visible ✕ that clears every
    // active chip at once, rendered only while a filter is active.
    expect(body).toContain("clear ✕");
    expect(body).toMatch(/\{filterOn && \(/);
  });

  test("the predicate carves every posture's active surfaces, and only those", () => {
    // The room's slices, the board's columns and the calendar's grid+rail
    // all take the same predicate; the Done shelves and the payloads are
    // untouched — a filter that reached a record would be a delete path
    // wearing a squint's name.
    expect(code(room)).toContain("const itemPasses");
    expect(code(read("board.tsx"))).toContain("!pass || pass(row.item.id)");
    expect(code(read("calendar.tsx"))).toContain("!pass || pass(row.item.id)");
  });
});

describe("the shelf — notes beside the items, drained and never deleted", () => {
  const tray = read("tray.tsx");

  test("retiring a note requires a reason, behind the dialog, in drain wording", () => {
    // Three layers say so — the face, the proxy, the store — because the
    // rule is the record's meaning, not input validation.
    expect(flat("tray.tsx")).toContain("Retire this note?");
    expect(flat("tray.tsx")).toContain("drains off the working shelf");
    expect(code(tray)).toContain("a reason is required");
    const route = fs.readFileSync(
      path.join(dir, "..", "..", "app", "api", "spool", "notes", "[id]", "retire", "route.ts"),
      "utf8",
    );
    expect(route).toContain("reason is required");
    // And a retired note stays LISTED, dimmed with its reason quoted —
    // hiding it would make retirement indistinguishable from deletion.
    expect(flat("tray.tsx")).toContain("retired {note.retired.label}");
  });

  test("an agent's note is marked, and provenance never edits", () => {
    expect(code(tray)).toContain('author === "session"');
    expect(flat("tray.tsx")).toContain("agent&rsquo;s note");
    // The editor PATCHes title, body and tags — never author; the engine
    // refuses the key by name, and no spelling here tries it.
    expect(code(tray)).not.toMatch(/JSON\.stringify\([^)]*author/);
  });
});

describe("the search is lexical, honest, and marks what is over", () => {
  const search = read("search.tsx");

  test("an empty query is nothing, and closed hits are dimmed with the word beside them", () => {
    const body = code(search);
    // Empty query: no fetch, no zero-state lecture.
    expect(body).toContain("if (!q)");
    // Closed/retired/settled hits render dimmed and MARKED — found, never
    // hidden: hiding them would be a delete path wearing a filter's name.
    expect(body).toContain("hit.closed");
    expect(flat("search.tsx")).toContain("· over");
    // No model call anywhere on this path — the search is the engine's
    // deterministic lexical scorer, quoted.
    expect(body).not.toMatch(/submitTurn|newRunId|createSession/);
  });
});

describe("the socket's connect card — the secret is treated like a key", () => {
  const tray = read("tray.tsx");

  test("the secret is masked by default, revealed only by the hand, and the caution is said", () => {
    const body = code(tray);
    // Masked by default — the reveal toggle starts false…
    expect(body).toContain("const [revealed, setRevealed] = useState(false)");
    // …and the mask covers the secret's spelling INSIDE the composed add
    // command too, or the mask would be theatre.
    expect(body).toContain('mcp.addCommand.replaceAll(mcp.secret, "••••••••")');
    // The caution, in the user's own words.
    expect(flat("tray.tsx")).toContain("treat it like a key");
    // The command is the ENGINE's composition — nothing here builds one.
    expect(body).not.toContain("claude mcp add");
  });
});
