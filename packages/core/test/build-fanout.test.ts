import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectManifest, Verdict } from "../src/schemas";

const { piecesAreDisjoint, decideBuildFanout, splitBuild, runBuildFanout } = await import("../src/build-fanout");

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { ok: true, summary: "done", files_touched: [], blocker: null, ...overrides };
}

const fakeManifest: ProjectManifest = {
  name: "p",
  root: "/tmp/telar-fanout-fake-root",
  adapter: "plain",
  account: "personal",
  baseBranch: "main",
  gates: [],
  guardrails: { disallowedTools: [], protectedPaths: [] },
  charterPolicy: "human-required-for-epics",
};

describe("piecesAreDisjoint (pure)", () => {
  test("disjoint allowedPaths -> true", () => {
    expect(
      piecesAreDisjoint([
        { id: "a", title: "A", prompt: "p", allowedPaths: ["src/a"] },
        { id: "b", title: "B", prompt: "p", allowedPaths: ["src/b"] },
      ]),
    ).toBe(true);
  });

  test("overlapping directory prefix -> false", () => {
    expect(
      piecesAreDisjoint([
        { id: "a", title: "A", prompt: "p", allowedPaths: ["src/shared"] },
        { id: "b", title: "B", prompt: "p", allowedPaths: ["src/shared/sub"] },
      ]),
    ).toBe(false);
  });

  test("exact same path -> false", () => {
    expect(
      piecesAreDisjoint([
        { id: "a", title: "A", prompt: "p", allowedPaths: ["a.txt"] },
        { id: "b", title: "B", prompt: "p", allowedPaths: ["a.txt"] },
      ]),
    ).toBe(false);
  });

  test("a piece with empty allowedPaths is ambiguous -> conservatively false", () => {
    expect(
      piecesAreDisjoint([
        { id: "a", title: "A", prompt: "p", allowedPaths: [] },
        { id: "b", title: "B", prompt: "p", allowedPaths: ["src/b"] },
      ]),
    ).toBe(false);
  });

  test("single piece (nothing to overlap with) -> true", () => {
    expect(piecesAreDisjoint([{ id: "a", title: "A", prompt: "p", allowedPaths: ["src/a"] }])).toBe(true);
  });

  test("paths differing only by case -> false (case-insensitive filesystems alias them)", () => {
    expect(
      piecesAreDisjoint([
        { id: "a", title: "A", prompt: "p", allowedPaths: ["src/Foo"] },
        { id: "b", title: "B", prompt: "p", allowedPaths: ["src/foo/sub"] },
      ]),
    ).toBe(false);
  });
});

describe("decideBuildFanout (pure, reuses fanoutSize from budget.ts)", () => {
  const budget = { maxAgents: 12, inFlight: 0, budgetLeftUsd: Infinity, estCostPerAgent: 0.5 };

  test("1 piece -> 1 (no fan-out)", () => {
    expect(decideBuildFanout(1, budget)).toBe(1);
  });

  test("0 pieces -> 1", () => {
    expect(decideBuildFanout(0, budget)).toBe(1);
  });

  test("N pieces capped by pool room", () => {
    expect(decideBuildFanout(5, { ...budget, maxAgents: 3 })).toBe(3);
  });

  test("N pieces capped by budget left", () => {
    expect(decideBuildFanout(5, { ...budget, budgetLeftUsd: 1 })).toBe(2); // floor(1 / 0.5) = 2
  });

  test("N pieces under both caps -> the full piece count", () => {
    expect(decideBuildFanout(3, budget)).toBe(3);
  });

  test("pool already full -> 0 (no room to start anything)", () => {
    expect(decideBuildFanout(3, { ...budget, inFlight: 12 })).toBe(0);
  });
});

describe("splitBuild (injected fake agent, no live model)", () => {
  test("2 disjoint pieces pass through, agent called read-only", async () => {
    const canned = {
      pieces: [
        { id: "s1", title: "A", prompt: "do A", allowedPaths: ["src/a"] },
        { id: "s2", title: "B", prompt: "do B", allowedPaths: ["src/b"] },
      ],
    };
    let captured: { prompt: string; opts: any } | null = null;
    const fakeAgent = (async (promptText: string, opts: any) => {
      captured = { prompt: promptText, opts };
      return canned;
    }) as unknown as typeof import("../src/engine").agent;

    const pieces = await splitBuild({ prompt: "build X and Y", manifest: fakeManifest }, { agent: fakeAgent });
    expect(pieces).toEqual(canned.pieces);

    expect(captured).not.toBeNull();
    expect(captured!.opts.restrictTools).toBe(true);
    expect(captured!.opts.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(captured!.opts.tools).not.toContain("Write");
    expect(captured!.opts.tools).not.toContain("Edit");
    expect(captured!.opts.tools).not.toContain("Bash");
    expect(captured!.opts.disallowedTools).toContain("Write");
    expect(captured!.opts.disallowedTools).toContain("Edit");
    expect(captured!.opts.disallowedTools).toContain("Bash");
    expect(captured!.opts.settingSources).toEqual([]);
    expect(captured!.opts.cwd).toBe(fakeManifest.root);
  });

  test("overlapping pieces collapse to [] (no fan-out)", async () => {
    const canned = {
      pieces: [
        { id: "s1", title: "A", prompt: "do A", allowedPaths: ["src/shared"] },
        { id: "s2", title: "B", prompt: "do B", allowedPaths: ["src/shared/sub"] },
      ],
    };
    const fakeAgent = (async () => canned) as unknown as typeof import("../src/engine").agent;
    const pieces = await splitBuild({ prompt: "build X and Y", manifest: fakeManifest }, { agent: fakeAgent });
    expect(pieces).toEqual([]);
  });

  test("a single proposed piece also collapses to [] (nothing to fan out)", async () => {
    const canned = { pieces: [{ id: "s1", title: "A", prompt: "do A", allowedPaths: ["src/a"] }] };
    const fakeAgent = (async () => canned) as unknown as typeof import("../src/engine").agent;
    const pieces = await splitBuild({ prompt: "x", manifest: fakeManifest }, { agent: fakeAgent });
    expect(pieces).toEqual([]);
  });

  test("agent never emits a result -> []", async () => {
    const fakeAgent = (async () => null) as unknown as typeof import("../src/engine").agent;
    const pieces = await splitBuild({ prompt: "x", manifest: fakeManifest }, { agent: fakeAgent });
    expect(pieces).toEqual([]);
  });
});

describe("runBuildFanout (real temp git repo, fake runPieceBuilder — no live agent)", () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-fanout-repo-"));
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Telar Test"], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "original a\n");
    fs.writeFileSync(path.join(repoRoot, "b.txt"), "original b\n");
    fs.writeFileSync(path.join(repoRoot, "conflict.txt"), "original conflict\n");
    execFileSync("git", ["add", "a.txt", "b.txt", "conflict.txt"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const worktreeLines = (): string[] =>
    execFileSync("git", ["worktree", "list"], { cwd: repoRoot })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);

  test("2 disjoint pieces merge cleanly and leave no worktree behind", async () => {
    const pieces = [
      { id: "p1", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
      { id: "p2", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
    ];

    const result = await runBuildFanout({
      repoRoot,
      baseRef: "HEAD",
      pieces,
      runPieceBuilder: async (piece, cwd) => {
        fs.writeFileSync(path.join(cwd, piece.allowedPaths[0]), `new ${piece.id}\n`);
        return verdict({ summary: `${piece.id} done` });
      },
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, "a.txt"), "utf8")).toBe("new p1\n");
    expect(fs.readFileSync(path.join(repoRoot, "b.txt"), "utf8")).toBe("new p2\n");
    expect(result.merged.sort()).toEqual(["a.txt", "b.txt"]);
    expect(result.stray).toEqual([]);

    // NO WORKTREE LEAKS: only the main worktree remains registered.
    expect(worktreeLines().length).toBe(1);
  });

  test("a stray file outside allowedPaths is NOT merged and is reported", async () => {
    const pieces = [
      { id: "p3", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
      { id: "p4", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
    ];

    const result = await runBuildFanout({
      repoRoot,
      baseRef: "HEAD",
      pieces,
      runPieceBuilder: async (piece, cwd) => {
        fs.writeFileSync(path.join(cwd, piece.allowedPaths[0]), `scoped ${piece.id}\n`);
        if (piece.id === "p3") fs.writeFileSync(path.join(cwd, "c.txt"), "should never reach repoRoot\n");
        return verdict({ summary: `${piece.id} done` });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.merged.sort()).toEqual(["a.txt", "b.txt"]);
    expect(result.stray).toEqual(["c.txt"]);
    expect(fs.existsSync(path.join(repoRoot, "c.txt"))).toBe(false);
    expect(worktreeLines().length).toBe(1);
  });

  test("LEAK-ON-FAILURE: a throwing builder still removes every worktree and reports ok:false", async () => {
    const pieces = [
      { id: "p5", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
      { id: "p6", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
    ];

    const result = await runBuildFanout({
      repoRoot,
      baseRef: "HEAD",
      pieces,
      runPieceBuilder: async (piece, cwd) => {
        if (piece.id === "p5") throw new Error("builder boom");
        fs.writeFileSync(path.join(cwd, piece.allowedPaths[0]), "should not matter\n");
        return verdict();
      },
    });

    expect(result.ok).toBe(false);
    expect(worktreeLines().length).toBe(1); // no leaks even though one builder threw
  });

  test("ENFORCEMENT: overlapping pieces are rejected by runBuildFanout itself, before any worktree is created", async () => {
    const pieces = [
      { id: "p9", title: "A", prompt: "do A", allowedPaths: ["shared"] },
      { id: "p10", title: "B", prompt: "do B", allowedPaths: ["shared/sub"] },
    ];

    let builderCalled = false;
    await expect(
      runBuildFanout({
        repoRoot,
        baseRef: "HEAD",
        pieces,
        runPieceBuilder: async () => {
          builderCalled = true;
          return verdict();
        },
      }),
    ).rejects.toThrow(/disjoint/i);

    // Refused up front — no piece builder ever ran, no worktree ever registered.
    expect(builderCalled).toBe(false);
    expect(worktreeLines().length).toBe(1);
  });

  test("a merge failure for one piece is reported (ok:false) but does NOT discard another piece's clean merge, and leaves no worktree", async () => {
    const pieces = [
      { id: "p11", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
      { id: "p12", title: "B", prompt: "do B", allowedPaths: ["conflict.txt"] },
    ];

    // Simulate a filesystem-level surprise for p12's merge: by the time the
    // merge phase runs, repoRoot's tracked "conflict.txt" has been replaced
    // by a DIRECTORY, so mergeDisjoint's fs.copyFileSync(src, dest) throws
    // (EISDIR) — independent of p11, which stays cleanly disjoint and
    // mergeable.
    const conflictPath = path.join(repoRoot, "conflict.txt");

    try {
      const result = await runBuildFanout({
        repoRoot,
        baseRef: "HEAD",
        pieces,
        runPieceBuilder: async (piece, cwd) => {
          if (piece.id === "p11") {
            fs.writeFileSync(path.join(cwd, "a.txt"), "new p11\n");
          } else {
            fs.writeFileSync(path.join(cwd, "conflict.txt"), "new p12\n");
            // Introduce the on-disk collision in repoRoot only once both
            // builders have produced their changes (the merge phase only
            // starts after BOTH concurrent builders settle, so this reliably
            // lands before merge begins).
            fs.rmSync(conflictPath);
            fs.mkdirSync(conflictPath);
          }
          return verdict({ summary: `${piece.id} done` });
        },
      });

      expect(result.ok).toBe(false);
      // p11's clean merge must have survived p12's merge exception.
      expect(result.merged).toContain("a.txt");
      expect(fs.readFileSync(path.join(repoRoot, "a.txt"), "utf8")).toBe("new p11\n");
      expect(result.stray.some((s) => s.includes("merge failed") && s.includes("p12"))).toBe(true);
      expect(worktreeLines().length).toBe(1);
    } finally {
      // Restore repoRoot's tracked conflict.txt from a directory back to the
      // committed file so later tests in this describe block see clean state.
      fs.rmSync(conflictPath, { recursive: true, force: true });
      execFileSync("git", ["checkout", "--", "conflict.txt"], { cwd: repoRoot });
    }
  });

  test("MOAT: the result is only a verdict/merge summary — no Loom, no state", async () => {
    const pieces = [
      { id: "p7", title: "A", prompt: "do A", allowedPaths: ["a.txt"] },
      { id: "p8", title: "B", prompt: "do B", allowedPaths: ["b.txt"] },
    ];

    const result = await runBuildFanout({
      repoRoot,
      baseRef: "HEAD",
      pieces,
      runPieceBuilder: async () => verdict(),
    });

    expect(Object.keys(result).sort()).toEqual(["merged", "ok", "stray", "verdicts"]);
    expect((result as any).loom).toBeUndefined();
    expect((result as any).state).toBeUndefined();
    expect(worktreeLines().length).toBe(1);
  });
});
