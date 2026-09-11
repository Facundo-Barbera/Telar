# Where Telar is slow — measured, 2026-09-11

Against `main` @ `9ce8d454`, on the dogfood Mac, with the live engine running
(pid 11538, nightly `0.1.0-nightly.20260911.1`, up 13h53m). Everything here is a
number taken today; nothing is estimated from reading alone unless it says so.

**Method.** Read-only against the live engine: `ps`, `sample`, `lsof`, and GETs
on its loopback port. Every store measurement runs against a **copy** of
`execution.sqlite` in `/tmp`, never the live file. Two scratch worktrees under
`/tmp/perfinv` hold `main`'s merge-base (`6d3b09a9`) and the unmerged idle branch
so the same bench runs on both.

**Caveat on the live numbers.** The machine had two other sessions working
during the window, so the engine's 82.5% includes real turn work. The bench
numbers below are the clean attribution; the live figure is the ceiling they
add up to.

---

## The store, because every number below scales with it

| | |
|---|---|
| sessions | 154 |
| `execution.sqlite` | 520 MB + 16 MB WAL |
| NDJSON journals | 333 MB |
| `events` rows | 503,319 (278 MB) |
| `receipts` rows | 181,383 |

`documents` table, by kind:

| kind | count | total | max |
|---|---|---|---|
| `items.json` | 151 | 98.2 MB | — |
| `requests.json` | 142 | 17.2 MB | — |
| `queue.json` | 154 | 6.28 MB | 1.01 MB |
| `session.json` | 154 | 0.12 MB | — |

Journal composition: `content.delta` 267,362 (69.8 MB), `item.completed` 58,111
(107.6 MB), `item.started` 58,116, `usage.updated` 59,833.

---

## DO NOW

### 1. Merge the idle-CPU branch. It is ~50 points of a core, and it is already written.

**Symptom.** Telar's engine sits at 80%+ of a core with nothing on screen
changing. Fans audible on a laptop; other work gets slower.

**Measurement.** CPU-time delta on the live engine, 60 s wall:
`49.49 s / 60 s = 82.5% of one core`. Sixty `ps` samples agree (avg 81.6%, min
44.1, max 111.2). RSS 366–386 MB; peak physical footprint 694.8 MB; 82 fds.
`sample 11538 10` puts **3,991 of 8,226 main-thread samples (48.5%) inside
`uv__run_timers` → `RunTimers` → JS** — the 100 ms worker tick.

Against a copy of the real 520 MB store, `main` (`6d3b09a9`) vs the branch
(`telar/engine-idle-cpu-profile-the-100ms-worker-77c3ce`, 8 commits, unmerged):

| per call | main | branch |
|---|---|---|
| `cancellationsForWorker` | 12.52 ms | 0.05 ms |
| `resolutionsForWorker` | 13.11 ms | 0.03 ms |
| `steerForWorker` | 12.27 ms | 0.09 ms |
| **one heartbeat** | **37.91 ms → 38% of a core at 10 beats/s** | **0.18 ms → 0.2%** |
| `claimNextTurn` | 12.59 ms → +12.6% of a core | 0.71 ms |

The branch's own `bench:idle`, run on both today, confirms it scales:

| shape | main beat | main idle | branch beat | branch idle |
|---|---|---|---|---|
| 129 sessions / 45 live / 27 turns | 13.44 ms | 21.5% of a core | 0.09 ms | 0.6% |
| 154 / 60 / 40 (this machine's shape) | 25.89 ms | 37.7% of a core | 0.21 ms | 0.6% |

**Main's idle cost grows with the store; the branch's is flat at 0.6%.** Its
numbers still hold — better than its own write-up, because the real store is
larger than the synthetic one it was tuned against.

**Cause.** The worker heartbeats ten times a second and each beat asks three
questions that walk the live-turn index: `state.ts:8499`
(`cancellationsForWorker`), `:8060` (`resolutionsForWorker`), `:8088`
(`steerForWorker`). Each walk re-reads and re-parses the queue documents —
6.28 MB of them, avg 41 KB, max 1.01 MB. `execution-store.ts:44-60` re-`prepare()`s
every statement on every call. Tick installed at `worker.ts:470`, `pollMs = 100`
(`worker.ts:426`).

**Fix.** Merge the branch. It caches prepared statements, serves an unchanged
queue from memory, bounds that cache to the sessions a worker can be concerned
with, reads machine memory once instead of ten times a second, retires a stopped
turn's claim at boot so the live index actually empties, and lets the loop slow
when nothing is happening.

**Size S** (written, with tests). **Risk M** — eight commits touching the tick
and the execution store; it needs a review pass and a soak, not new design.

---

### 2. Window `requests` in the session snapshot. 292 KB/s per open cockpit, for nothing.

**Symptom.** An open conversation keeps the machine busy while you read it.

**Measurement.** The cockpit re-reads a full windowed snapshot **every second**
(`session-cockpit.tsx:1638`). On the largest session that read is **1.07 MB,
0.26–0.92 s**. Its composition:

| key | size | count |
|---|---|---|
| `items` | 753.0 KB | 327 — correctly windowed to the 10 turns |
| `requests` | **315.0 KB** | **549 — all resolved, none open** |
| `turns` | 23.8 KB | 10 |

Of those 549 requests, **44 belong to the 10-turn window; 292 KB is for turns the
client is not showing**, and zero are unresolved — so none of it renders.

**Cause.** `daemon.ts:3167` — `requests: store.requests(session.sessionId)` sits
beside `...window` (`:3165`) and ignores it. Turns and items are windowed;
requests never were.

**Fix.** Send the requests belonging to the windowed turns, plus any unresolved
one wherever it sits (an open question on a paged-out turn must still reach the
composer). ~315 KB → ~25 KB per read.

**Size S. Risk L** — one route, and the client already filters by `runId`.

---

### 3. Batch the streamed `content.delta` appends. 9.7% → 1.1% of a core while a turn streams.

**Symptom.** The machine works noticeably harder while an agent is typing, and
proportionally worse with several sessions streaming at once.

**Measurement.** Streaming peaks at **133.5 `content.delta`/s within one run**
(top runs: 133.5, 129.3, 99.7, 64.2, 56.2/s), avg 261 bytes each. Appending 400
events of that shape:

| | per event | at 133 deltas/s |
|---|---|---|
| main today (fresh prepare + `synchronous=FULL`) | 0.073 ms | **9.7% of a core** |
| prepared statements cached | 0.066 ms | 8.8% |
| + `synchronous=NORMAL` | 0.020 ms | 2.7% |
| + 16 per transaction, `FULL` | 0.008 ms | **1.1%** |
| + 16 per transaction, `NORMAL` | 0.004 ms | 0.5% |

**Cause.** `execution-store.ts:59` — `append()` is one INSERT outside any
transaction, so each event is its own implicit transaction, and
`execution-store.ts:25` sets `PRAGMA synchronous=FULL`: **one WAL fsync per
streamed token-chunk**. `state.ts:9217` additionally asks the store for
`cursor(sessionId)` before every append.

**Fix.** Coalesce appends inside one turn into a transaction flushed on a short
timer (~16 ms) or at a small count, whichever comes first, and flush
unconditionally on any turn-terminal event. Keep `synchronous=FULL`: the
batching is where the win is, and durability is the reason that pragma is set.

**Size M. Risk M** — the flush boundary is the whole design; a crash mid-batch
must lose only unflushed deltas, never a settled turn, and the journal's
`id` sequencing has to stay contiguous.

---

## WORTH A DESIGN

### 4. The cockpit's once-a-second read is a full snapshot, not a delta.

Even with requests windowed (#2), it is **~750 KB every second** per open
conversation, over loopback, serialized by the engine and parsed by the
renderer — to learn what an events tail (42 B when idle) already told it.
`tail()` at `session-cockpit.tsx:1101-1123` fetches the whole snapshot and then
`mergeRows` it, and `hydrateSession` (`session-sync.ts:76-78`) reads the snapshot
and the tail together.

The shape of a fix: tail events only, and re-read the snapshot just when
`needsSessionSnapshot(events)` says the queue changed (that predicate already
exists, `session-sync.ts:52`, and is already used on the paging path at `:105`).
The engine-side cost is real too — `liveSessions()` 134 ms, `listSessions()` 98 ms
per call. **Size L, risk M**: the snapshot re-read is what keeps a live transcript
honest across steers, retries and item revisions, and the delta path has to
reproduce that exactly. This is the biggest remaining structural win after #1.

### 5. iOS re-parses the whole message 30 times a second.

`StreamingMarkdown.swift:6` says it plainly: *"EVERY FRAME RE-PARSES THE
MESSAGE."* `revealFrameMs = 33` drives `MarkdownText(text: shown)`
(`StreamingMarkdown.swift:84`), and `MarkdownText.swift:27` runs
`splitMath(rewriteInlineImages(text))` — two full string scans plus MarkdownUI's
parse — on every one of those frames, for the growing prefix. Only rendered
equations are cached (`MarkdownText.swift:104`, `MathCache`).

Not measured: no simulator on this Mac and no device install, so this is a code
read. The cost is O(message length) × 30/s and rises as the answer grows, which
is the shape of "the phone gets warm near the end of a long reply". A fix caches
the split/parse keyed by the prefix boundary, or re-parses only the trailing
block. **Size M, risk M** — it changes what the reveal renders, and the current
30 Hz was already a deliberate halving of a display-rate loop.

The phone's sync is otherwise sound: 1 s active / 3 s idle with capped
exponential backoff (`SessionSyncEngine.swift:99-104`). But it calls the same
snapshot route, so **#2 and #4 are iOS wins too** — 1 MB/s over Wi-Fi instead of
loopback.

### 6. No `React.memo` anywhere in the cockpit.

`session-cockpit.tsx` is 2,444 lines with zero memo boundaries. Every 1 s tail
re-runs `projectJournal` (`:1651`) and re-renders all ten `SessionTurn`s. Bounded
by the 10-turn window, so it is not the emergency the raw fact suggests — but it
puts a full fold and ten subtree renders on the main thread every second, next to
a 1 MB JSON parse. Worth measuring with the React Profiler once #4 lands, because
#4 changes what re-renders and how often. Measuring it before then would profile
a path that is about to change.

---

## NOT WORTH IT — these look slow and measure fine

- **The transcript is already windowed.** `INITIAL_TURNS = 10`
  (`session-sync.ts:21`); PR #137 merged. A 200-turn session mounts **10**
  `SessionTurn` components, not 200. DOM virtualization would buy nothing.
- **The sidebar N+1 is already fixed.** `loadHost` (`app-sidebar.tsx:426`) calls
  the aggregate `liveSessions()` once per host, not once per project. Measured:
  157 KB, 0.20–0.57 s, every 3 s live / 10 s idle ≈ 5% of a core. The 14-project
  fan-out the old code did would have been 1.80 s per poll — 60% of a core — and
  it is gone.
- **The Electron preload.** 139 lines, one `require` (`apps/desktop/preload.js`).
  `server-preload.js` is 7 lines and only ties the forked server's lifetime to
  the parent.
- **The web streaming pacer** (`streaming-reveal.ts`) is arithmetic on a handful
  of numbers per frame, tuned against recorded measurements. It is not a cost.

**Electron memory, for the record:** 10 processes, **1,532 MB total RSS** — main
185 MB, engine helper 386 MB, six renderers 75–313 MB. Not obviously wrong for
six surfaces, but worth watching if renderer count grows.

**Cold start was not measured.** It needs a restart of the live app, which this
investigation was scoped not to do. `main.js` logs no startup timing
(`app.whenReady()` at `:1912`, `:1935`); adding one is a prerequisite for any
claim about it.

---

## The three I would do first, and the measurement that proves each

1. **Merge the idle-CPU branch.** Proof: CPU-time delta on the live engine over
   60 s at idle, before and after. Today it is 82.5% of a core; the bench says
   ~50 points of that are the tick. Target under 35%.
2. **Window `requests` in the session snapshot** (`daemon.ts:3167`). Proof:
   `curl -w '%{size_download}'` on `/v2/sessions/<id>?turns=10` for
   `session_f8e0ff9e…`. Today 1,066,437 B. Target under 800 KB, with the
   requests key under 30 KB.
3. **Batch the delta appends** (`execution-store.ts:59`). Proof: re-run
   `bench/append-cost.ts` — today 0.073 ms/event. Target under 0.010 ms, and
   confirm on the live engine that a streaming turn's CPU share drops by ~8
   points of a core.

Scratch benches used here (`/tmp/perfinv/`, not committed): `real-store.ts`
times the heartbeat trio and read routes against a copy of the live database;
`append-cost.ts` splits the per-event append cost by prepare-caching, pragma and
batch size. Both are small enough to re-create; `bench/idle-heartbeat.ts` on the
idle branch is the one worth keeping and should land with it.
