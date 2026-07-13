// M11 (docs/adaptive-verification.md §3.2, §7, §8) — the PURE deliverable
// signal ALL THREE M11 seams consume, so it lives in its own module and is
// never duplicated:
//   M11.0 — isLaneViable's third true-path ("a non-server verification plan is
//           formable — now or after the build") + the strategy-derived park copy;
//   M11.1 — synthesizeContract's per-criterion assertion-type derivation (the
//           `run` field is the runnable an emitted command assertion carries);
//   M11.2 — frozenLaneVerify's strategy selection (the `strategy` values map
//           1:1 onto the VerificationStrategy union's non-server members).
//
// PURITY IS THE CONTRACT (the M11.0 no-spend guarantee, doc §8): every signal
// is a cheap, bounded, synchronous filesystem read (one package.json parse +
// one top-level readdir) or an in-memory charter lookup — no LLM, no agent, no
// spawn, no network. That honors the executor.ts isLaneViable "cannot loop or
// spawn" contract verbatim; the pre-flight decision itself stays free. Signals
// are RE-DERIVABLE: a greenfield "deferred-gate" plan carries no runnable yet,
// and the establishing seam (M11.2) simply derives the signal AGAIN when the
// artifact exists — by then the filesystem evidence answers concretely.
//
// Signal set + precedence (doc §8 "how the orchestrator INFERS project type"):
//   0. WEB SHAPE SHORT-CIRCUITS TO NOT-PLANNABLE. A deliverable whose own
//      package.json declares a dev/start script wants a LIVE lane — a test
//      gate cannot honestly settle its live-critic assertions, and proceeding
//      on one would burn build spend before the inevitable no-target demote.
//      Conservative bias (doc §4): classify toward web/unknown when unsure —
//      the fail-closed direction whose worst case is EXACTLY today's park.
//   1. package.json `scripts.test`  → a test gate exists TODAY ("test-gate")
//   2. package.json `bin`           → a CLI harness is runnable ("cli-harness")
//   3. notebook/dataset markers     → a sandbox eval is plannable ("sandbox-eval")
//   4. charter proof intent         → PROOF_TEMPLATES[proofStrategy]
//      .verifyMechanism === "gate" on the charter or any SubGoal — the
//      GREENFIELD case (the loom_mrigs3zo_vxgrsr prove-run): NO files exist at
//      pre-flight time, but the charter already says "prove me by a
//      deterministic gate", so a plan CAN be formed and the gate is
//      established WHEN THE ARTIFACT APPEARS, never demanded up front
//      ("deferred-gate").
// Filesystem evidence (establishable now) is checked before charter intent
// (plannable later). Malformed/missing package.json or an unreadable root
// NEVER throws — every read degrades to "no signal", which fail-closes to
// today's exact park behavior (worst case unchanged, doc §4).
//
// The signal can only WIDEN viability (proceed where M10.4 parked); it never
// touches a verdict. A deliverable that proceeds on a deferred plan and then
// can't be verified lands the existing fail-closed floor (panelRequired skip →
// demoting coercion, executor.ts:1157-1160) — an honest "could not prove it",
// never a rubber-stamp.
import fs from "node:fs";
import path from "node:path";
import { PROOF_TEMPLATES } from "./proof-templates";
import type { ProofStrategy } from "./schemas";

// Structurally typed (not `Charter`) so this module depends only on schemas'
// ProofStrategy enum — usable with a full Charter, a bare SubGoal list, or the
// nothing a plain custom loom has. Mirrors how isWoven avoids the looms cycle.
export type CharterProofIntent =
  | {
      proofStrategy?: ProofStrategy;
      decomposition?: { proofStrategy?: ProofStrategy }[];
    }
  | null
  | undefined;

// The deliverable SHAPE steers the last-resort escalation COPY (what to ASK
// for when no plan can be formed): a library/CLI/DS deliverable must never be
// asked "how do I run this app / give me a dev command" (doc §3.2 — "the
// escalation copy is web-shaped and must derive").
export type DeliverableShape = "web" | "library" | "cli" | "data-science" | "unknown";

// Which non-server strategy the plan is shaped by (doc §3.4 taxonomy — these
// values map 1:1 onto the non-server members of M11.2's VerificationStrategy
// union). "deferred-gate" is the greenfield charter-intent-only case: nothing
// runnable exists yet, but a deterministic gate is the declared proof.
export type NonServerStrategy = "test-gate" | "cli-harness" | "sandbox-eval" | "deferred-gate";

export type DeliverableSignal =
  | {
      plannable: true;
      shape: DeliverableShape;
      strategy: NonServerStrategy;
      // The runnable that ENCODES the plan, when one exists today — for a
      // "test-gate" it is the lockfile-aware test invocation (`bun run test` /
      // `npm run test` …), exactly what an M11.1-derived `command` assertion
      // puts in `expected`. Absent for deferred-gate (nothing runnable yet —
      // re-derive when the artifact exists) and for cli-harness/sandbox-eval
      // (the runnable is per-criterion, authored where the criteria live).
      run?: string;
      reason: string;
    }
  | { plannable: false; shape: DeliverableShape; reason: string };

// A parse that can only yield a plain object or null — a malformed, missing,
// or non-object package.json is treated as ABSENT (no signal), never a throw.
function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function script(pkg: Record<string, unknown> | null, name: string): string | null {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const s = (scripts as Record<string, unknown>)[name];
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

// npm's scaffold placeholder (`echo "Error: no test specified" && exit 1`) is
// NOT a test command — treating it as one would form a plan that can only
// fail. Excluding it keeps the last-resort ask honest ("give me a test
// command") instead of proceeding into a guaranteed-red gate.
function testScript(pkg: Record<string, unknown> | null): string | null {
  const s = script(pkg, "test");
  return s && !/no test specified/i.test(s) ? s : null;
}

function hasBin(pkg: Record<string, unknown> | null): boolean {
  const bin = pkg?.bin;
  if (typeof bin === "string") return !!bin.trim();
  if (bin && typeof bin === "object") return Object.keys(bin).length > 0;
  return false;
}

// ONE bounded top-level readdir — never recursive (purity/no-spend), never a
// throw (a nonexistent root reads as an empty greenfield dir).
function rootEntries(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function notebookOrDatasetMarker(entries: fs.Dirent[]): string | null {
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".ipynb")) return e.name;
    if (e.isDirectory() && e.name === "notebooks") return "notebooks/";
    if (e.isFile() && (e.name.endsWith(".csv") || e.name.endsWith(".parquet"))) return e.name;
  }
  return null;
}

// The lockfile-aware test invocation: `<pm> run test` runs the declared script
// under the manager that owns the lockfile, regardless of what the script's
// body is — the safest runnable to hand a fail-closed exit-code gate. Reads
// only the ALREADY-fetched top-level entries (no extra I/O); an unknown/absent
// lockfile falls back to npm, which every Node project can run.
function testRunnable(entries: fs.Dirent[]): string {
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun run test";
  if (names.has("pnpm-lock.yaml")) return "pnpm run test";
  if (names.has("yarn.lock")) return "yarn run test";
  return "npm run test";
}

// The charter's proof intent: the charter (or ANY SubGoal) declaring a
// proofStrategy whose PROOF_TEMPLATES verifyMechanism is "gate" says "prove me
// by a deterministic exit-code check" — a formable plan even over zero files.
function charterGateIntent(charter: CharterProofIntent): ProofStrategy | null {
  if (!charter) return null;
  const strategies = [charter.proofStrategy, ...(charter.decomposition ?? []).map((s) => s.proofStrategy)];
  for (const s of strategies) {
    if (s && PROOF_TEMPLATES[s]?.verifyMechanism === "gate") return s;
  }
  return null;
}

// Shape precedence: the STRONGEST marker wins — notebook/dataset (DS) over a
// bin (CLI) over a dev/start script (web) over a package entry point
// (library). Used for the escalation copy AND carried on every signal so
// M11.1's derivation can reuse the classification.
function classifyShape(pkg: Record<string, unknown> | null, entries: fs.Dirent[]): DeliverableShape {
  if (notebookOrDatasetMarker(entries)) return "data-science";
  if (hasBin(pkg)) return "cli";
  if (script(pkg, "dev") || script(pkg, "start")) return "web";
  if (pkg && (pkg.main || pkg.exports || pkg.module || pkg.types || testScript(pkg))) return "library";
  return "unknown";
}

// ADDITIVE export (the frozen-API extension rule: new exports only). The
// charter's gate intent is the SANCTION predicate two consumers share so it can
// never drift: (a) weave-contracts' blanket test-gate tightening — an authored
// multi-criteria contract may be settled by the suite ONLY when the charter
// explicitly declared "prove me by a deterministic gate" (or the criteria are
// the prompt fallback); (b) executor's M11.2 artifact-time establishment, the
// same sanction re-checked when the deferred gate is finally executed. Pure,
// in-memory, never throws.
export function charterHasGateIntent(charter: CharterProofIntent): boolean {
  return charterGateIntent(charter) !== null;
}

export function deriveDeliverableSignal(root: string, charter?: CharterProofIntent): DeliverableSignal {
  const pkg = readPackageJson(root);
  const entries = rootEntries(root);
  const shape = classifyShape(pkg, entries);

  // Web short-circuit (precedence rule 0): a web-shaped deliverable NEEDS a
  // live lane — no non-server plan can honestly settle it, so the pre-flight
  // keeps TODAY'S exact park (and today's dev-command ask) for it. This is
  // the conservative direction: mis-classifying toward web can only preserve
  // current behavior, never launder an unverifiable proceed.
  if (shape === "web") {
    return {
      plannable: false,
      shape,
      reason:
        "the deliverable is web-shaped (package.json declares a dev/start script) — a live lane " +
        "is the right verification substrate and no non-server strategy applies",
    };
  }

  const test = testScript(pkg);
  if (test) {
    return {
      plannable: true,
      shape,
      strategy: "test-gate",
      run: testRunnable(entries),
      reason: `package.json declares a test script (\`${test}\`) — a deterministic exit-code gate exists today`,
    };
  }
  if (hasBin(pkg)) {
    return {
      plannable: true,
      shape,
      strategy: "cli-harness",
      reason: "package.json declares a bin entry — the CLI can be run and asserted on (exit code / output)",
    };
  }
  const marker = notebookOrDatasetMarker(entries);
  if (marker) {
    return {
      plannable: true,
      shape,
      strategy: "sandbox-eval",
      reason: `notebook/dataset marker at the project root (${marker}) — a sandbox eval asserting on artifacts is plannable`,
    };
  }
  const intent = charterGateIntent(charter);
  if (intent) {
    return {
      plannable: true,
      shape,
      strategy: "deferred-gate",
      reason:
        `the charter's proof intent is a deterministic gate (proofStrategy "${intent}") — ` +
        "nothing runnable exists yet, but the gate is establishable when the artifact appears",
    };
  }
  return {
    plannable: false,
    shape,
    reason:
      "no non-server verification strategy is derivable (checked: package.json test script, " +
      "CLI bin, notebook/dataset markers, charter proof intent)",
  };
}

// The LAST-RESORT escalation question, derived from the deliverable shape
// (doc §3.2): ask for what the derived strategy actually NEEDS. Only a
// genuinely-web deliverable is asked for a dev command; a library/CLI/DS
// deliverable is asked for its own strategy's missing piece. Reached only
// when deriveDeliverableSignal found NO plan (plannable:false), so the copy
// keys on shape alone.
export function blockedStrategyQuestion(signal: DeliverableSignal): string {
  switch (signal.shape) {
    case "library":
      return (
        "What command proves this package? Give me a test command I can run against the repo " +
        "(e.g. `bun test`) — its exit code becomes the fail-closed verification gate."
      );
    case "cli":
      return (
        "How do I exercise this CLI? Give me the command(s) to run and the expected " +
        "exit code/output so verification can assert on them."
      );
    case "data-science":
      return (
        "How do I evaluate this deliverable? Give me an eval command and its passing threshold " +
        "(a runnable whose exit code encodes the assertion, e.g. accuracy >= 0.9 on the holdout)."
      );
    case "web":
      // The genuinely-web deliverable keeps today's ask verbatim — a dev
      // command / servers recipe IS what a live-critic lane actually needs.
      return (
        "How do I run this app so verification can drive it? Give me a dev command " +
        "(e.g. `bun run dev`) or a servers recipe, plus any steps to reach the feature."
      );
    default:
      return (
        "How should I verify this deliverable? Give me a verification command I can run " +
        "(a test command like `bun test`, or an eval command plus its passing threshold) — " +
        "or, only if this is genuinely a runnable app, a dev command (e.g. `bun run dev`) " +
        "or a servers recipe."
      );
  }
}
