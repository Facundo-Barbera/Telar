// Phase 0 — Scoping & the Charter (docs/loom-orchestrator.md §5). draftCharter
// is a READ-ONLY agent() pass — Read/Grep/Glob only, restrictTools enforced —
// mirroring verifier.ts's read-only guarantee exactly. It never mutates the repo.
import { agent } from "./engine";
import {
  Charter as CharterSchema,
  type AccountProfile,
  type Charter,
  type ContractAssertion,
  type ProjectManifest,
  type ProofStrategy,
  type VerificationContract,
} from "./schemas";
import { PROOF_TEMPLATES, proofTemplate } from "./proof-templates";

// PURE. The fast-path switch: scoping only runs when the caller gave us
// neither ready-made acceptance criteria nor a ready charter. This is the
// regression guarantee — startLoom's behavior stays byte-identical to today's
// whenever this returns false.
export function needsScoping(input: { acceptanceCriteria?: string[]; charter?: Charter }): boolean {
  const hasCriteria = !!input.acceptanceCriteria?.length;
  const hasCharter = !!input.charter;
  return !hasCriteria && !hasCharter;
}

// PURE. Validates a drafted (or hand-authored) Charter against Telar's
// invariants — most importantly the MOAT GUARD: a woven charter with zero
// required subgoals would make rollupWeave vacuously "done" (M7.1 finding).
// Returns every violation found, not just the first.
export function validateCharter(c: Charter): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!c.objective || !c.objective.trim()) errors.push("objective must be non-empty");

  if (c.decomposition.length) {
    if (!c.decomposition.some((sg) => sg.required)) {
      errors.push(
        "a woven charter must have at least one required subgoal (a decomposition with zero required subgoals is vacuously \"done\")",
      );
    }
  }

  const ids = c.decomposition.map((sg) => sg.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`duplicate subgoal id "${id}"`);
    seen.add(id);
  }

  const idSet = new Set(ids);
  for (const sg of c.decomposition) {
    for (const dep of sg.dependsOn) {
      if (!idSet.has(dep)) errors.push(`subgoal "${sg.id}" depends on unknown subgoal "${dep}"`);
    }
  }

  const cycle = findCycle(c.decomposition.map((sg) => [sg.id, sg.dependsOn] as const));
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);

  return { ok: errors.length === 0, errors };
}

// Standard 3-color DFS cycle detection over an adjacency list. Returns the
// cyclic path (for a useful error message) or null if acyclic. Missing
// dependsOn targets are ignored here — validateCharter reports those separately.
function findCycle(edges: ReadonlyArray<readonly [string, string[]]>): string[] | null {
  const adj = new Map(edges.map(([id, deps]) => [id, deps]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const [id] of edges) color.set(id, WHITE);

  const path: string[] = [];
  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY);
    path.push(id);
    for (const dep of adj.get(id) ?? []) {
      if (!adj.has(dep)) continue; // unknown target — reported elsewhere
      const c = color.get(dep);
      if (c === GRAY) return [...path, dep];
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    path.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const [id] of edges) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return null;
}

// Injectable so tests never invoke a live model — see verifier.ts for the
// same pattern (VerifyOpts.account/model).
export type DraftCharterDeps = { agent?: typeof agent; account?: AccountProfile; model?: string };

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

// READ-ONLY: never mutates the repo. Copies verifier.ts's exact read-only
// option names (restrictTools + read-only tools only, explicit disallow of
// Write/Edit/Bash as defense-in-depth). Does NOT throw on an invalid
// decomposition — the caller (dispatcher.startLoom) validates via validateCharter.
export async function draftCharter(
  input: { prompt: string; manifest: ProjectManifest; proofStrategy?: ProofStrategy; storyMarkdown?: string },
  deps: DraftCharterDeps = {},
): Promise<Charter> {
  const strategy = input.proofStrategy ?? "verifier-criteria";
  const template = proofTemplate(strategy);

  const templatesBlock = Object.values(PROOF_TEMPLATES)
    .map((t) => `- ${t.strategy}${t.strategy === strategy ? " (selected)" : ""}: ${t.label} — ${t.guidance}`)
    .join("\n");

  const task = `You are drafting a Telar Charter for the following objective. This is a
READ-ONLY scoping pass — you may read the repository to understand context, but
you must NOT write, edit, or run anything. Decide whether this objective is a
single self-contained change, or must be decomposed into sub-goals (a weave of
Threads).

--- Objective ---
${input.prompt}

--- Selected proof strategy: ${strategy} ---
${template.guidance}

--- All proof strategies (choose the same or a better fit per subgoal) ---
${templatesBlock}

${input.storyMarkdown ? `--- Story ---\n${input.storyMarkdown}\n` : ""}
Rules:
- If this objective decomposes naturally, produce a decomposition[] of
  SubGoals — a non-empty decomposition is what makes this Charter weave
  Threads. EACH subgoal must be provable INDEPENDENTLY (its own proofStrategy
  + acceptanceCriteria), not by inspecting the whole.
- A woven decomposition MUST include at least one subgoal with required:true —
  a decomposition with zero required subgoals is invalid and will be rejected.
- If it is a single self-contained change, leave decomposition empty.
- Fill scope (allowedPaths/forbiddenPaths) and budget conservatively.
- Set proofStrategy to the strategy that will actually prove this done.`;

  const charter = await (deps.agent ?? agent)(task, {
    schema: CharterSchema,
    cwd: input.manifest.root,
    tools: READ_ONLY_TOOLS,
    restrictTools: true,
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"],
    settingSources: [],
    account: deps.account,
    model: deps.model,
  });

  if (!charter) {
    // agent() returns null only if the model never emitted a result — surface
    // a minimal, non-weaving charter so validateCharter's caller sees a clear
    // failure rather than a thrown exception from a null-deref downstream.
    return CharterSchema.parse({
      objective: input.prompt,
      proofStrategy: strategy,
      scope: {},
      budget: {},
    });
  }
  return charter;
}

// READ-ONLY weave planner for the bundle path (docs/loom-model.md §5, §W). The
// Spec Bundle is ALREADY human-approved (provenance-stamped) and its objective,
// contract, and provenance are FROZEN — this pass does NOT re-scope them. Its
// only job is to decompose the bundle into a charter.decomposition so the
// existing weave engine (dispatchExecution -> runWeaveWiring -> runWeave) fans
// the work across independently-buildable, independently-provable Threads.
//
// Mirrors draftCharter's read-only agent() lockdown VERBATIM — Read/Grep/Glob
// only, restrictTools + an explicit Write/Edit/Bash disallow, settingSources:[]
// — so planning never mutates the repo. NEVER throws on a null model result:
// like draftCharter it returns a minimal, non-weaving charter, which makes the
// caller (startLoomFromBundle) degrade to today's single-builder path unchanged.
export async function planWeaveFromBundle(
  input: {
    loomId: string;
    objective: string;
    bundleFiles: { path: string; contents: string }[];
    contract: VerificationContract | null;
    manifest: ProjectManifest;
  },
  deps: DraftCharterDeps = {},
): Promise<Charter> {
  const assertions = input.contract?.assertions ?? [];

  // Partition the contract by subGoalId — the bundle's OWN build-order labels
  // (e.g. W1-109, W2-112). Assertions labelled "ALL" (or unlabelled) are
  // cross-cutting: they belong to every Thread, so they never mint a workstream
  // of their own. We surface the partition to the planner but do NOT invent ids.
  const bySubGoal = new Map<string, ContractAssertion[]>();
  const crossCutting: ContractAssertion[] = [];
  for (const a of assertions) {
    const key = a.subGoalId?.trim();
    if (!key || key === "ALL") {
      crossCutting.push(a);
      continue;
    }
    const list = bySubGoal.get(key) ?? [];
    list.push(a);
    bySubGoal.set(key, list);
  }

  const workstreamsBlock = bySubGoal.size
    ? [...bySubGoal.entries()]
        .map(([id, as]) => `- ${id}:\n${as.map((a) => `    - [${a.type}] ${a.description}`).join("\n")}`)
        .join("\n")
    : "(the contract carries no subGoalId labels — decide the decomposition from the bundle itself)";

  const crossCuttingBlock = crossCutting.length
    ? crossCutting.map((a) => `    - [${a.type}] ${a.description}`).join("\n")
    : "(none)";

  const filesBlock = input.bundleFiles.length
    ? input.bundleFiles.map((f) => `----- ${f.path} -----\n${f.contents}`).join("\n\n")
    : "(no bundle files)";

  const task = `You are PLANNING the execution of an already-approved Telar Spec
Bundle. Its objective, Verification Contract, and provenance are human-approved
and FROZEN — do NOT re-scope, re-approve, or edit them. This is a READ-ONLY
planning pass: you may read the repository to understand context, but you must
NOT write, edit, or run anything.

Your ONLY job: decompose this Bundle into independently-BUILDABLE,
independently-PROVABLE Threads (a decomposition[] of SubGoals). Each Thread is
handed to its own builder with its own slice of the contract, so each SubGoal
must be provable on its OWN — never by inspecting the whole.

--- Objective ---
${input.objective}

--- Workstreams (the contract's subGoalId partition) ---
${workstreamsBlock}

--- Cross-cutting assertions (subGoalId ALL/none — apply to EVERY Thread) ---
${crossCuttingBlock}

--- Bundle files ---
${filesBlock}

Rules:
- If the contract's assertions carry subGoalId labels, produce EXACTLY ONE
  SubGoal per distinct non-ALL subGoalId, using that exact value as the SubGoal
  id. Do NOT invent, merge, split, or rename ids — partition by the labels the
  bundle already gives you.
- Derive each SubGoal's acceptanceCriteria from THAT workstream's assertions
  (the ones sharing its subGoalId, plus the cross-cutting ones), so the Thread
  is provable in isolation.
- Set dependsOn from the build-order notes in the bundle (roadmap.md / design
  docs). Only real prerequisites — keep the graph acyclic.
- A woven decomposition MUST include at least one SubGoal with required:true —
  a decomposition with zero required subgoals is invalid and will be rejected.
- Leave decomposition EMPTY only if the work is genuinely ONE atomic unit (a
  single workstream, or an unpartitioned contract that does not decompose).
- objective/proofStrategy/scope/budget describe the whole weave; fill them
  conservatively from the bundle.`;

  const charter = await (deps.agent ?? agent)(task, {
    schema: CharterSchema,
    cwd: input.manifest.root,
    tools: READ_ONLY_TOOLS,
    restrictTools: true,
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"],
    settingSources: [],
    account: deps.account,
    model: deps.model,
  });

  if (!charter) {
    // Mirror draftCharter's null-result fallback: a minimal, non-weaving
    // charter so startLoomFromBundle degrades to the single-builder path
    // rather than throwing.
    return CharterSchema.parse({
      objective: input.objective,
      proofStrategy: "verifier-criteria",
      scope: {},
      budget: {},
    });
  }
  return charter;
}
