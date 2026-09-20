# Falsifying the navigation clock before believing anything it says — #490

2026-09-20. Web half of #490's audit. This document gates the surface audit
beside it (`490-web-surface-audit-2026-09-20.md`): every number there is taken
with `apps/web/lib/perf-marks.ts` or against a fixture, and this is the record
of what was done to the instrument before either was trusted.

Nothing here touched `~/Library/Application Support/Telar/engine/`. No process
outlives the commands below.

---

## 1. Why the instrument was suspect

Numbers in the tree cite "#490's audit", and
`docs/investigations/closure-audit-2026-09-19.md:317` records that the audit
deliverable **was never produced**. Their provenance was the engine half's to
settle and it has, in PR #795 — recorded here so this document does not leave a
suspicion standing that has since been answered:

- `apps/engine/src/daemon.ts:604`, **"185 KB"** — *holds*. `bench:events` puts a
  200-row page at 206.2 KB with 2,000-char bodies, and flat at 206.2 KB across
  40, 120, 200 and 400 turns. The cap does what it claims.
- the same line's **"106 ms"** — *does not reproduce at the engine boundary*:
  1.7 ms at 40 turns, 10.7 ms at 400. It was most likely measured end to end,
  which is the web half's path and is not something a bench can reach.
- the same line's **"36.5 MB unpaged"** — unmeasurable by construction, since
  `EVENT_PAGE_MAX` means the route will not serve a journal unpaged. It
  describes the world before the cap rather than a measurement anyone can repeat.
- `apps/web/lib/engine/client.ts:226`, "three serial round trips" — engine half.
- **`apps/web/lib/perf-marks.ts:90` is correct as written** and was wrongly on
  this list in an earlier draft: it cites #490's *complaint from the issue body*,
  not the missing audit.

What follows is only about the instrument the web half would use to produce new
numbers.

## 2. The existing test suite is vacuous about duration

`apps/web/lib/perf-marks.test.ts` has six tests and eighteen assertions. Every
one of its duration assertions is of this form:

```ts
expect(typeof timing?.commit).toBe("number");
expect(typeof timing?.idle).toBe("number");
```

**A clock frozen at zero passes all six.** Measured, not inferred — see §4.

The suite tests the ring's *bookkeeping*: which addresses are measured,
idempotence per destination, that the ring hands out copies, that a phase
nothing navigated to is not invented, that `window.telarNavTimings` is fitted.
All worth testing. None of it is a test that the number moves.

This is the exact failure shape the dispatch board names: a check satisfied by
both the working and the broken state.

## 3. What was broken on purpose, and what the number did

New file: `apps/web/lib/perf-marks.falsify.test.tsx`. Four tests, twelve
assertions, in-process (Happy DOM + React `act`), no browser and no daemon.

The method: **delay `/bootstrap` — the one read the whole opening waits on — by
a known 300 ms in the fetch fixture, change nothing else, and require the
instrument's number to move by roughly that much.** Every claim is a *pair*, a
slow opening and a fast one, and the assertion is on the **difference**; a
single `toBeGreaterThan(0)` is satisfied by any constant. The pair is run in
both orders, because module singletons make a first opening genuinely colder
than a second and one-order tests report that warmth as measurement.

### 3.1 `transcript` is real

| opening | injected delay | `transcript` recorded |
|---|---|---|
| `falsify_slow_a` | 300 ms | **356.7 ms** |
| `falsify_fast_a` | 0 | 12.5 ms |
| `falsify_slow_b` (fast-first order) | 300 ms | 313.3 ms |
| `falsify_fast_b` | 0 | 7.2 ms |

The phase tracks the read it claims to measure, in both orders. **This is the
one positive result, and it is what licenses the surface audit's use of the
instrument for the `transcript` span.**

### 3.2 `commit` is structurally zero for every `from: "route"` opening

`apps/web/components/app-shell.tsx:116-119` calls `startNavigation(pathname)`
and `markNavigation("commit", pathname)` **in one effect body, in one tick**.
`commit` is therefore the distance from a stamp to itself: measured at exactly
`0` on a 300 ms opening, and no delay anywhere in the app can move it.

`app-shell.tsx:95-100` argues the cockpit's `commit` is the one recorded,
because child effects run before parent ones. That ordering is real and its
consequence is the opposite of the one claimed: the child's mark runs while the
ring's `current` is still `undefined` (cold load) or still the *previous*
address, the `current.href !== href` guard at `perf-marks.ts:140` drops it, and
the parent's zero is what lands.

A **click**-started opening is a different population and is fine — there the
stamp is taken by the capture-phase listener at press time, and `commit` came
back as 8.4 ms and 11.2 ms on real openings. The file is right that the two
populations must never be averaged; this is the arithmetic reason.

### 3.3 `idle` is wrong on every conversation switch — and wrong in the flattering direction

The finding that matters most, because it is missing from exactly the
population #490 is about.

`loading` is a **one-way latch**: `useState(Boolean(routeSessionId))` at
`session-cockpit.tsx:1515`, and the only writes are `setLoading(false)` at
`:2848` and `:2863`. Nothing sets it true again, and the cockpit does not
remount between conversations — that is #497's whole design.

So the *first* opening on a mounted cockpit is honest. On every switch after
it, the effect keyed `[loading, pathname]` re-runs because the **address**
changed while `loading` is already `false` — in the commit that switches,
before `/bootstrap` has even been asked.

Measured, both openings delayed by the same 300 ms:

```
opened .../falsify_idle_first  — commit 8.4ms · transcript 323.5ms · idle 323.5ms (from click)
opened .../falsify_idle_second — commit 6.1ms · transcript —       · idle   6.1ms (from click)
```

The second conversation took just as long — its `transcript` proves it — and
the instrument reports it as having settled in **6 ms**.

Reporting settled at 6 ms **before its own transcript arrived** is not an
inaccuracy, it is an **impossibility** — and it always errs in the flattering
direction. "Everything else the screen wanted before it settled" cannot finish
before the rows it was waiting for.

The `from: "route"` variant is worse. Mounted under `<AppShell>`, where the
shell rather than a press starts the clock, the same latch makes
`markNavigation` drop the mark on the href guard and the phase is **absent
altogether**:

```
A1 first open   commit 0 · transcript  41.3 · idle 41.3
A2 switch       commit 0 · transcript 322.0 · idle absent
A3 switch       commit 0 · transcript  13.3 · idle absent
B1 first open   commit 0 · transcript 313.3 · idle 313.3
B2 switch       commit 0 · transcript   7.2 · idle absent
```

**Consequence for #490.** "transcript → idle", one of the three spans this
instrument's header promises, does not exist for conversation switching. It
lands on exactly the population behind *"switching between them should be
instant, not 2 minutes"* — so **every prior claim about that path was
unmeasurable.** Not "should be treated with caution": unmeasurable. Any past or
future PR citing an `idle` improvement on a switch is citing noise, and the
noise is biased towards good news.

### 3.4 A third defect, found by the harness rather than looked for

`installNavigationMarks()` latches on a module-level `listening` flag that is
per **process**, not per document. It binds to whatever `document` existed at
the first call anywhere in the run — and `perf-marks.test.ts` spends that call
inside a Happy DOM it then *unregisters*. Harmless in the app, which has one
document for the life of a tab. Fatal to any test that is not the first to call
it: real anchor clicks started the clock when the new file ran alone and
silently did nothing in the full suite. Recorded because the next person to try
to test this file will lose the same hour.

### 3.5 A fourth: a mounted component's reach is process-wide, and so is the damage

Found by CI, not by this pass, and it is the third distinct instance of one
shape in a single file.

`lib/inbox-policy.ts` keeps a `Map` keyed by host **at module scope** with a
30 s TTL (`:38`, `:44`). Mounting the real cockpit calls `useInboxPolicy()`,
which fills the `"local"` entry from this file's stubbed `/api/inbox` answer.
`lib/inbox-policy.test.ts` then asserts that nine simultaneous callers make
**one** request — and is served **zero**, because the entry is already warm.

**It is not a flake — it is file order, and it is deterministic per platform.**
That distinction is the lesson, and an earlier draft of this document got it
wrong in the direction that does damage: calling it a flake invites a re-run,
and a re-run would have been red every time.

The evidence is timestamps, not reading. On the failing CI run (35500094280,
`Test web`):

```
08:38:27.1782924  ##[group]lib/perf-marks.falsify.test.tsx:
08:38:29.7215524  ##[group]lib/inbox-policy.test.ts:      ← Expected: 1, Received: 0
```

Two and a half seconds apart, this file immediately before it, trivially inside
the 30 s TTL. On macOS bun enumerates the two in the other order, so
`inbox-policy` runs first and never sees a warm entry — which is why the full
local suite passed at 3602/285 **with the bug still in it**, and why forcing the
order on the command line does not reproduce it either (bun uses its own).

A rival hypothesis with precedent in this repo was checked and rejected: #732
was `react-dom` reading `canUseDOM` at module scope, so a static import hoisted
above `GlobalRegistrator.register()` changed React's code path for the whole
process — and this file registers a DOM, so it is in that class. It is not the
cause here: the failing assertion counts calls to an **injected inbox fetcher**,
which no React feature table can reach, and the ordering evidence above is
direct.

So: **a green local suite is not evidence about this class of bug.** What is
evidence is a test that pins the mechanism. The fix is
a `releaseProcessWideState()` in `afterEach`, and the test that defends it
checks **both** halves — that immediately after an opening the cache is warm
and a fresh read asks nobody (`calls === 0`, which is the leak, demonstrated),
and that after the cleanup it is cold again (`calls === 1`). Checking only the
cleared state would pass equally against a cockpit that never touched the cache
at all, and would go on passing after somebody deleted the clear.

The three instances together, because the next person will meet a fourth:

| per-process thing | how it bit |
|---|---|
| `mock.module` registration | a second stub of `app-sidebar` silently answered `app-shell.solo.test.tsx`'s loader |
| `installNavigationMarks`' `listening` latch | bound to a document another file had since unregistered |
| a module-level cache with a TTL | warmed by a mount, read by a later file's first test |

**Anything a mounted component touches above its own tree is shared state, and
belongs in the teardown.**

## 4. The negative controls — proof that the new tests can go red

The instrument was sabotaged two ways at `perf-marks.ts:141` and both suites
run against each. Restored afterwards; `git diff` on the file is empty.

| sabotage | `perf-marks.test.ts` (existing) | `perf-marks.falsify.test.tsx` (new) |
|---|---|---|
| `current[phase] = 0` — frozen clock | **6 pass, 0 fail** | 1 pass, **3 fail** |
| `current[phase] = 500` — plausible constant | **6 pass, 0 fail** | 0 pass, **4 fail** |
| none (restored) | 6 pass | 4 pass |

Two things this settles:

1. **The existing suite is blind to both.** The claim in §2 is measured.
2. **The constant case is what the pair-wise design buys.** A frozen clock is
   caught by any floor assertion. A constant `500` passes every
   `toBeGreaterThanOrEqual(225)` in the file and is caught only by the
   *difference* assertions, which came back `Received: 0`. This is why no claim
   here rests on a single reading.

Under the frozen clock one of the four still passes: the `commit === 0` test,
correctly — `commit` genuinely is zero, so a clock that returns zero agrees
with it by accident. Stated rather than hidden; it is why that test is not the
one carrying the falsification.

## 5. Gate evidence

Full `apps/web` suite in **one process**, `--reporter=junit`, rebased onto
`main` at `825b88a1`:

```
main:  3598 tests, 284 files
after: 3603 tests, 23548 assertions, 0 failures, 285 files
<testsuites name="bun test" tests="3603" assertions="23548" failures="0" skipped="0" time="43.991273">
```

`skipped="0"` with `assertions>0`, and the total moved by **exactly the five**
that were added: **+5 tests, +1 file**. The whole suite in one process rather
than this file alone, deliberately — §3.5 is a bug that only exists when two
files share a process, and a per-file pass says nothing about it.

**Two verification mistakes made while producing this document, recorded
because the audit is where the habit gets read:**

1. The first version of this section quoted absolute totals against a base
   older than `main`. Absolute suite counts are a fact about a base; **quote
   the delta**.
2. This branch's PR was reported as "open and green" on the strength of a
   different PR's CI. A report *about* a PR is not the PR. §3.5 is the failure
   that was live at the time, and it was a flake — so even "I looked and it was
   green" would have been worth little without looking at which run.

One honest note on the way there: the first cut of the new file mounted
`<AppShell>` and **broke `app-shell.solo.test.tsx`** — four of its six cases,
in a run containing both files and only then. `mock.module` is a per-process
registration and that file's whole subject is counting how many times the shell
reaches for the rail module. It is recorded because it is the same class of
defect as everything else here: a check that is green alone and meaningless in
company. The file no longer mounts the shell.

## 6. The fixture store

**It already existed and did not need building.** `apps/engine/bench/live-list.ts`
seeds the shape #490 names — 291 sessions, 284 of them settled *by the clock*
rather than by an explicit pin, 12 turns each — into `mkdtempSync`, starts its
own daemon on a random port, measures, and `rmSync`s the directory. It never
reads the live store: the engine root is passed explicitly
(`startEngine({ engineRoot: root })`), so there is no path by which the real one
is opened.

Rebuild and re-measure:

```bash
bun run --cwd apps/engine bench:live              # 291 sessions, 284 settled, 12 turns
bun run --cwd apps/engine bench:live 291 284 12   # same, explicit
bun run --cwd apps/engine bench:open              # one conversation, 40 turns × 8 items
```

Measured on this branch, 2026-09-20 (20 samples each, machine under load):

```
seeded 291 sessions (284 settled by the clock, 12 turns each) — 28.1 MB sqlite
  sessions table  291 rows ≈ 28 KB of scalars
  documents       10.4 MB of blobs the fold used to parse

  default (unsettled)      1.1 ms median (1.0–2.6),   2.5 KB, HTTP 200
  ?all=1                  21.8 ms median (18.5–40.2), 101.6 KB, HTTP 200
  ?full=1                 21.4 ms median (18.0–30.2), 136.0 KB, HTTP 200
```

`EXPLAIN QUERY PLAN`, off that fixture's real database:

```
fold (after)    SEARCH sessions USING INDEX sessions_shelf (archived=?)
project rows    SEARCH sessions USING INDEX sessions_project (project_id=?)
fold (before)   SCAN documents
```

Both hot rail reads are index-served. The `SCAN documents` line is what the
fold used to do and no longer does.

`bench:open`, same day: **175 KB per open** for a 40-turn session on a 10-turn
window; 3.31 ms/open for `/bootstrap` against 2.98 ms for the old serial pair,
at the engine boundary. Worth stating plainly: **at the engine boundary the
one-read open is not faster** — the two reads are cheap locally and the saving
is the round trip, which only appears once the Next route handler is in the
path. A PR claiming #451's win should measure end-to-end or not claim it.

## 7. What this licenses, and what it does not

- **`transcript` may be cited.** It tracks injected latency in both orders and
  fails under both sabotages.
- **`commit` may be cited for click-started openings only**, and never averaged
  with route-started ones, which are structurally 0.
- **`idle` may not be cited for any conversation switch.** It is either absent
  or earlier than the transcript it claims to follow. Until `loading` stops
  being a one-way latch, "the opening settled in N ms" is only meaningful for
  the first conversation a cockpit opens and for Settings.

The two pinned defects are written as tests that will **fail when they are
fixed**, each carrying the assertion to replace it with. A characterisation
test that does not say it is one is how a bug becomes a requirement.

## 8. The better template, which already exists and nothing points at

For anything engine-side, **do not build a second perf-marks — use
`EngineState.readAccounting`** (`apps/engine/src/state.ts:2145`). It is a public
`{ documentBytes, documentReads }` counter incremented in `readIndexedRows` and
`accountWholeRead`, and it is already load-bearing in real assertions:
`test/snapshot-window.test.ts:132` requires a stripped-index read to exceed
twice the indexed span, `:167` requires a warm read to be under half a whole
read, and `test/request-index.test.ts:61` counts reads per document suffix.

Those are **counts the failure state cannot produce** — the property this whole
document is about, and the one `perf-marks.test.ts` did not have. A byte counter
cannot be satisfied by a frozen clock or a plausible constant, because the
assertion is a ratio between two measured reads rather than a threshold on one.

It also leaves one question open that nobody is asking, and it is a question
with a number attached: **`accountWholeRead` counts the whole-document fallback,
and nothing outside the tests ever reads that counter.** Whether real sessions
carry the byte-offset index or are silently taking the slow path is answerable
by comparing `documentBytes` on a fixture with and without it. That is in the
surface audit's ranked list.
