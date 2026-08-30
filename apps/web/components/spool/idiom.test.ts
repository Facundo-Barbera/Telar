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

  test("window.prompt is gone from the whole app, not only this surface — the idiom pass's own gate", () => {
    /**
     * THE CONTEXT-MENU PASS REINTRODUCED IT: `warehouse-nav.tsx`'s area
     * rename and `tray.tsx`'s note retirement reason both reached for
     * `window.prompt` — a light OS box with no room for the Reminders idiom
     * this suite otherwise pins. Both replaced with `AskOneThing`
     * (`prompt-card.tsx`), an anchored popover-card at the row that was
     * acted on. Scanned across the whole app, not just this directory's own
     * surfaces, because a native prompt anywhere is the same regression.
     */
    const root = path.join(dir, "..", "..");
    const offenders: string[] = [];
    const walk = (from: string) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
          const body = code(fs.readFileSync(full, "utf8"));
          if (/[^.\w]window\.prompt\(/.test(body)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
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

  test("the wordmark is STATIC and the switcher is a button beside it; the retired Spool button is gone", () => {
    /**
     * REVISED FROM loops §11's wordmark-as-switcher. The band under the macOS
     * traffic lights is window decoration by adjacency, and a wordmark that
     * read "telar" or "spool" depending on the route mutated the one region
     * that must not move. The wordmark is now the app's name — "Telar",
     * capitalised, always — and the places live behind one small square
     * button beside it. The main area has its own name in that menu:
     * "Sessions"; an app cannot be one of its own places.
     * CHROME, NOT ROUTING still holds: the menu only reads the pathname to
     * decide which entry is checked; picking one navigates.
     */
    const sidebar = fs.readFileSync(path.join(dir, "..", "app-sidebar.tsx"), "utf8");
    expect(sidebar).toContain("function PlaceSwitcher");
    expect(sidebar).toContain('router.push("/")');
    expect(sidebar).toContain('router.push("/spool")');
    expect(sidebar).toContain("inSpool");
    // The footer's Spool destination retired — the switcher is its one home.
    expect(sidebar).not.toContain("function SpoolButton");
    expect(code(sidebar)).not.toMatch(/<SpoolButton\b/);
    const switcherBody2 = sidebar.slice(sidebar.indexOf("function PlaceSwitcher"), sidebar.indexOf("function SidebarEmpty"));
    // The brand is the capitalised app name, never the lowercase place word,
    // and never route-conditional.
    expect(switcherBody2).toContain(">Telar</span>");
    expect(switcherBody2).not.toMatch(/\{place\}/);
    // The retired Telar T glyph stays retired — the wordmark alone is the mark.
    expect(switcherBody2).not.toContain("TypeIcon");
    // The main area is a place with its OWN name in the menu.
    expect(switcherBody2).toContain("<span>Sessions</span>");
    // Colour marks the place, not the neutral entries: only the Spool entry
    // wears the room's hue inside the switcher.
    const hued = (switcherBody2.match(/text-spool/g) ?? []).length;
    expect(hued).toBe(1);
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
    // fixed rooms are Lobby, Today and Scheduled — floor plan, not a
    // squint over one inventory.
    expect(nav).toContain('"Lobby"');
    expect(nav).toContain('"Today"');
    expect(nav).toContain('"Scheduled"');
    // §13.6, added 2026-08-18: the Assistant is a fourth fixed room, the same
    // conversation the summoned layer holds, reached full-width — the rail's
    // other door beside the layer's expand control.
    expect(nav).toContain('"Assistant"');
    /**
     * RETARGETED `docs/spool-loops.md` §13.8 (2026-08-19): the tree itself
     * (and the `buildAreaTree`/"Areas" `aria-label` it used to render under)
     * left the rail entirely — "the map is content, not chrome" moved the
     * whole structure into `lobby.tsx`'s own content pane. The rail is floor
     * plan only now: four fixed rooms, no tree, no `aria-label="Areas"` for
     * assistive tech to land on because there is no list here to label.
     */
    expect(nav).not.toContain('aria-label="Areas"');
    expect(nav).not.toContain("buildAreaTree(");
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
    /**
     * RETARGETED 2026-08-18 (§13.6, "the assistant's two doors"): the tray's
     * own close button is unchanged, but what it dismisses is no longer a
     * `tray` slot the stance owns beside a resident chat — it is the summoned
     * LAYER'S face slot, the same slot the layer's chat occupies when a face
     * is not up. Dismissing either shape closes the whole layer and the room
     * is back to rail + main, never a third column standing on its own.
     */
    const tray = code(read("tray.tsx"));
    expect(tray).toContain('aria-label="Close the tray"');
    // And closing is state, not navigation — the stance owns it.
    expect(code(read("stance.tsx"))).toContain("onClose={() => setLayer(null)}");
  });

  test("it paints its own background, so the room's ground does not bleed through", () => {
    /**
     * RETARGETED 2026-08-18 (§13.6): the tray's ground still steps to the
     * RAIL token, but the div that paints it is now the summoned layer's OWN
     * wrapper — one overlay shared by the face slot and the chat slot — not a
     * column rendered only when a face is up. The law is unchanged: an opaque
     * ground of its own, `bg-sidebar`, a real step off the canvas in BOTH
     * schemes.
     */
    const stance = code(read("stance.tsx"));
    const column = stance.slice(stance.indexOf("<SpoolTray") - 900, stance.indexOf("<SpoolTray"));
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
    /**
     * RETARGETED `docs/spool-loops.md` §13.7 (path ceilings, 2026-08-18): an
     * area name is a PATH, and every prefix's ceiling clamps down it, most
     * restrictive wins — so the segment that actually clamped a subject is
     * not always that subject's own `area`; an ancestor's ceiling can be the
     * one that won. The sentence now quotes the threads read's own
     * `clampedBy` (the winning prefix, exact), falling back to `subject.area`
     * only for data that predates the field. The sentence's shape is
     * unchanged: `draft — clamped to read by "Personal"'s ceiling`.
     */
    expect(flat("tray.tsx")).toContain("clamped to {acts} by &ldquo;{clampSource}&rdquo;&rsquo;s ceiling");
    expect(body).toContain("const clampSource = clampedBy[subject.key] ?? subject.area;");
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

  test("an unresolvable entry falls back to a true fact, never a fabricated pickup", () => {
    // Three states, told apart: no current focus entries at all ("Nothing
    // open here yet"), entries with resolvable words ("You were on …"), and
    // entries that resolve to nothing.
    //
    // RETARGETED 2026-08-19, §13.8 — driven live: the third state used to
    // render `null`, which is not "an empty fact" on screen, it is an empty
    // BOX — the strip still shows its Resume/X chrome with no sentence
    // between them, indistinguishable from a rendering bug. The law this
    // test pins is narrower than "render nothing": never FABRICATE a pickup
    // sentence for an entry that didn't resolve. Falling back to
    // `sinceYourLook.digest` (a real, already-fetched fact about the same
    // subject) or, failing that, a plain admission that there's nothing more
    // to say, both honour that — neither invents what the human was doing.
    const flatRoom = flat("room.tsx");
    expect(flatRoom).toContain("Nothing open here yet.");
    expect(flatRoom).toContain("You were on {pickupWords.map");
    expect(code(room)).toMatch(
      /pickupWords\.length > 0 \? \([\s\S]*?\) : brief\.sinceYourLook\.digest\?\.\[0\] \? \([\s\S]*?\) : \(/,
    );
    // The fallback text is honest about having nothing more to say — it does
    // not compose a "You were on …" sentence for an entry that never resolved.
    expect(flatRoom).toContain("Picked up here — nothing more to say about it yet.");
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
    // And the helper's callers are pinned: the shared dot, the tray's swatch
    // control, and `subject-identity.tsx`'s own swatch row, the ONE shared
    // identity component the subject room's About tab mounts. RETARGETED
    // §13.8 (2026-08-19): the "Color ▸" context-menu submenu moved with the
    // rest of the tree from `warehouse-nav.tsx` into `lobby.tsx`'s own
    // `LobbyCard` — same swatches, same helper, a fourth caller rather than
    // a fifth.
    const callers = surfaces().filter((f) => code(f.source).includes("subjectColorVar("));
    expect(callers.map((f) => f.name).sort()).toEqual(["chips.tsx", "lobby.tsx", "subject-identity.tsx", "tray.tsx"]);
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

  test("the aperture slot is gone from the UI's side — no read, no follow, no PUT", () => {
    /**
     * RETARGETED FOR §13.6. Loops §8.1 had the chat's `spool_set_aperture`
     * and the hand's own clicks writing the SAME slot — a two-way wire. §13
     * cut the UI's write half, leaving the room FOLLOWING an external write
     * (`lastAppliedAperture`, the one-way wire). §13.6 amended the assistant
     * to have no screen-moving hand at all — the tool that ever wrote the
     * slot is off the wall — so this pass cuts the follow too: the room
     * belongs to the user's hand alone, and the agent answers in words.
     * There is nothing left in `stance.tsx` naming the aperture slot: no
     * GET, no PUT, no ref telling an external write apart from this
     * component's own, no effect reacting to one.
     */
    const stance = read("stance.tsx");
    const body = code(stance);
    expect(body).not.toContain("/api/spool/aperture");
    expect(body).not.toContain("lastAppliedAperture");
    expect(body).not.toContain("apertureView");
    expect(body).not.toContain("SpoolApertureView");
    expect(body).not.toContain("spool_set_aperture");
    // And the web-side proxy route this UI was the only caller of is gone
    // too — dead plumbing to a tool that no longer exists, not a door left
    // open for one.
    expect(
      fs.existsSync(path.join(dir, "..", "..", "app", "api", "spool", "aperture", "route.ts")),
    ).toBe(false);
  });

  test("subject focus covers the room untouched by any aperture machinery", () => {
    /**
     * The precedence §8.1 fixed, still true under §13.6: subject focus is
     * the DEEPER aperture — entering a subject's room writes nothing but the
     * focus log (`goSubject`'s POST), and leaving it again shows whatever
     * `room` was before. There is no slot left to touch either way.
     */
    const stance = read("stance.tsx");
    const body = code(stance);
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
  // REHOMED AGAIN (§13.8, 2026-08-19: the Warehouse dissolves): the card
  // moved from `tray.tsx`'s `PermitsFace`, through `warehouse.tsx`'s
  // `ConnectionsTab`, to the Assistant room's own foot in `master-chat.tsx`
  // — see that file's own file-level note on `McpConnectionsCard`. Moved,
  // not duplicated: the assertions below now pin the card's ONE remaining
  // home rather than weakening what they check.
  const chat = read("master-chat.tsx");

  test("the secret is masked by default, revealed only by the hand, and the caution is said", () => {
    const body = code(chat);
    // Masked by default — the reveal toggle starts false…
    expect(body).toContain("const [revealed, setRevealed] = useState(false)");
    // …and the mask covers the secret's spelling INSIDE the composed add
    // command too, or the mask would be theatre.
    expect(body).toContain('mcp.addCommand.replaceAll(mcp.secret, "••••••••")');
    // The caution, in the user's own words.
    expect(flat("master-chat.tsx")).toContain("treat it like a key");
    // The command is the ENGINE's composition — nothing here builds one.
    expect(body).not.toContain("claude mcp add");
  });

  test("the card no longer lives on the tray's permits face", () => {
    expect(code(read("tray.tsx"))).not.toContain('mcp.addCommand.replaceAll(mcp.secret, "••••••••")');
  });

  test("warehouse.tsx no longer exists — the room it belonged to is gone", () => {
    expect(fs.existsSync(path.join(dir, "warehouse.tsx"))).toBe(false);
  });
});

/**
 * THE ASSISTANT'S TWO DOORS — `docs/spool-loops.md` §13.6, added 2026-08-18.
 * Before this pass the stance rendered a RESIDENT `<aside>` carrying
 * `MasterChat` beside whatever the summoned tray happened to be showing —
 * three real columns (rail, main, chat) the moment a face was up, four once
 * the rail is counted. §13.6 retires the resident chat outright: there is now
 * ONE summoned overlay, holding ONE slot (conversation XOR a face), plus a
 * second, permanent door into the same conversation — the Assistant room,
 * reached from the rail, full-width. §13.2's "chat rides beside every room"
 * is superseded by this file; the tests below assert the shape that replaced
 * it, not the shape it names.
 */
describe("the assistant's two doors — §13.6", () => {
  test("there is no resident sidebar — the chat is summoned, or it is the whole room", () => {
    /**
     * The old shape had an UNCONDITIONAL `<aside>` wrapping `MasterChat`,
     * painted on every render regardless of what else was open. That element
     * is gone outright: `MasterChat` now appears only inside the summoned
     * layer's `layer.kind === "chat"` branch and inside the Assistant room's
     * own branch, both conditional on state, never a fixed column.
     */
    const stance = code(read("stance.tsx"));
    expect(stance).not.toContain("<aside");
    expect(stance).not.toContain("w-[26rem]");
  });

  test("the summoned layer holds ONE slot — conversation XOR a face, never both", () => {
    const stance = code(read("stance.tsx"));
    // The type itself states the exclusion.
    expect(stance).toContain('type SpoolLayer = { kind: "chat" } | { kind: "face"; face: TrayFace };');
    expect(stance).toContain("const [layer, setLayer] = useState<SpoolLayer | null>(");
    // One overlay renders the whole slot — a single conditional choosing
    // between the two shapes, not two elements that could both be present.
    expect(stance).toContain('layer.kind === "chat" ? (');
    // Only one `{layer && (` gate exists — a second summoned block would be
    // the four-column bug's other half.
    expect(stance.match(/\{layer && \(/g)?.length).toBe(1);
  });

  test("summoning a face and summoning the chat both go through the one slot", () => {
    const stance = code(read("stance.tsx"));
    // Every call site that used to open the tray now opens the layer's face
    // slot through the same helper — never a second, parallel `setTray`.
    expect(stance).toContain("const openFace = useCallback((face: TrayFace) => setLayer({ kind: \"face\", face }), []);");
    expect(stance).not.toContain("setTray(");
    expect(stance).not.toContain("useState<TrayFace | null>");
    // "Answer in chat" (a stance line's suggest verb) summons the chat slot.
    expect(stance).toContain('setLayer({ kind: "chat" });');
  });

  test("Assistant is the rail's fourth room, reached the same way every other one is", () => {
    const nav = code(read("warehouse-nav.tsx"));
    expect(nav).toContain('{ kind: "assistant" as const, label: "Assistant", icon: MessageCircleIcon, go: controls.goAssistant }');
    // Reuses the SAME active-state render loop and classes as Lobby/Today/
    // Scheduled — no new `--spool` mark spent on this entry.
    expect(nav).not.toMatch(/kind === "assistant"[^}]*text-spool/);
    const room = read("../../lib/spool-room.ts");
    expect(code(room)).toContain('goAssistant: () => void;');
  });

  test("⌘J means \"give me the assistant\" — three states, not a bare toggle", () => {
    /**
     * RETARGETED 2026-08-18 (driven, live): ⌘J while a FACE was up used to
     * close the layer outright — the two-state toggle didn't distinguish "a
     * face is open" from "the assistant is open". The fix is a named verb,
     * `toggleAssistant`, with three cases: closed → chat (open it), face →
     * chat (a face up is not the assistant answering — swap to the slot that
     * is), chat → closed (the assistant is already what you have; dismiss
     * it). ⌘J and the header button both drive this one function — the same
     * key never means two different things depending on which control fired
     * it.
     */
    const stance = code(read("stance.tsx"));
    expect(stance).toContain(
      'const toggleAssistant = useCallback(() => {\n    setLayer((current) => (current && current.kind === "chat" ? null : { kind: "chat" }));\n  }, []);',
    );
    // closed → chat: `current` is null, falls to the `: { kind: "chat" }` arm.
    // face → chat: `current.kind === "chat"` is false for a face, same arm.
    // chat → closed: `current.kind === "chat"` is true, the `null` arm fires.
    expect(stance).toContain('event.key.toLowerCase() === "j"');
    expect(stance).toContain("toggleAssistant();");
    expect(stance).toContain('if (event.key === "Escape" && layer) setLayer(null);');
    // The header button drives the exact same verb, not a second copy of it.
    expect(stance).toContain("onClick={toggleAssistant}");
  });

  test("the layer's expand control trades the overlay for the Assistant room", () => {
    // Both the chat slot and the face slot get an `onExpand` that navigates
    // via `goAssistant` (which sets `room`, never a route) and then closes
    // the layer — the room, not a second copy of the conversation, is what
    // is left open.
    const stance = code(read("stance.tsx"));
    const expands = stance.match(/onExpand=\{\(\) => \{\s*goAssistant\(\);\s*setLayer\(null\);\s*\}\}/g) ?? [];
    expect(expands.length).toBe(2);
    // `MasterChat` and `SpoolTray` both declare the prop they are handed.
    expect(code(read("master-chat.tsx"))).toContain("onExpand?: () => void;");
    expect(code(read("tray.tsx"))).toContain("onExpand?: () => void;");
  });

  test("the Assistant room renders the same MasterChat, full-width, with nothing to expand or close", () => {
    const stance = code(read("stance.tsx"));
    expect(stance).toContain('room.kind === "assistant" && (');
    // The room's own MasterChat is the one call site with neither prop set —
    // there is nowhere further to expand to and nothing hosting it to close.
    // It IS the one call site that asks for the reading-width layout — see
    // the next test for what `variant="room"` gets it.
    expect(stance).toContain(
      '<MasterChat onChanged={load} openers={openers} prefill={suggestion} context={viewContext} variant="room" />',
    );
  });

  test("the Assistant room's MasterChat gets the reading-width, bottom-anchored layout — the layer's slide-over does not", () => {
    /**
     * The user's own screenshot of the built room: messages pinned to the
     * top, a huge empty void, chips and composer floating at the bottom. A
     * full-width room is not the layer's narrow strip — setting prose in a
     * line as wide as the screen and leaving a short exchange stranded at
     * the top was the bug. `variant="room"` parameterizes the ONE `MasterChat`
     * rather than forking a second chat component: the reading column reuses
     * the app's own `max-w-3xl` token (`Stance`, `Lobby` and `SubjectRoom`
     * already center on it), and the transcript's content wrapper floors to
     * the viewport's height and packs its children to the bottom, so a short
     * conversation ends just above the composer instead of at the top of a
     * void. The layer's slide-over keeps its original top-anchored,
     * full-bleed shape — `variant` defaults to `"layer"`, and nothing at
     * either of the layer's two call sites passes it.
     */
    const chat = code(read("master-chat.tsx"));
    expect(chat).toContain('variant = "layer"');
    expect(chat).toContain('variant === "room" && "mx-auto w-full max-w-3xl"');
    expect(chat).toContain('variant === "room" && "min-h-full justify-end"');
    const stance = code(read("stance.tsx"));
    // The layer's two MasterChat mounts (the chat slot, and nowhere else)
    // never pass `variant` — they keep the narrow, top-anchored shape.
    const layerChat = stance.slice(stance.indexOf("layer.kind === \"chat\""), stance.indexOf("SpoolTray"));
    expect(layerChat).not.toContain("variant=");
  });

  test("the room-stamp mechanism survives — every turn still carries `[room: …]`, read from the CURRENT room", () => {
    /**
     * The layer's chat slot and the Assistant room render the exact same
     * `MasterChat` with the exact same `context={viewContext}` — one
     * derivation, so a message sent from either place is stamped with
     * whatever room is open at the moment of sending, never a room frozen at
     * summon time.
     */
    const stance = code(read("stance.tsx"));
    // RETARGETED §13.8 (2026-08-19): an area page's own label folds in —
    // `roomLabel` still resolves to one string per open room, just a
    // three-way ternary now instead of two.
    expect(stance).toContain(
      'const roomLabel = room.kind === "subject" ? room.key : room.kind === "area" ? `area:${room.path}` : room.kind;',
    );
    expect(stance).toContain("const viewContext = `[room: room=${roomLabel}");
    const chat = code(read("master-chat.tsx"));
    expect(chat).toContain("const ROOM_PREFIX = /^\\[room: [^\\n]*\\]\\n/;");
  });
});

/**
 * ONE SEARCH FIELD, TWO RAILS, AND A HAND VERB IN THE TREE — the web pass
 * (2026-08-18) that put Telar's own sidebar and the Spool's rail through the
 * same chrome, and gave the rail's Areas tree a drag: a subject dropped on
 * an area header files it there, dropped on the unfiled strip clears it,
 * both through the identity route `tray.tsx`'s swatch already writes.
 */
describe("the sidebar's search field is one component, shared, not two copies of the same chrome", () => {
  test("Telar's sidebar and the Spool's rail both import the shared field, not their own Input+icon", () => {
    const app = code(read("../app-sidebar.tsx"));
    const search = code(read("search.tsx"));
    expect(app).toContain('import { SidebarSearchField } from "@/components/sidebar-search-field";');
    expect(search).toContain('import { SidebarSearchField } from "@/components/sidebar-search-field";');
    // Neither rail hand-rolls the icon+Input pair the shared field now owns.
    expect(app).not.toMatch(/<SearchIcon[^>]*\/>\s*<Input/);
    expect(search).not.toContain("<Input");
  });

  test("the field's own file carries no bound key — each caller's binding stays its own", () => {
    // The primitive itself must not wire ⌘K (or any key) — Telar's ⌘K stays
    // Telar's own `useCommandKeys` call, and the Spool's field keeps opening
    // on focus/typing, never a shared keybinding smuggled into the shared
    // chrome.
    const field = code(read("../sidebar-search-field.tsx"));
    expect(field).not.toMatch(/onKeyDown|useCommandKeys|metaKey|ctrlKey/);
  });

  test("only Telar's sidebar still carries the ⌘K binding; the Spool's field opens on focus, not a key", () => {
    const app = read("../app-sidebar.tsx");
    expect(app).toContain("useCommandKeys");
    const search = code(read("search.tsx"));
    expect(search).not.toMatch(/useCommandKeys|metaKey.*key.*k|key === "k"/i);
    expect(search).toContain("onFocus={() => setOpen(true)}");
  });

  test("the Spool's section caption and Telar's now share one scale — CAPTION, not two type ramps", () => {
    // `warehouse-nav.tsx`'s CAPTION was the newer standard named in the
    // brief; `app-sidebar.tsx`'s BandRule now renders its label at the same
    // scale, rather than the sentence-case 11px it used before this pass.
    const nav = read("warehouse-nav.tsx");
    const app = read("../app-sidebar.tsx");
    const captionScale = "text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/45";
    expect(nav).toContain(`const CAPTION = "${captionScale}"`);
    expect(app).toContain(`const CAPTION = "${captionScale}"`);
  });
});

describe("a subject is filed by dropping it — the rail's own drag, §Part 2 of the shared-chrome pass", () => {
  // RETARGETED §13.8 (2026-08-19): every symbol this block pins moved from
  // the rail into `lobby.tsx` — "the map is content, not chrome."
  test("a subject in the tree is draggable, wearing the app's one native HTML5 idiom — no library, no second grammar", () => {
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain("draggable");
    // `onSubjectDragStart` is now a curried factory (`onSubjectDragStart(subject)`
    // handed to `LobbyCard`), so the payload is set against its own `subject`
    // parameter, not a rail-scoped `line.subject`.
    expect(nav).toContain('event.dataTransfer.setData(DRAG_TYPE, subject)');
    expect(nav).toContain('event.dataTransfer.effectAllowed = "move"');
    // The payload's own type key is named distinctly from the board's, so a
    // stray drop from one surface can never be misread as the other's.
    expect(nav).toContain('const DRAG_TYPE = "application/x-spool-subject"');
    const board = code(read("board.tsx"));
    expect(board).toContain('const DRAG_TYPE = "application/x-spool-item"');
  });

  test("every node in the tree is a drop target that assigns its own path, and the ghost node clears it — both call the one PATCH", () => {
    /**
     * RETARGETED §13.7 (2026-08-18), then §13.8 (2026-08-19): "an area's own
     * header" (one flat level) became "any node in the tree" — a drop on
     * "Work" files `area: "Work"`, a drop on the nested "Focaltec" beneath
     * it files `area: "Work / Focaltec"`. The old always-present "unfiled
     * strip" is now the SAME ghost node every un-areaed subject already
     * renders under — it clears to `null` the same way, and it is still
     * reachable by hand even when it currently holds nothing (see the next
     * test). §13.8 moved the whole tree from the rail into `lobby.tsx`.
     */
    const nav = code(read("lobby.tsx"));
    // Every node carries the same drop handlers, keyed to its own path.
    expect(nav).toContain("{...nodeDropProps(node)}");
    expect(nav).toContain("assignArea(subject, node.ghost ? null : node.key);");
  });

  test("the drop PATCHes the exact route the swatch control already writes — no second identity-write path", () => {
    // Same URL pattern, same body shape (`{ area }`) as `tray.tsx`'s
    // `patchIdentity` — a second CALLER of the route that exists, never a
    // second route or a shared fetch helper that would erase `tray.tsx`'s
    // own pinned literals (see "the swatch control PATCHes the subject
    // record" above).
    const nav = code(read("lobby.tsx"));
    expect(nav).toMatch(/fetch\(`\/api\/spool\/subjects\/\$\{encodeURIComponent\(subject\)\}`,\s*\{\s*method: "PATCH"/);
    expect(nav).toContain("body: JSON.stringify({ area })");
    const tray = code(read("tray.tsx"));
    expect(tray).toContain("/api/spool/subjects/");
    // The lobby holds no copy of `SpoolSubjectIdentity`'s own write function —
    // it calls `fetch` directly against the same route, same as it always
    // has for every other write this file makes.
    expect(nav).not.toContain("import { patchIdentity");
  });

  test("a landed drop still asks the room to reload — the reconciliation path, now trailing the paint rather than gating it", () => {
    /**
     * RETARGETED §13.8 (2026-08-19): the rail was a SIBLING of `SpoolStance`
     * reading/writing through the published `lib/spool-room.ts` store, so a
     * landed drop called `controls.refresh()`. `lobby.tsx` is now a mounted
     * CHILD of `SpoolStance` instead (`stance.tsx` renders `<Lobby
     * onChanged={load} .../>`), so the same reconciliation is its own local
     * `load()` (this file's own `GET /api/spool/lobby` read) plus the
     * `onChanged` callback prop that tells `SpoolStance` to reload too — two
     * calls, not `controls.refresh()`, because this surface is no longer
     * reached from outside `SpoolStance`'s own tree.
     */
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain("void load();");
    expect(nav).toContain("onChanged?.();");
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("<Lobby");
    expect(stance).toContain("onChanged={load}");
  });

  test("the drop paints instantly through a local overlay, retired once the published snapshot agrees with it", () => {
    // The overlay is `pendingAreas`, keyed by subject, applied over the
    // lobby's own read BEFORE the tree is built — so `effectiveLines`/`tree`
    // reflect the drop on the very next render, not after any fetch
    // resolves.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain("const [pendingAreas, setPendingAreas] = useState<Map<string, string | null>>(new Map());");
    expect(nav).toContain("setPendingAreas((prev) => new Map(prev).set(subject, area));");
    // RETARGETED §13.8: keyed by `SpoolLobbySubject.key`, the lobby's own
    // identity field, not the rail's `SpoolRoomAreaLine.subject`.
    expect(nav).toContain(
      "pendingAreas.has(line.key) ? { ...line, area: pendingAreas.get(line.key) ?? undefined } : line",
    );
    // RETARGETED §13.7: `groupLinesByArea` (flat) is `buildAreaTree` (nested
    // paths) now — same law, `effectiveLines` feeds it before anything
    // renders.
    expect(nav).toContain("buildAreaTree<SpoolLobbySubject>(effectiveLines");
    // The overlay is retired by diffing it against the PUBLISHED lobby read —
    // not against the PATCH's own response — so a slow reload never leaves the
    // paint hanging past its own confirmation.
    //
    // RETARGETED (React compiler): this pinned an effect on `[lobby]`, which
    // is a setState called synchronously from an effect and now a lint error.
    // The law is unchanged and the pattern still asserts the whole of it —
    // retirement happens against the snapshot `load` just published, keyed on
    // that snapshot AGREEING with the overlay — it simply no longer requires
    // the extra render pass an effect would cost.
    expect(nav).toMatch(
      /const published = \(await lobbyRes\.json\(\)\)\.lobby as SpoolLobby;[\s\S]*?setPendingAreas\(\(prev\) => \{[\s\S]*?\(line\.area \?\? null\) === area/,
    );
  });

  test("a refused drop reverts its own overlay entry and renders the engine's sentence in place — no red, the room's own quiet inline idiom", () => {
    const nav = code(read("lobby.tsx"));
    // Revert: the overlay entry this request itself set is deleted on
    // failure, so the tree falls back to whatever the store still says.
    expect(nav).toMatch(/\.catch\(\(err\) => \{[\s\S]*?next\.delete\(subject\)[\s\S]*?setRefused\(err instanceof Error \? err\.message : String\(err\)\)/);
    expect(nav).toMatch(/\{refused &&/);
    // The quiet-colour law, restated for this new surface: no status colour
    // spent on the refusal or the drag highlight either.
    expect(nav).not.toMatch(/text-(destructive|warning|success)|bg-(destructive|warning|success)/);
  });

  test("rapid successive drags of the same subject don't fight — a per-subject sequence lets only the last request touch that subject's overlay or error", () => {
    // `requestSeq` is a ref, not state (a counter racing its own render is
    // not a value the tree paints), and every touch of `pendingAreas` or
    // `refused` inside the request's callbacks is gated on `isLatest()` —
    // a stale request superseded by a newer drop of the SAME subject can
    // neither revert the newer drop's optimistic entry nor show its own,
    // now-irrelevant error over it.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain("const requestSeq = useRef<Map<string, number>>(new Map());");
    expect(nav).toContain("const seq = (requestSeq.current.get(subject) ?? 0) + 1;");
    expect(nav).toContain("requestSeq.current.set(subject, seq);");
    expect(nav).toContain("const isLatest = () => requestSeq.current.get(subject) === seq;");
    expect(nav).toContain("if (!isLatest()) return;");
    expect(nav).toContain("if (isLatest()) setRefused(null);");
  });

  test("the drag highlight spends only existing hover/accent tokens — no new colour for this pass", () => {
    // RETARGETED §13.7, then §13.8 (2026-08-19): the highlight keys on the
    // node's own joined path (`node.key`) the same way, but `lobby.tsx`
    // spends the content pane's own `bg-muted/60` token, not the rail's
    // `sidebar-accent` pair — there is no sidebar surface to match any more.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain('dragOver === node.key && "bg-muted/60"');
    expect(nav).not.toMatch(/--spool/);
  });
});

/**
 * RECEIVING MODE, A NEW-AREA ZONE, AND REORDER — §Part 2's own live-use
 * follow-up, 2026-08-18. Three asks: the drop zones must not exist at rest,
 * a new area can be created by dropping onto a naming zone rather than
 * needing one to already exist, and a subject can be dragged to a specific
 * place inside (or across) an area rather than only into it.
 */
describe("the rail's drop zones exist only while a drag is live", () => {
  // RETARGETED §13.8 (2026-08-19): the drop zones moved with the rest of
  // the tree into `lobby.tsx`; the describe block's own title is kept as
  // the historical name of the law, not the surface it now lives on.
  const nav = code(read("lobby.tsx"));

  test("`dragActive` is nothing but `dragging !== null`, and the new-area zone is gated on it — the ghost node's own ephemeral appearance carries the old clear-strip's law", () => {
    /**
     * RETARGETED §13.7 (2026-08-18): the old always-during-a-drag "unfiled
     * strip" is now the SAME ghost node every un-areaed subject renders
     * under. `LobbyNode` folds the old gate INTO that one node: it renders
     * unconditionally once it holds real subjects (never floating), and
     * ALSO — with no lines of its own — for as long as `dragActive`, so
     * clearing stays reachable by hand even when nothing is unfiled yet.
     */
    expect(nav).toContain("const dragActive = dragging !== null;");
    expect(nav).toContain("if (node.ghost && !showGhostAtRest && !dragActive) return null;");
    expect(nav).toContain("(dragActive || newAreaDraft) &&");
  });

  test("a node wears the same quiet dashed affordance for as long as a drag is live, not only once hovered", () => {
    // The hover highlight (`dragOver === node.key`) already existed; what
    // is new is a SECOND, mode-wide affordance that does not wait for the
    // pointer to arrive. RETARGETED §13.8: `lobby.tsx` spends `border-border/60`
    // (the content pane's own token, not the rail's `sidebar-border`). The
    // border itself is UNCONDITIONAL — only its colour toggles with
    // `dragActive`, so a node's box never changes size.
    expect(nav).toContain("dragActive ? \"border-border/60\" : \"border-transparent\"");
    expect(nav).toContain("border border-dashed px-2 py-1");
  });

  test("no new colour rides in on receiving mode — the quiet-colour law holds for it too", () => {
    expect(nav).not.toMatch(/text-(destructive|warning|success)|bg-(destructive|warning|success)/);
    expect(nav).not.toMatch(/--spool/);
  });
});

describe("dropping on the new-area zone names an area by hand, rather than requiring one to already exist", () => {
  // RETARGETED §13.8 (2026-08-19): moved into `lobby.tsx` with the rest of
  // the tree.
  const nav = code(read("lobby.tsx"));

  test("the zone's own drop opens an inline draft — it does not PATCH by itself", () => {
    const dropSite = nav.slice(nav.indexOf("const newAreaDropProps"), nav.indexOf("const onSubjectDragStart"));
    expect(dropSite).not.toContain("fetch(");
    expect(dropSite).toContain("setNewAreaDraft({ subject, name: \"\" })");
  });

  test("the draft is an autofocused input, and Enter files the subject through the SAME assignArea every other target calls", () => {
    const nav2 = read("lobby.tsx");
    const input = nav2.slice(nav2.indexOf("newAreaDraft ? (") , nav2.indexOf("Drop to start a new area"));
    expect(input).toContain("autoFocus");
    expect(input).toContain('if (event.key === "Enter")');
    expect(input).toContain("assignArea(newAreaDraft.subject, name)");
    // No second identity-write path opened for naming an area — it is still
    // just a subject's own stored `area` word, same PATCH, same route.
    expect(code(input)).not.toMatch(/fetch\(/);
  });

  test("Escape and losing focus both discard the draft, reverting to nothing having happened", () => {
    // RETARGETED §13.8: `lobby.tsx`'s own indentation (two levels deeper
    // than the rail's flat render was) shifts this pin's whitespace.
    const nav2 = read("lobby.tsx");
    const input = nav2.slice(nav2.indexOf("newAreaDraft ? ("), nav2.indexOf("Drop to start a new area"));
    expect(input).toContain('if (event.key === "Escape") {\n                  setNewAreaDraft(null);');
    expect(input).toContain("onBlur={() => setNewAreaDraft(null)}");
  });

  test("the zone's resting label says what dropping there does, in the same quiet dashed idiom as the clear strip", () => {
    // RETARGETED §13.8: `lobby.tsx` spends the content pane's own
    // `--spool` accent (the same accent `LobbyCard`'s insertion indicator
    // uses) rather than the rail's `sidebar-accent` triple.
    expect(nav).toContain("Drop to start a new area");
    expect(nav).toMatch(/dragOver === "__new-area" && "border-spool\/60 bg-muted\/60 text-foreground"/);
  });
});

describe("a subject can be dragged to a position — inside an area, or into another one", () => {
  // RETARGETED §13.8 (2026-08-19): the tree and its drag machinery moved
  // from the rail into the lobby's own content pane — "the map is content,
  // not chrome." `lobby.tsx` now owns every symbol this block pins.
  const nav = code(read("lobby.tsx"));

  test("a subject row is itself a drop target, and the half the pointer sits over decides above vs below", () => {
    /**
     * RETARGETED §13.8 (2026-08-19): the row now lives in `lobby.tsx`'s own
     * `LobbyCard`/`onRowDragOver`, keyed by `SpoolLobbySubject.key` rather
     * than the rail's `SpoolRoomAreaLine.subject` — same guarantee, the
     * field the join carries it on changed with the surface.
     */
    expect(nav).toContain("if (dragging === line.key) return;");
    expect(nav).toContain('event.clientY < rect.top + rect.height / 2 ? "above" : "below"');
    expect(nav).toContain("reorderSubject(subject, line, position)");
  });

  test("the insertion indicator spends existing border tokens only, above XOR below, never both", () => {
    // RETARGETED §13.8 (2026-08-19): the indicator lives on `LobbyCard`'s
    // own `insertPosition` prop, not a rail-scoped `rowInsert.position`, and
    // spends the Spool's own `--spool` accent rather than the rail's
    // `sidebar-accent` token — still one border, above XOR below, never both.
    expect(nav).toContain('insertPosition === "above" && "border-t-2 border-spool/60"');
    expect(nav).toContain('insertPosition === "below" && "border-b-2 border-spool/60"');
    expect(nav).not.toMatch(/text-(destructive|warning|success)|bg-(destructive|warning|success)/);
  });

  test("the reorder scheme reassigns 0..n-1 across the target area's subjects, PATCHing only the ones that moved", () => {
    const fn = nav.slice(nav.indexOf("const reorderSubject ="), nav.indexOf("const renameAreaPrefix ="));
    expect(fn).toContain("sortByRank(effectiveLines.filter((l) => (l.area ?? null) === targetArea && l.key !== subject))");
    expect(fn).toContain("ordered.forEach((line, rank) => {");
    // A subject whose computed rank did not change, and did not just cross
    // areas, is skipped — bounded writes, not a rewrite of the whole list.
    expect(fn).toContain("if (line.rank === rank && !(line.key === subject && crossedArea)) return;");
  });

  test("a cross-area drop onto a row PATCHes area and rank together for the moved subject, and rank alone for everyone else it displaced", () => {
    const patch = nav.slice(nav.indexOf("const patchRank ="), nav.indexOf("const reorderSubject ="));
    expect(patch).toContain("body: JSON.stringify(area !== undefined ? { area, rank } : { rank })");
    // `assignArea`'s own pinned body is untouched by this — a second call
    // site, never a rewrite of the first.
    expect(nav).toContain("body: JSON.stringify({ area })");
  });

  test("the reorder overlay is the SAME seq-guarded, last-drop-wins shape as the area overlay, with its own map", () => {
    expect(nav).toContain("const [pendingRanks, setPendingRanks] = useState<Map<string, number>>(new Map());");
    const patch = nav.slice(nav.indexOf("const patchRank ="), nav.indexOf("const reorderSubject ="));
    expect(patch).toContain("const seq = (requestSeq.current.get(subject) ?? 0) + 1;");
    expect(patch).toContain("if (!isLatest()) return;");
    expect(patch).toMatch(/setPendingRanks\(\(prev\) => \{\s*const next = new Map\(prev\);\s*next\.delete\(subject\);/);
    expect(patch).toContain("setRefused(err instanceof Error ? err.message : String(err));");
  });

  test("the rank overlay is retired the same way the area overlay is — a diff against the published lobby snapshot", () => {
    // RETARGETED §13.8 (2026-08-19): the lobby holds no separate `room.areas`
    // join — it diffs straight against its own `lobby` state (the raw
    // `GET /api/spool/lobby` read), the same overlay-vs-published law with
    // one fewer layer of indirection.
    // RETARGETED (React compiler), the same move the area overlay's own test
    // documents: retired inside `load` against the snapshot it just published,
    // rather than by an effect firing on `[lobby]` afterwards.
    expect(nav).toMatch(
      /const published = \(await lobbyRes\.json\(\)\)\.lobby as SpoolLobby;[\s\S]*?setPendingRanks\(\(prev\) => \{[\s\S]*?line\.rank === rank/,
    );
    // Both overlays are folded into the SAME `effectiveLines`, one pass, so
    // the grouping below never has to know two overlays exist.
    expect(nav).toContain("pendingRanks.has(line.key) ? { ...withArea, rank: pendingRanks.get(line.key) } : withArea");
  });

  test("within a node, rank-ascending and unranked trailing — one shared sort, not a render-site filter", () => {
    // RETARGETED §13.8 (2026-08-19): `sortByRank` now sorts
    // `SpoolLobbySubject[]` (the lobby's own join, which already carries
    // rank) rather than the rail's `SpoolRoomAreaLine[]` — `LobbyNode`
    // applies it once, per node, the same way `renderNode` used to.
    // RETARGETED AGAIN §13.8 (2026-08-19, folded-is-unreachable fix): the
    // `!entry.folded` filter this test used to pin dropped folded subjects
    // off the map entirely — the very bug this pass fixes. `sortByRank` now
    // runs over the WHOLE node, never pre-filtered.
    expect(nav).toContain("function sortByRank(lines: SpoolLobbySubject[]): SpoolLobbySubject[] {");
    expect(nav).toContain("const entries = sortByRank(node.lines);");
  });
});

describe("rank rides the wire beside area and colour — joined once, published once", () => {
  test("`SpoolRoomAreaLine` carries an optional `rank`, the rail's own shape for the room's identity join", () => {
    const room = code(read("../../lib/spool-room.ts"));
    expect(room).toContain("rank?: number;");
  });

  test("`stance.tsx` joins rank from the subject record and republishes it on the same snapshot as area and colour", () => {
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("...(subjectRank(record) !== undefined ? { rank: subjectRank(record) } : {})");
    expect(stance).toContain("...(line.rank !== undefined ? { rank: line.rank } : {})");
  });
});

/**
 * A ROW'S DROP ALWAYS WINS OVER THE REGION BENEATH IT — the live-drive
 * follow-up, 2026-08-18. Driven evidence: dropping on a subject row's own
 * top edge produced the AREA-only PATCH (`{"area":"Trabajo"}`, no rank) —
 * the header's write, not the row's. Root cause: the header's receiving-mode
 * outline used to be conditionally rendered, so turning a drag ON grew the
 * header's box by a border's width and shoved every row beneath it down —
 * a drop aimed at a row's own top edge, computed a beat earlier, could land
 * on the header that just grew underneath it. These pins hold the fix: the
 * header's border is now unconditional (colour-only toggle, no box-size
 * change), and a row's own drag handlers additionally call
 * `stopPropagation()` as a second, independent guarantee.
 */
describe("a row's drop always wins over the region beneath it — the live-drive fix", () => {
  // RETARGETED §13.8 (2026-08-19): this machinery moved from the rail into
  // `lobby.tsx` wholesale — same fix, same pinned mechanism, new home.
  const nav = code(read("lobby.tsx"));

  test("the header's receiving-mode border is unconditional — only its colour changes, never its width", () => {
    // A conditionally-added border changes box height the instant a drag
    // starts, shoving every row below it — the actual mechanism behind the
    // driven bug. The border must always be present; only the colour toggles.
    // RETARGETED §13.8: the lobby's own container row spends `border-border/60`
    // (not the rail's `sidebar-border` token), unconditional the same way.
    expect(nav).not.toMatch(/dragActive && "border border-dashed border-border\/60"/);
    expect(nav).toContain('dragActive ? "border-border/60" : "border-transparent"');
  });

  test("a subject row's own drag-over and drop both stop propagation, so a row's drop can never be reread as a drop on whatever encloses it", () => {
    /**
     * RETARGETED §13.8 (2026-08-19): `LobbyCard`'s own drag handlers are
     * bare prop references (`onDragOver={onRowDragOver}`); the propagation
     * guard lives in the curried `onRowDragOver`/`onRowDrop` factories
     * `Lobby` builds once and hands down — bounded by those functions' own
     * names rather than a line's inline drag-start payload.
     */
    const dragOverSite = nav.slice(nav.indexOf("const onRowDragOver ="), nav.indexOf("const onRowDragLeave ="));
    const dropSite = nav.slice(nav.indexOf("const onRowDrop ="), nav.indexOf("const containerDragStart ="));
    expect(dragOverSite).toContain("event.stopPropagation();");
    expect(dropSite).toContain("event.stopPropagation();");
    // Every node's own drop target — not only a subject row's — stops
    // propagation, so the DEEPEST target under the pointer always wins.
    const nodeDrop = nav.slice(nav.indexOf("const nodeDropProps ="), nav.indexOf("const newAreaDropProps ="));
    expect(nodeDrop).toContain("event.stopPropagation();");
  });

  test("no new colour rides in on the fix — the quiet-colour law holds", () => {
    expect(nav).not.toMatch(/text-(destructive|warning|success)|bg-(destructive|warning|success)/);
    expect(nav).not.toMatch(/--spool/);
  });
});

/**
 * THE PROXY'S IDENTITY ARM LEARNS `rank` — the SECOND live-drive follow-up,
 * 2026-08-18. The row-drop fix above made the rail send correct rank-only
 * PATCHes (`{"rank":0}`), but `app/api/spool/subjects/[key]/route.ts`
 * predates rank: its identity arm only triggered on `"area" in body ||
 * "color" in body`, so a rank-only body fell through to the `permits` arm
 * and was refused with THAT arm's error. `rank` now joins the identity arm
 * on equal footing with `area`/`color` — same guarded-then-forwarded shape,
 * same `null`-clears convention, forwarded through the identity verb the
 * engine-client method already accepts `rank` on.
 */
describe("the identity route's PATCH learns rank, the same way it already knows area and color", () => {
  const route = fs.readFileSync(
    path.join(dir, "..", "..", "app", "api", "spool", "subjects", "[key]", "route.ts"),
    "utf8",
  );

  test("a rank-only body takes the identity arm, not the permits arm", () => {
    expect(route).toContain('if ("area" in body || "color" in body || "rank" in body) {');
  });

  test("rank is guarded in the route's own style — a finite number >= 0, or null to clear — before it reaches the engine", () => {
    expect(route).toContain(
      "if (rank !== undefined && rank !== null && !(typeof rank === \"number\" && Number.isFinite(rank) && rank >= 0)) {",
    );
    expect(route).toMatch(/rank must be a finite number >= 0, or null — got \$\{JSON\.stringify\(rank\)\}\./);
  });

  test("rank forwards through the same identity verb area and color already use, never a second route or a second call", () => {
    expect(route).toContain('...("rank" in body ? { rank: rank as number | null } : {})');
    expect((route.match(/setSpoolSubjectIdentity/g) ?? []).length).toBe(1);
  });

  test("the route's doc comment names rank as a THIRD identity field, dated to the reorder pass", () => {
    expect(route).toMatch(/`area`, `color`, and[\s\S]*?`rank`/);
    expect(route).toContain("2026-08-18");
  });
});

/**
 * DEPTH IS FOR NAMES, NEVER FOR WORK — `docs/spool-loops.md` §13.7,
 * 2026-08-18. Two problems fixed as one pass: the tree's containers used to
 * render LIGHTER than the rows they held (a 10px muted caption above
 * full-weight subject rows), and an area was one flat word, so "Work /
 * Focaltec" filed two subjects under two unrelated top-level captions rather
 * than one nested inside the other. §13.7 makes an area's name a PATH
 * (still ONE stored string per subject — `lib/spool-area-tree.ts` is pure
 * rendering over it, unit-tested directly in `lib/spool-area-tree.test.ts`)
 * and makes every path segment a real container: a chevron, a collapse
 * state, a weight that never drops below its own contents', and a rollup
 * computed from what sits beneath it. `lobby.tsx` builds this tree now —
 * §13.8 (2026-08-19) moved it wholesale out of `warehouse-nav.tsx`.
 */
describe("the tree is containers all the way down, never a caption above a list — §13.7", () => {
  // RETARGETED §13.8 (2026-08-19): the tree moved into `lobby.tsx`.
  const nav = code(read("lobby.tsx"));

  test("the Areas caption is gone — no SidebarGroupLabel wears it any more", () => {
    expect(nav).not.toContain("SidebarGroupLabel");
    expect(nav).not.toContain(">Areas<");
  });

  test("a container's weight/size descends with depth but never drops below a subject row's own", () => {
    // Subject rows render at `text-sm`, `font-normal` at rest (`font-medium`
    // only once active). Every container depth stays at `font-medium` or
    // heavier, so a container can never read as lighter than its contents,
    // however deep the path runs.
    expect(nav).toContain("function containerTextClass(depth: number, ghost: boolean): string {");
    expect(nav).toMatch(/depth === 0 && "font-semibold/);
    expect(nav).toMatch(/depth >= 2 && "font-medium/);
    expect(nav).not.toMatch(/font-normal.*depth|depth.*font-normal/);
  });

  test("every node carries a disclosure chevron that rotates with its own collapse state", () => {
    expect(nav).toContain("<ChevronRightIcon");
    expect(nav).toContain("!collapsed && \"rotate-90\"");
    expect(nav).toContain("const collapsed = !node.ghost && isCollapsed(node.key);");
  });

  test("a container's rollup is computed, never stored — subject count and the needs-you total, from what sits beneath it", () => {
    // RETARGETED §13.8: `lobby.tsx` rolls up `SpoolLobbySubject.needsYou`,
    // not the rail's `SpoolRoomAreaLine.needs` — same computed-never-stored
    // law, the field the lobby's own join carries it on.
    expect(nav).toContain("const rollup = rollupCount(node, (entry) => entry.needsYou);");
    expect(nav).toMatch(/\{rollup\.subjects\}/);
    expect(nav).toMatch(/rollup\.needs > 0/);
  });
});

describe("collapse is a UI preference keyed by path, not a fact the store owns — §13.7", () => {
  const collapse = code(read("../../lib/spool-area-collapse.ts"));

  test("keyed in localStorage by the node's own joined path, so nested nodes fold independently", () => {
    expect(collapse).toContain('const KEY_PREFIX = "telar:spool-area-collapsed:"');
  });

  test("read outside render, never seeded synchronously — the same hydration law every other localStorage preference in this app follows", () => {
    /**
     * RETARGETED (React compiler): the shape was `useState(new Set())` plus a
     * mount effect that called `setCollapsed` once `localStorage` had been
     * scanned — a setState called synchronously from an effect, and a second
     * render pass on every mount. `useSyncExternalStore` is the hook built for
     * a value that lives outside React, and the LAW this test exists to pin is
     * strictly better served by it: the third argument IS the server snapshot,
     * so "never seeded synchronously" is now enforced by the hook's own
     * signature rather than by our remembering to defer the read.
     */
    expect(collapse).toContain("useSyncExternalStore(subscribe, snapshot, () => EMPTY)");
    expect(collapse).toMatch(/function snapshot\(\)[\s\S]*?window\.localStorage/);
    // The seeding this test forbids, spelled out: no render-time read of the
    // store into component state, by any route.
    expect(collapse).not.toContain("useState");
  });

  test("only the lobby imports the hook now — the rail retired its own tree, §13.8", () => {
    /**
     * RETARGETED §13.8 (2026-08-19): this used to pin BOTH the rail and the
     * lobby importing the same hook — "one collapse grammar, not two." The
     * rail no longer has a tree to collapse, so it dropped the import
     * outright rather than keep a dead one; the lobby is now the ONLY
     * caller, which is still one collapse grammar, just one fewer surface.
     */
    const nav = read("warehouse-nav.tsx");
    const lobby = read("lobby.tsx");
    expect(nav).not.toContain('import { useAreaCollapse } from "@/lib/spool-area-collapse";');
    expect(lobby).toContain('import { useAreaCollapse } from "@/lib/spool-area-collapse";');
  });
});

describe("an area's name is a path, split the engine's own way — §13.7", () => {
  test("the lobby builds its tree from `buildAreaTree`, the one tree-builder — §13.8 retired the rail's own copy of this import", () => {
    // RETARGETED §13.8 (2026-08-19): the rail no longer imports
    // `lib/spool-area-tree.ts` at all — its tree, and every gesture built on
    // it, moved into `lobby.tsx` wholesale. `lobby.tsx` now imports the
    // FULL set the rail used to (plus `findAreaNode`, newly put to use for
    // the area page's own subtree scoping — §13.8).
    const nav = code(read("warehouse-nav.tsx"));
    const lobby = code(read("lobby.tsx"));
    expect(nav).not.toContain('from "@/lib/spool-area-tree"');
    expect(lobby).toContain(
      'import {\n  type AreaTreeNode,\n  buildAreaTree,\n  findAreaNode,\n  pathIsPrefixOf,\n  renameAreaPrefixAcrossSubjects,\n  renamePathPrefix,\n  rollupCount,\n  splitAreaPath,\n} from "@/lib/spool-area-tree";',
    );
  });

  // The splitting rule itself, and the segment-boundary law ("Work" must
  // never match "Workshop"), are asserted directly as unit tests against the
  // real functions in `lib/spool-area-tree.test.ts` — a source-text pin
  // would only restate what that file already proves by calling the code.
});

describe("a drop on any node in the tree files at that node's own full path — §13.7", () => {
  // RETARGETED §13.8 (2026-08-19): moved into `lobby.tsx`.
  const nav = code(read("lobby.tsx"));

  test("dropping on a nested node's own key files the subject at the whole path, not just its last segment", () => {
    // `node.key` IS the joined path (`lib/spool-area-tree.ts`'s own
    // `AreaTreeNode.key`) — a drop on the "Focaltec" node nested under
    // "Work" hands `assignArea` the string "Work / Focaltec", never "Focaltec"
    // alone.
    expect(nav).toContain("assignArea(subject, node.ghost ? null : node.key);");
  });

  test("the new-area zone accepts a typed path verbatim — \"Work / Focaltec\" typed there names a nested area", () => {
    expect(nav).toContain("assignArea(newAreaDraft.subject, name)");
    // No splitting or validation happens before the write — the typed
    // string rides straight through, same as any other stored area word.
    const draftSite = nav.slice(nav.indexOf("newAreaDraft ? ("), nav.indexOf("Drop to start a new area"));
    expect(draftSite).not.toMatch(/splitAreaPath|pathIsPrefixOf/);
  });
});

describe("a container is also draggable, and dropping one onto another renames a prefix — §13.7", () => {
  // RETARGETED §13.8 (2026-08-19): moved into `lobby.tsx`. `lobby.tsx` has
  // no standalone `renderNode` function the way the rail did — the
  // recursive render IS the `LobbyNode` component — so slice boundaries
  // below anchor on the functions actually declared next to `renameAreaPrefix`
  // in this file (`submitRenameContainer`, `setSubjectColor`, `nodeDropProps`)
  // rather than a `renderNode` that does not exist here.
  const nav = code(read("lobby.tsx"));

  test("a container's own drag payload is named distinctly from a subject's, so a stray drop is never misread", () => {
    expect(nav).toContain('const DRAG_TYPE_AREA = "application/x-spool-area"');
    expect(nav).toContain("event.dataTransfer.setData(DRAG_TYPE_AREA, node.key);");
    expect(nav).toContain("draggable={!node.ghost}");
  });

  test("the rename walks every subject under the FROM prefix — segment-boundary, not a string prefix", () => {
    const fn = nav.slice(nav.indexOf("const renameAreaPrefix ="), nav.indexOf("const submitRenameContainer ="));
    expect(fn).toContain("const from = splitAreaPath(fromKey);");
    expect(fn).toContain("pathIsPrefixOf(from, splitAreaPath(line.area))");
    expect(fn).toContain("renamePathPrefix(line.area as string, from, to)");
  });

  test("one PATCH per affected subject, optimistic through the SAME `pendingAreas` overlay every other drop uses", () => {
    // The PATCH itself is `setSubjectColor`'s own — the nearest fetch to the
    // SAME `/api/spool/subjects/:key` route after `renameAreaPrefix` in this
    // file's declaration order, proving it is still the one identity route
    // every write in this module shares, not a second one minted for rename.
    const fn = nav.slice(nav.indexOf("const renameAreaPrefix ="), nav.indexOf("const nodeDropProps ="));
    expect(fn).toContain("fetch(`/api/spool/subjects/${encodeURIComponent(subject)}`, {");
    expect(fn).toContain('method: "PATCH"');
    expect(fn).toContain("setPendingAreas((prev) => {");
  });

  test("the rename's own failure law is revert-ALL, not the per-subject seq guard the ordinary drop uses", () => {
    /**
     * A rename is ONE gesture that happens to touch many subjects — a
     * partial landing (some renamed, some refused) is not a smaller version
     * of what was asked for, it is a different, unrequested shape. Revert-ALL
     * still holds after the 2026-08-18 extraction of the wire work itself
     * into `renameAreaPrefixAcrossSubjects` (`lib/spool-area-tree.ts`,
     * shared with the retired `warehouse.tsx`'s own Areas tab): THIS file's
     * own `renameAreaPrefix` delegates the `Promise.allSettled` loop to that
     * shared function and keeps only the overlay-paint-then-revert-all law as
     * its own job, asserted here against the shared function directly rather
     * than against a copy inlined in this file.
     */
    const fn = nav.slice(nav.indexOf("const renameAreaPrefix ="), nav.indexOf("const setSubjectColor ="));
    expect(fn).toContain("void renameAreaPrefixAcrossSubjects(");
    expect(fn).toMatch(/for \(const subject of renamed\.keys\(\)\) next\.delete\(subject\);/);
    expect(fn).toContain("setRefused(error);");
    // No new colour rides in on the rename either.
    expect(fn).not.toMatch(/text-(destructive|warning|success)|bg-(destructive|warning|success)/);

    const shared = code(read("../../lib/spool-area-tree.ts"));
    const sharedFn = shared.slice(shared.indexOf("export async function renameAreaPrefixAcrossSubjects"));
    expect(sharedFn).toContain("Promise.allSettled(");
  });

  test("a subject not under the FROM prefix is skipped — the rename is bounded, never a rewrite of the whole tree", () => {
    const fn = nav.slice(nav.indexOf("const renameAreaPrefix ="), nav.indexOf("const submitRenameContainer ="));
    expect(fn).toContain("const affected = effectiveLines.filter((line) => line.area && pathIsPrefixOf(from, splitAreaPath(line.area)));");
    expect(fn).toContain("if (affected.length === 0) return;");
  });
});

describe("un-areaed subjects sit under a ghost container, never floating — §13.7", () => {
  // RETARGETED §13.8 (2026-08-19): moved into `lobby.tsx`.
  const nav = code(read("lobby.tsx"));

  test("the ghost node's own label is quiet and names an absence, never invents a group", () => {
    expect(nav).toContain('label: "No area yet"');
    expect(nav).not.toMatch(/["'`>]Other["'`<]/);
  });

  test("the ghost node renders whenever it holds real subjects — never only during a drag", () => {
    expect(nav).toContain("const showGhostAtRest = node.ghost && (node.lines.length > 0 || node.children.length > 0);");
    expect(nav).toContain("if (node.ghost && !showGhostAtRest && !dragActive) return null;");
  });

  test("the ghost node is ALSO the clearing target — reachable by hand even while empty, for as long as a subject is mid-drag", () => {
    // This is the old "unfiled strip"'s own law, carried by the ghost node
    // now instead of a second, separate element. RETARGETED §13.8: the
    // fallback lives on `treeWithGhost` (the home screen's own render list),
    // computed once beside `tree` rather than inline at the JSX call site.
    expect(nav).toContain("const ghostFromTree = tree.find((node) => node.ghost);");
    expect(nav).toContain(
      'dragActive && !ghostFromTree\n      ? [...tree, { key: "__ghost", path: [], label: "No area yet", depth: 0, ghost: true, lines: [], children: [] }]\n      : tree;',
    );
  });
});

describe("the lobby renders the same container grammar the rail does — §13.7", () => {
  const lobby = code(read("lobby.tsx"));

  test("the lobby builds its own tree from `buildAreaTree`, over its own subject/area shape", () => {
    /**
     * RETARGETED §13.8 (2026-08-19): the lobby dropped the `LobbyEntry`
     * wrapper type this test used to pin — `SpoolLobbySubject` (the
     * protocol's own shape for `GET /api/spool/lobby`) already carries
     * `area`, `rank`, and `color`, so `buildAreaTree` runs directly over it,
     * one fewer type in the middle.
     */
    expect(lobby).toContain("const tree = buildAreaTree<SpoolLobbySubject>(effectiveLines, (entry) => entry.area);");
    // `lobby.unareaed` feeds the same ghost node the rail's tree makes —
    // never its own bare, unheaded list any more.
    expect(lobby).toContain(
      "const flatEntries: SpoolLobbySubject[] = lobby ? [...lobby.areas.flatMap((area) => area.subjects), ...lobby.unareaed] : [];",
    );
  });

  test("a container's weight never drops below a card's own — same law, same numbers, as the rail", () => {
    expect(lobby).toContain("function containerTextClass(depth: number, ghost: boolean): string {");
    expect(lobby).toMatch(/depth === 0 && "font-semibold/);
  });

  test("collapsing a subtree still says whether something in it needs you — folding a card away must never fold away the claim on the hand", () => {
    /**
     * RETARGETED §13.8 (2026-08-19, folded-is-unreachable fix): the engine's
     * own per-subject `folded` used to compress a subject away entirely
     * (`AreaFold`, since deleted) — that made it unreachable, the bug this
     * pass fixes. `folded` now only chooses `LobbyRow` over `LobbyCard`; the
     * subject still renders. A user's manual COLLAPSE is a different act —
     * hiding a whole subtree by hand — and it must not silently drop an
     * honest "something in here needs you" either.
     */
    expect(lobby).toContain("function collapsedRollupLine(subjects: number, needs: number): string {");
    expect(lobby).toContain('if (needs === 0) return `${subjects} ${subjects === 1 ? "subject" : "subjects"}, nothing needs you`;');
    expect(lobby).toMatch(/needs === 1 \? "needs" : "need"/);
  });

  test("a ceiling rides on the node whose own joined path matches the area's stated name exactly — never assumed from an ancestor", () => {
    // The same "never assume, quote the exact winner" law `tray.tsx`'s
    // `clampedBy` fix restates elsewhere in this pass.
    expect(lobby).toContain("const ceilingByPath = new Map<string, string>(");
    expect(lobby).toContain("const ceiling = ceilingByPath.get(node.key);");
  });

  test("no invented \"Other\" group anywhere in the lobby's own tree", () => {
    expect(lobby).not.toMatch(/["'`>]Other["'`<]/);
  });
});

/**
 * ADAPTIVE RIGHT-CLICK MENUS — issue #94, the Spool as reference. ONE shared
 * primitive (`components/ui/context-menu.tsx`, base-ui's own `ContextMenu`
 * module); every surface composes its OWN items from it, and every item's
 * handler is a function the same surface already wires to a VISIBLE control
 * — never a second write path. Quiet idiom: no red, retire/close/reopen
 * render as ordinary rows, nothing deletes.
 */
describe("the shared context-menu primitive, and each surface's own composed menu", () => {
  test("components/ui/context-menu.tsx exists, wraps base-ui's dedicated ContextMenu module (not Menu), and is the ONE definition every surface imports from", () => {
    const primitive = fs.readFileSync(path.join(dir, "..", "ui", "context-menu.tsx"), "utf8");
    expect(primitive).toContain('import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"');
    expect(primitive).toContain("export {");
    expect(primitive).toContain("ContextMenu,");
    expect(primitive).toContain("ContextMenuTrigger,");
    expect(primitive).toContain("ContextMenuContent,");
    expect(primitive).toContain("ContextMenuItem,");
    // Every surface wired below imports from this one file, never a copy.
    // RETARGETED §13.8 (2026-08-19): `warehouse-nav.tsx` dropped out of this
    // list — the rail is floor-plan-only now and carries no context menu of
    // its own; its gestures (and this import) moved into `lobby.tsx`.
    for (const name of ["lobby.tsx", "stance.tsx", "board.tsx", "calendar.tsx", "tray.tsx"]) {
      const source = code(read(name));
      expect(source, `${name} imports the shared primitive`).toContain('from "@/components/ui/context-menu"');
      expect(source, `${name} does not define its own ContextMenu`).not.toMatch(/function ContextMenu\b/);
    }
    expect(code(read("warehouse-nav.tsx")), "warehouse-nav.tsx carries no context menu at all").not.toContain(
      'from "@/components/ui/context-menu"',
    );
  });

  test("the lobby's own container row composes its own menu — Rename…, Set ceiling ▸, Collapse others — none of which any other surface's menu carries", () => {
    // RETARGETED §13.8 (2026-08-19): this verb set moved from the rail's
    // container row into `lobby.tsx`'s own `LobbyNode` when the tree did.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain("Rename…");
    expect(nav).toContain("Set ceiling");
    expect(nav).toContain("Collapse others");
    // Distinguishing item, pinned: only the container row offers it.
    for (const name of ["warehouse-nav.tsx", "stance.tsx", "board.tsx", "calendar.tsx", "tray.tsx"]) {
      expect(code(read(name)), `${name} does not also carry the container's own verb`).not.toContain("Collapse others");
    }
  });

  test("the lobby card composes a DIFFERENT menu from its own container's — Move to ▸, Color ▸, Move up/down — reusing assignArea, setSubjectColor's own PATCH, and reorderSubject", () => {
    // RETARGETED §13.8 (2026-08-19): this verb set moved from the rail's
    // subject row into `lobby.tsx`'s own `LobbyCard`.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain('<ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>');
    expect(nav).toContain('<ContextMenuSubTrigger>Color</ContextMenuSubTrigger>');
    expect(nav).toContain("Move up");
    expect(nav).toContain("Move down");
    // Reuse, not reinvention: the SAME assignArea/reorderSubject the drag
    // machinery and the rank arrows already call — one level of indirection
    // through `LobbyCard`'s own `onMoveTo`/`onMoveUp`/`onMoveDown` props,
    // wired by `LobbyNode` to the exact functions its own drag handlers use.
    // RETARGETED §13.8 (2026-08-19, folded-is-unreachable fix): the render
    // loop that builds these props no longer walks a `cards`-only array
    // (that name, and the filter that built it, is what hid folded
    // subjects) — it walks `entries`, every subject in the node, folded and
    // not alike, and hands `LobbyCard`/`LobbyRow` the identical props.
    expect(nav).toContain("onClick={() => onMoveTo(null)}");
    expect(nav).toContain("onMoveTo={(path) => assignArea(entry.key, path)}");
    expect(nav).toMatch(/onMoveUp=\{\(\) => idx > 0 && reorderSubject\(entry\.key, entries\[idx - 1\], "above"\)\}/);
    expect(nav).toMatch(/onMoveDown=\{\(\) => idx < entries\.length - 1 && reorderSubject\(entry\.key, entries\[idx \+ 1\], "below"\)\}/);
  });

  test("the lobby card composes its own menu — Enter room, Add a task… — distinct from the rail's, sharing only the primitive", () => {
    const lobby = code(read("lobby.tsx"));
    expect(lobby).toContain("Enter room");
    expect(lobby).toMatch(/onClick=\{\(\) => onEnter\(subject\.key\)\}/);
    expect(lobby).toMatch(/onClick=\{\(\) => onAddTask\(subject\.key\)\}/);
    // Omitted verbs are named, not silently dropped — the doc comment above
    // `LobbyCard`, so `read()` rather than `code()` here.
    expect(read("lobby.tsx")).toContain('Omitted, and named here rather than faked: "Resume session"');
  });

  test("the Tasks tab's active row composes Close / Pin to… / Open packet — reusing the SAME close/pin/onOpen props Row already threads, no new plumbing", () => {
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("function RowContextMenu({");
    expect(stance).toContain("{close && <ContextMenuItem onClick={close}>Close</ContextMenuItem>}");
    expect(stance).toContain('<ContextMenuSubTrigger>Pin to…</ContextMenuSubTrigger>');
    expect(stance).toContain("<ContextMenuItem onClick={() => onOpen(itemId)}>Open packet</ContextMenuItem>");
    // Distinguishing item, pinned: only the task row's menu offers "Pin to…"
    // as a submenu with a bare date input reusing the row's own `pin` prop.
    expect(stance).toMatch(/onChange=\{\(event\) => \{\s*const day = event\.currentTarget\.value;\s*if \(day\) pin\(day\);/);
    // Named omissions — no per-row lane/tag callback reaches Row.
    const stanceFlat = flat("stance.tsx");
    expect(stanceFlat).toContain("OMITTED, and named here rather than faked");
    expect(stanceFlat).toContain('"Move to lane…"');
    expect(stanceFlat).toContain('"Tag…"');
  });

  test("the closed shelf (DoneShelf) composes the CLOSED twin — Reopen / Open packet — never Close, and never a second reopen route", () => {
    const stance = code(read("stance.tsx"));
    const shelf = stance.slice(stance.indexOf("function DoneShelf"), stance.indexOf("function NightCard"));
    expect(shelf).toContain("<ContextMenuItem onClick={() => onReopen(row.id)}>Reopen</ContextMenuItem>");
    expect(shelf).not.toContain(">Close<");
  });

  test("the board card composes Close / Open packet, right-click never racing the card's own native drag", () => {
    const board = code(read("board.tsx"));
    // Drag stays on the outer <li>; the trigger wraps only the card's own
    // content, so a right-click cannot start (or be confused with) a drag.
    const cardFn = board.slice(board.indexOf("function Card("), board.indexOf("function LaneDoneFold"));
    expect(cardFn).toContain("draggable");
    expect(cardFn.indexOf("draggable")).toBeLessThan(cardFn.indexOf("<ContextMenu>"));
    expect(cardFn).toContain("<ContextMenuItem onClick={() => onClose(item.id)}>Close</ContextMenuItem>");
    expect(cardFn).toContain("<ContextMenuItem onClick={() => onOpen(item.id)}>Open packet</ContextMenuItem>");
    // Named omissions — no per-card pin/lane/tag control on the board.
    const boardFlat = flat("board.tsx");
    expect(boardFlat).toContain("OMITTED, and named rather than faked");
    expect(boardFlat).toContain('"Pin to…"');
    expect(boardFlat).toContain('"Tag…"');
  });

  test("the calendar's day cell offers a menu the pill does NOT, and the pill offers one the cell does NOT — genuinely different surfaces, not one list reused twice", () => {
    const cal = code(read("calendar.tsx"));
    expect(cal).toContain("Add a task for this day…");
    expect(cal).toContain("<ContextMenuItem onClick={() => setAddingDay(day)}>Add a task for this day…</ContextMenuItem>");
    expect(cal).toContain("<ContextMenuItem onClick={() => onUnpin(item.id)}>Unpin</ContextMenuItem>");
    // The day cell is a drop TARGET only (never a drag source), so wrapping
    // the whole cell in the trigger cannot race the pill's own drag.
    const cellSite = cal.slice(cal.indexOf("weeks.flat().map"), cal.indexOf("THE UNPINNED RAIL"));
    expect(cellSite).not.toMatch(/<div\s+draggable/);
  });

  test("the calendar's day-cell verb reuses the SAME AddTaskDialog and POST route as the room's own \"Add a task\" button, merely pre-picking the day", () => {
    const addTask = code(read("add-task.tsx"));
    expect(addTask).toContain("defaultPinDay?: string;");
    expect(addTask).toContain('const [pinDay, setPinDay] = useState(defaultPinDay ?? "");');
    // One POST route, still — no second endpoint added for the calendar's verb.
    expect(addTask.match(/fetch\("\/api\/spool\/items"/g)?.length).toBe(1);
    const cal = code(read("calendar.tsx"));
    expect(cal).toContain("<AddTaskDialog");
    expect(cal).toContain("defaultPinDay: addingDay");
  });

  test("the notes-tab row composes Open / Retire…, reaching the SAME retire route NoteFace's own retire() already POSTs to — never a second endpoint", () => {
    const tray = code(read("tray.tsx"));
    expect(tray).toContain("const retireNoteRow = useCallback(");
    expect(tray).toMatch(/fetch\(`\/api\/spool\/notes\/\$\{encodeURIComponent\(id\)\}\/retire`,\s*\{\s*method: "POST"/);
    // Same route NoteFace's retire() posts to, not a rename of it.
    const noteFace = tray.slice(tray.indexOf("function NoteFace"), tray.indexOf("function SubjectFace"));
    expect(noteFace).toMatch(/`\/api\/spool\/notes\/\$\{encodeURIComponent\(id\)\}\/retire`/);
    expect(tray).toContain("<ContextMenuItem onClick={() => retireNoteRow(note.id)}>Retire…</ContextMenuItem>");
  });

  test("close/reopen stay hand-only everywhere a menu offers them — every menu's Close/Reopen item fires the SAME callback the row's own CloseCheckbox fires, never a fresh fetch inline", () => {
    for (const name of ["stance.tsx", "board.tsx"]) {
      const source = code(read(name));
      // No ContextMenuItem in these files POSTs/PATCHes inline for close or
      // reopen — every Close/Reopen item's onClick is a bare callback
      // reference (close, onClose, onReopen), matching CloseCheckbox's own
      // onToggle in the same file.
      const closeItems = source.match(/<ContextMenuItem onClick=\{[^}]*\}>(Close|Reopen)<\/ContextMenuItem>/g) ?? [];
      expect(closeItems.length).toBeGreaterThan(0);
      for (const item of closeItems) {
        expect(item, `${name}'s ${item} avoids a second write path`).not.toMatch(/fetch\(|patch\(|POST|PATCH/);
      }
    }
  });

  test("no menu item anywhere spells a second PATCH for area, rank, pin, or lane — every area/rank/pin write still lives in exactly the functions the drag and swatch controls already call", () => {
    // area/rank/color: assignArea, reorderSubject, and the menu's own
    // setSubjectColor all PATCH the SAME `/api/spool/subjects/:key` route —
    // the one identity write path — never a distinct URL of their own. The
    // drag machinery already established this route; the menu's new
    // callers (setSubjectColor for "Color ▸", the ceiling PATCH for "Set
    // ceiling ▸") are additional CALLERS of an existing route, not a second
    // route — mirrored by the earlier "no second identity-write path" test.
    // RETARGETED §13.8 (2026-08-19): this machinery lives in `lobby.tsx` now.
    const nav = code(read("lobby.tsx"));
    const subjectRoutes = nav.match(/fetch\(`\/api\/spool\/subjects\/\$\{encodeURIComponent\([a-zA-Z]+\)\}`/g) ?? [];
    expect(subjectRoutes.length).toBeGreaterThan(0);
    expect(new Set(subjectRoutes.map((s) => s.replace(/\(\w+\)/, "(x)"))).size).toBe(1);
    expect(nav).toContain("const setSubjectColor = (subject: string, color: string | null)");
    expect(nav).toContain("const setAreaCeiling = (name: string, ceiling: SpoolSubjectPermits | null)");
    // pin: RowContextMenu's submenu calls the SAME `pin` prop the row's own
    // hover verb calls — no fetch of its own anywhere in stance.tsx's Row
    // machinery beyond the ones the pre-existing pin/close callbacks make
    // upstream in `SpoolStance`.
    const stance = code(read("stance.tsx"));
    const rowContextMenuFn = stance.slice(stance.indexOf("function RowContextMenu("), stance.indexOf("function RowVerbs("));
    expect(rowContextMenuFn).not.toMatch(/fetch\(/);
    // lane: no menu anywhere in this pass introduces a lane PATCH — named
    // as an omission everywhere a lane verb would have gone.
    for (const name of ["stance.tsx", "board.tsx"]) {
      expect(flat(name)).toContain('"Move to lane…"');
    }
  });

  test("no red anywhere in the new menu code — the quiet idiom holds for close, reopen, and retire alike", () => {
    for (const name of ["warehouse-nav.tsx", "lobby.tsx", "stance.tsx", "board.tsx", "calendar.tsx", "tray.tsx"]) {
      const source = code(read(name));
      expect(source, `${name} spends no destructive-variant colour in its menu items`).not.toMatch(/ContextMenuItem[^>]*variant="destructive"/);
    }
    const primitive = fs.readFileSync(path.join(dir, "..", "ui", "context-menu.tsx"), "utf8");
    // The primitive itself carries the destructive variant machinery (as
    // dropdown-menu.tsx does) for future callers — no surface in the Spool
    // opts into it.
    expect(primitive).toContain('variant?: "default" | "destructive"');
  });
});

/**
 * THE REMINDERS IDIOM — the verdict on the Spool's own dialogs: "too
 * generic, doesn't even fit our UI… I like Apple Reminders." Inset-grouped
 * field ROWS (a rounded container one step off the sheet, hairline-
 * separated, quiet label left / control right) replace stacked labelled
 * inputs; dialogs shrink to content width with a small quiet title and no
 * description ceremony; and a tiny single-field ask (rename, retire reason)
 * is a small anchored popover-card at the row it names, never a centered
 * modal reopened for one word.
 */
describe("the Spool's dialogs wear the Reminders idiom, not the generic centered form", () => {
  test("the inset-group and row primitives exist, one definition site", () => {
    const fields = read("field-group.tsx");
    expect(fields).toContain("export function FieldGroup");
    expect(fields).toContain("export function FieldRow");
    expect(fields).toContain("export function RowInput");
    // Rows are hairline-separated inside a rounded container one step off
    // the sheet — the shape itself, not merely the name.
    expect(fields).toContain("divide-y divide-border/50");
    expect(fields).toContain("rounded-xl");
    // No second definition site anywhere else in the module.
    for (const { name, source } of surfaces()) {
      if (name === "field-group.tsx") continue;
      expect(code(source), `${name} spells its own FieldGroup/FieldRow`).not.toMatch(
        /function (FieldGroup|FieldRow)\(/,
      );
    }
  });

  test("the add-task and confirm/lane dialogs are built from the shared rows, not stacked labelled inputs", () => {
    for (const name of ["add-task.tsx", "dialogs.tsx"]) {
      const source = code(read(name));
      expect(source, `${name} does not import the row primitives`).toContain(
        '@/components/spool/field-group',
      );
      expect(source, `${name} still spells its own stacked Field()`).not.toMatch(/function Field\(/);
    }
    expect(code(read("add-task.tsx"))).toContain("<FieldGroup>");
    expect(code(read("dialogs.tsx"))).toContain("<FieldGroup>");
  });

  test("dialogs shrink to content width and carry no description paragraph beyond the §-law copy", () => {
    const dialogs = code(read("dialogs.tsx"));
    // Compact, not the generic sm:max-w-md every dialog wore before.
    expect(dialogs).not.toContain("sm:max-w-md");
    expect(dialogs).toMatch(/sm:max-w-(xs|sm)/);
    const addTask = code(read("add-task.tsx"));
    expect(addTask).not.toContain("sm:max-w-md");
    // The add-task dialog's own title is carried by the title INPUT, not a
    // visible dialog heading — the accessible title stays for assistive
    // tech, marked sr-only, exactly the row this idiom drops from view.
    expect(addTask).toContain('DialogHeader className="sr-only"');
  });

  test("commit is light — Enter submits, Escape cancels, and no button ceremony beyond it", () => {
    // The lane and confirm dialogs' footers still carry their one Cancel /
    // confirm pair (a real multi-field form and a destructive-adjacent
    // confirm both earn a button), but the quiet variant, not `outline`,
    // now that the card itself is quiet rather than boxed.
    const dialogs = code(read("dialogs.tsx"));
    expect(dialogs).toContain('variant="ghost"');
    expect(dialogs).not.toContain('variant="outline"');
  });

  test("window.prompt's replacement is a small anchored popover-card, never a centered dialog", () => {
    const card = read("prompt-card.tsx");
    expect(card).toContain("export function AskOneThing");
    // Anchored at the invocation point — a caller's own ref/element, not the
    // page center a Dialog would use.
    expect(card).toContain("anchor:");
    expect(card).toContain("PopoverPrimitive.Positioner");
    // No button ceremony: Enter (the form's own submit) and Escape are the
    // whole interaction; a refusal is the one line that earns space.
    expect(card).not.toMatch(/<button[^>]*type="submit"/);
    expect(card).not.toContain("Cancel</");
  });

  test("the rename-area and retire-note asks are both anchored to the row, not the browser", () => {
    // RETARGETED §13.8 (2026-08-19): the container rename ask moved from the
    // rail's own tree into the lobby's, along with the rest of the map.
    const nav = code(read("lobby.tsx"));
    expect(nav).toContain('@/components/spool/prompt-card');
    expect(nav).toContain("<AskOneThing");
    expect(nav).toContain("containerRefs.current.get(node.key)");
    expect(nav).not.toContain("window.prompt");

    const tray = code(read("tray.tsx"));
    expect(tray).toContain('@/components/spool/prompt-card');
    expect(tray).toContain("<AskOneThing");
    // The anchor is READ AT THE CLICK rather than during the row's render —
    // a ref read in render is a lint error and, worse, a miss on the first
    // render after mount, which would open the ask unanchored. Still the row's
    // own element; only the moment of reading moved.
    expect(tray).toContain("noteRowRefs.current.get(id)");
    expect(tray).not.toContain("window.prompt");
  });
});

/**
 * §13.8, 2026-08-19, added as its own law suite — "the map is content, not
 * chrome." Four claims the wave-1 nav restructure makes as a whole, each
 * decidable by reading source: the rail carries no tree, the Lobby opens on
 * two live smart tiles, an area page's breadcrumb is walkable by the hand,
 * and the dissolved Warehouse room leaves no trace anywhere in the module.
 */
describe("§13.8 — the map is content, not chrome", () => {
  test("the rail renders no area tree of its own — no buildAreaTree, no recursive node component, no drag handlers", () => {
    const nav = code(read("warehouse-nav.tsx"));
    expect(nav).not.toContain("buildAreaTree(");
    expect(nav).not.toMatch(/function \w*Node\(/);
    expect(nav).not.toMatch(/draggable=/);
    expect(nav).not.toContain("useAreaCollapse");
    // Four fixed rooms and nothing structural beyond them.
    expect(nav).toContain('"Lobby"');
    expect(nav).toContain('"Today"');
    expect(nav).toContain('"Scheduled"');
    expect(nav).toContain('"Assistant"');
  });

  test("the Lobby opens on two live smart tiles — Today and Scheduled, each a real click into that room, not a static caption", () => {
    const lobby = code(read("lobby.tsx"));
    expect(lobby).toContain("function SmartTile(");
    expect(lobby).toContain('<SmartTile label="Today" count={todayCount ?? 0} hint="pinned for today" onClick={() => onEnterToday?.()} />');
    expect(lobby).toContain('<SmartTile label="Scheduled" count={scheduledCount ?? 0} hint="pinned ahead" onClick={() => onEnterScheduled?.()} />');
    // The counts are handed down, never re-derived — `stance.tsx` computes
    // them once from `wideModel`, the same model Today/Scheduled themselves
    // render from.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("todayCount={wideModel.needs.length}");
    expect(stance).toMatch(/scheduledCount=\{wideModel\.scheduled\.slipped\.length/);
  });

  test("an area page's breadcrumb segments are each their own button — clicking a middle segment jumps straight there, not one step at a time", () => {
    const lobby = code(read("lobby.tsx"));
    const breadcrumbFn = lobby.slice(lobby.indexOf("function Breadcrumb("), lobby.indexOf("export function Lobby("));
    // "Lobby" walks all the way out…
    expect(breadcrumbFn).toContain('<button type="button" onClick={onEnterLobby}');
    // …and every named segment is its own <button>, targeting the FULL path
    // up to and including itself, not the ancestors one hop at a time.
    expect(breadcrumbFn).toContain("const target = path.slice(0, idx + 1).join(\" / \");");
    expect(breadcrumbFn).toContain('<button type="button" onClick={() => onEnterArea(target)}');
    expect(breadcrumbFn).not.toContain("<a ");
  });

  test("every subject on the map renders — folded or not — as a row you can stand on, never as nothing", () => {
    /**
     * DRIVEN 2026-08-19: a quiet subject (Personal's casa, Trabajo's
     * telar-vnext) had NO row anywhere — the lobby's own "N subjects,
     * nothing needs you" sentence spoke for it instead. That made the
     * subject unreachable from the map, the exact failure §13.8 exists to
     * rule out: "everything else sits folded as plain structure you can
     * stand on" means a row, never an absence. Fixed by rendering EVERY
     * entry in a node's own `lines`, `LobbyRow` for `folded`, `LobbyCard`
     * otherwise — never a `!entry.folded` filter dropping the rest.
     */
    const lobby = code(read("lobby.tsx"));
    expect(lobby).toContain("function LobbyRow(");
    // The old per-subject fold sentence is gone outright — deleted, not
    // merely unreachable code left behind.
    expect(lobby).not.toContain("function AreaFold(");
    // `LobbyNode`'s own render loop walks every entry, never a folded-only
    // filter — the fix lives here, once, for both the home screen's tree
    // and the area page's own top-level subjects.
    expect(lobby).toContain("const entries = sortByRank(node.lines);");
    expect(lobby).toMatch(/entries\.map\(\(entry, idx\) =>\s*\n\s*entry\.folded \? \(/);
    expect(lobby).toMatch(/sortByRank\(scopedNodes\[0\]\?\.lines \?\? \[\]\)\.map\(\(entry, idx, arr\) =>\s*\n\s*entry\.folded \? \(/);
    // A folded row is still a real drag source and a real click into its
    // own room — not a lesser, inert copy of the card beside it.
    const rowFn = lobby.slice(lobby.indexOf("function LobbyRow("), lobby.indexOf("const DRAG_TYPE ="));
    expect(rowFn).toContain("draggable");
    expect(rowFn).toContain("onClick={() => onEnter(subject.key)}");
  });

  test("the Warehouse room is gone — no file named warehouse.tsx, and nothing in the module imports it", () => {
    expect(fs.existsSync(path.join(dir, "warehouse.tsx"))).toBe(false);
    for (const { name, source } of surfaces()) {
      expect(code(source), `${name} imports the retired warehouse room`).not.toMatch(
        /from ["']@\/components\/spool\/warehouse["']/,
      );
    }
    // Its room kind retired too — `stance.tsx` no longer branches on it.
    expect(code(read("stance.tsx"))).not.toMatch(/room\.kind === ["']warehouse["']/);
    const roomLib = read("../../lib/spool-room.ts");
    expect(code(roomLib)).not.toMatch(/kind: ["']warehouse["']/);
  });
});

/**
 * §13.8 WAVE 2, 2026-08-19 — "rows edit in place": the subject room becomes
 * the task list, edited in place. Four claims decidable by reading source:
 * a row's title commits through the existing item PATCH and reverts on a
 * verbatim engine refusal; the ghost row creates through the existing create
 * route, preset to the room's own subject; closed items stay behind
 * `DoneShelf`'s existing fold rather than a second "show completed"
 * mechanism; and the brief strip is dismissible while Resume session stays
 * reachable in both its states.
 */
describe("§13.8 wave 2 — rows edit in place", () => {
  test("EditableTitle commits through the caller's route and reverts to the prior text on a verbatim refusal", () => {
    const taskRow = code(read("task-row.tsx"));
    expect(taskRow).toContain("export function EditableTitle(");
    // Commits only a real, changed value — not a mere blur with nothing typed.
    expect(taskRow).toContain('if (!trimmed || trimmed === text) {');
    // A rejection reverts the field to the ORIGINAL text and shows the
    // rejection's own message — never invents wording of its own.
    expect(taskRow).toMatch(/\.catch\(\(err\) => \{\s*setValue\(text\);\s*setError\(err instanceof Error \? err\.message : String\(err\)\);/);
    // Escape reverts without ever calling `onCommit`.
    expect(taskRow).toMatch(/if \(e\.key === "Escape"\) \{[\s\S]*?setValue\(text\);\s*setEditing\(false\);/);
  });

  test("the shared row grammar's title edit reaches the SAME generic item PATCH the bulk action bar already speaks — no new route", () => {
    const stance = code(read("stance.tsx"));
    // The subject room's "Waiting its turn" rows and the Scheduled scope's
    // rows both route their title/lane/pin/tag edits through one prop,
    // `onEditItem`, and its one implementation PATCHes the existing route.
    expect(stance).toMatch(/onEditTitle:\s*\(next: string\) => onEditItem\(row\.id, \{ title: next \}\)/);
    expect(stance).toMatch(/fetch\(`\/api\/spool\/items\/\$\{encodeURIComponent\(id\)\}`, \{\s*method: "PATCH"/);
    // The verbatim-error convention every write in this module already keeps.
    expect(stance).toContain('throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);');
  });

  test("lane/pin/tags edit through RowDisclosure, never a note/body field — SpoolItem has none, so there is nothing to disclose", () => {
    const taskRow = code(read("task-row.tsx"));
    expect(taskRow).toContain("export function RowDisclosure(");
    expect(taskRow).toContain("onLane: (lane: string) => void;");
    expect(taskRow).toContain("onPin: (day: string | null) => void;");
    expect(taskRow).toContain("onTags: (tags: string[]) => void;");
    // Named here rather than silently absent — `SpoolItem` carries no
    // note/body field (`packages/engine-client/src/protocol/spool.ts`);
    // notes are a separate shelf/note store with its own route. This is a
    // comment, not code, so it is checked in the RAW source (`flat`, which
    // only collapses whitespace) rather than `code` (which strips comments).
    expect(flat("task-row.tsx")).toContain("OMITTED: a note/body field");
  });

  test("the ghost row creates through the SAME create route add-task.tsx speaks, preset to the room's own subject, and clears rather than remounting", () => {
    const taskRow = code(read("task-row.tsx"));
    expect(taskRow).toContain("export function GhostTaskRow(");
    expect(taskRow).toMatch(/fetch\("\/api\/spool\/items", \{\s*method: "POST"/);
    expect(taskRow).toContain('body: JSON.stringify({ title, project: subject })');
    // On success the field clears in place — no dialog close, no remount —
    // so a hand naming several tasks keeps typing without reclicking in.
    expect(taskRow).toMatch(/setValue\(""\);\s*onCreated\(\);/);

    const room = code(read("room.tsx"));
    expect(room).toContain("<GhostTaskRow");
    expect(room).toContain("subject={subjectKey}");
    // The room's own "Add a task" button is gone from the Tasks tab —
    // Board and Calendar keep it, since neither has a row list to type into.
    expect(room).toMatch(/\{\(tab === "board" \|\| tab === "calendar"\) && \(/);
  });

  test("closed items stay behind DoneShelf's existing fold — wave 2 reuses it rather than building a second show-completed mechanism", () => {
    // `DoneShelf` (hidden-by-default, "Done — {rows.length}" toggle,
    // `reopenItemByHand` on its own rows) already satisfies §13.8's "show
    // completed foot" — the very thing the deleted Warehouse room's Done tab
    // used. This law only pins that wave 2 did not grow a second one.
    const stance = code(read("stance.tsx"));
    expect(stance).toContain("function DoneShelf(");
    expect(stance).not.toMatch(/function ShowCompleted\(/);
    expect(stance).not.toMatch(/function CompletedFold\(/);
    // Still mounted at exactly its existing two call sites (the smart
    // Today/Scheduled branch and the subject-scoped branch, both pre-dating
    // wave 2) — no third one added for the ghost row's neighbourhood.
    expect(stance.match(/<DoneShelf\b/g)?.length).toBe(2);
  });

  test("the brief strip is dismissible per subject, and Resume session stays reachable whether collapsed or expanded", () => {
    const room = code(read("room.tsx"));
    // Dismiss reads/writes through the sanctioned hook, not a direct
    // `localStorage` call — room.tsx keeps the file-wide ban this suite
    // already pins elsewhere.
    expect(room).toContain('import { useBriefDismiss } from "@/lib/spool-brief-dismiss";');
    expect(room).toContain("const { dismissed: briefDismissed, dismiss: dismissBrief } = useBriefDismiss(subjectKey);");
    expect(room).not.toMatch(/window\.localStorage/);
    // Dismissed renders nothing — "the room is just the list."
    expect(room).toMatch(/\{!briefDismissed && \(/);
    // Resume session sits OUTSIDE the `briefExpanded` gate, so it is on the
    // strip in both its compact and expanded states.
    const briefBlock = room.slice(room.indexOf('{!briefDismissed && ('), room.indexOf("{/* ── TABS"));
    const expandedGateIdx = briefBlock.indexOf("{briefExpanded && (");
    const resumeIdx = briefBlock.indexOf("Resume session");
    expect(expandedGateIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(resumeIdx).toBeLessThan(expandedGateIdx);
  });
});

/**
 * §13.8 HOTFIX, 2026-08-19 — driven live: entering a subject's room showed
 * FOUR "Nothing…" thread bands and a footer quoting the WHOLE STORE'S count,
 * while the store held two real open items filed to that very subject — one
 * of them typed into the ghost row moments earlier, which POSTed clean (200)
 * and then never appeared. Root cause: `claimedByBands` (deriveStance,
 * stance.tsx) claimed every housekeeping id — including an UNPLACED item's,
 * which still names a real `project` (`unplaced` describes the LANE the seed
 * lane resolved to, not an absent subject) — unconditionally, while the
 * housekeeping FOLD that would have shown them is itself suppressed under
 * `scope`. Claimed by a fold that had gone quiet, an unplaced item rendered
 * in neither place: it vanished. These laws pin the fix, not just its symptom.
 */
describe("§13.8 hotfix, 2026-08-19 — a subject's own open items never vanish from its room", () => {
  const stance = code(read("stance.tsx"));

  test("housekeeping's ids are only claimed against `prepared` in the WIDE view, where the fold that owns them actually renders", () => {
    // The claim set must be conditioned on `scope` — an unconditional
    // `...housekeeping.map(...)` here is exactly the regression: it silently
    // excludes a scoped subject's own unplaced items from `prepared` even
    // though `housekeeping` itself renders as `[]` under scope two lines
    // below (that line is unchanged and still pinned by the assertion after
    // this one).
    expect(stance).toMatch(/\.\.\.\(scope \? \[\] : housekeeping\.map\(\(h\) => h\.id\)\)/);
  });

  test("the housekeeping fold itself still goes quiet under scope — unchanged law, so the two arms cannot silently agree by accident", () => {
    expect(stance).toContain("housekeeping: scope ? [] : housekeeping");
  });

  test("`prepared` is built from this subject's own inventory group and is never filtered by `unplaced`", () => {
    // The fix is entirely in what CLAIMS a row before this loop runs — the
    // loop itself never tested `row.item.unplaced`, and must go on not
    // testing it: an unplaced item is not a different CLASS of item, it is
    // an ordinary item whose lane could not be resolved.
    const preparedBlock = stance.slice(stance.indexOf("const prepared: PreparedGroup[] = []"), stance.indexOf("const pinnedAll: ScheduledRow[]"));
    expect(preparedBlock).toContain('(inventory ?? []).find((g) => g.project === scope)?.rows ?? []');
    expect(preparedBlock).not.toMatch(/row\.item\.unplaced/);
  });

  test("the footer's conservation line counts THIS subject's own items under scope, not the whole store's", () => {
    expect(stance).toMatch(
      /scopeTotals:\s*scope\s*\?\s*\{\s*totalItems:\s*scopeRows\.length,\s*agentsAdded:\s*scopeRows\.filter\(\(r\) => r\.item\.provenance === "session"\)\.length\s*\}/,
    );
    // The render site actually branches on it — a scoped room states its own
    // count, never falling silently back to the global read.
    expect(stance).toMatch(/\{scope && scopeTotals \? \(/);
    expect(stance).toContain("{scopeTotals.totalItems} {scopeTotals.totalItems === 1");
    // The wide view's exact wording — pinned above by an earlier suite — is
    // untouched: this only adds a scoped branch beside it.
    expect(stance).toContain("the count never grows from breakdown.");
  });

  test("a ghost-row create lands visibly — the room refetches the same snapshot the create just changed, no separate `onCreated` truth", () => {
    const room = code(read("room.tsx"));
    // `onChanged` IS `load` at the root (stance.tsx) — the ghost row's
    // success calls the very function whose result was the vanishing bug's
    // OTHER half. Refetch-on-success, the sanctioned alternative to a hand
    // rolled optimistic append (see lobby.tsx for that pattern elsewhere).
    expect(room).toMatch(/onCreated={\(\) => \{\s*void onChanged\(\);\s*void loadBrief\(\);\s*\}\}/);
  });
});

/**
 * §13.8, 2026-08-19 — driven live, again: the vanish fix above surfaced a
 * SECOND violation of "the subject room IS the task list". A quiet room
 * led with FOUR near-empty bands — "Nothing needs you." / "Nothing in
 * flight, and no night has run yet." / "Nothing is parked on anyone." /
 * "Nothing settled yet. Answers land here, and stay." — filling the whole
 * first screen above the actual list, exactly the "four nearly-empty
 * bands" defect `focus shows the subject's actual items` already named
 * once, resurfaced one level up. Reminders never shows four paragraphs of
 * nothing before your tasks.
 *
 * SCOPED TO THE SUBJECT ROOM ONLY — the wide (choosing) view and the Today
 * aperture keep their quiet "Nothing…" sentences exactly as before; this
 * fix touches only the third, focused branch of `Stance`'s render.
 */
describe("§13.8, 2026-08-19 — a quiet subject room does not lead with empty bands", () => {
  const stanceFlat = flat("stance.tsx");
  const stanceCode = code(read("stance.tsx"));
  const focusedStart = stanceFlat.indexOf("FOCUS IS THE RESIDENCE");
  const focusedEnd = stanceFlat.indexOf("WHAT THE APERTURE IS NOT SHOWING");
  const focused = stanceFlat.slice(focusedStart, focusedEnd);

  test("each of the four exceptional bands is gated on its own emptiness — no header, no quiet sentence, when it has nothing to say", () => {
    expect(focusedStart).toBeGreaterThan(-1);
    expect(focusedEnd).toBeGreaterThan(focusedStart);
    expect(focused).toContain("{!needsNothing && (");
    expect(focused).toContain("{!handsNothing && (");
    expect(focused).toContain("{onPerson.length > 0 && (");
    expect(focused).toContain("{settled.length > 0 && (");
    // No quiet "Nothing…" sentence survives in the focused branch at all —
    // an empty band renders NOTHING, not a header with a sentence under it.
    expect(focused).not.toContain("<Empty>");
  });

  test("the wide (choosing) view and the Today aperture are untouched — they still speak their quiet 'Nothing…' sentences", () => {
    // This fix is scoped to the subject room only; the wide/Today text
    // before `focusedStart` is exactly where those two apertures render.
    const wideAndToday = stanceFlat.slice(0, focusedStart);
    expect(wideAndToday).toContain("<Empty>Nothing needs you.</Empty>");
    expect(wideAndToday).toContain("<Empty>Nothing in flight, and no night has run yet.</Empty>");
  });

  test("the task list leads: 'Waiting its turn' renders before the Done fold, which moved to the foot of the list", () => {
    // §13.8's own words: "a 'show completed' foot on each list" — Done used
    // to sit ABOVE the prepared list (right after Settled); now it is
    // strictly below it, the room's own foot fold rather than a second
    // thing to read before reaching the tasks.
    const turnIdx = focused.indexOf('title="Waiting its turn"');
    const doneIdx = focused.indexOf("<DoneShelf");
    expect(turnIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(turnIdx);
  });

  test("'Waiting its turn' keeps its header — a pre-existing law pins the literal title, so this pass could not drop it without weakening that test", () => {
    // `focus shows the subject's actual items` (above) asserts
    // `title="Waiting its turn"` literally. §13.8's own instructions: drop
    // the header only if it is cheap AND no law pins it; one does, so it
    // stays, and this test says so rather than leaving the decision silent.
    expect(stanceCode).toContain('title="Waiting its turn"');
  });
});
