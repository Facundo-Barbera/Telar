# #197 — the intermittent git overview test timeout, measured

Every number below
comes from `/tmp/telar-197/measure.ts`, which imports the production runners
(`createGitRunner`, `createAsyncGitRunner`, `defaultAsyncGitRunner`) and the
production readers (`gitOverview*`, `sessionDiff*`, `sessionFilePatch*`) and
repeats the body of `apps/engine/test/worktree.test.ts:415` verbatim in shape,
each iteration in a fresh `mkdtemp` repo. Machine: 8 cores, load average ~3.7–4.7
at the time of measurement.

## What the test costs

| | |
| --- | --- |
| git children per run | **51** — 24 synchronous + 22 asynchronous through the runners, plus 5 in the `repo()` fixture |
| one git child | median **6 ms** (min 4, p90 7) |
| whole test body, isolated | median **329 ms**, p90 362 ms, max 362 ms |
| the same test via `bun test -t`, 12 runs | 406–507 ms end to end |
| budget | 5000 ms — about **15× headroom** |

So the test is almost entirely process-spawn cost: 51 × ~6 ms. Nothing it does
is slow, and nothing in it waits on anything but `git`.

## Load alone does not explain it — confirmed

Eight CPU spinners (one per core) for the duration of a run:

| | isolated | 8 spinners |
| --- | --- | --- |
| one async child | 6 ms | 9 ms |
| whole test body | 329 ms | **509 ms** |

**1.55×.** Reaching 5000 ms this way needs a ~15× inflation of per-spawn cost.
This matches the issue's note that load alone has not explained every failure.

## A demonstrated mechanism: the shared async pool can starve

`createAsyncGitRunner` keeps **one 4-slot pool per instance**, and its deadline
**includes queue time** (`apps/engine/src/worktree.ts:108-155`). There is one
module-global instance, `defaultAsyncGitRunner` (`worktree.ts:157`) — and
**every `EngineState` constructed without an explicit runner uses it**
(`apps/engine/src/state.ts:3940`). A composite run builds many of those in one
`bun test` process; the flaky test issues 22 asynchronous reads through the same
four slots.

Occupying **all four slots** with real git children held 3 s each, while running
the test body:

| | shared pool, quiet | shared pool, four 3 s competitors |
| --- | --- | --- |
| one async child | median 6 ms, max 9 ms | median 6 ms, **max 2950 ms** |
| `gitOverviewAsync` phase | 53 ms | **3002 ms** |
| whole test body | 338 ms | **3357 ms** (p90) |

Saturating the pool turns a 338 ms test into a 3357 ms test, and none of that is
git being slow: it is queue time, charged to the waiting call's own deadline. The
pool's default deadline is `DEFAULT_GIT_TIMEOUT_MS = 30_000` (`worktree.ts:57`),
so a competitor that stalls rather than merely being slow can hold a slot for up
to 30 s — **six times** this test's 5 s budget — with the test's own git work
still costing 6 ms a call.

### What this is and is not

- **It is a mechanism, demonstrated.** Saturating the singleton reproduces a
  breach of the same budget, in the same code, with the same runner.
- **It is NOT the measured cause of the historical failures.** No trace was
  captured from a failing composite run, and there is no evidence yet that real
  neighbouring tests occupied the singleton's slots when this test failed. The
  only test file that used `defaultAsyncGitRunner` was this one; `state.ts` uses
  it for every `EngineState` built without an explicit runner, which makes the
  coupling *possible*, not proven.
- **All four slots have to be busy** for a read to queue at all. One occupied
  slot delays nothing: the pool's limit is 4, and three remain.
- Whether it explains "passes standalone, passes hosted CI" is therefore a
  hypothesis consistent with the numbers, not a finding.

## Why a bigger timeout is the wrong answer

Measurement does not support it, on its own terms:

- Isolated p90 is 362 ms against 5000 ms. The budget is not tight.
- The mechanism above is queue waiting, not a slightly slow test. While the
  pool is saturated by stalled reads, a budget under 30 s (the pool's own
  deadline) can still be exceeded, so a larger number buys a slower failure
  rather than a fix — for that mechanism. For any cause not yet identified, a
  larger number has no measured justification either.
- It would also hide the real signal: a test that suddenly waits seconds for a
  pool slot is telling us something true about the daemon's read path.

## Options considered

1. **Give the test its own pool** — DONE, see below (smallest, and arguably more correct):
   `worktree.test.ts:415` uses `defaultAsyncGitRunner`, but what it asserts is
   that the async readers agree with the sync ones — not anything about the
   singleton. A `createAsyncGitRunner()` local to the test removes the
   cross-file coupling entirely. One line, in the test, no product change.
   It does mean the singleton's own queue behaviour is covered only by the
   dedicated pool tests above it (`worktree.test.ts:401`), which is where that
   behaviour is actually specified.
2. **Do not charge queue time to a call's deadline** (product change): start the
   timer when the child starts, and bound the queue separately. This changes
   what the deadline promises — today it is "an answer within N ms", which is
   the honest thing for a poll — so it needs a decision, not just a patch.
3. **A pool per `EngineState`** (product change): removes the cross-test
   coupling in production too, at the cost of the machine-wide cap the single
   pool exists to provide. Concurrency would then need a global limit of its
   own.

Option 1 fixes the test. Options 2 and 3 are about whether one slow git read in
the daemon should be able to delay every other project's read by up to 30 s —
which is the same defect wearing production clothes, and worth its own issue.

## What was changed

Option 1, in `apps/engine/test/worktree.test.ts`:

- The parity test builds its own `createAsyncGitRunner()`. It asserts that the
  async readers agree with the synchronous ones; it never needed the singleton,
  and using one removed the only cross-file coupling it had. **No timeout was
  changed** and no production code was touched.
- `the shared async runner is a bounded runner like any other` — the singleton
  is still exercised: reachable, and a per-call bound is honoured.
- `a queued read's deadline counts the time it spent queued` — the production
  semantics the parity test used to depend on, pinned on a pool the test owns:
  one slot, occupied, and the queued read reports a timeout without being
  spawned.

Isolated timing after the change, 6 runs: 384–575 ms against the 5000 ms budget.
28 tests pass in the file.

## Limitations

No composite suite was run from this session (root owns that slot), so nothing
here observed a real failure. The falsifiable prediction: if the historical
failures were this mechanism, they should stop under the change above with no
timeout increase; if they continue, the cause is elsewhere and this document has
only ruled out per-call git latency (6 ms median) and CPU load (1.55×).
