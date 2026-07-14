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
import { z } from "zod";
import { agent } from "./engine";
import { fanoutSize } from "./budget";
import { Verdict, type AccountProfile, type AgentSpec, type ProjectManifest, type StepKind } from "./schemas";
// M3: the worktree lifecycle + disjoint merge primitives now live in the one
// shared vcs.ts module (promoted verbatim out of this file). runBuildFanout's
// behavior is unchanged — it just calls them through the default git runner.
import { addWorktree, defaultGitRunner, globBase, mergeDisjoint, normalizePath, removeWorktree } from "./vcs";

export type BuildPiece = {
  id: string;
  title: string;
  prompt: string;
  allowedPaths: string[];
  // M6 — optional curated roster preset name (schemas.ts Roster). When set and
  // it names a loaded roster entry, makePieceBuilder (executor.ts) merges the
  // preset's model/tools/disallowedTools/promptPrelude over the piece defaults.
  // Unset or unknown ⇒ byte-identical to today.
  agent?: string;
};

// M9.2 — the general per-step fan-out primitive maps a Step's `agents` onto the
// existing BuildPiece machinery. These two exports are the ONLY glue the runner
// (SLICE-B) needs; runBuildFanout/piecesAreDisjoint/decideBuildFanout/mergeDisjoint
// are reused verbatim.

// WRITING kinds — the disjoint-writer partition applies; a writing step must have
// partition "disjoint-writer" + >=2 agents to fan out. Non-writing kinds
// (research|design|check) fan out free (no partition/merge).
export function isWritingKind(kind: StepKind): boolean {
  return kind === "build" || kind === "migrate";
}

// The ONE place the AgentSpec≡BuildPiece structural-superset is committed to, so
// a future AgentSpec field addition is caught here, not silently coerced.
export function agentsToPieces(agents: AgentSpec[]): BuildPiece[] {
  return agents.map((a) => ({
    id: a.id,
    title: a.title,
    prompt: a.prompt,
    allowedPaths: a.allowedPaths,
    agent: a.agent,
  }));
}

// --- path-overlap helpers (conservative: unsure => overlapping) -----------

// globBase/normalizePath (the literal-prefix approximation of "do these path
// sets intersect") now live in vcs.ts, shared with mergeDisjoint.
//
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

// The moat's read-only wall — the SINGLE source of truth for every read-only
// fan-out (splitBuild here, the M9.2 free-step fan-out in executor.ts's
// runFreeStepFanout). Pairs with restrictTools:true and settingSources:[] at
// each call site. scoping.ts keeps its own copy for the charter-lockdown path.
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
export const READ_ONLY_DISALLOWED_TOOLS = ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"];

const BuildPieceSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  allowedPaths: z.array(z.string()).default([]),
  agent: z.string().optional(),
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
    disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
    settingSources: [],
    account: deps.account,
    model: deps.model,
  });

  const pieces = result?.pieces ?? [];
  if (pieces.length < 2 || !piecesAreDisjoint(pieces)) return [];
  return pieces;
}

// --- runBuildFanout: the moat-preserving fan-out entry point ---------------
// addWorktree/removeWorktree/mergeDisjoint are imported from vcs.ts (promoted
// verbatim). They now take an injectable GitRunner; the fan-out passes the
// default runner so its behavior is unchanged.

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
        const wt = addWorktree(defaultGitRunner, repoRoot, baseRef, piece.id);
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
          const m = mergeDisjoint(defaultGitRunner, r.wt, repoRoot, r.piece.allowedPaths);
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
    // FAIL CLOSED (M6): a stray — an out-of-lane write dropped by mergeDisjoint,
    // or a per-piece merge failure recorded as a stray-like entry — forces
    // ok:false. For a WIRED, mutating fan-out a dropped out-of-lane file can
    // leave the merged tree provably incomplete (an in-lane file references a
    // dropped file) yet green. The fan-out layer must not report success on a
    // lossy merge; the executor surfaces the strays in `blocker` when !ok, so
    // normal retry / single-builder fallback / repair takes over.
    const ok =
      !mergeFailed && verdicts.length > 0 && verdicts.every((v) => v?.ok === true) && stray.length === 0;
    return { ok, verdicts, merged, stray };
  } finally {
    // NO WORKTREE LEAKS: every worktree we created gets removed, even if the
    // merge step above threw.
    for (const wt of created) removeWorktree(defaultGitRunner, repoRoot, wt);
  }
}
