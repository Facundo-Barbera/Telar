// Dispatcher: fire-and-forget seam between request handlers and the executor.
// Persistence is wired here (looms.ts); abort handles live only in this
// process's memory — cancel works while the loom's process is alive.
import fs from "node:fs";
import path from "node:path";
import { ModelPolicy, type AccountProfile, type Charter, type ProjectManifest, type ProofStrategy } from "./schemas";
import { getProject, telarDir } from "./manifest";
import { createLoom, saveLoom, appendEvent, getLoom, type Loom, type LoomKind } from "./looms";
import { executeLoom, type ExecuteOpts } from "./executor";
import { runEpic } from "./epic";
import { draftCharter as draftCharterDefault, needsScoping, validateCharter } from "./scoping";

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
// executeLoom/runEpic/draftCharter contractually never reject, but a throw
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

// The epic branch: spawn+run child Looms for the charter's decomposition and
// fold up via runEpic. Reused by both the fast path (charter supplied up
// front) and the post-scoping dispatch (charter drafted then approved).
function runEpicWiring(loom: Loom, manifest: ProjectManifest, deps: DispatcherDeps, abort: AbortController): Promise<Loom> {
  const decomposition = loom.charter!.decomposition;
  const policy = deps.policy ?? loadPolicy();
  return runEpic(loom, decomposition, {
    spawnChild: (sg) => {
      const child = createLoom({
        project: loom.project,
        kind: sg.proofStrategy === "quickfix" ? "quickfix" : sg.proofStrategy === "bmad-story" ? "story" : "custom",
        title: sg.title,
        prompt: sg.detail,
        account: manifest.account,
        role: "leaf",
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

// Post-charter dispatch: epic role -> the epic wiring; leaf role -> the plain
// verified loop (executeLoom, or its test injector).
function dispatchExecution(
  loom: Loom,
  manifest: ProjectManifest,
  deps: DispatcherDeps,
  abort: AbortController,
  opts: { maxAttempts?: number } = {},
): Promise<Loom> {
  // TODO(loom-model P1): derive epic-ness from "has decomposition/children"
  // rather than the stored charter.shape-derived loom.role (docs/loom-model.md
  // §2 "Epic-ness is derived"). Left as-is: role is set in multiple places
  // (below, and the scoping path) entangled with charterPolicy gating — a
  // broad refactor is out of scope for this pass.
  if (loom.role === "epic") return runEpicWiring(loom, manifest, deps, abort);
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
    if (input.charter?.shape === "epic" && input.charter.decomposition.length) {
      // MOAT GUARD applies here too: a caller-supplied epic charter bypasses
      // draftCharter (and its validateCharter call in the scoping path below)
      // by going straight through the fast path, so without this check a
      // zero-required-subgoal decomposition would roll up vacuously "done"
      // (the M7.1 finding) via a route validateCharter never sees.
      const v = validateCharter(input.charter);
      if (!v.ok) {
        loom.error = v.errors.join("; ");
        loom.state = "needs-review";
        appendEvent(loom.id, { type: "state", state: "needs-review" });
        saveLoom(loom);
        active.delete(loom.id);
        return loom;
      }
      loom.role = "epic";
      loom.charter = input.charter;
      saveLoom(loom);
      runEpicWiring(loom, manifest, deps, abort)
        .catch(onFailure)
        .finally(() => active.delete(loom.id));
      return loom;
    }

    if (input.charter?.shape === "leaf") {
      loom.role = "leaf";
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
    loom.role = charter.shape === "epic" ? "epic" : "leaf";
    saveLoom(loom);

    const requiresHuman =
      manifest.charterPolicy === "human-required" ||
      (manifest.charterPolicy === "human-required-for-epics" && charter.shape === "epic");

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

export const activeLoomIds = (): string[] => [...active.keys()];

export function loadPolicy(): ModelPolicy {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "policy.json"), "utf8");
    return ModelPolicy.parse(JSON.parse(raw));
  } catch {
    return ModelPolicy.parse({});
  }
}
