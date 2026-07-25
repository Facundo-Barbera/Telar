# Story Pipeline — the boilerplate prompt

Copy the block below, replace `{STORY_ID}`, run it. Same prompt for every story, 1.1 through 6.6.

---

```
Deliver story {STORY_ID} end to end as a single Workflow run: context → plan → build → verify → report.

You orchestrate. You write no code. Every agent() call names an explicit model — never omit it,
because an omitted model inherits this session's model and a spawned Fable agent is prohibited.

SOURCE OF TRUTH, in precedence order:
  1. _bmad-output/planning-artifacts/epics.md — story {STORY_ID}: its user story, acceptance
     criteria verbatim, dev-server proof, dispatch notes, and the FR ids it covers
  2. _bmad-output/specs/<owning-spec>/SPEC.md — the success: clauses ARE the acceptance contract
  3. _bmad-output/specs/<owning-spec>/*.md — contractual companions (admission.md, verification.md,
     map-and-storage.md, item-model.md, ui-contract.md, ux-surfaces.md, recipe-schema.md, brownfield.md)
  4. _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md — AD-1..AD-21
  5. _bmad-output/project-context.md — binding project rules
  Documents listed in SPEC frontmatter as `sources:` are traceability only, not contract.

PHASES

1. CONTEXT — 5 readers in parallel, model: sonnet. Fixed at 5, one each:
   story (the entry in epics.md, ACs verbatim) · contract (owning SPEC success/constraints/non-goals)
   · as-built (the spec's brownfield.md, then the real files it names — what to REUSE, with file:line)
   · architecture (every binding AD, quoted; the track's write-set boundary from WORK-SPLIT.md)
   · rules (project-context.md + the UX companion if this story has UX-DR coverage)

2. PLAN — model: opus. Author tasks, each naming its files, its ACs and the test that proves it.
   Copy ACs verbatim; never invent, soften or merge them. Reuse over rebuild. Honor any stated
   within-story ordering. Then one adversarial critic, model: opus, whose job is to BREAK the plan —
   an AC no task satisfies, a rebuild of something that exists, a write outside the track's write
   set, a missing test, a devProof that doesn't prove the ACs.

3. BUILD — ONE agent, model: opus. Not a fan-out: parallel writers collide on shared files, and the
   interference analysis that would make it safe is FR-LR-9, which we're using this to build.
   Implement every task, write tests as you go, run bun test yourself. Stay inside the track's write
   set — a change needed in another track's files is reported, not made. Do not commit, do not branch.

4. VERIFY — parallel, all read-only:
   · gate (haiku): bun test · bun run lint · bunx tsc --noEmit in BOTH packages/core and apps/web.
     Fix nothing. Report only NEW lint problems in changed files — the ~77k pre-existing ones,
     mostly under .next-desktop/, are not this story's.
   · sentinel (opus): audit changed files against the four walls below.
   · dev-proof (sonnet): actually run this story's dev-server proof from epics.md. Report what you
     observed, not what you expected.
   · AC refuters (sonnet): one per acceptance criterion, capped at 12 — if the story has more, say
     so loudly, don't silently truncate. Each tries to REFUTE its AC. Default is not-met; only
     not-met:false with positive evidence (a passing test, code you read). "Looks right" isn't evidence.

5. REPAIR — max 2 rounds, model: opus. Fix only what's broken; no refactors, no improvements.
   Never weaken a test or an AC to make it pass. A refuter can be wrong — if the AC is met, say so
   with the evidence they missed rather than changing code. Re-verify after each round.

6. REPORT — model: sonnet. Write _bmad-output/implementation-artifacts/stories/{STORY_ID}-<slug>.md
   with frontmatter (story_id, title, status, epic, frs, baseline_commit) and sections: user story ·
   Acceptance Criteria (checked only where a refuter confirmed) · Tasks/Subtasks · Dev Agent Record
   (Debug Log: gate output, every AC verdict with evidence, dev-proof observation, each repair round;
   Completion Notes) · File List · Change Log with a suggested conventional-commit message.
   Report faithfully — if the gate is red, say so with the output. Never describe blocked work as done.

HALT IMMEDIATELY, do not repair, status blocked, if any appear:
  · an agent-callable accept tool, or any non-human path from ready to done
  · a write or edit tool granted to verifier.ts / verify-thread.ts / critic.ts / panel.ts or a lab agent
  · a module writing another module's TELAR_HOME subtree by path, or shared runtime state written
    outside its core port
  · a client component importing @telar/core runtime
These are non-negotiable. A guessed fix to a wall is worse than a red build.

HOUSE RULES
  Bun only; bun.lock only via bun install/add. No CI — the gate above is it. Atomic writes
  (.tmp → fs.renameSync). zod schemas for persisted entities live in @telar/core, never redefined
  in apps/web. @telar/core is server-side only; client components import types only. Next 16 canary —
  read node_modules/next/dist/docs/ before writing framework code. No formatter: match surrounding
  style exactly. Write tests for new logic; bun test is the only tooling.

DONE = gate green in both packages · every AC confirmed by its refuter · the dev-server proof
observed · story file written. No commit — committing is mine.
```

---

**Dry-run a big story first:** append `Stop after the plan and critic; do not build.` — worth doing for 6.2, 6.3 and 6.4.

**If the run dies:** every Workflow invocation returns a `runId` and persists its script. Resume with `Workflow({scriptPath, resumeFromRunId})` — the unchanged prefix replays from cache. Read `<transcriptDir>/journal.jsonl` before diagnosing an empty result.
