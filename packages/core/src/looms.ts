// Loom persistence in ~/.telar/looms/<id>/ — loom.json (current state, atomic
// rewrite) + events.ndjson (append-only log, tailed by the UI via line offset).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Charter, PanelReport, Verdict, VerifierReport, WorkUnitState } from "./schemas";
import type { GateResult } from "./gates";
import { getProject } from "./manifest";

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

// An injectable git runner (docs/loom-model.md §A — landing the work): given
// the project root and argv, run git and report its exit status + output. The
// default shells out; tests swap in a fake so no real git process runs and no
// working tree is touched. The runner owns pointing git at `root` (`git -C`).
export type GitRunResult = { status: number; stdout: string; stderr: string };
export type GitRunner = (root: string, args: string[]) => GitRunResult;

const defaultGitRunner: GitRunner = (root, args) => {
  try {
    const stdout = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : String(err),
    };
  }
};

type LandResult =
  | { committed: true; sha: string }
  | { committed: false; skipped: string }
  | { committed: false; error: string };

// docs/loom-model.md §A — "acceptance LANDS the work." Commit the loom's
// changes in the project working tree on accept. Pure of process exit: every
// failure mode is returned, never thrown, so accept can transition to `done`
// regardless. Skips gracefully when the root is not a git repo or the tree is
// already clean.
function landWorkingTree(loom: Loom, by: string, git: GitRunner): LandResult {
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
function recordLanding(loom: Loom, by: string, git: GitRunner): void {
  let res: LandResult;
  try {
    res = landWorkingTree(loom, by, git);
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

// §A / §M.2 (docs/loom-model.md): the ONLY path to "done". There are three
// ways in, and only the first is a "clean" accept:
//  1. CLEAN — from `ready` (independently verified green). override:false.
//  2. OWNER OVERRIDE (P5) — from `needs-review` (verification red/incomplete)
//     or `blocked` (paused on a prerequisite/decision). The loom was NOT
//     independently verified, so the owner closing it is a distinct, AUDITED
//     override: recorded as `accepted {override:true}` + the `acceptedOverride`
//     flag, never a silent clean accept. The owner's server-derived `by` IS
//     the §M.2 human touch these states require; a `cosignedBy` may still be
//     attached but is not demanded from here. auto-detected by state — the
//     caller need not pass opts.override.
//  3. EXPLICIT OVERRIDE — from any OTHER non-ready state, still gated behind
//     an explicit opts.override + opts.cosignedBy co-sign (never the default
//     accept button).
// All three LAND the diff and reach `done`; nothing else can.
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
    recordLanding(loom, by, git); // §A: accept LANDS the work (never throws)
    saveLoom(loom);
    return loom;
  }

  // (2) OWNER OVERRIDE: needs-review / blocked are directly override-acceptable
  // by the owner. (3) any other non-ready state still needs an explicit co-sign.
  const ownerOverride = loom.state === "needs-review" || loom.state === "blocked";
  if (!ownerOverride && (!opts?.override || !opts.cosignedBy?.trim())) {
    throw new Error("accepting a non-ready loom requires an override co-sign");
  }

  const fromState = loom.state;
  loom.state = "done";
  loom.acceptedOverride = true; // the audited-override flag (§A/§M)
  const ev: { type: string } & Record<string, unknown> = { type: "accepted", by, override: true, fromState };
  if (opts?.cosignedBy?.trim()) ev.cosignedBy = opts.cosignedBy;
  appendEvent(id, ev);
  recordLanding(loom, by, git); // §A: accept LANDS the work (never throws)
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
