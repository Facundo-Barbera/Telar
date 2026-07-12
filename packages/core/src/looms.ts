// Loom persistence in ~/.telar/looms/<id>/ — loom.json (current state, atomic
// rewrite) + events.ndjson (append-only log, tailed by the UI via line offset).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, PanelReport, Verdict, VerifierReport, WorkUnitState } from "./schemas";
import type { GateResult } from "./gates";
import type { RepairRound } from "./repair-guard";
import { getProject } from "./manifest";
// M3: the git runner (and the whole VCS/worktree substrate) now lives in
// vcs.ts. Re-exported here for back-compat with existing `../src/looms`
// imports (e.g. accept-commit.test.ts).
import { defaultGitRunner, type GitRunner } from "./vcs";
export { defaultGitRunner } from "./vcs";
export type { GitRunner, GitRunResult } from "./vcs";

const telarDir = () => process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar");
const loomsDir = () => path.join(telarDir(), "looms");

// Every consumer of a loom's on-disk location (spec/evidence dirs, loom.json,
// events.ndjson) routes through here, so this is the one place `id` needs
// guarding against path traversal (e.g. id="../../etc" relocating the whole
// per-loom sandbox off-disk). Reject anything that isn't a bare, separator-
// free path segment matching createLoom()'s own id shape.
export const loomDir = (id: string) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid loom id: ${JSON.stringify(id)}`);
  }
  const dir = path.join(loomsDir(), id);
  const base = loomsDir();
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!dir.startsWith(withSep)) {
    throw new Error(`invalid loom id: ${JSON.stringify(id)}`);
  }
  return dir;
};

export type LoomKind = "quickfix" | "story" | "custom" | "verify";

export type LoomEvent = { ts: number; type: string } & Record<string, unknown>;

export type AttemptRecord = {
  n: number;
  role: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  sessionId?: string;
  verdict?: Verdict | null;
  verifierReport?: VerifierReport | null;
  // §4 Layer 2 (docs/loom-model.md): the Critic Panel's aggregated report,
  // present when the loom's verification was panel-driven (a Spec Bundle
  // contract exists) instead of the legacy single-Verifier path.
  panelReport?: PanelReport | null;
  gates?: GateResult[];
  costUsd?: number;
};

export type Loom = {
  id: string;
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  account: string;
  acceptanceCriteria?: string[];
  target?: "dev" | "preview" | "prod";
  state: WorkUnitState;
  createdAt: number;
  updatedAt: number;
  attempts: AttemptRecord[];
  error: string | null;
  // Weave/child-Loom fields (docs/loom-orchestrator.md §4) — additive, absent
  // on today's plain looms. No stored "role" (docs/loom-model.md §W) — a
  // child is identified by parentLoomId (isThread), a woven root by isWoven;
  // nothing here declares a shape.
  parentLoomId?: string; // set on a child; points at the weave's root loom
  subGoalId?: string; // which Charter.decomposition node this child proves
  charter?: Charter; // the approved scope (a woven root loom)
  // docs/loom-model.md §5/§M.6 — a loom whose Spec Bundle is still being
  // authored by a planning session. Exists on disk (so the god-view can
  // render the bundle-in-progress) but must not be listed or dispatched
  // until `startLoomFromBundle` commits it (stamps provenance, flips this
  // to false, and dispatches). Absent/false = a normal started loom.
  draft?: boolean;
  // §M.1: stamped true by startLoomFromBundle's CONTRACT GATE the moment a
  // valid Verification Contract was required to start this loom. Sticky for
  // the loom's lifetime so a contract that later goes missing/corrupt/
  // invalid (a steering edit, a bad write, anything) is a hard verification
  // FAILURE, never a silent downgrade to the legacy no-panel skip path —
  // see runVerification in executor.ts.
  contractRequired?: boolean;
  // docs/loom-model.md §A — the git sha of the commit acceptLoom LANDED into
  // the project working tree when the owner closed the loom (ready->done).
  // Absent when the project isn't a git repo, the tree was clean at accept
  // time, or the commit failed (a commit failure is recorded as a
  // "commit-failed" event and NEVER thrown out of accept).
  commit?: string;
  // docs/loom-model.md §A/§M (P5) — set true when the owner closed this loom
  // via an AUDITED OVERRIDE instead of a clean accept: it reached `done` from
  // a state that was NOT independently verified (`needs-review`/`blocked`) or
  // via an explicit override co-sign, rather than from a green `ready`. The
  // matching `accepted` event carries `override:true`. Absent/false = a clean
  // accept of green.
  acceptedOverride?: boolean;
  // Unit 6 (docs §8 MVP) — the string Verification of the end-of-orchestration
  // ALL-scope integration verify, recorded on a WOVEN root after its children
  // fold up to "ready". Mirrors ThreadView.latestVerdict (tick.ts). Purely
  // INFORMATIONAL in this phase: it never changes loom.state (rollupWeave stays
  // the only completion path). The UI reads it off loom.json; the Unit-7 tick
  // will read it to gate finish-loom. Absent on plain looms and on woven roots
  // with no ALL contract (no integration verify ran).
  latestVerdict?: string;
  // M3 (per-loom worktree isolation) — all three absent unless
  // manifest.isolateWorktrees (or TELAR_ISOLATE_WORKTREES) is on, so flag-off
  // every loom is byte-identical to pre-M3.
  //   worktree            — a CHILD thread's live worktree path, persisted at
  //                         build start and cleared on removal (a reclamation
  //                         record for the reaper if the process is killed).
  //   baseSha             — set on the ROOT: the pinned base SHA (resolved once
  //                         from manifest.baseBranch) all its threads fork from.
  //   consolidationBranch — set on the ROOT: the review-branch deliverable
  //                         (`telar/<rootId>`) every done child's work folds
  //                         onto. NEVER merged to baseBranch except under a
  //                         human acceptLoom click (landWorkingTree).
  worktree?: string;
  baseSha?: string;
  consolidationBranch?: string;
  // M8 worktree recovery: WIP snapshot branch + reaper-shield flag
  recoveryBranch?: string;
  worktreeRetained?: boolean;
  // M4 (auto-repair) — the ordered log of frozen-lane integration-verify rounds
  // (repair-guard.ts). Absent unless the autoRepair master flag fired: history[0]
  // is the initial verify, each later entry follows one dispatched repair. Read
  // by the Verify tab (round deltas, escalate reason) and by nothing that gates
  // promotion — the guards are a pure function of THIS array, never re-parsed
  // from gate output. Root-only, additive; absent flag-off.
  repairHistory?: RepairRound[];
};

// docs/loom-model.md §5 — a loom is "listable" (shown in the top-level Looms
// list) once it's no longer a draft awaiting commit and isn't a child loom
// (children render nested under their woven root). Pure so the web list
// route and any other consumer share one definition instead of inlining it.
export const isListableLoom = (l: Loom): boolean => !l.draft && !l.parentLoomId;

// PURE. docs/loom-model.md §W — a child loom (a "Thread") is identified by
// having a parent, never by a stored role/shape.
export const isThread = (l: Pick<Loom, "parentLoomId">): boolean => !!l.parentLoomId;

// Idempotent, non-destructive legacy migration from ~/.telar/runs/ to
// ~/.telar/looms/ (and run.json -> loom.json within each loom dir). Runs once
// per process, guarded so it never throws.
let migrated = false;
function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    const looms = loomsDir();
    const legacy = path.join(telarDir(), "runs");
    let legacyStat: fs.Stats | null = null;
    try {
      legacyStat = fs.lstatSync(legacy);
    } catch {}
    if (!fs.existsSync(looms) && legacyStat && legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
      fs.renameSync(legacy, looms);
      try {
        fs.symlinkSync(looms, legacy, "dir"); // back-compat shim
      } catch {}
    }
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(looms);
    } catch {}
    for (const id of ids) {
      const d = path.join(looms, id);
      const oldF = path.join(d, "run.json");
      const newF = path.join(d, "loom.json");
      try {
        if (fs.existsSync(oldF) && !fs.existsSync(newF)) fs.renameSync(oldF, newF);
      } catch {}
    }
  } catch {}
}

export function createLoom(init: {
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  account: string;
  parentLoomId?: string;
  subGoalId?: string;
  charter?: Charter;
  draft?: boolean;
}): Loom {
  ensureMigrated();
  const now = Date.now();
  const id = `loom_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const loom: Loom = {
    id,
    ...init,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    attempts: [],
    error: null,
  };
  fs.mkdirSync(loomDir(id), { recursive: true });
  saveLoom(loom);
  return loom;
}

export function saveLoom(loom: Loom): void {
  ensureMigrated();
  loom.updatedAt = Date.now();
  const dir = loomDir(loom.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "loom.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(loom, null, 2));
  fs.renameSync(tmp, file);
}

export function getLoom(id: string): Loom | null {
  ensureMigrated();
  let dir: string;
  try {
    dir = loomDir(id);
  } catch {
    return null; // malformed/traversal id: treat like "not found", not a 500
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "loom.json"), "utf8")) as Loom;
  } catch {
    // fallback to legacy run.json if loom.json is absent
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Loom;
    } catch {
      return null;
    }
  }
}

export function listLooms(): Loom[] {
  ensureMigrated();
  let ids: string[];
  try {
    ids = fs.readdirSync(loomsDir());
  } catch {
    return [];
  }
  return ids
    .map((id) => getLoom(id))
    .filter((l): l is Loom => l !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Child Looms (threads) of a woven root — each its own loom.json
// (docs/loom-orchestrator.md §4); no embedded lane state on the parent.
export function listChildLooms(parentId: string): Loom[] {
  return listLooms().filter((l) => l.parentLoomId === parentId);
}

export function appendEvent(id: string, ev: { type: string } & Record<string, unknown>): void {
  ensureMigrated();
  const dir = loomDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "events.ndjson"), JSON.stringify({ ...ev, ts: Date.now() }) + "\n");
}

type LandResult =
  | { committed: true; sha: string }
  | { committed: false; skipped: string }
  | { committed: false; error: string };

// A loom PRODUCED BUILD OUTPUT iff it (or its subtree) has a builder attempt —
// any attempt whose role is not a pure-verification role. In today's shared-tree
// model only a builder attempt writes the project tree; a verify-only or
// never-run loom touched nothing, so committing on its behalf can only sweep
// unrelated files.
//
// A woven ROOT has no builder attempt of its OWN — its CHILD does the building
// (in the shared tree flag-off, or on a branch/worktree flag-on). So we also
// return true when it owns a consolidationBranch/worktree (its flag-on
// deliverable, landed via the --no-ff merge in landWorkingTree) OR when ANY
// child in its subtree produced build output (the flag-off shared-tree case —
// accepting the root is the SOLE landing of the child's work). Recursion via
// listChildLooms; children never point back at their parent, but a `seen`
// guard keeps it terminating regardless. A genuinely verify-only loom with NO
// building children still returns false — no `git add -A` sweep (the E1 fix).
const VERIFY_ONLY_ROLES = new Set(["verifier", "integration"]);
function producedBuildOutput(loom: Loom, seen: Set<string> = new Set()): boolean {
  if (seen.has(loom.id)) return false; // cycle guard — never revisit a loom
  seen.add(loom.id);
  const built = loom.attempts.some((a) => !VERIFY_ONLY_ROLES.has(a.role));
  if (built || loom.commit || loom.worktree || loom.consolidationBranch) return true;
  return listChildLooms(loom.id).some((child) => producedBuildOutput(child, seen));
}

// docs/loom-model.md §A — "acceptance LANDS the work." Commit the loom's
// changes in the project working tree on accept. Pure of process exit: every
// failure mode is returned, never thrown, so accept can transition to `done`
// regardless. Skips gracefully when the loom produced no build output (a
// stranded/verify-only loom — never runs git add -A on unrelated files), when
// the root is not a git repo, or when the tree is already clean.
function landWorkingTree(loom: Loom, by: string, git: GitRunner, land: boolean): LandResult {
  // No-sweep guard (FIRST, before any git call): only land when the caller
  // determined there is work to land (a real builder attempt, or a state whose
  // accept is the sole landing of a subtree's work). A stranded/never-built
  // loom has nothing of its own in the shared tree, so `git add -A` could only
  // scoop up whatever the user happened to have dirty. Skip landing entirely.
  if (!land) {
    return { committed: false, skipped: "loom produced no build output" };
  }

  let root: string;
  try {
    root = getProject(loom.project).manifest.root;
  } catch (err) {
    return { committed: false, error: `cannot resolve project root: ${err instanceof Error ? err.message : String(err)}` };
  }

  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { committed: false, skipped: "not a git repository" };
  }

  // M3 branch-aware landing: when the loom carries a consolidationBranch (a
  // woven root's review-branch deliverable, produced under isolation), land
  // that BRANCH into the currently-checked-out branch (expected baseBranch)
  // via a --no-ff merge, instead of `git add -A` of the shared tree. This is
  // the ONE moat-adjacent landing change and only ever runs under a human
  // acceptLoom click. Still total — every failure returned as a LandResult.
  // (Conflicts against a moved baseBranch / a dirty shared tree are the §10
  // live-validation gap; until then it rides the same default-OFF flag.)
  if (loom.consolidationBranch) {
    const message = `feat(loom): ${loom.title}\n\nLoom: ${loom.id}\nReview-branch: ${loom.consolidationBranch}\nAccepted-by: ${by}`;
    const merge = git(root, ["merge", "--no-ff", "-m", message, loom.consolidationBranch]);
    if (merge.status !== 0) {
      return { committed: false, error: `git merge failed: ${merge.stderr.trim() || merge.stdout.trim()}` };
    }
    const mergedHead = git(root, ["rev-parse", "HEAD"]);
    if (mergedHead.status !== 0 || !mergedHead.stdout.trim()) {
      return { committed: false, error: `git rev-parse HEAD failed: ${mergedHead.stderr.trim()}` };
    }
    return { committed: true, sha: mergedHead.stdout.trim() };
  }

  const status = git(root, ["status", "--porcelain"]);
  if (status.status !== 0) {
    return { committed: false, error: `git status failed: ${status.stderr.trim()}` };
  }
  if (!status.stdout.trim()) {
    return { committed: false, skipped: "working tree clean" };
  }

  const add = git(root, ["add", "-A"]);
  if (add.status !== 0) {
    return { committed: false, error: `git add failed: ${add.stderr.trim()}` };
  }

  // No `--author` (docs/loom-model.md §A): let git use the user's own config.
  const message = `feat(loom): ${loom.title}\n\nLoom: ${loom.id}\nAccepted-by: ${by}`;
  const commit = git(root, ["commit", "-m", message]);
  if (commit.status !== 0) {
    return { committed: false, error: `git commit failed: ${commit.stderr.trim()}` };
  }

  const head = git(root, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    return { committed: false, error: `git rev-parse HEAD failed: ${head.stderr.trim()}` };
  }
  return { committed: true, sha: head.stdout.trim() };
}

// docs/loom-model.md §A — on the accept transition to `done`, LAND the work
// and record the outcome on the loom (commit sha + event) without ever
// letting a git failure escape accept. Mutates `loom` in place; the caller
// saves it.
function recordLanding(loom: Loom, by: string, git: GitRunner, land: boolean): void {
  let res: LandResult;
  try {
    res = landWorkingTree(loom, by, git, land);
  } catch (err) {
    // landWorkingTree is contractually total, but a git runner throwing
    // (e.g. an injected fake) must still never surface out of accept.
    res = { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.committed) {
    loom.commit = res.sha;
    try {
      appendEvent(loom.id, { type: "committed", sha: res.sha, by });
    } catch {}
  } else if ("error" in res) {
    try {
      appendEvent(loom.id, { type: "commit-failed", error: res.error, by });
    } catch {}
  } else {
    try {
      appendEvent(loom.id, { type: "commit-skipped", reason: res.skipped, by });
    } catch {}
  }
}

// §A / §M.2 (docs/loom-model.md): the ONLY path to "done". There are exactly
// two outcomes, keyed on state, and only the first is a "clean" accept:
//  1. CLEAN — from `ready` (independently verified green). override:false, no
//     flag.
//  2. AUDITED OWNER OVERRIDE (P5) — from ANY other non-`done` state (`queued`,
//     `scoping`, `charter-review`, `preparing`, `running`, `verifying`,
//     `needs-review`, `blocked`, `halted`, `failed`, `skipped`). The loom was
//     NOT independently verified, so the owner closing it is a distinct,
//     AUDITED override: recorded as `accepted {override:true, fromState}` + the
//     `acceptedOverride` flag, never a silent clean accept. The owner's
//     server-derived `by` IS the §M.2 human touch these states require; a
//     `cosignedBy` may still be attached but is never demanded — it is optional
//     metadata, not a gate.
// Both LAND the diff and reach `done`; nothing else can. Landing itself no
// longer sweeps: a stranded/never-built loom produced no build output, so
// recordLanding SKIPS the commit (see landWorkingTree) and the override is
// audited (`accepted {override:true}` + `commit-skipped`) without touching
// unrelated files in the shared tree.
export function acceptLoom(
  id: string,
  by: string,
  opts?: { override?: boolean; cosignedBy?: string; git?: GitRunner },
): Loom {
  // §A: "done" is reachable solely through a human (or an authenticated
  // human delegate) — a blank/missing `by` must never slip through, exactly
  // as assertProvenance rejects a blank approvedBy for the provenance gate.
  if (!by?.trim()) throw new Error("acceptLoom requires a non-blank `by`");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state === "done") throw new Error("loom already accepted");
  const git = opts?.git ?? defaultGitRunner;

  // (1) CLEAN accept of green — override:false (no flag, no override on event).
  if (loom.state === "ready") {
    loom.state = "done";
    appendEvent(id, { type: "accepted", by });
    // A clean accept lands only when the loom produced build output — a "ready"
    // single loom that built to get there, a woven root that owns a
    // consolidationBranch (--no-ff merge), or a child thread with a worktree. A
    // verify-only / never-built ready loom has nothing of its own in the shared
    // tree, so landWorkingTree records commit-skipped and it still reaches
    // "done" — the SAME producedBuildOutput predicate the override path uses below.
    recordLanding(loom, by, git, producedBuildOutput(loom)); // §A: accept LANDS the work (never throws)
    saveLoom(loom);
    return loom;
  }

  // (2) AUDITED OWNER OVERRIDE: every remaining non-`ready`/non-`done` state is
  // a stranded, non-green loom the OWNER may close. No co-sign gate — the
  // server-derived `by` is the human touch; `cosignedBy` is optional metadata.
  const fromState = loom.state;
  loom.state = "done";
  loom.acceptedOverride = true; // the audited-override flag (§A/§M)
  const ev: { type: string } & Record<string, unknown> = { type: "accepted", by, override: true, fromState };
  if (opts?.cosignedBy?.trim()) ev.cosignedBy = opts.cosignedBy;
  appendEvent(id, ev);
  // Land only when there's work to land — the SAME producedBuildOutput
  // predicate as the clean path. It now recurses into a woven root's subtree,
  // so a root demoted to "needs-review"/"blocked" whose CHILD built is already
  // covered (its subtree produced output -> true); a single loom that built and
  // is now "blocked" has its own builder attempt -> true. A stranded loom the
  // owner is just closing (queued/scoping/…/verify-only demoted to needs-review)
  // produced nothing, so we do NOT git add -A the shared tree on its behalf —
  // that would only sweep unrelated dirty files (the #55 / CA2 footgun).
  const land = producedBuildOutput(loom);
  recordLanding(loom, by, git, land); // §A: accept LANDS the work (never throws)
  saveLoom(loom);
  return loom;
}

// afterLine = complete lines already consumed; pass back nextLine to tail incrementally.
export function readEvents(id: string, afterLine = 0): { events: LoomEvent[]; nextLine: number } {
  ensureMigrated();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(loomDir(id), "events.ndjson"), "utf8");
  } catch {
    return { events: [], nextLine: afterLine };
  }
  const lines = raw.split("\n");
  lines.pop(); // "" after a final \n, or a partial line mid-append — either way not a complete event
  const events: LoomEvent[] = [];
  for (const line of lines.slice(afterLine)) {
    try {
      events.push(JSON.parse(line) as LoomEvent);
    } catch {
      // corrupt line: skip but still count it as consumed
    }
  }
  return { events, nextLine: lines.length };
}
