// Loom persistence in ~/.telar/looms/<id>/ — loom.json (current state, atomic
// rewrite) + events.ndjson (append-only log, tailed by the UI via line offset).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, ContractAssertion, EnvRequirement, PanelReport, ThreadWorkflow, Verdict, VerifierReport, WorkUnitState } from "./schemas";
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
  // The cwd this attempt's SDK session was born in (buildCwd at attempt-create
  // time). The SDK keys a resumable conversation by the cwd it started in, not
  // the sessionId alone — a retry that resumes `sessionId` from a DIFFERENT
  // cwd (e.g. a freshly re-minted per-thread worktree) gets "No conversation
  // found ..." from the SDK. executor.ts compares this against the NEXT
  // attempt's cwd before ever passing `resume`. Absent on pre-fix records
  // (legacy attempts safely never match, falling back to a fresh session).
  cwd?: string;
  verdict?: Verdict | null;
  verifierReport?: VerifierReport | null;
  // §4 Layer 2 (docs/loom-model.md): the Critic Panel's aggregated report,
  // present when the loom's verification was panel-driven (a Spec Bundle
  // contract exists) instead of the legacy single-Verifier path.
  panelReport?: PanelReport | null;
  gates?: GateResult[];
  // M10.5 — the EXPLICITLY subjective-marked assertions this
  // attempt pulled out of the autonomous panel. Informational only (alongside
  // gates/panelReport): carried to the human accept, NEVER converted into a
  // machine verdict. Absent when no assertion carries subjective:true.
  humanJudged?: ContractAssertion[];
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
  // Absent when the project isn't a git repo or the tree was clean at accept
  // time (no build output to land). NEVER set on a void accept: contract v0.8
  // L2 aborts (throws, no state change) instead of reaching `done` when the
  // loom produced build output but landing committed nothing.
  commit?: string;
  // docs/loom-model.md §A/§M (P5) — set true when the owner closed this loom
  // via an AUDITED OVERRIDE instead of a clean accept: it reached `done` from
  // a state that was NOT independently verified (`needs-review`/`blocked`) or
  // via an explicit override co-sign, rather than from a green `ready`. The
  // matching `accepted` event carries `override:true`. Absent/false = a clean
  // accept of green.
  acceptedOverride?: boolean;
  // L3 (contract v0.8) — the owner's acknowledgment naming what was missing/
  // unverified at an AUDITED OVERRIDE accept. Required (non-blank) whenever a
  // non-`ready` loom is accepted; absent on a clean accept of green. The
  // matching `accepted` event carries the same string as `missing`.
  acceptedOverrideMissing?: string;
  // Unit 6 (docs §8 MVP) — the string Verification of the end-of-orchestration
  // ALL-scope integration verify, recorded on a WOVEN root after its children
  // fold up to "ready". Mirrors ThreadView.latestVerdict (tick.ts). Purely
  // INFORMATIONAL in this phase: it never changes loom.state (rollupWeave stays
  // the only completion path). The UI reads it off loom.json; the Unit-7 tick
  // will read it to gate finish-loom. Absent on plain looms and on woven roots
  // with no ALL contract (no integration verify ran).
  latestVerdict?: string;
  // M3 (per-loom worktree isolation) — worktree isolation is unconditional; all
  // three are set only when the project is a git repo (a non-git project
  // degrades gracefully and leaves them unset).
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
  // M10.4 (lane-escalation) — the PRE-FLIGHT park draft. Set when the loom is
  // parked in `blocked` because its verification lane is unviable and cannot be
  // auto-provisioned. Two fields, cleared on answer:
  //   blockedReason   — MACHINE-facing: what it tried / why the lane is unviable
  //                     ("N agent-judged assertions need a live target; no
  //                     devCommand, no servers tier, setup agent off").
  //   blockedQuestion — HUMAN-facing narrative ask surfaced in the cockpit
  //                     ("How do I run this app so verification can drive it?").
  // Absent unless the loom is (or was) in `blocked`; absent flag-off.
  blockedReason?: string;
  blockedQuestion?: string;
  // M4 (auto-repair) — the ordered log of frozen-lane integration-verify rounds
  // (repair-guard.ts). Absent unless a repair loop ran: history[0] is the
  // initial verify, each later entry follows one dispatched repair. Read
  // by the Verify tab (round deltas, escalate reason) and by nothing that gates
  // promotion — the guards are a pure function of THIS array, never re-parsed
  // from gate output. Root-only, additive.
  repairHistory?: RepairRound[];
  // M9 (thread-as-workflow) — the step DAG runThreadWorkflow executes.
  // Absent ⇒ the default 1-step `build` template is synthesized at run time;
  // runThreadWorkflow delegates that step to executeLoom. Additive.
  workflow?: ThreadWorkflow;
  // B1 (COVERAGE INVARIANT) — the explicit record of every criterion this thread
  // RELAXED to green (stopped gating) instead of demoting. The one relaxation a
  // thread makes is a `panelRequired` SKIP whose evidence is structurally
  // unobtainable at thread altitude (the couldn't-verify case §70-72): it resolves
  // to a terminal GREEN and stamps the exact contract-assertion ids it no longer
  // gates. The top gate (runIntegrationVerify with fullContract) CONSUMES this and
  // fails CLOSED (demotes ready→needs-review) if any relaxed id is not provably
  // re-proven by the root ALL verify — the fail-open moat: a thread may relax ONLY
  // what the top gate re-proves. A verification-shaped FAIL (a panel FAIL, a
  // contract-miss, a step-check fail) is NOT recorded here — it ESCALATES (the
  // thread parks `blocked`; B2 re-routes to orchestrator mediation) rather than
  // promoting green, so there is no coverage to re-prove. Absent on a thread that
  // relaxed nothing.
  relaxedCoverage?: RelaxedCoverage[];
  // D3 (docs/deflag-cut-plan.md APPROVED DECISION D3) — the EAGER-DETECTION
  // heuristic-asking OFFER: the human-only (secret/credential) requirements
  // detection mapped at scoping, batched for OPTIONAL up-front answering on the
  // charter-review surface. An OFFER, NEVER a gate — dispatch proceeds
  // regardless (proceed is always valid, the build starts, a missing one blocks
  // ONLY the verify step). Absent when nothing human-only was detected or all
  // are already satisfied. Answered via answerRequirements (dispatcher).
  requirementsOffer?: { items: EnvRequirement[] };
};

// B1 — one relaxation a thread made: the criteria it stopped gating and why.
// `assertionIds` are the exact contract-assertion ids the top gate must
// re-prove; an empty/absent set relaxes nothing and never demotes the top gate.
export type RelaxedCoverage = {
  // What the thread relaxed. The executor writes "panel-skip" (evidence
  // unobtainable at thread altitude — the only relax-to-green case; every
  // verification-shaped FAIL escalates `blocked` instead of recording here).
  // Kept an open string because the top-gate coverage check is kind-agnostic — it
  // keys ONLY on assertionIds — so any future relaxation shape is re-proven the
  // same way without a schema change.
  kind: string;
  // The contract-assertion ids this thread no longer gates. The top gate proves
  // coverage by presence in its passing set — a relaxed id absent from that set
  // is NOT re-proven and demotes the whole, fail-closed.
  assertionIds: string[];
  note?: string;
};

// B1 — PURE coverage check for the generalized COVERAGE INVARIANT. Returns the
// relaxed assertion ids that the top gate could NOT re-prove: every id a thread
// relaxed which is absent from the top gate's `provenIds` (its passing set over
// the composed whole). A non-empty result MUST demote the top gate fail-closed
// — the thread stopped gating something the orchestrator never re-proved, so the
// deliverable is not provably green. Deduped + sorted for a stable demote reason.
export function uncoveredRelaxedIds(relaxed: RelaxedCoverage[], provenIds: string[]): string[] {
  const proven = new Set(provenIds);
  const uncovered = new Set<string>();
  for (const r of relaxed) for (const id of r.assertionIds) if (!proven.has(id)) uncovered.add(id);
  return [...uncovered].sort();
}

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
// failure mode is returned, never thrown. Contract v0.8 L2 overturns the old
// "so accept can transition to `done` regardless" — acceptLoom now aborts the
// accept (throws, no state change) when work was produced but nothing landed;
// landWorkingTree itself stays total, it only reports the outcome. Skips
// gracefully when the loom produced no build output (a stranded/verify-only
// loom — never runs git add -A on unrelated files), when the root is not a
// git repo, or when the tree is already clean.
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
    // L2 — deterministic re-derivation of landing evidence at accept time: the
    // deliverable is the consolidation branch, so count the commits it
    // actually carries over the pinned base BEFORE merging. Fail-closed: a git
    // failure is "no evidence", an empty branch is "nothing to land" — both
    // surface as an error LandResult (the caller, acceptLoom, aborts the
    // accept when work was produced). Without this, `git merge --no-ff` on an
    // empty branch reports "Already up to date" (status 0, no commit created)
    // and would have looked like a successful landing.
    const range = loom.baseSha ? `${loom.baseSha}..${loom.consolidationBranch}` : `HEAD..${loom.consolidationBranch}`;
    const count = git(root, ["rev-list", "--count", range]);
    if (count.status !== 0) {
      return { committed: false, error: `git rev-list failed re-deriving consolidation evidence: ${count.stderr.trim() || count.stdout.trim()}` };
    }
    if ((parseInt(count.stdout.trim() || "0", 10) || 0) === 0) {
      return { committed: false, error: `consolidation branch ${loom.consolidationBranch} carries 0 commits over base — nothing to land` };
    }
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

// L2 (contract v0.8) — land the diff and RETURN the outcome (no loom
// mutation, no event) so acceptLoom can decide BEFORE recording anything: a
// void accept (work produced, nothing landed) must never flip state or write
// a success-shaped event. Wraps landWorkingTree's total contract with the
// same throwing-runner guard the old recordLanding carried, so an injected
// fake git runner that throws still comes back as a LandResult, not an
// uncaught exception mid-accept.
function attemptLanding(loom: Loom, by: string, git: GitRunner, land: boolean): LandResult {
  try {
    return landWorkingTree(loom, by, git, land);
  } catch (err) {
    return { committed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// §A / §M.2 (docs/loom-model.md), overturned/amended by contract v0.8 L2/L3/L5:
// the ONLY path to "done". LAND FIRST, then decide — there is no state flip to
// `done` before landing evidence exists. Three outcomes:
//  1. CLEAN accept of `ready` (independently verified green). override:false,
//     no flag.
//  2. AUDITED OWNER OVERRIDE — accepting a non-`ready` loom is a distinct,
//     deliberate act (L3): it REQUIRES `override:true` PLUS a non-blank
//     `missing` acknowledgment naming what is unverified/incomplete. A bare
//     acceptLoom(id, by) on a non-ready loom THROWS. Recorded as `accepted
//     {override:true, fromState, missing}` + `acceptedOverride`/
//     `acceptedOverrideMissing` on the record. The owner's server-derived `by`
//     IS the human touch; `cosignedBy` may still be attached but is never
//     demanded — optional metadata, not a gate.
//  3. VOID accept (L2) — `producedBuildOutput(loom)` is true (work exists,
//     attempt-existence based, recurses into a woven root's child subtree) but
//     landing committed nothing (merge conflict, git failure, throwing runner,
//     empty consolidation branch, or a clean-but-built shared tree). ABORTS
//     loudly: throws, NO state change, an `accept-aborted` event records why.
//     The sole exemption is a genuinely non-git project (`skipped:"not a git
//     repository"`) — there is no VCS to land into.
// L5 accept-lock corollary (mandate 8): a child loom (parentLoomId set) is
// refused outright — children are consumed by the weave rollup, never
// human-accepted directly.
export function acceptLoom(
  id: string,
  by: string,
  opts?: { override?: boolean; missing?: string; cosignedBy?: string; git?: GitRunner },
): Loom {
  // §A: "done" is reachable solely through a human (or an authenticated
  // human delegate) — a blank/missing `by` must never slip through, exactly
  // as assertProvenance rejects a blank approvedBy for the provenance gate.
  if (!by?.trim()) throw new Error("acceptLoom requires a non-blank `by`");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state === "done") throw new Error("loom already accepted");
  // L5 accept-lock corollary (mandate 8): a child is consumed by the weave
  // rollup, never human-accepted directly.
  if (loom.parentLoomId) {
    throw new Error("cannot accept a child loom — children are consumed by the weave rollup, never accepted directly");
  }
  const git = opts?.git ?? defaultGitRunner;
  const fromState = loom.state;
  const isClean = fromState === "ready";

  // L3 — a non-`ready` accept is an OVERRIDE: a distinct, deliberate act that
  // names what is missing. Require override:true AND a non-blank
  // acknowledgment BEFORE any landing attempt.
  let missing: string | undefined;
  if (!isClean) {
    if (opts?.override !== true) {
      throw new Error(`cannot accept a non-ready loom (state: ${fromState}) without override — pass { override: true, missing } naming what is missing`);
    }
    missing = opts.missing?.trim();
    if (!missing) {
      throw new Error("an override accept requires a non-blank `missing` acknowledgment naming what is unverified or incomplete");
    }
  }

  // L2 — re-derive landing evidence BEFORE any state flip. Land first; a git
  // failure/empty branch/clean-but-built tree is a void accept.
  // producedBuildOutput recurses into a woven root's child subtree (its CHILD
  // does the building), so a root whose child built is correctly gated too.
  const land = producedBuildOutput(loom);
  const res = attemptLanding(loom, by, git, land);
  const nonGit = !res.committed && "skipped" in res && res.skipped === "not a git repository";
  if (land && !res.committed && !nonGit) {
    const why = "error" in res ? res.error : (res as { skipped: string }).skipped;
    appendEvent(id, { type: "accept-aborted", by, fromState, reason: why });
    throw new Error(`cannot accept loom ${id}: it produced build output but landing committed nothing (${why}) — the accept is void (L2)`);
  }

  // Landing succeeded, or there was genuinely nothing to land (no build
  // output / non-git project). NOW flip and record.
  loom.state = "done";
  if (res.committed) loom.commit = res.sha;
  if (isClean) {
    appendEvent(id, { type: "accepted", by });
  } else {
    loom.acceptedOverride = true; // the audited-override flag (§A/§M)
    loom.acceptedOverrideMissing = missing;
    const ev: { type: string } & Record<string, unknown> = { type: "accepted", by, override: true, fromState, missing };
    if (opts?.cosignedBy?.trim()) ev.cosignedBy = opts.cosignedBy;
    appendEvent(id, ev);
  }
  if (res.committed) appendEvent(id, { type: "committed", sha: res.sha, by });
  else appendEvent(id, { type: "commit-skipped", reason: (res as { skipped: string }).skipped, by });
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
