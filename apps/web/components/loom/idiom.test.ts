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

  test("the classification pane frames itself as an asset, not an error list", () => {
    expect(deck).toContain("Seen and not taken");
    expect(deck.replace(/\s+/g, " ")).toContain("the classification is the work");
  });

  test("a row that asks says what was already tried", () => {
    // The human is answering a question, not doing triage.
    expect(deck).toContain("ladderSummary");
    expect(deck).toContain("ladderTrace");
    expect(deck.replace(/\s+/g, " ")).toContain("absorbed");
  });

  test("an empty cockpit invites setup rather than rendering a broken page", () => {
    expect(deck).toContain("NoProgramYet");
    expect(deck.replace(/\s+/g, " ")).toContain("Setup is a conversation, not a form");
  });

  test("the diagnostic channel is rendered, so tolerance is never silent loss", () => {
    // A loom record the store could not read is SKIPPED and reported. A deck
    // that dropped the report would show a shrunken list with no sign anything
    // was wrong.
    expect(deck).toContain("overview.unreadable.length > 0");
    expect(deck).toContain("could not be read");
  });
});

describe("what the Program tab promises", () => {
  const panel = read("program-panel.tsx");

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
    expect(callers.map((file) => file.name)).toEqual(["program-panel.tsx"]);
  });

  test("the invitation says what pressing it will do", () => {
    // The dry run is the trust surface because it shows what WOULD happen before
    // anything is spent. The setup button carries the same honesty in miniature.
    const flat = read("program-panel.tsx").replace(/\s+/g, " ");
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
