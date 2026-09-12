# Optimization round 2 — measured, 2026-09-12

Follows `performance-2026-09-11.md`. That round's DO NOW item 1 (the idle-CPU
fix, #235) is merged and shipping in nightly `20260911.3` and later; this round
measures the engine after it and lands DO NOW items 2 (#245) and 3 (#246).

Against `main` @ `96864f2d`, on the dogfood Mac. The live engine measured here is
`/Applications/Telar.app`'s, running the installed nightly `20260911.3` —
**not** this branch's code (pid 71961 the night of the 11th, pid 97858 after the
shell crash and restart on the 12th).

---

## READ THIS BEFORE ANY LIVE NUMBER BELOW

**No live number here is an after-the-fix number, because the fixes are not in
the live app.** The running engine is the installed nightly; this branch reaches
it only through a build and a restart, which would have killed six people's
sessions. So the before-and-after proof in this document comes from the
**benches in `apps/engine/bench/`**, which run one engine against a store of
their own and compare two builds inside the same minute.

**And the night's measurements were taken under heavy load.** Six other Telar
sessions and a CI runner were working: load average ran **12–66 on 8 cores**
against a baseline of a few. Every figure is recorded with the load beside it.
Both sides of every bench comparison carry that contention equally, so the
*ratios* hold; the absolute milliseconds are roughly 3× what a quiet machine
shows. The morning's live figures (below) were re-taken at **load 4–11** after
the shell crashed and was restarted, which is as close to quiet as this machine
got.

**What still needs a run this document cannot do:**

1. **The streaming-turn CPU share #246 predicts, on the live engine.** Not
   measurable until this branch ships in a nightly. It is the first thing to do
   after it does.
2. **A true idle window.** Even the calm morning samples have one live session
   in them — the one writing this. "Idle" needs a machine with no session at all.
3. **The absolute bench targets the issues name** (see "Against the stated
   targets"), re-judged on a quiet machine.

---

## The live engine, as found

60 s wall, CPU-time delta from `ps`, plus 60 per-second `%cpu` samples. All four
are the **installed nightly** — none of this branch's code. The last two were
taken the next morning, after the shell crash (below) forced a restart, on a
machine with one live session instead of six.

| | 1 — 05:54Z | 2 — 06:11Z | 3 — 15:14Z | 4 — 15:15Z |
|---|---|---|---|---|
| sessions working | six + CI | six + CI | **one** | **one, agent idle** |
| load (before → after) | 29.4 → 26.9 | 21.8 → 37.5 | 4.2 → 5.9 | 6.5 → 10.7 |
| **engine CPU** | **47.0%** | **28.9%** | **50.6%** | **39.6%** |
| `ps %cpu` | avg 45.5 (5.6–86.1) | avg 28.1 (9.8–68.6) | avg 52.3 (12.6–104.4) | avg 39.5 (11.5–89.2) |
| engine RSS | 717 MB | 324 MB | 475 MB | 604 MB |
| desktop main | 1.1%, 212 MB | **102.5%, 1,881 MB** | 0.8%, 242 MB | 1.1%, 180 MB |
| GPU / one renderer | 10.5% / 10.2% | 19.7% / 14.0% | 11.7% / 12.2% | 14.3% / 14.2% |

**The engine costs about the same with one session as with six.** Samples 3 and
4 are a calm machine, a freshly restarted engine three minutes old, and a single
conversation — and it still spends 40–50% of a core, with samples 1 and 2 no
higher under six times the session load. That is the shape of a per-turn cost
that does not parallelise, which is exactly what the bench found: a streamed
delta could not fit in a core, so one streaming session saturates what the
engine has to give and a sixth adds contention rather than throughput.

Sample 4 is the closest thing to idle here — no agent work at all in the window,
only the session's own polling — and it is still 39.6%. RSS also grew 475 → 604
MB across two minutes of near-idle, which is worth a look on its own and is not
something this branch touches.

For scale, `performance-2026-09-11.md` measured 82.5% of a core before #235,
with two sessions working. None of these four figures is evidence either way
about #235 and none is offered as such — the heartbeat is measured directly
below instead.

---

## The shell's main process — not the engine, and the reason the night ended

Caught while taking the samples above: in sample 2 the desktop **main** process
spent a full core (102.5%) at **1.88 GB RSS**, against 1.1% and 212 MB
seventeen minutes earlier. The engine's own RSS *halved* over the same window
(717 → 324 MB), so this was not the engine moving its cost around.

At **00:25 it died with SIGTRAP**, taking the engine — its child — and every
session's running turn with it, including this investigation's. Filed as **#296**
with the crash reports and the timeline; this section is only what the profile
adds, and the same text is a comment there.

`sample 71941 3`, taken at 00:23:59, one minute before the crash. Process at
100.1% CPU, 2.98 GB RSS, 5h30m uptime, nightly `20260911.3`, Electron 43.1.1:

- **All 2,111 samples are on the main thread**, and inside that thread's whole
  2,051-line subtree `mach_msg2_trap` appears 7 times as a leaf. The main thread
  never returned to its idle event wait for the entire window. The shape is
  `NSApplication run → __CFRunLoopDoSource0 → SOURCE0_PERFORM → node/V8 → ~30
  frames of JIT code`. So: **one synchronous, deeply nested, CPU-bound JS call
  from a libuv/IPC run-loop source, running continuously** — not a periodic tick
  that is merely expensive, and not the parallel compiler or GC threads.
- **Physical footprint 16.7 GB** (peak 16.7 GB), against 2.98 GB resident. The
  process had touched far more memory than RSS suggests, which fits a V8
  heap-limit `CHECK` as the SIGTRAP's cause better than the resident figure does.
- **Not I/O bound.** Every large syscall leaf belongs to the other 49 threads
  blocking. `node::sqlite::DatabaseSync::*` appears 7 times and
  `LibuvStreamWrap::OnUvRead` 6.
- **The C++ symbol names are not trustworthy.** Electron 43 ships stripped, so
  `sample` attributes to the nearest exported symbol; `ares_dns_rr_get_ttl`,
  `uv_sem_init` and `node::permission::AddonPermission::Apply` appearing
  mid-stack are almost certainly wrong, and so is the crash report's own
  `ares_dns_rr_get_ttl` frame. The frame *shape* is reliable; the names are not.

It narrows #296's candidate list: a one-shot or periodic main-process task fits
badly, because the callback is running essentially all the time. Listeners
accumulating per scope in `browser-manager.js` — more of them per event, each
doing more work, on the main thread, from one source — fits what the profile
shows.

**After the restart the same process sits at 0.8% and 242 MB**, which is what it
should look like and is the measure of how far off it had drifted.

The heartbeat, which is what #235 actually fixed, is measured in isolation
instead — `bench:idle` at this machine's shape (154 sessions / 60 live / 40
turns each):

| | one beat | idle CPU |
|---|---|---|
| main, before #235 (2026-09-11) | 25.89 ms | 37.7% of a core |
| **this build, 2026-09-12** | **0.41 ms** | **0.7% of a core** |

The fix holds on the larger store: 63× on the beat, and flat with store size
where main's grew.

---

## #245 — window `requests` in the session snapshot

**Before**, the live engine, `GET /v2/sessions/session_f8e0ff9e…?turns=10`,
three consecutive reads: **1,066,437 bytes** in 0.29 s / 0.48 s / 2.53 s (the
2.53 s read is the loaded machine, not the payload).

| key | bytes | rows |
|---|---|---|
| `items` | 740,398 | 327 — windowed correctly |
| `requests` | **300,881** | **549 — 44 in the window, 0 open** |
| `turns` | 22,886 | 10 |

505 of those 549 requests belong to turns the client is not showing, and every
one of them is resolved, so none of it renders. The cockpit re-reads this
snapshot once a second per open conversation; the phone reads the same route
over Wi-Fi.

**After.** `daemon.ts` handed `requests` to `store.requests()` beside a
`...window` it ignored. Requests now follow their turns the way items and tasks
do, plus every OPEN request wherever its turn sits — an unanswered question on a
paged-out turn is still the session's state and still has to reach the composer,
and it rides along on *every* page because clients replace this key rather than
merging it (`SessionSyncEngine.swift:222`).

Measured on a **copy** of the live store, the same session, the same 10-turn
window, both shapes built by the same code so the difference is the change and
nothing else:

| | total | `requests` key | rows |
|---|---|---|---|
| before | 1,065,141 B | 300,881 B | 549 |
| **after** | **786,294 B** | **22,034 B** | **44** |

Both targets the issue named are met: under 800 KB total, under 30 KB for the
requests key. Per open cockpit that is **279 KB/s** of serialize-parse-discard
removed, and the same again on every phone sync.

---

## #246 — batch the streamed `content.delta` appends

### What the issue expected, and what the bench found

#246 costed a delta at **0.073 ms** — the cost of `ExecutionStore.append` on its
own, measured by a scratch bench — and predicted 9.7% of a core at the measured
peak of 133.5 deltas/s.

`apps/engine/bench/append-cost.ts` (new, committed) times the **public path**
instead: a delta as `reportObservations` actually delivers it, against a session
holding the measured shape (327 items / 748 KB of item text). On that path a
single delta cost **1.5–2.9 ms**, twenty times the insert it wraps. The insert
and its fsync were never the problem:

| | ms/event | at 133 deltas/s |
|---|---|---|
| raw append (own implicit transaction, `synchronous=FULL`) | 0.066–0.188 | 9–25% of a core |
| raw append, 16 per transaction | 0.030–0.035 | ~4% of a core |
| **ingest, 1 per call (the real path)** | **1.47–2.87** | **196–382% of a core** |

That last row is the finding: a streaming turn could not fit in one core, which
is what "the machine works noticeably harder while an agent is typing" was.

### The fix the issue names: coalesce per item, per tick

`driver.ts` flushed every delta on its own — *"Flush per delta: buffering
streamed text defeats streaming"* — and each flush is one engine command.
Deltas for the same open block now merge in the pending buffer and flush on a
**16 ms** timer. This is safe because it is exactly what a reader does with
them: N chunks of one block and one row carrying the same text are the same
transcript. The journal holds one row instead of N, too.

Any other observation flushes immediately and takes the buffered deltas with it
in order, so nothing terminal ever waits on the timer.

One correctness change came with it: the observation sink is now bound when
frames are **produced**, not when they are flushed. The old code read it at
flush time on the explicit grounds that emit and flush were adjacent; they no
longer are, and the idle pump swaps sinks between frames, so a deferred flush
could otherwise have posted a turn's text to a wake-up's binding.

**Honest sizing:** a 16 ms window at 133 deltas/s holds about **two** chunks,
not sixteen. That is why the bench sweeps batch size rather than reporting one
number — `2 per call` is what the tick buys, `16 per call` is the shape of the
ceiling.

### The bigger contributor, found while proving it

`ingestObservations` read the whole item projection and wrote it back on **every
batch** — including a batch that is one `content.delta`, which by design touches
no item at all (the text is folded in when the item closes). On a 327-item
session that is 750 KB parsed, validated through zod, re-serialised and stored
per streamed token-chunk.

Two changes, both the discipline this same method already applied to tasks and
to the queue:

- the projection is written only when an observation touched it — `itemsTouched`,
  beside the existing `tasksTouched` and `turnTouched`;
- the parsed projection is cached until something writes it, exactly as
  `queueCache` caches the parsed queue: one writer, in this process, dropped on
  write rather than replaced. Bounded to 8 sessions, because unlike the queue
  there is no live index to prune it against and one entry per session would be
  ~98 MB on this store.

Attribution, same bench, same run:

| | ms per delta, 1 per call |
|---|---|
| before | 2.09 |
| write guard only | 1.57 |
| **+ parsed projection cached** | **0.23** |

### #246 end to end

`bench:append`, 327 items, 400 deltas of 261 bytes, two passes alternating the
two builds back to back (load 19–21 throughout):

| deltas per call | before | after | |
|---|---|---|---|
| 1 | 2.87 / 1.47 ms | 0.39 / 0.40 ms | 4–7× |
| **2 (what a 16 ms tick holds)** | **0.94 / 0.64 ms** | **0.18 / 0.16 ms** | **4–5×** |
| 4 | 0.53 / 0.35 ms | 0.08 / 0.06 ms | 6× |
| 16 | 0.12 / 0.09 ms | 0.02 / 0.03 ms | 4–5× |

Together — coalescing moves a streaming turn from 1 delta per call to about 2,
and the projection fix makes each call cheap — a delta goes from **1.5–2.9 ms
to about 0.17 ms**, roughly **10×**. At the measured peak of 133 deltas/s that
is a streaming turn's engine cost falling from *more than two cores* to about
**23% of one**, on a machine under load.

Note the variance, which is itself a result: "before" ranged 1.47–2.87 ms
because a 750 KB parse per event is at the mercy of GC and memory pressure,
while "after" sat at 0.39/0.40 ms across passes. The fix removes a source of
jitter as well as a cost.

### Against the stated targets

#246 asked for `bench/append-cost.ts` under **0.010 ms per event**. That number
came from a bench measuring `ExecutionStore.append` alone on a quiet machine; on
this instrument, which times the whole ingest path, and on a machine at load 20,
the closest comparable rows are `raw append, 16 per txn` at 0.030–0.035 ms and
`ingest, 16 per call` at 0.021–0.026 ms. **Not met as literally stated**, and it
should be re-judged on a quiet machine — the rest of the sweep ran ~3× the
2026-09-11 figures for identical code, which is about what the load explains.

The second half of #246's proof — "a streaming turn's CPU share drops by about 8
points on the live engine" — is **not measured**, for the reason in the caveat
above. It is the first thing to do after this branch ships in a nightly.

---

## What landed

| commit | |
|---|---|
| `ab79a9a2` | window the session snapshot's requests (#245) |
| `5334cf58` | coalesce streamed deltas per item within a tick (#246) |
| `212f00ec` | stop reading and rewriting the item projection per delta |

New bench: `apps/engine/bench/append-cost.ts`, `bun run --cwd apps/engine
bench:append`. It takes the item count, delta count and batch size as arguments,
so the shape it prices can follow the store rather than being pinned to this one.

**Verified** on the calm machine (load 13–18): `bun run typecheck` clean;
`bun test --cwd apps/engine` **2,213 pass / 3 skip / 0 fail** across 124 files;
`bun run lint` 0 errors, 15 warnings, all pre-existing in `apps/web` and none in
a file this branch touches. `bun.lock` unchanged.

A note on the suite, because the first run of it did not look like that. Run
under the loaded machine it reported **14 failures** across four timing-sensitive
files (`embedded-worker`, `plugin-socket-rebind`, `requests`, `run-manager`) —
`eventually(…, 4000)` deadlines blown at load 66 on 8 cores. Checking out the
base commit's `state.ts`, `daemon.ts` and `driver.ts` and re-running the same
four files reproduced **14 failures of the same tests with this branch's changes
removed**, so they were the machine. On the calm machine all four files pass
(38/38), as does the whole suite.

---

## Found and left

- **`ingestObservations` reads `readTasks` on every batch too**, and writes it
  only when touched. The read is the same shape as the item read that mattered,
  against a much smaller document (6.3 MB of `queue.json` across 154 sessions;
  tasks are smaller again). Worth the same cache if it ever shows up, but it did
  not show up here and a cache nobody needs is a cache that can go stale.
- **`reportSessionTasks` reads the item projection and never writes it back.**
  Harmless today because no task observation touches items — but it is an
  unguarded silent-drop if one ever does. Left alone deliberately: changing it
  is a behaviour question, not a performance one.
- **DO NOW item 4 from 2026-09-11 is untouched and is now the largest remaining
  structural win.** Even with requests windowed, the cockpit re-reads ~786 KB
  every second per open conversation to learn what a 42-byte events tail already
  told it. `needsSessionSnapshot` already exists and is already used on the
  paging path. Size L, and it is a `apps/web` change, which this branch was
  scoped out of.
- **`items` is now 94% of the windowed snapshot** (740 KB of 786 KB). If #4 does
  not happen, windowing items harder — or streaming their detail separately — is
  where the next 500 KB/s lives.
- **The engine's own RSS moves in a way nobody has explained.** 717 MB, then
  324 MB seventeen minutes later; 475 MB three minutes after a fresh start, then
  604 MB two minutes after that with the agent doing nothing. Not investigated
  and not obviously wrong — V8 heaps breathe — but the shell's main process went
  the same way before it died (#296), and the engine is a child of the same
  binary. A heap line in `shell.log`, which #296 already asks for on the main
  process, would cost nothing to add for the engine child too.
- **The live engine spends 40–50% of a core on one conversation.** Sample 4
  above is a calm machine, one session, and no agent work in the window. This
  branch's work should move that number and cannot be shown to, because the fix
  is not in the live app. It is the single measurement that would confirm or
  refute this whole document, and it needs one nightly build.
