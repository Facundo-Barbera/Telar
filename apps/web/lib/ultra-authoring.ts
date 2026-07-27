// Story 4.2 / CAP-3 — THE ULTRA SCRIPT-AUTHORING REFERENCE, as ONE string.
//
// ZERO IMPORTS, exactly like `lib/ultra-wake.ts` and `lib/escalation-kickoff.ts`.
// That is not tidiness: this string is read by the SERVER (composed into a
// session's system-prompt appendix in `lib/session-prompts.ts`) AND by the
// CLIENT (the rail's Script tab renders it as the link-out target), and an
// importless module is the only shape that lets both reach the same text without
// an INV-4 client-bundle violation.
//
// WHY A `.ts` CONST AND NOT A `.md` ON DISK. Nothing in this repo reads a
// SHIPPED markdown asset at runtime — every `.md` read in production code reads
// the state root or a target project's root — and there is no
// `import.meta.url`/`__dirname` asset resolution anywhere in `packages/core/src`
// or `apps/web`. A file read would additionally have to survive the packaged
// Electron build and Next's output tracing (`requirements.ts` is the one place
// in the tree that shows what that costs: a `/* turbopackIgnore: true */` on both
// the read and the join). A TypeScript const is the house pattern for every
// shipped prompt in this repo.
//
// IT TAKES OVER FROM THE TOOL DESCRIPTION RATHER THAN DUPLICATING IT.
// `lib/ultra-mcp.ts`'s `ULTRA_TOOL_DESCRIPTION` used to carry a condensed
// version of all of this. A second, fuller text elsewhere would create exactly
// the failure `lib/session-prompts.ts`'s own header says that module exists to
// prevent — "a SECOND source of truth … the failure mode this repo has paid for
// more than once". So the split is:
//
//   `ULTRA_TOOL_DESCRIPTION` KEEPS the opt-in rule, the non-blocking contract,
//   the script format and the determinism bans — the things a tool description
//   must state because they decide whether the CALL IS LEGAL.
//
//   THIS FILE OWNS the injected surface walk-through, the quality patterns and
//   the worked example — the things that decide whether the SCRIPT IS GOOD. They
//   now arrive in the appendix on every Claude session, so riding the tool
//   schema on every turn as well would be paying twice.
//
// THE FIVE REQUIRED SUBJECTS, and the fifth is not optional. `SPEC.md` CAP-3
// names four (the injected surface API, the explicit-model rule, the quality
// patterns, one worked example) and `epics.md`'s § Story 4.2 dispatch note adds
// a fifth, verbatim: "The authoring reference should steer scripts away from
// standing up servers or long-lived processes via Bash: nothing supervises an
// Ultra child's processes, and service work belongs to sessions and looms." That
// hazard is named NOWHERE ELSE in the planning artifacts, and
// `ULTRA_TOOL_DESCRIPTION` does not carry it (its "Banned inside the script
// body" paragraph bans `require`/`import`/`process`/`Date`/`Math.random`, never
// a long-running Bash child). `ultra-authoring.test.ts` asserts all five by
// stable markers.
//
// THE TWO QUALITY-PATTERN NAMES ARE LOAD-BEARING STRINGS. `SPEC.md` CAP-3
// enumerates them — "the quality patterns (adversarial-verify, loop-until-dry)"
// — and before this story they appeared in exactly ONE production string, the
// paragraph of `ULTRA_TOOL_DESCRIPTION` this story deletes. If this file did not
// carry them, story 4.2 would REMOVE two named patterns from the product.
//
// IT IS STATIC. No `safeLiveContext`, no state-root read, no injected reader —
// say so out loud, because every other block added to `session-prompts.ts` since
// story 2.1 has been a live read and the next author will assume this one is too.

export const ULTRA_AUTHORING_REFERENCE = `## Authoring an Ultra script

An Ultra script is plain JavaScript that runs in a frozen sandbox. It gets ONE
injected surface and nothing else — no imports, no host access, no wall clock.

### The injected surface

Your default export receives exactly these:

- \`agent(prompt, opts)\` — spawns ONE subagent and returns its result, or
  \`null\` if it died. It never throws for an ordinary failure, so a dead agent
  is a value to handle, not an exception to catch. \`opts.model\` is REQUIRED on
  EVERY call (see below). Optional: \`label\` (a short display name, shown in the
  rail), \`effort\` (display only — it reaches the UI, never the child),
  \`schema\` (a zod object; forces a validated structured result off
  \`emit_result\` — omit it to get the model's final text instead), \`isolation\`
  (a fresh worktree for a parallel mutator).
- \`parallel(thunks)\` — runs an array of \`() => agent(...)\` thunks
  concurrently WITH A BARRIER. A failed thunk resolves to \`null\` in its slot;
  the call itself never rejects. Filter with \`.filter(Boolean)\` before use.
- \`pipeline(items, ...stages)\` — flows each item through every stage
  independently, NO inter-stage barrier, so item A can be in stage 3 while item B
  is still in stage 1. A stage callback receives \`(prev, item, index)\`; a throw
  drops just that item to \`null\` and skips its remaining stages.
- \`phase(title)\` — groups progress into a named section. The session UI groups
  agent rows by the most recent preceding \`phase()\` call, and the run anchor's
  progress sliver is the count of distinct phases seen over
  \`meta.phases.length\`. A run that never calls \`phase()\` gets no sliver.
- \`log(msg)\` — narrates one line into the rail's narrator window.
- \`args\` — whatever JSON value was passed at launch.

### The explicit-model rule

EVERY \`agent()\` call must carry \`opts.model\`. There is no default and there
is no inheritance. A script with even one model-less \`agent()\` call is REJECTED
BEFORE ANYTHING RUNS, naming the offending call site — you get the rejection
back and re-author, and nothing was spawned and nothing was billed.

Choose per call rather than globally: a cheap mechanical stage and the hardest
verify stage in the same script should not be the same model. Model is a control
signal, so it is never coerced to a default on your behalf.

### Quality patterns

There is no budget or spend ceiling anywhere in Ultra — spend is a readout, not a
cap — so bound open-ended work with structure instead of with a number:

- **loop-until-dry** — for unknown-size discovery (bugs, edge cases, files to
  rewrite), keep spawning finders until K consecutive rounds return nothing new.
  Iterate a queue until it is empty rather than running a fixed count; a simple
  \`while (i < 10)\` misses the tail and wastes the rounds it does not need.
- **adversarial-verify** — for anything you want double-checked, have a critic
  \`agent()\` try to REFUTE a builder \`agent()\`'s output rather than confirm it,
  and prefer several independent critics with DIFFERENT lenses (correctness,
  security, does-it-reproduce) over several identical ones. Diversity catches
  failure modes redundancy cannot.

Both are shapes, not library calls: you write them with \`parallel\`,
\`pipeline\` and ordinary control flow.

### No servers, no long-lived processes

Do not have a child agent start a server, a watcher, a tunnel, or any other
long-lived process via Bash. NOTHING SUPERVISES AN ULTRA CHILD'S PROCESSES: the
run detaches from the turn that launched it, a stop aborts the agents rather than
the things they spawned, and a server restart kills the run while leaving
whatever it started behind. Service work belongs to a session or a loom, which
have owners that outlive a single script.

Scripts should do bounded work that ends: read, analyze, generate, verify, write.
If a step needs something running, have the script produce the change and let a
session run it.

### A worked example

    export const meta = {
      name: "rank-files",
      description: "summarize then rank a set of files",
      phases: ["summarize", "rank"],
    };

    export default async function ({ agent, parallel, phase, log, args }) {
      phase("summarize");
      const summaries = await parallel(
        args.files.map((f) => () =>
          agent("Summarize " + f + " in two sentences.", { model: "sonnet", label: f })),
      );
      const ok = summaries.filter(Boolean);
      log(ok.length + "/" + args.files.length + " files summarized");

      phase("rank");
      return agent("Rank these summaries best-to-worst: " + JSON.stringify(ok), {
        model: "opus",
        label: "rank",
      });
    }

Note what it does NOT do: it declares no budget, it starts nothing long-lived,
and every \`agent()\` call names its own model.`;
