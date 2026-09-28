import { describe, expect, test } from "bun:test";
import { consultLabel, foldHarnessRows, harnessCandidatePath, harnessConsult, harnessInternalPath } from "./harness-paths";

/** A fixture project can live at `/tmp/exoplanets`, so "under /tmp" alone is not evidence. */
const CLAUDE_SKILL = "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz/SKILL.md";
const WORKSPACE = "/Users/facundo/work/telar";

describe("what counts as a harness-internal path", () => {
  test("a bundled skill under the harness's temp root folds, and names the skill", () => {
    expect(harnessInternalPath(CLAUDE_SKILL, WORKSPACE)).toEqual({ harness: "claude", skill: "dataviz" });
  });

  test("the same directory under either of its two macOS names answers the same", () => {
    // `/tmp` is a symlink to `/private/tmp`; rows carry either name.
    expect(harnessInternalPath("/tmp/claude-502/bundled-skills/2.1.267/abc123def456abc1/dataviz/scripts/plot.mjs", WORKSPACE)).toEqual({
      harness: "claude",
      skill: "dataviz",
    });
  });

  test("harness scratch that is not a skill still folds, with nothing invented about it", () => {
    expect(harnessInternalPath("/private/tmp/claude-502/-private-tmp-exoplanets/shell-snapshot", WORKSPACE)).toEqual({ harness: "claude" });
  });

  test("a project file is not harness-internal, however deep", () => {
    expect(harnessInternalPath(`${WORKSPACE}/apps/web/src/components/transcript.tsx`, WORKSPACE)).toBeUndefined();
  });

  test("a project that lives in /tmp is still the project", () => {
    expect(harnessInternalPath("/private/tmp/exoplanets/data/planets.csv", "/tmp/exoplanets")).toBeUndefined();
    expect(harnessInternalPath("/tmp/exoplanets/notebook.py")).toBeUndefined();
  });

  test("the workspace wins even when it sits inside a harness root", () => {
    const inside = "/tmp/claude-502/project/src/main.ts";
    expect(harnessInternalPath(inside)).toEqual({ harness: "claude" });
    expect(harnessInternalPath(inside, "/tmp/claude-502/project")).toBeUndefined();
  });

  test("a relative path is not judged at all", () => {
    expect(harnessInternalPath("components/transcript.tsx", WORKSPACE)).toBeUndefined();
  });

  test("Codex's equivalent root folds on the same shape", () => {
    expect(harnessInternalPath("/tmp/codex-502/bundled-skills/0.1.0/deadbeefdeadbeef/dataviz/SKILL.md", WORKSPACE)).toEqual({
      harness: "codex",
      skill: "dataviz",
    });
  });

  test("a version and a content hash are never mistaken for the skill's name", () => {
    expect(harnessInternalPath("/tmp/claude-1/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/", WORKSPACE)).toEqual({
      harness: "claude",
    });
  });
});

describe("what the folded line says", () => {
  test("a skill is named", () => {
    expect(consultLabel({ harness: "claude", skill: "dataviz" })).toBe("Consulted a skill: dataviz");
  });

  test("anything else says only what is known", () => {
    expect(consultLabel({ harness: "claude" })).toBe("Consulted the harness's own files");
  });
});

const read = (id: string, path: string, status = "completed") => ({ id, status, detail: { type: "file_read", read: { path } } }) as never;
const ran = (id: string, command: string, cwd?: string) =>
  ({ id, status: "completed", detail: { type: "command_execution", command: { command, ...(cwd ? { cwd } : {}) } } }) as never;
const said = (id: string) => ({ id, status: "completed", detail: { type: "assistant_message", text: "hello" } }) as never;

describe("the path a row is about", () => {
  test("a command's working directory decides for it", () => {
    expect(harnessCandidatePath(ran("a", "node plot.mjs", "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz"))).toBe(
      "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz",
    );
  });

  test("without one, the first absolute temp path in the command does", () => {
    expect(harnessCandidatePath(ran("a", "cd /private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz && node scripts/plot.mjs"))).toBe(
      "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz",
    );
  });

  test("a row about nothing pathlike offers no path", () => {
    expect(harnessCandidatePath(said("a"))).toBeUndefined();
  });
});

describe("folding a run's rows", () => {
  const workspace = WORKSPACE;

  test("a stretch of harness rows becomes one line, keeping every row inside it", () => {
    const rows = [
      read("a", CLAUDE_SKILL),
      read("b", "/private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz/references/palette.md"),
      ran("c", "cd /private/tmp/claude-502/bundled-skills/2.1.267/31072555b6351e965abe2d4388310e5b/dataviz && node scripts/plot.mjs"),
    ];
    const folded = foldHarnessRows(rows, workspace);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ kind: "consult", label: "Consulted a skill: dataviz" });
    expect(folded[0]!.items).toHaveLength(3);
  });

  test("the project's own work is untouched and keeps its place", () => {
    const rows = [read("a", `${workspace}/src/one.ts`), read("b", CLAUDE_SKILL), read("c", `${workspace}/src/two.ts`)];
    expect(foldHarnessRows(rows, workspace).map((segment) => segment.kind)).toEqual(["rows", "consult", "rows"]);
  });

  test("two different skills stay two lines", () => {
    const rows = [read("a", CLAUDE_SKILL), read("b", "/tmp/claude-502/bundled-skills/2.1.267/0fee495fbdd60971f76689e210df2a52/pdf/SKILL.md")];
    const folded = foldHarnessRows(rows, workspace);
    expect(folded.map((segment) => (segment.kind === "consult" ? segment.label : segment.kind))).toEqual([
      "Consulted a skill: dataviz",
      "Consulted a skill: pdf",
    ]);
  });

  test("a failed harness row never folds — errors survive collapse", () => {
    const rows = [read("a", CLAUDE_SKILL, "failed")];
    expect(foldHarnessRows(rows, workspace).map((segment) => segment.kind)).toEqual(["rows"]);
    expect(harnessConsult(rows[0]!, workspace)).toBeUndefined();
  });

  test("nothing folds when every row is the project's", () => {
    const rows = [read("a", `${workspace}/src/one.ts`), said("b")];
    expect(foldHarnessRows(rows, workspace)).toEqual([{ kind: "rows", items: rows }]);
  });
});
