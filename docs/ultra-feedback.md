# Ultra, from the agent's side

**Status:** written 2026-08-03, from one authored run (`u-f085dfaa8157`, "telar-dev-perf")
while that run was still in its implement phase. **Scope:** the MCP tool surface
(`ultra`, `ultra_status`, `ultra_stop`) and the script-authoring contract — not the
executor, not the storage layer, not the rail UI.

**Who this is from:** the only user of this surface who is not a human. Everything below
is what the API felt like to *author against and operate*, not what it looks like to read.
Where a claim is an impression rather than a checked fact it is marked as one.

## What this rests on

| Claim | Evidence |
| --- | --- |
| Resume exists server-side but is unreachable from the tool | `apps/web/app/api/ultra/[id]/resume/route.ts` exists; the `ultra` tool's input schema is `{script, args}`, `required: [script]` |
| `schema` cannot be constructed as documented | Authoring reference says `schema` takes *a zod object*; `import`/`require` are banned in the sandbox and `z` is not in the injected surface (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`) |
| Live counters can contradict the phase | Snapshot mid-run reported `started: 3, done: 1, inFlight: 2` while the script was provably past a `parallel()` barrier and running one sequential `agent()` |
| Spend is withheld deliberately | `ultra_status`'s own note: "This snapshot carries NO cost figure, deliberately" |
| Nothing bounds a run's spend | Authoring reference: "There is no budget or spend ceiling anywhere in Ultra — spend is a readout, not a cap" |

## What works, and should not be touched

**The explicit-model rule.** `opts.model` required on every `agent()` call, rejected
*before* anything spawns, naming the offending call site. This changed how the run was
authored: not "what model is this run" but "what model is this call". A default would
have hidden that decision. It is the same argument `summarizeRuns` already makes by
taking provider as an argument rather than defaulting it
(`components/common/ultra-dock-signal.tsx:179-184`) — Ultra is consistent with the
codebase's own philosophy here, and that consistency is worth protecting.

**Launch-and-detach, with guaranteed delivery.** The tool description is forceful about
the usage pattern — *end your turn, do not busy-poll, nothing makes the result arrive
sooner*. This is prompt-as-API-design and it works: the correct behaviour is also the
obvious one. Contrast with an ordinary background shell command, which invites the agent
to burn turns waiting on it.

**`ultra_status`'s honesty about its own limits.** The note explains why `done` and
`inFlight` can disagree (durable record vs. live event stream) and says outright not to
infer progress from a ratio. This prevented a wrong progress report to the user. Very
few tools document their own instrumentation lag; keep this.

**The determinism ban.** No `Date.now()`, no `Math.random()`, no imports. Mildly
annoying to author around, and correct — a re-run that is not byte-identical cannot be
resumed. Keep it even if resume never ships.

**Surface size.** Six injected names. A 5-agent, 3-phase script was authored in one pass
with no doc lookup. Resist growing this.

## Gaps, ordered by what they cost

### 1. Resume is built and not exposed

The highest-value gap and probably the cheapest to close. The run journals by ordinal and
`/api/ultra/[id]/resume` exists — but the tool takes only `{script, args}`, so an agent
cannot reach it. Consequence: if the last agent in a five-agent run dies, the two 90-turn
implementers ahead of it re-run from zero.

The comparable capability elsewhere takes a `resumeFromRunId` and replays the longest
unchanged prefix of `agent()` calls from cache, running live from the first edited call
onward. The determinism ban above is *precisely* the property that makes this sound, and
it is already paid for.

**Fix:** add `resumeFromRunId` to the `ultra` tool input; cache-hit on unchanged
`(prompt, opts)` pairs.

### 2. `schema` is unusable as specified

The reference documents `schema` as taking a zod object. The sandbox bans `import` and
`require`, and `z` is not injected. There is no expression that produces a zod object
inside a script, so the option cannot be used at all.

Consequence in the live run: structured output was abandoned and a planner's full
markdown was string-interpolated into the next agent's prompt — unvalidated, lossy, and
it spends the child's context on a prose document where five fields were wanted.

**Fix:** either inject `z` into the surface, or accept a JSON Schema object literal
(which needs no import and survives the determinism ban unchanged).

### 3. Worktree isolation has no reconciliation half

`isolation: 'worktree'` gives each agent its own checkout. Nothing collects the results.
For any run whose agents *write*, this makes parallelism unusable: the choice is
conflicting edits in one tree, or isolated edits stranded in N worktrees with no merge
primitive.

The live run serialized its two implementers for exactly this reason. That was the
correct call and it is also a ceiling — fan-out is the feature, and today it only
applies to agents that read.

**Fix:** a collection primitive — return each worktree's diff, or an explicit
`merge`/`collect` step — so a parallel write phase has a defined ending.

### 4. A running agent is opaque

`recentLog` carries only the script's own `log()` lines. A 90-turn implementer is a long
blind window; asked "how is it going", the only honest answer is a phase name. Per-agent
journals exist on disk (`agent-<id>.jsonl`) and are not surfaced.

**Fix:** last event line per in-flight agent in the `ultra_status` snapshot. Not the
stream — one line each is enough to distinguish "working" from "stuck".

### 5. No steering

`ultra_stop` aborts; nothing corrects. A single bad instruction discovered mid-run cannot
be amended. This compounds with gap 1: no steer *and* no resume means one wrong prompt
costs the whole run.

### 6. Spend is withheld from the agent

The stated reason — spend is human-facing and "there is nothing you can do with it" — is
a defensible product call, but it is not quite right. An agent that can read remaining
budget can write the loop-until-budget and loop-until-dry shapes, which are where fan-out
stops being a fixed pipeline and starts adapting to the work. Today Ultra has no ceiling
of any kind, so an unbounded discovery loop simply keeps going.

**Fix (small):** expose remaining budget to the *script*, not the readout — enough for
`while (remaining() > N)`. Keep the human-facing cost figure out of the snapshot if that
is the concern; those are different questions.

## Not a gap, still wrong

`inFlight: 2` while the script is provably sequential at that point is incorrect, even
though the note correctly explains the mechanism. An explained inconsistency is still an
inconsistency, and it is the number an operator reaches for first. Derive the live
counter from the same source as `phase`.

## Suggested order

1. **Expose resume.** Built, paid for by the determinism ban, unreachable.
2. **Fix `schema`.** A documented option that cannot be called is worse than an absent one.
3. **One line per in-flight agent** in the snapshot.
4. Worktree reconciliation — larger, and the thing that unlocks parallel *writes*.
5. Steering, spend-to-script, counter source. Independently droppable.

The first two are the difference between "a fan-out I launch and hope for" and "a harness
I can iterate inside".

## Caveat

One run, observed mid-flight, by an agent that authored the script it is reviewing. The
gaps above are the ones that changed authoring decisions in that run and can be pointed
at in the code; the ordering is a judgement and should be argued with. Nothing here is
based on reading the executor, so any claim about *why* something behaves as it does is
inference from the surface, not from the implementation.
