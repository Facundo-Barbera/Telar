/**
 * The Program artifact — parse, render, and the property that ties them.
 *
 * Two things are load-bearing here and everything else is detail:
 *
 *   1. THE PARSER HAS NO ERROR PATH. Every malformed input in this file must
 *      produce a Program and a warning, never a throw. The Program is a
 *      hand-edited markdown file in someone else's repo; if a typo can stop the
 *      orchestrator, the orchestrator stops overnight and nobody finds out
 *      until morning.
 *   2. THE ROUND TRIP IS EXACT. `parseProgram(renderProgram(p)).program`
 *      deep-equals `p`, including the awkward cases — no probe, empty ladder,
 *      unicode, `$ITEM`, absorbed counters, and notes that contain their own
 *      markdown headings. That property is what lets the UI rewrite one block
 *      of the file without disturbing the rest.
 */
import { describe, expect, test } from "bun:test";
import { LoomProgram, type LoomProgram as LoomProgramType } from "@telar/engine-client";
import {
  DEFAULT_PROGRAM,
  GITHUB_PRESET,
  GITHUB_PRESET_MARKDOWN,
  parseDuration,
  parseProgram,
  renderProgram,
} from "../src/loom/program";

const roundTrips = (p: LoomProgramType) => {
  const back = parseProgram(renderProgram(p)).program;
  expect(back).toEqual(p);
};

const program = (patch: Record<string, unknown> = {}): LoomProgramType =>
  LoomProgram.parse({ ...patch });

describe("an unknown heading degrades, it never fails", () => {
  test("the heading and its body land in notes verbatim, with a warning", () => {
    const { program: p, warnings } = parseProgram(`# Loom program — x

## Work source

\`\`\`list
gh issue list
\`\`\`

## Wen stukk

1 this was meant to be the ladder [on]
`);
    // The typo'd section did NOT become a ladder, and did NOT throw.
    expect(p.ladder).toEqual([]);
    expect(p.commands.list).toBe("gh issue list");
    expect(p.notes).toContain("## Wen stukk");
    expect(p.notes).toContain("1 this was meant to be the ladder [on]");
    expect(warnings.some((w) => w.includes("Wen stukk"))).toBe(true);
  });

  test("a file that is nothing but unknown headings still parses", () => {
    const { program: p } = parseProgram("## Nonsense\n\nwords\n\n## More nonsense\n\nmore words\n");
    expect(p.notes).toBe("## Nonsense\n\nwords\n\n## More nonsense\n\nmore words");
    expect(p.work.base).toBe("main");
  });

  test("prose before the first heading is prose, not an error", () => {
    const { program: p } = parseProgram("this file is a note to myself\n\n## Work\n\nbase: dev\n");
    expect(p.notes).toBe("this file is a note to myself");
    expect(p.work.base).toBe("dev");
  });

  test("the empty string, garbage and a lone fence all parse", () => {
    expect(() => parseProgram("")).not.toThrow();
    expect(() => parseProgram("\u0000\u0001 not markdown at all")).not.toThrow();
    expect(() => parseProgram("```gate\nunclosed forever")).not.toThrow();
    // The unclosed fence is still read as a gate rather than discarded.
    expect(parseProgram("```gate\nbun run ci\n0 pass").program.gates[0]?.command).toBe("bun run ci");
  });

  test("a missing probe is a warning, not an error", () => {
    const { program: p, warnings } = parseProgram("## Work source\n\n```list\ncat inbox.md\n```\n");
    expect(p.commands.probe).toBeUndefined();
    expect(p.commands.list).toBe("cat inbox.md");
    expect(warnings.some((w) => w.includes("sentinel is disabled"))).toBe(true);
  });
});

describe("the four command slots", () => {
  test("each fenced block fills its slot, wherever in the file it sits", () => {
    const { program: p } = parseProgram(`## Somewhere unexpected

\`\`\`probe
shasum inbox.md
\`\`\`

\`\`\`detail
sed -n "/^## $ITEM/,/^## /p" inbox.md
\`\`\`
`);
    expect(p.commands.probe).toBe("shasum inbox.md");
    expect(p.commands.detail).toContain("$ITEM");
  });

  test("a $NAME substitution is preserved literally, including the quoting around it", () => {
    const publish = 'gh pr create --draft --base $BASE --head $BRANCH --title "$TITLE" --body "$BODY"';
    const { program: p } = parseProgram("```publish\n" + publish + "\n```\n");
    expect(p.commands.publish).toBe(publish);
  });

  test("an empty block leaves the slot unset and says so", () => {
    const { program: p, warnings } = parseProgram("```probe\n\n```\n");
    expect(p.commands.probe).toBeUndefined();
    expect(warnings.some((w) => w.includes("empty `probe` block"))).toBe(true);
  });

  test("a duplicate slot takes the last one and warns", () => {
    const { program: p, warnings } = parseProgram("```list\nfirst\n```\n\n```list\nsecond\n```\n");
    expect(p.commands.list).toBe("second");
    expect(warnings.some((w) => w.includes("duplicate `list`"))).toBe(true);
  });

  test("a multi-line command survives whole", () => {
    const { program: p } = parseProgram("```list\ngh issue list \\\n  --state open\n```\n");
    expect(p.commands.list).toBe("gh issue list \\\n  --state open");
  });
});

describe("gates", () => {
  test("first line is the command, the rest is the exit table", () => {
    const { program: p } = parseProgram("## Gates\n\n```gate\nbun run ci\n0 pass\n1 fail\n2 unknown\n```\n");
    expect(p.gates).toEqual([
      { command: "bun run ci", exits: { 0: "pass", 1: "fail", 2: "unknown" }, onUnknown: "hold" },
    ]);
  });

  test("an unreadable exit line is warned about and skipped — the gate survives", () => {
    const { program: p, warnings } = parseProgram("```gate\nbun run ci\n0 pass\nprobably fine\n```\n");
    expect(p.gates[0]?.exits).toEqual({ 0: "pass" });
    expect(warnings.some((w) => w.includes("probably fine"))).toBe(true);
  });

  test("`On unknown:` binds to the gate above it, so two gates can differ", () => {
    const { program: p } = parseProgram(`## Gates

\`\`\`gate
bun run ci
0 pass
\`\`\`
On unknown: publish

\`\`\`gate
bun run e2e
0 pass
\`\`\`
On unknown: hold
`);
    expect(p.gates.map((g) => g.onUnknown)).toEqual(["publish", "hold"]);
  });

  test("an `On unknown:` line before any gate is the section default", () => {
    const { program: p } = parseProgram("## Gates\n\nOn unknown: publish\n\n```gate\nx\n0 pass\n```\n");
    expect(p.gates[0]?.onUnknown).toBe("publish");
  });

  test("an unreadable policy holds, because holding is the safe direction", () => {
    const { program: p, warnings } = parseProgram("## Gates\n\n```gate\nx\n0 pass\n```\nOn unknown: whatever\n");
    expect(p.gates[0]?.onUnknown).toBe("hold");
    expect(warnings.some((w) => w.includes("neither"))).toBe(true);
  });

  test("an empty gate block is skipped rather than becoming a nameless gate", () => {
    const { program: p, warnings } = parseProgram("```gate\n\n```\n");
    expect(p.gates).toEqual([]);
    expect(warnings.some((w) => w.includes("empty `gate` block"))).toBe(true);
  });
});

describe("the Work block", () => {
  test("base, branch prefix, concurrency and setup", () => {
    const { program: p } = parseProgram(`## Work

base: develop
branch: loom/<slug>
concurrency: 2
setup: bun install        # once per fresh worktree
`);
    expect(p.work).toEqual({ base: "develop", branchPrefix: "loom/", concurrency: 2, setup: "bun install" });
  });

  test("a branch line with no <slug> placeholder is taken whole", () => {
    expect(parseProgram("## Work\n\nbranch: bot-\n").program.work.branchPrefix).toBe("bot-");
  });

  test("a non-numeric concurrency keeps the default and says so", () => {
    const { program: p, warnings } = parseProgram("## Work\n\nconcurrency: as many as possible\n");
    expect(p.work.concurrency).toBe(4);
    expect(warnings.some((w) => w.includes("not a whole number"))).toBe(true);
  });

  test("an unknown key is kept as notes rather than thrown away", () => {
    const { program: p, warnings } = parseProgram("## Work\n\nbase: main\nremote: origin\n");
    expect(p.work.base).toBe("main");
    expect(p.notes).toContain("remote: origin");
    expect(warnings.some((w) => w.includes('unknown key "remote"'))).toBe(true);
  });
});

describe("the ladder", () => {
  test("numbered rungs with [on] / [off]", () => {
    const { program: p } = parseProgram(`## When stuck

1 re-read the item   [on]
2 run the gate again [on]
3 start from scratch [off]
`);
    expect(p.ladder).toEqual([
      { n: 1, label: "re-read the item", enabled: true, absorbed: 0 },
      { n: 2, label: "run the gate again", enabled: true, absorbed: 0 },
      { n: 3, label: "start from scratch", enabled: false, absorbed: 0 },
    ]);
  });

  test("an absorbed counter round-trips through the label", () => {
    const { program: p } = parseProgram("## When stuck\n\n1 re-read it  [on] (absorbed 12)\n");
    expect(p.ladder[0]).toEqual({ n: 1, label: "re-read it", enabled: true, absorbed: 12 });
  });

  test("a rung with no marker is treated as on, loudly", () => {
    const { program: p, warnings } = parseProgram("## When stuck\n\n1 re-read it\n");
    expect(p.ladder[0]?.enabled).toBe(true);
    expect(warnings.some((w) => w.includes("no [on]/[off]"))).toBe(true);
  });

  test("rung 0 is dropped, because 0 already means 'nothing tried yet'", () => {
    const { program: p, warnings } = parseProgram("## When stuck\n\n0 do nothing [on]\n1 do something [on]\n");
    expect(p.ladder.map((r) => r.n)).toEqual([1]);
    expect(warnings.some((w) => w.includes("numbered from 1"))).toBe(true);
  });

  test("an unnumbered line is warned about and skipped, the rest of the ladder stands", () => {
    const { program: p, warnings } = parseProgram("## When stuck\n\n- try harder\n1 re-read it [on]\n");
    expect(p.ladder.map((r) => r.n)).toEqual([1]);
    expect(warnings.some((w) => w.includes("try harder"))).toBe(true);
  });
});

describe("lists and the schedule", () => {
  test("never-touch globs read with or without bullets", () => {
    const { program: p } = parseProgram("## Never touch\n\n.env*\n- supabase/.env.keys\n");
    expect(p.neverTouch).toEqual([".env*", "supabase/.env.keys"]);
  });

  test("ask-me-only-when and assumed are bullet lists", () => {
    const { program: p } = parseProgram(
      "## Ask me only when\n\n- a product decision\n\n## Assumed — confirm\n\n- that main is the base\n",
    );
    expect(p.askWhen).toEqual(["a product decision"]);
    expect(p.assumed).toEqual(["that main is the base"]);
  });

  test("`Assumed` without the em dash is the same heading", () => {
    expect(parseProgram("## Assumed\n\n- x\n").program.assumed).toEqual(["x"]);
  });

  test("the schedule is read leniently — seconds, minutes or hours", () => {
    const read = (text: string) => parseProgram(`## When to look\n\n${text}\n`).program.watch;
    expect(read("every 300s, backing off to 3600s after 6 quiet checks")).toEqual({
      intervalSec: 300,
      backoffMaxSec: 3600,
    });
    expect(read("every 5m, backing off to 1h")).toEqual({ intervalSec: 300, backoffMaxSec: 3600 });
    expect(read("every 30, back off to 2 hours")).toEqual({ intervalSec: 30, backoffMaxSec: 7200 });
    // "after 6 quiet checks" must not be mistaken for a duration.
    expect(read("every 60s after 6 quiet checks").intervalSec).toBe(60);
  });

  test("an unreadable schedule keeps the defaults and says so", () => {
    const { program: p, warnings } = parseProgram("## When to look\n\nwhenever you feel like it\n");
    expect(p.watch).toEqual({ intervalSec: 300, backoffMaxSec: 3600 });
    expect(warnings.some((w) => w.includes("could not read a schedule"))).toBe(true);
  });

  test("parseDuration on its own", () => {
    expect(parseDuration("300")).toBe(300);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2 hours")).toBe(7200);
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
  });
});

describe("the round trip is exact", () => {
  test("the default program", () => roundTrips(DEFAULT_PROGRAM));
  test("the github preset", () => roundTrips(GITHUB_PRESET));

  test("an empty program — every list empty, no commands, no gates", () => roundTrips(program()));

  test("an empty ladder beside a full everything-else", () =>
    roundTrips(
      program({
        project: "no ladder",
        commands: { probe: "shasum inbox.md", list: "cat inbox.md" },
        gates: [{ command: "bun test", exits: { 0: "pass", 1: "fail" }, onUnknown: "hold" }],
        ladder: [],
        neverTouch: [".env*"],
        askWhen: ["anything at all"],
      }),
    ));

  test("no probe at all", () =>
    roundTrips(program({ commands: { list: "cat inbox.md", publish: "git push -u origin $BRANCH" } })));

  test("unicode in commands, labels and notes", () =>
    roundTrips(
      program({
        project: "ozom-gv — producción",
        commands: { list: "gh issue list --label 'listo ✅' --search 'búsqueda'" },
        ladder: [{ n: 1, label: "volvé a leer el ítem — y todo lo que se dijo después", enabled: true, absorbed: 3 }],
        askWhen: ["los puntos 2 y 3 son decisión de JMB"],
        notes: "日本語のノート — and an emoji 🧵",
      }),
    ));

  test("$ITEM and friends survive", () =>
    roundTrips(
      program({
        commands: {
          detail: "gh issue view $ITEM --comments",
          publish: 'gh pr create --base $BASE --head $BRANCH --title "$TITLE" --body "$BODY"',
        },
      }),
    ));

  test("multi-line notes, including blank lines", () =>
    roundTrips(program({ notes: "first paragraph\n\nsecond paragraph\n\n- and a list\n- of things" })));

  test("notes that contain their own markdown heading", () =>
    roundTrips(program({ notes: "## A heading inside the notes\n\nwith a body under it" })));

  test("two gates with different unknown policies", () =>
    roundTrips(
      program({
        gates: [
          { command: "bun run ci", exits: { 0: "pass", 1: "fail", 2: "unknown" }, onUnknown: "hold" },
          { command: "bun run e2e", exits: { 0: "pass" }, onUnknown: "publish" },
        ],
      }),
    ));

  test("a gate with an empty exit table — every code is unknown, and that is legal", () =>
    roundTrips(program({ gates: [{ command: "bun run ci", exits: {}, onUnknown: "hold" }] })));

  test("absorbed counters and mixed toggles", () =>
    roundTrips(
      program({
        ladder: [
          { n: 1, label: "re-read", enabled: true, absorbed: 41 },
          { n: 2, label: "re-gate", enabled: false, absorbed: 0 },
          { n: 7, label: "a gap in the numbering is preserved", enabled: true, absorbed: 1 },
        ],
      }),
    ));

  test("a non-default schedule and a zero concurrency", () =>
    roundTrips(program({ watch: { intervalSec: 15, backoffMaxSec: 60 }, work: { concurrency: 0 } })));

  test("rendering twice is byte-identical — the format has no drift", () => {
    const once = renderProgram(GITHUB_PRESET);
    expect(renderProgram(parseProgram(once).program)).toBe(once);
  });
});

describe("GitHub is data, not code", () => {
  test("the preset IS its markdown — nothing derives it from a source flag", () => {
    expect(GITHUB_PRESET).toEqual(parseProgram(GITHUB_PRESET_MARKDOWN).program);
  });

  test("it parses with no complaints at all", () => {
    expect(parseProgram(GITHUB_PRESET_MARKDOWN).warnings).toEqual([]);
  });

  test("every gh command lives in the text and nowhere else", () => {
    expect(GITHUB_PRESET.commands.probe).toContain("gh issue list");
    expect(GITHUB_PRESET.commands.detail).toBe("gh issue view $ITEM --comments");
    expect(GITHUB_PRESET.commands.publish).toContain("gh pr create");
    // No gate is presumed: only the project knows what its CI means.
    expect(GITHUB_PRESET.gates).toEqual([]);
    expect(GITHUB_PRESET.assumed.length).toBeGreaterThan(0);
  });

  test("a project with no tracker at all is the same shape of file", () => {
    const inbox = parseProgram(`# Loom program — inbox

## Work source

\`\`\`probe
shasum inbox.md
\`\`\`

\`\`\`list
cat inbox.md
\`\`\`

\`\`\`publish
git push -u origin $BRANCH
\`\`\`
`).program;
    expect(inbox.commands.list).toBe("cat inbox.md");
    expect(inbox.commands.publish).toBe("git push -u origin $BRANCH");
    roundTrips(inbox);
  });

  test("the default program invents no work source", () => {
    expect(DEFAULT_PROGRAM.commands).toEqual({});
    expect(DEFAULT_PROGRAM.ladder).toHaveLength(5);
    expect(DEFAULT_PROGRAM.ladder.filter((r) => r.enabled)).toHaveLength(3);
  });
});

describe("the title", () => {
  test("the project name comes off the h1, with or without a dash", () => {
    expect(parseProgram("# Loom program — ozom-gv\n").program.project).toBe("ozom-gv");
    expect(parseProgram("# Loom program: ozom-gv\n").program.project).toBe("ozom-gv");
    expect(parseProgram("# Loom program\n").program.project).toBe("");
  });

  test("an unrelated h1 is an unknown heading, not a title", () => {
    const { program: p } = parseProgram("# My notes\n\nhello\n");
    expect(p.project).toBe("");
    expect(p.notes).toContain("# My notes");
  });
});
