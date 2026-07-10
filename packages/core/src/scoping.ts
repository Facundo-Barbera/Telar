// Phase 0 — Scoping & the Charter (docs/loom-orchestrator.md §5). draftCharter
// is a READ-ONLY agent() pass — Read/Grep/Glob only, restrictTools enforced —
// mirroring verifier.ts's read-only guarantee exactly. It never mutates the repo.
import { agent } from "./engine";
import { Charter as CharterSchema, type AccountProfile, type Charter, type ProjectManifest, type ProofStrategy } from "./schemas";
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
