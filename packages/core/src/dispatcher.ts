// Dispatcher: fire-and-forget seam between request handlers and the executor.
// Persistence is wired here (looms.ts); abort handles live only in this
// process's memory — cancel works while the loom's process is alive.
import fs from "node:fs";
import path from "node:path";
import {
  ModelPolicy,
  assertProvenance,
  isWoven,
  type AccountProfile,
  type Charter,
  type ProjectManifest,
  type ProofStrategy,
  type Provenance,
} from "./schemas";
import { getProject, telarDir } from "./manifest";
import { createLoom, saveLoom, appendEvent, getLoom, loomDir, type Loom, type LoomKind } from "./looms";
import { executeLoom, type ExecuteOpts } from "./executor";
import { runWeave } from "./weave";
import { draftCharter as draftCharterDefault, needsScoping, validateCharter } from "./scoping";
import { appendSteering, readContract, writeProvenance } from "./bundle";

export type StartLoomInput = {
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  acceptanceCriteria?: string[];
  maxAttempts?: number;
  target?: "dev" | "preview" | "prod";
  charter?: Charter;
  proofStrategy?: ProofStrategy;
};
export type DispatcherDeps = {
  accounts: Record<string, AccountProfile>;
  policy?: ModelPolicy;
  // Injectors — tests swap these for fakes so no live agent/model runs.
  draftCharterFn?: typeof draftCharterDefault;
  runLoomFn?: (loom: Loom, manifest: ProjectManifest, opts: ExecuteOpts) => Promise<Loom>;
};

const active = new Map<string, AbortController>();

// Persistence guard shared by every fire-and-forget background chain below —
// executeLoom/runWeave/draftCharter contractually never reject, but a throw
// here (e.g. a full disk) must never surface as an unhandled rejection and
// crash the server. Each write is attempted independently.
function makeOnFailure(loom: Loom): (err: unknown) => void {
  return (err: unknown) => {
    loom.state = "failed";
    loom.error = err instanceof Error ? err.message : String(err);
    try {
      appendEvent(loom.id, { type: "error", message: loom.error });
    } catch {}
    try {
      saveLoom(loom);
    } catch {}
  };
}

// The weave branch: spawn+run child Looms (threads) for the charter's
// decomposition and fold up via runWeave. Reused by both the fast path
// (charter supplied up front) and the post-scoping dispatch (charter drafted
// then approved).
function runWeaveWiring(loom: Loom, manifest: ProjectManifest, deps: DispatcherDeps, abort: AbortController): Promise<Loom> {
  const decomposition = loom.charter!.decomposition;
  const policy = deps.policy ?? loadPolicy();
  return runWeave(loom, decomposition, {
    spawnChild: (sg) => {
      const child = createLoom({
        project: loom.project,
        kind: sg.proofStrategy === "quickfix" ? "quickfix" : sg.proofStrategy === "bmad-story" ? "story" : "custom",
        title: sg.title,
        prompt: sg.detail,
        account: manifest.account,
        parentLoomId: loom.id,
        subGoalId: sg.id,
      });
      child.acceptanceCriteria = sg.acceptanceCriteria;
      saveLoom(child);
      return child;
    },
    runChild: (child) =>
      executeLoom(child, manifest, {
        policy,
        accounts: deps.accounts,
        abort,
        onState: saveLoom,
        onEvent: (ev) => appendEvent(child.id, ev),
      }),
    onState: saveLoom,
    onEvent: (ev) => appendEvent(loom.id, ev),
    abort,
  });
}

// Post-charter dispatch: a woven charter -> the weave wiring; otherwise the
// plain verified loop (executeLoom, or its test injector).
function dispatchExecution(
  loom: Loom,
  manifest: ProjectManifest,
  deps: DispatcherDeps,
  abort: AbortController,
  opts: { maxAttempts?: number } = {},
): Promise<Loom> {
  if (isWoven(loom)) return runWeaveWiring(loom, manifest, deps, abort);
  return (deps.runLoomFn ?? executeLoom)(loom, manifest, {
    policy: deps.policy ?? loadPolicy(),
    accounts: deps.accounts,
    maxAttempts: opts.maxAttempts,
    abort,
    onState: saveLoom,
    onEvent: (ev) => appendEvent(loom.id, ev),
  });
}

export function startLoom(input: StartLoomInput, deps: DispatcherDeps): Loom {
  const { manifest } = getProject(input.project);
  const loom = createLoom({
    project: input.project,
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    account: manifest.account,
  });
  loom.acceptanceCriteria = input.acceptanceCriteria;
  loom.target = input.target;
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  const scope = needsScoping({ acceptanceCriteria: input.acceptanceCriteria, charter: input.charter });

  if (!scope) {
    // FAST PATH — byte-identical to today's behavior. No draftCharter call,
    // no "scoping" state. This is the regression guarantee.
    if (isWoven(input.charter)) {
      // MOAT GUARD applies here too: a caller-supplied woven charter bypasses
      // draftCharter (and its validateCharter call in the scoping path below)
      // by going straight through the fast path, so without this check a
      // zero-required-subgoal decomposition would roll up vacuously "done"
      // (the M7.1 finding) via a route validateCharter never sees.
      const v = validateCharter(input.charter!);
      if (!v.ok) {
        loom.error = v.errors.join("; ");
        loom.state = "needs-review";
        appendEvent(loom.id, { type: "state", state: "needs-review" });
        saveLoom(loom);
        active.delete(loom.id);
        return loom;
      }
      loom.charter = input.charter;
      saveLoom(loom);
      runWeaveWiring(loom, manifest, deps, abort)
        .catch(onFailure)
        .finally(() => active.delete(loom.id));
      return loom;
    }

    if (input.charter) {
      loom.charter = input.charter;
    }

    executeLoom(loom, manifest, {
      policy: deps.policy ?? loadPolicy(),
      accounts: deps.accounts,
      maxAttempts: input.maxAttempts,
      abort,
      onState: saveLoom,
      onEvent: (ev) => appendEvent(loom.id, ev),
    })
      .catch(onFailure)
      .finally(() => active.delete(loom.id));
    return loom;
  }

  // SCOPING PATH — vague prompt, no acceptanceCriteria/charter supplied.
  const setState = (s: Loom["state"]) => {
    loom.state = s;
    appendEvent(loom.id, { type: "state", state: s });
    saveLoom(loom);
  };

  (async () => {
    setState("scoping");

    const charter = await (deps.draftCharterFn ?? draftCharterDefault)(
      { prompt: input.prompt, manifest, proofStrategy: input.proofStrategy },
      { account: deps.accounts?.[manifest.account], model: deps.policy?.dev },
    );

    const v = validateCharter(charter);
    if (!v.ok) {
      loom.error = v.errors.join("; ");
      setState("needs-review");
      return loom;
    }

    loom.charter = charter;
    saveLoom(loom);

    const requiresHuman =
      manifest.charterPolicy === "human-required" ||
      (manifest.charterPolicy === "human-required-for-epics" && isWoven(charter));

    if (requiresHuman) {
      setState("charter-review"); // paused — awaits approveCharter
      return loom;
    }

    charter.approvedBy = `auto:${manifest.charterPolicy}`;
    saveLoom(loom);
    return dispatchExecution(loom, manifest, deps, abort, { maxAttempts: input.maxAttempts });
  })()
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return loom;
}

// Approve a Charter paused in "charter-review" and dispatch its execution.
// Returns false if the loom doesn't exist, isn't awaiting approval, or has no
// charter to approve.
export async function approveCharter(id: string, by: string, deps: DispatcherDeps): Promise<boolean> {
  const loom = getLoom(id);
  if (!loom || loom.state !== "charter-review" || !loom.charter) return false;

  loom.charter.approvedBy = by;
  saveLoom(loom);
  appendEvent(loom.id, { type: "charter-approved", by });

  const { manifest } = getProject(loom.project);
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, manifest, deps, abort)
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return true;
}

// docs/loom-model.md §5/§2 — a planning session calls this to get a loom id
// to write Spec Bundle files into, BEFORE the loom is "started". The loom
// exists on disk (draft:true, state "queued") so the god-view can render the
// bundle-in-progress, but it is not dispatched — that only happens at the
// commit moment, `startLoomFromBundle`.
export function createDraftLoom(input: { project: string; title: string; objective: string; account?: string }): Loom {
  const account = input.account ?? getProject(input.project).manifest.account;
  return createLoom({
    project: input.project,
    kind: "custom",
    title: input.title,
    prompt: input.objective,
    account,
    draft: true,
  });
}

// The commit moment (docs/loom-model.md §5, §M.6): a session finalizes a
// draft loom's Spec Bundle and this is what turns it into a running loom.
// Provenance-gated (§M.6 — "a Loom can only start from human-approved
// provenance") and contract-gated (§M.1 — no falsifiable Verification
// Contract, no start), modeled on approveCharter's dispatch tail.
export async function startLoomFromBundle(
  loomId: string,
  by: string,
  deps: DispatcherDeps,
  opts?: { sessionId?: string; maxAttempts?: number },
): Promise<Loom> {
  const loom = getLoom(loomId);
  if (!loom) throw new Error(`loom not found: ${loomId}`);
  if (!loom.draft) throw new Error("loom is not a draft awaiting start");

  // PROVENANCE GATE — settable only by this (human-approved UI) action, never
  // the session agent; assertProvenance throws on a blank approver.
  const provenance: Provenance = { sessionId: opts?.sessionId, approvedBy: by, humanApprovedAt: Date.now() };
  assertProvenance(provenance);
  writeProvenance(loomId, provenance);

  // CONTRACT GATE — a bundle loom cannot start (and thus cannot reach ready)
  // without a falsifiable Verification Contract (§M.1).
  const { contract, errors } = readContract(loomId);
  if (!contract || errors.length) {
    throw new Error(`bundle has no valid verification contract: ${errors.join("; ")}`);
  }

  // CROSS-PROCESS GUARD (docs/loom-model.md §M.8): the draft->started flip
  // below is a plain read-modify-write on loom.json with no file lock or
  // version check. Within a single Node process, JS run-to-completion
  // semantics already serialize two calls for the same loom id (no `await`
  // precedes the flip), but a second OS process racing this function could
  // still pass every gate above before either writes draft:false, and both
  // dispatch. An O_EXCL sentinel file makes the FIRST caller to reach here
  // (i.e. the first to actually pass all gates) win atomically; a concurrent
  // second caller fails fast here instead of double-dispatching. Placed after
  // the gates (not before) so a legitimate retry following a failed gate
  // check — e.g. a fixed-up contract on the same draft loom — is never
  // permanently blocked by a leftover marker from the earlier, failed call.
  try {
    fs.writeFileSync(path.join(loomDir(loomId), ".started"), String(Date.now()), { flag: "wx" });
  } catch {
    throw new Error(`loom ${loomId} is already starting or started (concurrent start)`);
  }

  // Sticky: once a contract was required to start, it stays required for
  // the loom's whole lifetime (executor.ts's runVerification enforces this).
  loom.contractRequired = true;
  loom.draft = false;
  saveLoom(loom);
  appendEvent(loomId, { type: "started", by });

  const { manifest } = getProject(loom.project);
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, manifest, deps, abort, { maxAttempts: opts?.maxAttempts })
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return loom;
}

const TERMINAL_STATES: ReadonlySet<Loom["state"]> = new Set(["done", "halted", "failed", "skipped"]);

// "Cancel" always means "stop this loom" — a live loom is aborted (the
// running executor handles its own transition to "halted"); a paused loom
// (charter-review/queued/ready/blocked/needs-review) has no live process to
// abort, so it's halted directly here instead.
export function cancelLoom(id: string): boolean {
  const ctl = active.get(id);
  if (ctl) {
    ctl.abort();
    active.delete(id);
    return true;
  }

  const loom = getLoom(id);
  if (!loom || TERMINAL_STATES.has(loom.state)) return false;

  loom.state = "halted";
  loom.error = loom.error ?? "Cancelled by user.";
  appendEvent(id, { type: "state", state: "halted" });
  saveLoom(loom);
  return true;
}

// Shared re-dispatch tail for steer/reject (docs/loom-model.md §A): a loom
// leaves `ready`/`blocked` and re-enters the SAME verified loop the initial
// start uses (dispatchExecution) — so it RE-VERIFIES and can only land back in
// `ready`, never `done` (terminalStateForCompletedLoom). Fire-and-forget with
// the same persistence guard the other dispatch chains use. Any live process
// for this id (there is none from `ready`/`blocked`, but be defensive) is
// aborted first so we never run two executors against one loom.
function reDispatch(loom: Loom, deps: DispatcherDeps): void {
  const existing = active.get(loom.id);
  if (existing) existing.abort();

  const { manifest } = getProject(loom.project);
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, manifest, deps, abort)
    .catch(onFailure)
    .finally(() => {
      // Only clear if still ours — a concurrent reDispatch may have replaced it.
      if (active.get(loom.id) === abort) active.delete(loom.id);
    });
}

// docs/loom-model.md §A — from `ready` the owner may STEER: record a directive
// and re-dispatch so the loom continues and RE-VERIFIES; it never auto-promotes
// to `done`. `by` is server-derived (never from the request body). The
// directive is recorded durably in the bundle steering log AND folded into the
// loom's prompt so the re-dispatched builder actually acts on it.
export async function steerLoom(id: string, directive: string, by: string, deps: DispatcherDeps): Promise<Loom> {
  if (!by?.trim()) throw new Error("steerLoom requires a non-blank `by`");
  if (!directive?.trim()) throw new Error("steerLoom requires a non-empty directive");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  // §A: steering is offered FROM the verified `ready` milestone.
  if (loom.state !== "ready") {
    throw new Error(`steer is only valid from 'ready' (loom is '${loom.state}')`);
  }

  appendSteering(id, { kind: "steer", text: directive, by });
  appendEvent(id, { type: "steered", directive, by });
  loom.prompt = `${loom.prompt}\n\n## Steering directive (${by})\n${directive.trim()}`;

  // Leave `ready`, re-enter the verified loop. Never jump to `done`.
  loom.state = "queued";
  loom.error = null;
  appendEvent(id, { type: "state", state: "queued" });
  saveLoom(loom);

  reDispatch(loom, deps);
  return loom;
}

// docs/loom-model.md §A — REJECT sends a verified/blocked loom back to work
// with feedback so it re-enters the verified loop; it never reaches `done`.
// Valid from `ready` (the owner is unhappy with green work) or `blocked` (a
// paused loom the owner un-sticks with guidance). `by` is server-derived.
export async function rejectLoom(id: string, feedback: string, by: string, deps: DispatcherDeps): Promise<Loom> {
  if (!by?.trim()) throw new Error("rejectLoom requires a non-blank `by`");
  if (!feedback?.trim()) throw new Error("rejectLoom requires non-empty feedback");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state !== "ready" && loom.state !== "blocked") {
    throw new Error(`reject is only valid from 'ready' or 'blocked' (loom is '${loom.state}')`);
  }

  appendSteering(id, { kind: "reject", text: feedback, by });
  appendEvent(id, { type: "rejected", feedback, by });
  loom.prompt = `${loom.prompt}\n\n## Rejection feedback (${by})\n${feedback.trim()}`;

  // Back to work, re-entering the verified loop. Never `done`.
  loom.state = "queued";
  loom.error = null;
  appendEvent(id, { type: "state", state: "queued" });
  saveLoom(loom);

  reDispatch(loom, deps);
  return loom;
}

export const activeLoomIds = (): string[] => [...active.keys()];

export function loadPolicy(): ModelPolicy {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "policy.json"), "utf8");
    return ModelPolicy.parse(JSON.parse(raw));
  } catch {
    return ModelPolicy.parse({});
  }
}
