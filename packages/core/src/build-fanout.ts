// M7.3b — intra-thread Build fan-out with git worktree isolation
// (docs/loom-orchestrator.md §7, "Inner" axis). ADDITIVE + strictly opt-in:
// the default executeLoom single-builder path (executor.ts) never calls into
// this module unless a caller explicitly supplies opts.buildFanout.
//
// MOAT: runBuildFanout only GENERATES code across N worktree-isolated
// builders and reports a merge summary — it never touches Loom state and
// never runs the Verifier. The caller (executeLoom) still runs gates +
// exactly ONE independent Verifier on the merged result.
//
// DISJOINTNESS is enforced INSIDE runBuildFanout itself (piecesAreDisjoint,
// checked before any worktree is created) — not merely upstream in
// splitBuild. splitBuild is only one possible source of opts.buildFanout;
// any caller supplying overlapping pieces gets a hard throw, never a silent
// last-writer-wins clobber during merge.
//
// SAFETY: every git worktree created here is removed in a finally, even when
// a piece builder throws. Worktrees live under os.tmpdir() and are only ever
// added/removed via `git worktree` — never an rm -rf of anything git doesn't
// manage.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { agent } from "./engine";
import { fanoutSize } from "./budget";
import { Verdict, type AccountProfile, type ProjectManifest } from "./schemas";

export type BuildPiece = {
  id: string;
  title: string;
  prompt: string;
  allowedPaths: string[];
};

// --- path-overlap helpers (conservative: unsure => overlapping) -----------

// The literal, non-glob portion of a path pattern — everything before the
// first glob metacharacter. Comparing these prefixes/exact-matches is a
// deliberately simple, conservative approximation of "do these path sets
// intersect": it can flag disjoint globs as overlapping (safe: collapses to
// a single piece) but never misses a real overlap.
function globBase(p: string): string {
  const idx = p.search(/[*?[]/);
  return idx === -1 ? p : p.slice(0, idx);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

// Disjointness is checked case-insensitively (conservative direction only):
// on the default case-insensitive filesystems this project ships to (macOS
// APFS/HFS+, Windows NTFS) two paths differing only by case resolve to the
// SAME on-disk file, so treating them as non-overlapping would silently
// defeat the merge-conflict-free invariant. Actual file I/O (mergeDisjoint)
// still uses the real, case-preserved paths — only the overlap *decision*
// lowercases.
function pathsOverlap(a: string, b: string): boolean {
  const ba = normalizePath(globBase(a)).toLowerCase();
  const bb = normalizePath(globBase(b)).toLowerCase();
  if (ba === "" || bb === "") return true; // unanchored wildcard — matches everything
  if (ba === bb) return true;
  return ba.startsWith(bb + "/") || bb.startsWith(ba + "/");
}

// true iff no allowedPaths entry in one piece overlaps an entry in another.
// A piece with an empty allowedPaths list is ambiguous scope (could touch
// anything) — treated conservatively as overlapping everything.
export function piecesAreDisjoint(pieces: BuildPiece[]): boolean {
  if (pieces.some((p) => p.allowedPaths.length === 0)) return false;
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      for (const a of pieces[i].allowedPaths) {
        for (const b of pieces[j].allowedPaths) {
          if (pathsOverlap(a, b)) return false;
        }
      }
    }
  }
  return true;
}

// PURE. 1 piece (or fewer) never fans out — clamp(1). N>=2 disjoint pieces
// size against the SAME shared pool (fanoutSize/budget.ts) — never spawn
// more than the charter's maxAgents allows, never more than the pieces need.
export function decideBuildFanout(
  pieceCount: number,
  args: { maxAgents: number; inFlight: number; budgetLeftUsd: number; estCostPerAgent: number },
): number {
  if (pieceCount <= 1) return 1;
  return fanoutSize(pieceCount, args);
}

// --- splitBuild: a READ-ONLY planner agent proposing disjoint pieces ------

export type SplitBuildDeps = { agent?: typeof agent; account?: AccountProfile; model?: string };

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

const BuildPieceSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  allowedPaths: z.array(z.string()).default([]),
});

const SplitBuildResult = z.object({
  pieces: z.array(BuildPieceSchema).default([]),
});

// READ-ONLY: mirrors scoping.ts's draftCharter lockdown EXACTLY (restrictTools
// + read-only tools only, explicit disallow of Write/Edit/Bash/etc as
// defense-in-depth, settingSources:[] so the target repo's own .claude hooks
// can't run). Post-processing enforces the merge-safety invariant: fewer than
// 2 pieces, or any overlapping allowedPaths, collapses to [] — "don't fan
// out, use the single builder" — rather than risk a merge conflict.
export async function splitBuild(
  input: { prompt: string; manifest: ProjectManifest },
  deps: SplitBuildDeps = {},
): Promise<BuildPiece[]> {
  const task = `You are splitting a build task into independently-buildable pieces for
parallel execution. This is a READ-ONLY planning pass — you may read the
repository to understand context, but you must NOT write, edit, or run
anything.

--- Build objective ---
${input.prompt}

Rules:
- Propose 0..N pieces. Each piece needs a short id, a title, a self-contained
  prompt for the builder that will implement ONLY that piece, and
  allowedPaths: the file paths/globs that piece is allowed to touch.
- The allowedPaths across ALL pieces MUST be mutually DISJOINT — no two
  pieces may claim the same file or overlapping directory. If the work does
  not cleanly split into disjoint pieces, return a single piece (or none) —
  do NOT fabricate a split that would conflict.
- If the task is small/atomic and shouldn't be split, return an empty
  pieces list (or a single piece).`;

  const result = await (deps.agent ?? agent)(task, {
    schema: SplitBuildResult,
    cwd: input.manifest.root,
    tools: READ_ONLY_TOOLS,
    restrictTools: true,
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"],
    settingSources: [],
    account: deps.account,
    model: deps.model,
  });

  const pieces = result?.pieces ?? [];
  if (pieces.length < 2 || !piecesAreDisjoint(pieces)) return [];
  return pieces;
}

// --- git worktree lifecycle -------------------------------------------------

// Per-call incrementing counter for worktree-directory uniqueness — no
// Date.now/Math.random, so tests stay deterministic.
let worktreeCounter = 0;

function addWorktree(repoRoot: string, baseRef: string, id: string): string {
  worktreeCounter++;
  const wt = path.join(os.tmpdir(), "telar-fanout-" + id + "-" + worktreeCounter);
  execFileSync("git", ["worktree", "add", "--detach", wt, baseRef], { cwd: repoRoot });
  return wt;
}

function removeWorktree(repoRoot: string, wt: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot });
  } catch {
    // best-effort cleanup — a failed remove must never break the caller.
    // (git tracks the worktree registration; a leaked *directory* here is
    // still bounded under os.tmpdir(), never inside the user's repo.)
  }
}

// Parses `git status --porcelain` for the worktree's changed files, copying
// only those under one of `allowedPaths` back into repoRoot. Anything else
// the builder touched is recorded as "stray" and deliberately NOT copied —
// this is what keeps the merge conflict-free by construction.
function mergeDisjoint(
  repoRoot: string,
  wt: string,
  allowedPaths: string[],
): { merged: string[]; stray: string[] } {
  // core.quotepath=false: stop git from octal-escaping non-ASCII filenames in
  // --porcelain output. Without this, a filename like "café.txt" comes back
  // as "caf\303\251.txt" and the path.join below points at a path that
  // doesn't exist, throwing ENOENT out of fs.copyFileSync.
  const raw = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain"], { cwd: wt }).toString();
  const merged: string[] = [];
  const stray: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3);
    if (status.includes("R")) {
      // rename: "old -> new" — merge the destination.
      const parts = filePath.split(" -> ");
      filePath = parts[parts.length - 1];
    }
    // Strip possible git quoting around paths with special characters.
    filePath = filePath.replace(/^"|"$/g, "");

    const fp = normalizePath(filePath);
    const isAllowed = allowedPaths.some((p) => {
      const base = normalizePath(globBase(p));
      return base === "" || fp === base || fp.startsWith(base + "/");
    });

    if (isAllowed) {
      const src = path.join(wt, filePath);
      const dest = path.join(repoRoot, filePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      merged.push(filePath);
    } else {
      stray.push(filePath);
    }
  }

  return { merged, stray };
}

// --- runBuildFanout: the moat-preserving fan-out entry point ---------------

export async function runBuildFanout(input: {
  repoRoot: string;
  baseRef: string;
  pieces: BuildPiece[];
  runPieceBuilder: (piece: BuildPiece, cwd: string) => Promise<Verdict | null>;
}): Promise<{ ok: boolean; verdicts: (Verdict | null)[]; merged: string[]; stray: string[] }> {
  const { repoRoot, baseRef, pieces, runPieceBuilder } = input;

  // ENFORCED HERE, not just in splitBuild: splitBuild is one caller among
  // possibly several (a future scheduler, a hand-built opts.buildFanout).
  // Fan-out with overlapping allowedPaths would build concurrently in
  // separate worktrees and merge with silent last-writer-wins clobbering —
  // refuse before any worktree exists rather than document the invariant
  // and hope every caller upholds it.
  if (pieces.length >= 2 && !piecesAreDisjoint(pieces)) {
    throw new Error("runBuildFanout: pieces are not disjoint — refusing to fan out");
  }

  const created: string[] = [];

  try {
    // Concurrent phase: spin up one isolated worktree per piece and run its
    // builder. Promise.allSettled (not .all) so a throw in one piece never
    // abandons another piece's worktree mid-flight — every created worktree
    // is guaranteed to make it into `created` before we move to cleanup.
    const settled = await Promise.allSettled(
      pieces.map(async (piece) => {
        const wt = addWorktree(repoRoot, baseRef, piece.id);
        created.push(wt);
        const verdict = await runPieceBuilder(piece, wt).catch(() => null);
        return { piece, wt, verdict };
      }),
    );

    const runs = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { piece: pieces[i], wt: null as string | null, verdict: null },
    );

    // Sequential merge, after every builder has finished — paths are
    // disjoint by construction (piecesAreDisjoint gated fan-out at the top of
    // this function), so ordering doesn't matter; sequential just avoids
    // concurrent fs writes.
    // Each piece's merge is isolated in its own try/catch: a copy failure for
    // one piece (e.g. a filesystem-level surprise) must not discard the
    // already-computed, cleanly-disjoint merge results of the OTHER pieces —
    // it's reported (as a stray-like entry, forcing ok:false) instead of
    // thrown out of the whole call.
    const merged: string[] = [];
    const stray: string[] = [];
    let mergeFailed = false;
    for (const r of runs) {
      if (r.verdict?.ok && r.wt) {
        try {
          const m = mergeDisjoint(repoRoot, r.wt, r.piece.allowedPaths);
          merged.push(...m.merged);
          stray.push(...m.stray);
        } catch (err) {
          mergeFailed = true;
          const message = err instanceof Error ? err.message : String(err);
          stray.push(`[merge failed: ${r.piece.id}] ${message}`);
        }
      }
    }

    const verdicts = runs.map((r) => r.verdict);
    const ok = !mergeFailed && verdicts.length > 0 && verdicts.every((v) => v?.ok === true);
    return { ok, verdicts, merged, stray };
  } finally {
    // NO WORKTREE LEAKS: every worktree we created gets removed, even if the
    // merge step above threw.
    for (const wt of created) removeWorktree(repoRoot, wt);
  }
}
