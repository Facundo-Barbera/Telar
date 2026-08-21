// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The loom UI's contract, asserted as source text.
 *
 * WHY SOURCE TEXT AND NOT A RENDER. There is no DOM harness in this app, and
 * every claim below is structural rather than visual: "there is ONE gate chip",
 * "no component declares its own `Loom` type", "nothing here knows what a forge
 * is". Each is decidable by reading the file, and each is a rule a future edit
 * could break silently — a second gate chip defined inside the deck would look
 * fine on screen and would quietly end the cross-surface invariant it violates.
 *
 * Ported in spirit from `components/spool/idiom.test.ts`, including its `code()`
 * helper, and for the same reason: the comments that explain an ABSENCE have to
 * name the thing that is absent, so a scan that read prose would fire on the
 * explanation and teach the next person to delete it. Only code is checked.
 */
const dir = fileURLToPath(new URL(".", import.meta.url));
const appRoot = path.join(dir, "..", "..");
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every component on this surface. */
const surfaces = () =>
  fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({ name: file, source: read(file) }));

/** The pure modules behind them, plus the pages. */
function tree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return tree(file);
    return /\.tsx?$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}

const vertical = () =>
  [
    ...surfaces().map((surface) => ({ name: surface.name, source: surface.source })),
    ...tree(path.join(appRoot, "app", "looms")).map((file) => ({
      name: path.relative(appRoot, file),
      source: fs.readFileSync(file, "utf8"),
    })),
    ...tree(path.join(appRoot, "lib"))
      .filter((file) => path.basename(file).startsWith("loom-"))
      .map((file) => ({ name: path.relative(appRoot, file), source: fs.readFileSync(file, "utf8") })),
  ] as { name: string; source: string }[];


/**
 * The body of every `useEffect(...)` in a source, by paren matching.
 *
 * Quotes are tracked so a parenthesis inside a string cannot end a block early.
 * Comments are stripped first, for the reason `code()` exists at all.
 */
function effectBodies(source: string): string[] {
  const body = code(source);
  const found: string[] = [];
  const NEEDLE = "useEffect(";
  for (let start = body.indexOf(NEEDLE); start !== -1; start = body.indexOf(NEEDLE, start + 1)) {
    let depth = 0;
    let quote = "";
    for (let i = start + NEEDLE.length - 1; i < body.length; i++) {
      const ch = body[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          found.push(body.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return found;
}

/** Import statements removed, so naming a verb is not mistaken for calling it. */
const withoutImports = (source: string) => code(source).replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");

describe("the tri-state gate is defined once and imported everywhere", () => {
  test("exactly one module renders a gate chip, and it is gate-chip.tsx", () => {
    // Cross-surface invariant: a gate renders identically on the deck, in the
    // rail and in the Program tab. That is satisfied by there being ONE
    // definition, not by three surfaces being careful.
    const definitions = surfaces().filter((file) => /export function GateChip\b/.test(file.source));
    expect(definitions.map((file) => file.name)).toEqual(["gate-chip.tsx"]);
  });

  test("exactly one module maps a gate outcome to a token", () => {
    const owners = vertical().filter((file) => /export function describeGate\b/.test(file.source));
    expect(owners.map((file) => file.name)).toEqual([path.join("lib", "loom-gate.ts")]);
  });

  test("a surface that draws a gate imports the shared chip rather than spelling one", () => {
    for (const { name, source } of surfaces()) {
      if (name === "gate-chip.tsx") continue;
      if (!/<Gate(Chip|ToneChip)\b/.test(source)) continue;
      expect(source, `${name} draws a gate chip without importing the shared module`).toContain(
        "./gate-chip",
      );
    }
  });

  test("`unknown` is a warning token and is never dressed as a pass", () => {
    // Exit 2 means the gate COULD NOT RUN. A checkmark there is the UI
    // inventing an answer nothing gave it, and it is the single failure this
    // module exists to make impossible. The tone table is the one place the
    // mapping is decided, so it is the one place worth pinning.
    const table = read("../../lib/loom-gate.ts");
    const unknown = /unknown:\s*\{[\s\S]*?\},/.exec(code(table))?.[0] ?? "";
    expect(unknown).not.toBe("");
    expect(unknown).toContain("warning");
    expect(unknown).not.toContain("success");
    // AND THE WORDS DIFFER TOO, so the distinction survives a greyscale
    // screenshot and colour-blindness.
    expect(unknown).toContain("could not verify");
  });

  test("no surface writes its own outcome-to-class branch", () => {
    // The failure this prevents: a row that decides its own colour, which is
    // how `unknown` becomes green in exactly one place and nobody notices.
    for (const { name, source } of surfaces()) {
      if (name === "gate-chip.tsx") continue;
      const branch = /["'](pass|fail|unknown)["']\s*(?:\?|===|:)[^\n]*\b(?:text|bg|border)-(success|destructive|warning)/;
      expect(branch.test(code(source)), `${name} maps a gate outcome to a class of its own`).toBe(false);
    }
  });

  test("a gate is never rendered as a boolean", () => {
    // `GateOutcome` is three-valued everywhere, including in the Program tab's
    // exit-code table. A checkbox or a switch bound to a gate would be a fourth
    // spelling of the bug this whole design is built against.
    for (const { name, source } of surfaces()) {
      expect(/<(?:Switch|input[^>]*type=["']checkbox["'])[^>]*gate/i.test(code(source)), `${name} draws a gate as a boolean`).toBe(false);
    }
  });
});

describe("the wire types are the engine's, never a local copy", () => {
  test("nothing in this vertical declares its own Loom-shaped type", () => {
    // The old mockup declared `type Loom = {...}` beside its fixture, and that
    // is precisely how a UI drifts from the record it claims to draw: the
    // component compiles against a shape nothing produces. Every one of these
    // names belongs to `@telar/engine-client`.
    const forbidden = /^\s*(?:export\s+)?(?:type|interface)\s+(Loom|LoomState|LoomProgram|LoomProgramDoc|LoomOverview|LoomProjectSummary|LoomRun|LoomWatch|TriageEntry|LedgerEntry|GateOutcome|Rung)\b/m;
    for (const { name, source } of vertical()) {
      const match = forbidden.exec(code(source));
      expect(match?.[1], `${name} declares a local \`${match?.[1]}\` instead of importing the engine's`).toBeUndefined();
    }
  });

  test("a file that names a wire type imports it from the engine client", () => {
    for (const { name, source } of vertical()) {
      const body = code(source);
      if (!/\b(Loom|LoomOverview|LoomProgram|TriageEntry|LedgerEntry|Rung)\b/.test(body)) continue;
      if (!/\bfrom ["']@telar\/engine-client["']/.test(body)) {
        // Re-exporting through another loom module is fine; inventing one is not.
        expect(/\bfrom ["']\.{1,2}\//.test(body) || /\bfrom ["']@\/lib\/loom-/.test(body), `${name} names a wire type without importing one`).toBe(true);
      }
    }
  });
});

describe("nothing here is shaped like one forge's schema", () => {
  test("no shared component hardcodes tracker vocabulary", () => {
    /**
     * "Items are too big, and they have a lot of visuals from GitHub issues
     * where they should be more like sessions; do not fit the UI to a single
     * example."
     *
     * An `item` is A STRING the project's own `list` command produced. It may
     * be `#491`, `inbox.md:12`, or a sentence. A component that says "issue",
     * "milestone" or "label" has assumed a tracker that the four command slots
     * exist specifically to avoid assuming.
     *
     * ── "REPOSITORY" IS BANNED AND "REPO" IS NOT ────────────────────────────
     * That asymmetry is on purpose — do not "fix" this regex to catch both.
     *
     * A TRACKER IS ABSTRACTED; A VCS IS NOT. Git is assumed everywhere in this
     * design and the artifact's own shape says so: `LoomWork.base` and
     * `LoomWork.branchPrefix` are non-optional with defaults, `Loom.branch` and
     * `Loom.worktreePath` exist at all, §8 cuts a worktree and branches off
     * `<base>` for every loom whatever the work source, §10's risk posture is
     * git-shaped (never pushes to base, never force-pushes), and even §1's
     * deliberately tracker-less example still publishes with
     * `git push -u origin $BRANCH`. There is no shape here for a project
     * without a git checkout, so "the project repo" is an honest sentence.
     *
     * "Repository" is the fence-sitter, and it falls on the banned side because
     * it is also the forge's own noun for the thing that HOLDS the issues —
     * which is precisely the assumption being guarded against. `repos?itor`
     * therefore matches "repository"/"repositories" and deliberately not bare
     * "repo".
     *
     * See `packages/engine-client/src/protocol/loom.ts`'s header, decision 2,
     * which names this boundary and points back at this test as its
     * enforcement.
     */
    const forbidden = /\b(github|issues?|milestones?|repos?itor(?:y|ies)|assignees?)\b/i;
    for (const { name, source } of surfaces()) {
      const match = forbidden.exec(code(source));
      expect(match?.[0], `${name} hardcodes "${match?.[0]}" — an item is a string, not a tracker row`).toBeUndefined();
    }
  });

  test("the vocabulary guard bans `repository` and permits `repo`, deliberately", () => {
    /**
     * THE ASYMMETRY ABOVE, MADE EXECUTABLE.
     *
     * A comment saying "do not widen this regex" is advice; this is the thing
     * that goes red when someone widens it anyway, with a name that tells them
     * what they broke. It also pins the other direction: a regex quietly
     * narrowed to stop matching "repository" would let the forge's own noun for
     * the thing that holds the issues back into the copy.
     */
    const forbidden = /\b(github|issues?|milestones?|repos?itor(?:y|ies)|assignees?)\b/i;
    // Git is assumed. These sentences are honest and must keep compiling.
    for (const allowed of ["the project repo", "a repo with no tracker", "REPO"]) {
      expect(forbidden.test(allowed), `"${allowed}" should be allowed — a VCS is assumed`).toBe(false);
    }
    // A tracker is not assumed. These must not survive review.
    for (const banned of ["the repository", "two repositories", "a GitHub issue", "its milestone", "the assignee"]) {
      expect(forbidden.test(banned), `"${banned}" should be banned — a tracker is not assumed`).toBe(true);
    }
  });

  test("the boundary's other half still points back at this test", () => {
    /**
     * A POINTER THAT NOTHING ENFORCES IS WORSE THAN NO POINTER, because it
     * reads as covered.
     *
     * The vocabulary rule is documented in two places that cite each other:
     * `protocol/loom.ts`'s header states the tracker/VCS boundary and names
     * THIS FILE as its enforcement, and the comment above cites that header
     * back. Both directions were verified by hand once. Neither was enforced,
     * which is the same one-way-citation mistake this build made twice
     * independently — here, and on the `attempts` default guard.
     *
     * So the half that matters is asserted: if the header stops naming this
     * file, the rule becomes enforcement nobody can find from the type it
     * constrains, and the next person to relax a line of UI copy will read a
     * boundary that sounds documented and is not. A moved or renamed file
     * SHOULD fail here — that is the signal, not brittleness.
     */
    const header = path.join(appRoot, "..", "..", "packages", "engine-client", "src", "protocol", "loom.ts");
    expect(fs.existsSync(header), `${path.relative(appRoot, header)} is not where this test's citation says — update both ends`).toBe(true);
    const source = fs.readFileSync(header, "utf8");
    expect(
      source.includes("components/loom/idiom.test.ts"),
      "protocol/loom.ts no longer names this file as the enforcement of the tracker/VCS boundary — restore the citation, or delete the one pointing back at it",
    ).toBe(true);
  });

  test("a loom row leads with its title, not with a reference number", () => {
    // A loom is a SESSION. The item ref rides the second line in mono, as
    // addressing rather than as identity — the same treatment a session id gets
    // everywhere else in Telar.
    const rows = read("rows.tsx");
    expect(rows).toContain("loomTitle");
    expect(rows).toContain("font-mono text-muted-foreground/70");
  });

  test("no surface reports money", () => {
    // `fmtCost` was deliberately removed from `lib/format.ts`: only some
    // providers report a price, a subscription seat has none, and `$0.0000`
    // reads as free rather than as unknown. A loom row must not reintroduce it.
    for (const { name, source } of surfaces()) {
      expect(/\$\{?[0-9]|fmtCost|costUsd/.test(code(source)), `${name} reports money`).toBe(false);
    }
  });
});

describe("a row answers one question", () => {
  /**
   *   *What is this, and what do I do about it?*
   *
   * THE OWNER'S SECOND COMPLAINT, SURVIVING ONE LEVEL DOWN. A published row on
   * the live deck rendered: the title, the item, the step sentence, the branch,
   * a gate chip, a relative time, A SECOND GATE CHIP, a full session id, an
   * absolute worktree path, the branch AGAIN, and then the publish sentence.
   * Every one of those is true; together they are the bombardment the page was
   * restructured to end, reassembled inside a 60px row.
   */
  const rows = read("rows.tsx");
  const deck = read("deck.tsx");

  test("each fact is stated once", () => {
    expect(code(rows).split("<GateChip").length - 1, "the row draws more than one gate chip").toBe(1);
    expect(code(deck).includes("<GateChip"), "the deck adds a second gate chip to a row it did not draw").toBe(false);
    expect(code(rows).split("{loom.branch}").length - 1, "the row prints the branch more than once").toBe(1);
    expect(code(deck).includes("{loom.branch}"), "the deck repeats the branch the row already drew").toBe(false);
  });

  test("a section cannot hang chrome on a row", () => {
    // `trailing` existed for exactly one caller, and that caller used it to
    // draw the gate chip a second time. `children` stays, because that is where
    // a section hangs its own VERB — an answer box, a link out — and a verb is
    // the one thing a row cannot supply for itself.
    expect(code(rows).includes("trailing"), "rows.tsx took back a slot for section chrome").toBe(false);
  });

  test("addressing is disclosed, never displayed", () => {
    /**
     * `session_d7868765d2b649dcb04f52edbee17172` and
     * `/private/tmp/telar-…/worktrees/loom-…` are DEBUGGING OUTPUT. Real, worth
     * keeping — at 2am the worktree path is the first thing you want — and not
     * what a person reads the deck for in the morning, when it is a wall of hex
     * between them and the title.
     */
    const body = code(rows);
    expect(body).toContain("aria-expanded");
    // RENDERED, not merely mentioned: `Boolean(loom.sessionId || …)` decides
    // whether there is anything to disclose, and that is not a rendering.
    const disclosureAt = body.indexOf("function Addressing");
    expect(disclosureAt, "rows.tsx has no disclosure to put the addressing behind").toBeGreaterThan(-1);
    for (const field of ["{loom.worktreePath}", "{loom.sessionId}"]) {
      const at = [...body.matchAll(new RegExp(field.replace(/[{}.]/g, "\\$&"), "g"))].map((match) => match.index ?? -1);
      expect(at.length, `${field} is rendered ${at.length} times; it belongs in the disclosure once`).toBe(1);
      expect(at[0], `${field} is rendered outside the disclosure`).toBeGreaterThan(disclosureAt);
    }
  });

  test("the classification pile stays scannable, and nothing is summarised away", () => {
    /**
     * 33 of 37 items land in this pile. A paragraph each turns the one pane
     * that answers "what did it decide about everything" into six screens.
     *
     * IT TRUNCATES, IT DOES NOT SUMMARISE. The reason and the ask are the
     * classifier's own sentences and the durable output of a tick that
     * dispatched nothing; cutting them to a code would throw away the product.
     * Truncation is a rendering — every word is one click away and nothing was
     * rewritten.
     */
    const body = code(deck);
    expect(body).toContain("TriageRow");
    expect(body.split('open ? "" : "truncate"').length - 1, "the reason and the ask do not both collapse").toBe(2);
    expect(body).toContain("{entry.reason}");
    expect(body).toContain("{ask}");
  });
});

describe("the boundaries this vertical could trip", () => {
  test("nothing imports the frozen app's `@/components/looms`", () => {
    // PLURAL `looms/` is on the banned-import list in
    // `lib/engine/source-boundary.test.ts` because it names the frozen app's
    // directory. This one is SINGULAR `loom/`, and the ban list is not amended.
    for (const { name, source } of vertical()) {
      expect(source.includes('@/components/looms'), `${name} imports the frozen app's directory`).toBe(false);
    }
  });

  test("this directory is singular", () => {
    expect(path.basename(dir)).toBe("loom");
  });
});

describe("two columns, and never a third", () => {
  /**
   * THE PRODUCT OWNER'S VERDICT, MADE EXECUTABLE.
   *
   *   "The 4 column design is not that good in general."
   *
   * This page was app sidebar + loom rail + conversation + Program panel, and
   * five whenever a real session loaded, because the stock cockpit brings its
   * own right panel. An earlier fix resized the panel, which treated the
   * symptom: the arrangement was wrong, not its widths.
   *
   * SO THE RULE IS PINNED, NOT THE MECHANISM. The tests below do not care
   * whether the segments are a query param, a route segment or a tab strip.
   * They care that nothing in this vertical declares a PERSISTENT SIDE COLUMN
   * of its own, that the orchestrator STACKS rather than rows, and that its one
   * content region renders exactly one segment at a time. Any of the three
   * going red means the third column is back, whatever it is spelled as.
   *
   * THE COCKPIT'S OWN PANEL IS NOT A THIRD COLUMN AND IS NOT BANNED. It is the
   * second column of the conversation, which is the whole content column when
   * it is on screen at all — that is exactly why the conversation had to become
   * a segment rather than a pane.
   */

  test("no loom surface declares a side column of its own", () => {
    for (const { name, source } of surfaces()) {
      const body = code(source);
      expect(/<aside\b/.test(body), `${name} declares an <aside> — a persistent column beside the content`).toBe(false);
      // A remembered, draggable width is what an auxiliary COLUMN needs and
      // nothing else does.
      expect(/RightPanelResizeHandle|useSidebarPrefs|--right-panel-width/.test(body), `${name} carries panel-resize plumbing`).toBe(
        false,
      );
      // A fixed, unshrinkable width is the other spelling: it takes its pixels
      // off the top and the content absorbs whatever the window lacks.
      expect(
        /w-\[\d+px\][^"'`]*shrink-0|shrink-0[^"'`]*w-\[\d+px\]/.test(body),
        `${name} pins a fixed-width column that cannot shrink`,
      ).toBe(false);
    }
  });

  test("nothing here folds a column away at a breakpoint, because there is none to fold", () => {
    // `useNarrowWindow` existed to decide WHICH of three columns lost. A page
    // with one content column has no such decision, and reaching for this hook
    // again is the tell that a second one came back.
    for (const { name, source } of vertical()) {
      expect(code(source).includes("useNarrowWindow"), `${name} folds a column at a breakpoint`).toBe(false);
      expect(code(source).includes("right-panel-layout"), `${name} imports the panel's sizing constants`).toBe(false);
    }
  });

  test("the orchestrator stacks its children; it does not lay them out in a row", () => {
    // A bar and one content region, top to bottom. A `flex` ROW at the page
    // root is the shape a third column grows out of.
    const body = code(read("orchestrator.tsx"));
    const root = /<div className="([^"]*h-dvh[^"]*)"/.exec(body)?.[1] ?? "";
    expect(root, "the orchestrator's root is not a full-height element").not.toBe("");
    expect(root, "the orchestrator's root lays its children out in a row").toContain("flex-col");
  });

  test("the content column shows exactly one segment at a time", () => {
    /**
     * Every segment is rendered under its own `view === "…"` guard, one per
     * entry in `LOOM_VIEWS` and no more. Two segments rendered as siblings —
     * which is what a panel IS — would show up here as a guard missing.
     */
    const body = code(read("orchestrator.tsx"));
    const views = read("../../lib/loom-views.ts");
    const ids = [...views.matchAll(/id: "([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["deck", "program", "ledger", "conversation"]);
    for (const id of ids) {
      const guards = body.split(`view === "${id}"`).length - 1;
      expect(guards, `the ${id} segment is not rendered under exactly one guard`).toBe(1);
    }
    // And nothing else renders one of these surfaces unguarded.
    for (const tag of ["<LoomDeck", "<ProgramView", "<LoomLedger", "<SessionCockpit"]) {
      expect(body.split(tag).length - 1, `${tag} appears more than once in the content region`).toBe(1);
    }
  });

  test("only the conversation is kept mounted while hidden, and that is deliberate", () => {
    /**
     * §4.3 — CORRECTION IS THE LOOP. The product's core motion is Program ↔
     * Conversation, flipped repeatedly while you correct the artifact; a plain
     * unmount re-hydrates the session and loses its scroll position on every
     * flip, taxing the one motion the feature exists for. So the conversation
     * hides instead.
     *
     * THIS IS THE TEST THAT STOPS SOMEBODY "TIDYING" IT BACK. A `hidden` that
     * looks redundant is exactly the kind of thing a later pass deletes.
     *
     * IT IS ALSO NOT A LOOPHOLE. `display:none` has no width and takes no room,
     * so a hidden subtree is not the third column this page refuses — and there
     * is exactly ONE of them, so "one content at a time" cannot be quietly
     * relaxed into "render them all and hide four".
     */
    const body = code(read("orchestrator.tsx"));
    // `"hidden"` with its quotes: `overflow-hidden` lives inside a longer
    // class string and is deliberately not matched.
    expect(body.split('"hidden"').length - 1, "more than one segment is kept mounted and hidden").toBe(1);
    expect(body, "the conversation is hidden unconditionally rather than when it is not the active segment").toContain(
      '!conversing && "hidden"',
    );
  });

  test("hiding a segment did not smuggle a column back in", () => {
    // The three structural guards, re-asserted against the file that got the
    // exception, so the exception cannot be the hole they are read through.
    const body = code(read("orchestrator.tsx"));
    expect(/<aside\b/.test(body)).toBe(false);
    expect(/w-\[\d+px\][^"'`]*shrink-0|shrink-0[^"'`]*w-\[\d+px\]/.test(body)).toBe(false);
    expect(/RightPanelResizeHandle|useSidebarPrefs|--right-panel-width/.test(body)).toBe(false);
  });

  test("the chosen segment is in the URL, so a person can link someone to the Ledger", () => {
    // A tab strip that keeps its choice in `useState` is a surface nobody can
    // send you.
    const views = read("../../lib/loom-views.ts");
    expect(views).toContain("export function loomViewHref");
    expect(views).toContain("?view=");
    expect(read("../../app/looms/[projectId]/page.tsx")).toContain("searchParams");
  });

  test("the segment parser is not exported from a client module", () => {
    // A function exported from `"use client"` is a CLIENT REFERENCE on the
    // server, not a function. The page calls this one for real while rendering,
    // so it lives where both sides can run it. This was a 500, not a theory.
    expect(read("../../lib/loom-views.ts").startsWith('"use client"')).toBe(false);
    expect(code(read("orchestrator.tsx"))).not.toContain("export function loomView");
  });
});

describe("the chat is stock Telar and is not reimplemented", () => {
  test("the orchestrator renders session-cockpit rather than a transcript of its own", () => {
    const orchestrator = read("orchestrator.tsx");
    expect(orchestrator).toContain("@/components/session-cockpit");
    expect(orchestrator).toContain("<SessionCockpit");
  });

  test("no loom component builds a message list or a composer", () => {
    // A standing instruction from the product owner, and the reason the
    // previous mockup was rejected. The orchestrator is a stock Telar session.
    for (const { name, source } of surfaces()) {
      const body = code(source);
      expect(/<Composer\b|<Transcript\b|<Message\b|<ConversationContent\b/.test(body), `${name} builds a chat`).toBe(
        false,
      );
      expect(/\bmessages\.map\(|\bturns\.map\(/.test(body), `${name} renders a transcript`).toBe(false);
    }
  });
});

describe("what the deck promises", () => {
  const deck = read("deck.tsx");

  test("one project's deck is a slice of the same read, not a second one", () => {
    // `/looms/[projectId]`'s Deck segment renders the same four piles narrowed
    // to one project. The narrowing is a pure function over the snapshot.
    expect(code(deck)).toContain("scopeOverview");
    expect(read("../../lib/loom-deck.ts")).toContain("export function scopeOverview");
  });

  test("the whole deck comes from one read", () => {
    // Two surfaces on separate cadences disagree with no way to tell which is
    // stale. `GET /api/looms` returns the entire snapshot.
    expect(code(deck)).not.toMatch(/fetch\(["']\/api\/looms/);
    expect(read("../../lib/loom-overview.ts")).toContain('fetch("/api/looms")');
  });

  test("the deck abstains from the two single-subject routes, and that is design, not a gap", () => {
    /**
     * `GET /api/looms/triage` AND `GET /api/looms/:loomId` EXIST AND ARE
     * CORRECT. An engine-client consumer, a script, or a future surface all
     * have honest reasons to read one loom or the triage cache on its own.
     * THIS surface must not, because both already arrive inside `LoomOverview`
     * — so a second read of either is two schedules disagreeing, with nothing
     * in either payload saying which half is stale. That is the failure the
     * spool learned expensively and the reason the one-call rule exists.
     *
     * WHY THIS IS A TEST AND NOT A COMMENT. The abstention is an ABSENCE in the
     * source, which reads identically to an oversight — and the "fix" is the
     * natural one to reach for ("the triage list looks stale, poll it
     * directly"). It would be type-correct, lint-clean, green on every other
     * test here, and wrong in a way that takes an afternoon to see. Guard what
     * can rot silently, not what is symmetric.
     *
     * The sibling routes WITH a path segment — `/answer`, `/cancel` — are
     * writes, not reads, and are deliberately still allowed. Exempting them
     * matters as much as catching the reads: a guard that also blocked the
     * writes would be worse than none, because the fix for it is to weaken it.
     *
     * ── ITS REACH, SO NOBODY READS THIS AS EXHAUSTIVE ───────────────────────
     * Three forms slip past the single-loom arm and are known to:
     *
     *     `/api/looms/${id}?full=1`     query suffix
     *     "/api/looms/" + id            string concatenation
     *     `${base}/api/looms/${id}`     prefixed base
     *
     * That is deliberate, not an oversight to be tidied later. None of the
     * three is a form anyone writes in this codebase — every fetch here is a
     * bare template literal against a root-relative path — so widening would
     * buy precision against inputs that do not occur, at the cost of a regex
     * nobody can read and that starts catching the legal writes by accident.
     *
     * What this guard is FOR is the natural expression of the mistake — "the
     * triage list looks stale, poll it directly" — which now fails by name.
     * A guard that catches what a person would actually type, and exempts what
     * must stay legal, is doing its job; one that claims to be a proof is
     * making a promise it cannot keep.
     */
    const singleLoomRead = /`\/api\/looms\/\$\{[^}]*\}`/;
    for (const { name, source } of vertical()) {
      const body = code(source);
      expect(body.includes("/api/looms/triage"), `${name} reads the triage cache separately from the snapshot`).toBe(
        false,
      );
      expect(singleLoomRead.test(body), `${name} reads one loom separately from the snapshot`).toBe(false);
    }
  });

  test("a published row always names where the work went, and only ever links to a real URL", () => {
    /**
     * MEASURED ON A LIVE RUN. A project whose `publish` echoed
     * `published local://loom/strip-openai-prefix` published successfully, the
     * branch really reached the remote, and `publishedUrl` came back `null` —
     * so this section, the one the whole design ends at, drew a row that said
     * "ready to review" with nothing at all to act on.
     *
     * The engine deliberately still records no URL for that (`firstUrl` stays
     * http(s): this value goes into an `href`, and a scheme the browser cannot
     * open is a control that lies about being a hand-off). So the fallback is
     * here, and it is the BRANCH — as text, never as a link, because
     * `href="loom/x"` is a relative URL that would navigate off the deck.
     */
    const body = code(deck);
    expect(body).toContain("published; the publish command printed no link");
    expect(/href=\{loom\.branch/.test(body), "the deck links to a branch name as though it were a URL").toBe(false);
  });

  test("the classification pane is a heading and a count, and nothing else", () => {
    /**
     * "It bombards the user with too much information."
     *
     * This pane used to carry a paragraph above it explaining why a pile of
     * unactionable items is an asset rather than an error list, and every pile
     * carried a second sentence of its own. Both were the designer justifying
     * himself inside the UI. The heading names the pile, the count sizes it,
     * and the reasoning lives in `docs/plans/loom-build.md`.
     */
    expect(deck).toContain("Seen and not taken");
    const flat = code(deck).replace(/\s+/g, " ");
    expect(flat).not.toContain("Most of a good backlog");
    expect(flat).not.toContain("the classification is the work");
    // The per-pile blurbs went with it — a pile is a label and a count.
    expect(code(read("../../lib/loom-deck.ts"))).not.toContain("blurb");
  });

  test("a row that asks says what was already tried", () => {
    // The human is answering a question, not doing triage.
    expect(deck).toContain("ladderSummary");
    expect(deck).toContain("ladderTrace");
    expect(deck.replace(/\s+/g, " ")).toContain("absorbed");
  });

  test("an empty cockpit invites setup rather than rendering a broken page", () => {
    // An empty section with no explanation is a dead end, so an empty state
    // keeps ONE short line. It is one line and not three.
    expect(deck).toContain("NoProgramYet");
    expect(deck).toContain("No orchestrator yet");
  });

  test("the diagnostic channel is rendered, so tolerance is never silent loss", () => {
    // A loom record the store could not read is SKIPPED and reported. A deck
    // that dropped the report would show a shrunken list with no sign anything
    // was wrong.
    expect(deck).toContain("overview.unreadable.length > 0");
    expect(deck).toContain("could not be read");
  });
});

describe("what the Program segment promises", () => {
  const panel = read("program.tsx");

  test("the per-slot explanations are gone and the substitution vars are not", () => {
    // The prose said what each slot is HANDED, in a paragraph under every one
    // of the four. The `$NAME` chips say the same thing in a word a sentence
    // cannot replace, so they stay and the paragraphs do not.
    expect(code(panel)).not.toContain("contract");
    expect(code(panel).replace(/\s+/g, " ")).not.toContain("One cheap line to stdout");
  });

  test("all four command slots are editable and their substitution vars are shown", () => {
    for (const slot of ["probe", "list", "detail", "publish"]) {
      expect(panel, `the ${slot} slot is missing`).toContain(`id: "${slot}"`);
    }
    for (const name of ["$ITEM", "$BRANCH", "$TITLE", "$BODY", "$BASE"]) {
      expect(panel, `${name} is not shown`).toContain(name);
    }
  });

  test("a gate renders its exit-code table and its on-unknown policy", () => {
    expect(panel).toContain("gateExitRows");
    expect(panel).toContain("UNDECLARED_EXIT_SENTENCE");
    expect(panel).toContain('"hold"');
    expect(panel).toContain('"publish"');
  });

  test("every rung shows its absorbed count", () => {
    // The number that tells the human whether their ladder is any good. It is
    // never behind a disclosure.
    expect(panel).toContain("rung.absorbed");
    expect(panel.replace(/\s+/g, " ")).toContain("absorbed ${rung.absorbed}");
  });

  test("the raw artifact is always one click away", () => {
    expect(panel).toContain("SourceBlock");
    expect(panel).toContain("Source");
  });

  test("the reasoning paragraphs are gone from every block", () => {
    /**
     * Each of these explained a design decision to a reader who did not ask.
     * If a reader genuinely needs the reasoning, `docs/plans/loom-build.md` is
     * where it lives — a UI that argues with you is not a UI.
     */
    const flat = code(panel).replace(/\s+/g, " ");
    for (const prose of [
      "These run on your machine, unattended",
      "Escalations go to the orchestrator first",
      "The interval doubles after each quiet probe",
      "A wrong assumption you can see is survivable",
      "The engine parses this and renders it back",
      "Press it after every correction",
    ]) {
      expect(flat, `program.tsx still explains itself: "${prose}…"`).not.toContain(prose);
    }
  });

  test("what the engine said is never truncated to a code", () => {
    // A refusal and a parser warning are the whole value of the engine's
    // refusals. The copy pass cut prose, not these.
    expect(panel).toContain("{error}");
    expect(panel).toContain("{warning}");
  });

  test("the dry run is rendered as a report, not a spinner", () => {
    expect(panel).toContain("dryRunLoom");
    expect(panel).toContain("RunReport");
    expect(panel).toContain("decision.ask");
  });

  test("editing writes the whole markdown back through the engine", () => {
    // The engine owns `parseProgram`/`renderProgram`. A second renderer in the
    // browser would drift from the first.
    expect(panel).toContain("@/lib/loom-program-markdown");
    expect(read("../../lib/loom-actions.ts")).toContain('send<T>("/api/looms/program", { method: "PUT"');
  });
});

describe("nothing spends money without a human pressing something", () => {
  /**
   * THE PROPERTY, AND WHY IT IS WORTH A TEST.
   *
   * These verbs start agent work: a session that goes and reads a repository, a
   * tick, a dry run, a dispatch. The design's whole risk posture is that nothing
   * compounds silently — it opens PRs it never merges, it holds rather than
   * pushing when a gate could not be verified, and it writes down what it
   * assumed instead of guessing quietly. An agent that starts because someone
   * navigated to a page is the same class of mistake: an effect the human did
   * not ask for and could not see coming, billed to the person most likely to
   * open the deck at 2am precisely to find out what happened overnight.
   *
   * This was a real regression, not a hypothetical: the first cut of
   * `orchestrator.tsx` called `ensureLoomSession` from a mount effect. It is
   * exactly the rule someone breaks later while adding a convenience.
   */
  const SPENDING = ["ensureLoomSession", "dryRunLoom", "tickLoom", "dispatchLoom", "suggestLoomProgram"];
  /** Everything that writes at all — a superset, held to the weaker rule below. */
  const WRITES = [...SPENDING, "answerLoom", "cancelLoom", "saveLoomProgram", "setLoomWatch"];

  test("no effect anywhere in this vertical starts work", () => {
    for (const { name, source } of vertical()) {
      for (const effect of effectBodies(source)) {
        for (const verb of WRITES) {
          expect(effect.includes(`${verb}(`), `${name} calls ${verb} from a useEffect`).toBe(false);
        }
      }
    }
  });

  test("every call site of a spending verb sits in a press handler", () => {
    // `onClick` / `onCheckedChange` and nothing else: not a render body, not a
    // memo, not a ref callback.
    for (const { name, source } of surfaces()) {
      const body = withoutImports(source);
      for (const verb of SPENDING) {
        for (let at = body.indexOf(`${verb}(`); at !== -1; at = body.indexOf(`${verb}(`, at + 1)) {
          const before = body.slice(Math.max(0, at - 500), at);
          const handler = /on(?:Click|CheckedChange|Submit)=\{/.test(before);
          expect(handler, `${name} calls ${verb} outside a press handler`).toBe(true);
        }
      }
    }
  });

  test("only the setup invitation creates an orchestrator session", () => {
    // One call site, so there is one place to read and one place to change.
    const callers = surfaces().filter(({ source }) => withoutImports(source).includes("ensureLoomSession("));
    expect(callers.map((file) => file.name)).toEqual(["program.tsx"]);
  });

  test("the invitation says what pressing it will do", () => {
    // The dry run is the trust surface because it shows what WOULD happen before
    // anything is spent. The setup button carries the same honesty in miniature.
    const flat = read("program.tsx").replace(/\s+/g, " ");
    expect(flat).toContain("goes and reads the project, so it costs tokens");
    expect(flat).toContain("Nothing runs until you press it");
  });

  test("nothing is triggered by hover, focus, or pointer entry", () => {
    // Forecloses the convenience that would break this next: "warm it up when
    // they hover the row".
    for (const { name, source } of surfaces()) {
      expect(/on(?:MouseEnter|MouseOver|PointerEnter|Focus)=/.test(code(source)), `${name} acts on hover or focus`).toBe(
        false,
      );
    }
  });
});
