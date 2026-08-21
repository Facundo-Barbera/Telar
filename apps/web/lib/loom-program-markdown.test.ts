// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  readBullets,
  removeAssumption,
  sectionBody,
  setBullets,
  setCommand,
  setGateCommand,
  setGateUnknownPolicy,
  setNotes,
  setRungEnabled,
  setWatchSchedule,
} from "./loom-program-markdown";

/**
 * These are SURGICAL EDITS on the artifact's own bytes, and the property under
 * test throughout is the same one: everything the human wrote that was not the
 * thing they changed must still be there afterwards. The engine owns the parser
 * and the renderer; this module only has to hand it text it will understand.
 */
const PROGRAM = `# Loom program — one

Some prose the author wrote at the top.

## Work source

\`\`\`probe
shasum inbox.md
\`\`\`

\`\`\`detail
cat notes/$ITEM.md          # $ITEM
\`\`\`

## Gates

\`\`\`gate
bun run ci
0 pass
1 fail
2 unknown
\`\`\`
On unknown: hold

\`\`\`gate
bun run typecheck
0 pass
\`\`\`

## Work

base: main
branch: t3code/<slug>
concurrency: 4

## When stuck

1 re-read the item          [on] (absorbed 4)
2 run the gate again        [on]
3 narrow the scope          [off]

## Ask me only when

- a product decision is genuinely mine
- credentials are involved

## When to look

every 300s, backing off to 3600s

## Assumed — confirm

- the base branch is main
- the check is the one in package.json

## Something the parser does not know

Kept as prose, verbatim.
`;

describe("setCommand", () => {
  test("rewrites only the fence body and leaves the fence line alone", () => {
    // The `# $ITEM` comment on the fence line is the author's, and an editor
    // that ate it would be teaching them not to write comments.
    const next = setCommand(PROGRAM, "detail", "gh view $ITEM");
    expect(next).toContain("```detail\ngh view $ITEM\n```");
    expect(next).toContain("shasum inbox.md");
  });

  test("prose around the blocks survives", () => {
    const next = setCommand(PROGRAM, "probe", "shasum -a 256 inbox.md");
    expect(next).toContain("Some prose the author wrote at the top.");
    expect(next).toContain("## Something the parser does not know");
    expect(next).toContain("Kept as prose, verbatim.");
  });

  test("a slot that is not in the file is APPENDED rather than refused", () => {
    // A Program with no `publish` is the normal case for a project that has not
    // finished setup. "You cannot fill this in because it is empty" is absurd.
    const next = setCommand(PROGRAM, "publish", "git push -u origin $BRANCH");
    expect(next).toContain("```publish\ngit push -u origin $BRANCH\n```");
    // …under the heading it belongs to, next to the slots that were already there.
    expect(next.indexOf("```publish")).toBeGreaterThan(next.indexOf("## Work source"));
  });

  test("a multi-line command survives as multiple lines", () => {
    const next = setCommand(PROGRAM, "list", "cat inbox.md \\\n  | head -50");
    expect(next).toContain("cat inbox.md \\\n  | head -50");
  });

  test("clearing a slot empties its block instead of corrupting the fence", () => {
    const next = setCommand(PROGRAM, "probe", "   ");
    expect(next).toContain("```probe\n```");
  });
});

describe("setGateUnknownPolicy", () => {
  test("rewrites the existing line for the gate it belongs to", () => {
    const next = setGateUnknownPolicy(PROGRAM, 0, "publish");
    expect(next).toContain("On unknown: publish");
    expect(next).not.toContain("On unknown: hold");
  });

  test("adds the line for a gate that has none, directly after its block", () => {
    // The line applies to the gate ABOVE it — that is how the artifact reads and
    // how the parser attaches it — so position is meaning, not cosmetics.
    const next = setGateUnknownPolicy(PROGRAM, 1, "publish");
    const afterSecondGate = next.slice(next.indexOf("bun run typecheck"));
    expect(afterSecondGate).toContain("On unknown: publish");
    // The first gate's own policy is untouched.
    expect(next).toContain("On unknown: hold");
  });

  test("an index with no gate behind it changes nothing", () => {
    expect(setGateUnknownPolicy(PROGRAM, 9, "publish")).toBe(PROGRAM);
  });
});

describe("setGateCommand", () => {
  test("replaces the command line and keeps the exit table", () => {
    const next = setGateCommand(PROGRAM, 0, "bun run verify");
    expect(next).toContain("```gate\nbun run verify\n0 pass\n1 fail\n2 unknown\n```");
  });

  test("an empty command is refused rather than writing an empty gate", () => {
    expect(setGateCommand(PROGRAM, 0, "  ")).toBe(PROGRAM);
  });
});

describe("setRungEnabled", () => {
  test("flips the toggle and keeps the label and the absorbed count", () => {
    // The absorbed count is the ladder's scoreboard. An edit that dropped it
    // would reset the only number that says whether the ladder is any good.
    const next = setRungEnabled(PROGRAM, 1, false);
    expect(next).toContain("1 re-read the item          [off] (absorbed 4)");
  });

  test("turning a rung back on is the same edit in reverse", () => {
    expect(setRungEnabled(PROGRAM, 3, true)).toContain("3 narrow the scope          [on]");
  });

  test("a rung that is not there changes nothing", () => {
    expect(setRungEnabled(PROGRAM, 9, false)).toBe(PROGRAM);
  });

  test("the rest of the ladder is byte-identical", () => {
    const next = setRungEnabled(PROGRAM, 2, false);
    expect(next).toContain("1 re-read the item          [on] (absorbed 4)");
    expect(next).toContain("3 narrow the scope          [off]");
  });
});

describe("setWatchSchedule", () => {
  test("writes the one sentence the parser reads", () => {
    const next = setWatchSchedule(PROGRAM, 60, 900);
    expect(next).toContain("every 60s, backing off to 900s");
    expect(next).not.toContain("every 300s");
  });

  test("the heading is created when the file has none", () => {
    const next = setWatchSchedule("# Loom program\n", 60, 900);
    expect(next).toContain("## When to look");
    expect(next).toContain("every 60s, backing off to 900s");
  });
});

describe("bullet sections", () => {
  test("reading strips the markers", () => {
    expect(readBullets(PROGRAM, "ask-when")).toEqual([
      "a product decision is genuinely mine",
      "credentials are involved",
    ]);
  });

  test("writing replaces the list wholesale and keeps everything after it", () => {
    const next = setBullets(PROGRAM, "ask-when", ["only when money is involved"]);
    expect(readBullets(next, "ask-when")).toEqual(["only when money is involved"]);
    expect(next).toContain("## When to look");
    expect(next).toContain("## Something the parser does not know");
  });

  test("blank entries are dropped rather than written as empty bullets", () => {
    const next = setBullets(PROGRAM, "ask-when", ["one", "   ", "", "two"]);
    expect(readBullets(next, "ask-when")).toEqual(["one", "two"]);
  });

  test("never-touch globs are written bare, because that is how they parse", () => {
    const next = setBullets(PROGRAM, "never-touch", [".env*", "supabase/.env.keys"]);
    expect(next).toContain("## Never touch\n\n.env*\nsupabase/.env.keys");
  });
});

describe("removeAssumption", () => {
  test("confirming an assumption removes it and leaves the others", () => {
    // Once read, it is no longer an assumption; the text it was assumed INTO is
    // already in the Program.
    const next = removeAssumption(PROGRAM, "the base branch is main");
    expect(readBullets(next, "assumed")).toEqual(["the check is the one in package.json"]);
  });

  test("removing the last one leaves the heading and an empty list", () => {
    let next = removeAssumption(PROGRAM, "the base branch is main");
    next = removeAssumption(next, "the check is the one in package.json");
    expect(readBullets(next, "assumed")).toEqual([]);
    expect(next).toContain("## Assumed — confirm");
  });

  test("an assumption that is not there is a no-op on the list", () => {
    const next = removeAssumption(PROGRAM, "something nobody wrote");
    expect(readBullets(next, "assumed")).toHaveLength(2);
  });
});

describe("setNotes", () => {
  test("prose lands under `## Notes`, which is where the renderer emits it", () => {
    const next = setNotes(PROGRAM, "The newest thing said wins.");
    expect(next).toContain("## Notes");
    expect(sectionBody(next, "notes").join("\n")).toContain("The newest thing said wins.");
  });

  test("clearing the notes leaves the heading rather than mangling the file", () => {
    const next = setNotes(setNotes(PROGRAM, "x"), "");
    expect(next).toContain("## Notes");
    expect(next).toContain("## Work source");
  });
});

describe("what every edit must preserve", () => {
  const edits: [string, (markdown: string) => string][] = [
    ["setCommand", (markdown) => setCommand(markdown, "probe", "true")],
    ["setGateUnknownPolicy", (markdown) => setGateUnknownPolicy(markdown, 0, "publish")],
    ["setRungEnabled", (markdown) => setRungEnabled(markdown, 2, false)],
    ["setWatchSchedule", (markdown) => setWatchSchedule(markdown, 60, 600)],
    ["setBullets", (markdown) => setBullets(markdown, "ask-when", ["one"])],
    ["setNotes", (markdown) => setNotes(markdown, "hello")],
  ];

  for (const [name, edit] of edits) {
    test(`${name} keeps the heading the parser does not understand`, () => {
      // "An unknown heading is not a syntax error, it is prose." An editor that
      // silently ate the section it did not recognise would make the artifact
      // unsafe to hand-edit, which is the whole reason it is a file.
      const next = edit(PROGRAM);
      expect(next).toContain("## Something the parser does not know");
      expect(next).toContain("Kept as prose, verbatim.");
    });

    test(`${name} keeps the title`, () => {
      expect(edit(PROGRAM)).toContain("# Loom program — one");
    });

    test(`${name} ends the file with exactly one newline`, () => {
      const next = edit(PROGRAM);
      expect(next.endsWith("\n")).toBe(true);
      expect(next.endsWith("\n\n")).toBe(false);
    });
  }

  test("edits compose without stepping on each other", () => {
    let next = setCommand(PROGRAM, "list", "cat inbox.md");
    next = setRungEnabled(next, 3, true);
    next = setGateUnknownPolicy(next, 0, "publish");
    next = setWatchSchedule(next, 120, 1200);
    expect(next).toContain("```list\ncat inbox.md\n```");
    expect(next).toContain("3 narrow the scope          [on]");
    expect(next).toContain("On unknown: publish");
    expect(next).toContain("every 120s, backing off to 1200s");
    expect(next).toContain("Some prose the author wrote at the top.");
  });

  test("CRLF input does not produce mixed line endings", () => {
    const next = setRungEnabled(PROGRAM.replace(/\n/g, "\r\n"), 2, false);
    expect(next).not.toContain("\r");
  });
});
