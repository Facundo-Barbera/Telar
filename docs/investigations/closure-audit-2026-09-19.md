# Closure audit of the open issue list — 2026-09-19

Twenty-eight open issues checked against `origin/main` at `19f6e55e`, one at a
time, by reading the code each issue is about rather than the PRs that claim to
have fixed it.

Two were closed. Twenty-six stay open. The interesting result is the ratio.

---

## 1. The finding

> **A PR that fixes issue A while crediting issue B leaves A open for ever, and
> no amount of diligence catches it — because there is nothing to look at.**

Two of twenty-eight open issues turned out to be finished. **Both had exactly
that shape**, and it is the whole explanation for why nobody had gone back to
them.

The clearest case: **#502 merged 2026-09-14T22:56Z carrying `Closes #499`**. It
fixed **#463**, filed seventeen hours earlier, and described that defect in its
own commit message down to the same number the issue quotes — *"re-pulled the
WHOLE live list — 318 KB on the owner's store"*. #463 stayed open for five days
with its fix already on `main`. Nothing linked them, so nothing could surface it.

This matters because it replaces a vague complaint with a narrow, fixable one.
"The list drifts and nobody goes back" is unactionable and implies a diligence
problem. **A broken cross-reference is a mechanical defect with a mechanical
fix**, and it is not caught by looking harder — the only thing that finds it is
someone reading the code an issue is about, which is what this audit did.

### And the premise it corrects

The audit was commissioned on the belief that the open list was partly stale
bookkeeping. **It is not.** Of twenty-eight issues verified at file and line,
**twenty-six describe work that has genuinely not been done.**

The list is a list of real open work — and the failure mode it actually has is
the opposite of the one suspected:

> Several open issues have **adjacent shipped work that resembles them**.

That resemblance is the hazard. It is what makes an auditor confident, and it is
wrong often enough that confidence is the wrong response to it. Three examples
from tonight, in increasing order of how convincing they were:

- **#520** asks for a `delegation` field carrying a human's authorization
  forward. `entities.ts:729` contains `kind: z.literal("delegation")`. It is
  #378's shelf-reason stamp and has nothing to do with it.
- **#516** asks for six query tools on the `sessions-tools` wall. Three of them
  — `sessions_find`, `sessions_outline`, `sessions_answer` — exist and work. On
  the **Agent's** wall, which is a different wall. The three it does not name
  (`sessions_step`, `sessions_steps`, `sessions_grep`) exist nowhere.
- **#547** is the sharp one, and it has its own section below.

**The next person opening this list should assume the issues are real.** Do not
assume the reverse and go hunting for closures; the hunt is where the mistakes
come from.

### There are three categories, not two

"Done" and "not done" do not cover the list. A third is real and was met twice
tonight:

> **An issue that no longer describes the system is its own kind of stale.**

Some part of it was **superseded rather than delivered** — a decision was taken
later that made the original clause obsolete. It is not unfinished work, and
treating it as unfinished sends someone to build a thing that was deliberately
abandoned. But it is not silently closeable either, because a closed issue
standing as a false description of the system misleads every later reader.

The two instances:

- **#531** specified that *a wake enqueues an Agent turn*. **#541 part A
  replaced that** with inbox rows — no wake starts an Agent turn now. Closed,
  with the supersession stated in the closing comment.
- **#544** asks for *"transcription on the engine"*. **Facundo superseded that
  on 2026-09-16**: the client streams to the vendor and the engine only mints a
  token. Still open for other reasons, but that clause must be recorded as
  abandoned rather than outstanding, or it reads as an unfinished feature to
  anyone arriving with only the original text.

**The rule: when closing, say which parts were superseded and by what.** The
supersession is the part that is invisible from the issue itself.

---

## 2. The rule this audit produced

> **A PR title or a matching commit message is not evidence. A timestamp is.**
>
> **Before closing an issue on the strength of a commit, check that the commit
> is younger than the issue.**

### The worked example: #547

`state.ts` on `main` carries `liveQueueIndex` and `queueCache`, maintained by
`writeQueue` as the single writer — which is, in outline, exactly what #547
prescribes. The commit that introduced the cache reports:

> 9.50 ms → 0.10 ms per heartbeat. Idle CPU 19.7% → 3.0% of a core.

Those are #547's own requested acceptance numbers, in #547's own vocabulary. The
closing comment was half-written.

**All of it predates the issue.**

| | |
|---|---|
| `ddd39eff` serve an unchanged session queue from memory | 2026-09-10 |
| `c80c07de` bound the queue cache to a worker's sessions | 2026-09-10 |
| `5b8c5206` the live fold reads each session's queue once | 2026-09-14 |
| **#547 filed** | **2026-09-16T22:55Z** |

#547 was filed 34 minutes after #545 closed, as the follow-up describing what was
**still hot after all of that had landed**. The only queue-adjacent commit since
is `d0b594e4`, which is #545's own fix.

The structural check confirms it independently: `liveQueueIndex` is a
`Set<string>` of session ids, **not** the per-turn index of
`(state, claim, acceptedAt, startedAt, held)` #547 asks for, and the third limb —
*a bounded window of settled turns in the document with the journal as the
ledger* — has no implementation anywhere in `state.ts`.

### Why this trap is worse than the others

Every other near-miss tonight misreported a **state** that was sitting in front
of us, and a second look corrected it. This one would have closed a **live
issue** using as its evidence **the very work that made the issue necessary**.
The stronger the resemblance, the older the code — because an issue filed as a
follow-up is, by construction, filed against a codebase that already contains
the thing it resembles.

---

## 3. The tooling hazard: `grep` here is not `/usr/bin/grep`

In this environment `grep` resolves to a **shell function wrapping `ugrep`**:

```sh
ARGV0=ugrep "$_cc_bin" -G --ignore-files --hidden -I \
  --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg \
  --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl "$@"
```

Two flags there silently suppress matches, and **an absence then reads as an
answer** — the worst possible failure for an audit, because every argument of
the form *"this was never built"* rests on a grep returning nothing.

### `-I` — skip anything it calls binary

Several engine sources trip that classification on a stray byte. It produced two
false negatives here before it was caught, both on the same file:
`apps/engine/src/provider-instances.ts`, where a search for `OWNED_ENV` and the
`configured` rule returned nothing. **Both are present, at `:92` and `:129` —
which is the entirety of #594.** Under plain `/usr/bin/grep` the same file
reports only `Binary file … matches`.

### `--ignore-files` — honour `.gitignore`, so `node_modules` is invisible

**This is the more dangerous half**, and it is not what the flag name suggests.
Reproduced deliberately: a directory named in `.gitignore`, containing a file
with the search term.

```
wrapped grep -rl NEEDLE .   ->  visible.js
/usr/bin/grep -ral NEEDLE . ->  ./visible.js
                                ./ignored/dep.js
```

"Misses some binary files" sounds like it applies to nothing anyone cares
about. **"Any conclusion about what a dependency does or does not expose is
unsound"** is a different claim entirely — *"the library has no API for this"*
is exactly what someone reads out of a directory the tool refuses to open, and
then designs around.

### A third route, which is not the wrapper's fault at all

```
(eval):1: no matches found: --include=*.js
```

**zsh globs an unquoted `--include=*.ts` before the command ever runs**, so the
command does not run. The result is empty output — indistinguishable from a
clean absence, and arriving by neither the binary skip nor `.gitignore`. It
happened in this audit, on the very first search of the first issue.

**Quote your globs.** `--include="*.ts"`.

### The rule, and the general defence

**Any conclusion resting on an absence uses `/usr/bin/grep -a`. Where the check
is load-bearing, do it in-process** — `fs.readFileSync` + `matchAll`, or a
`node -e` one-liner — **rather than shelling out at all.** The two measurements
in this note that had to be exact (`display_open` at 655 chars, `warp` at 2,988)
were taken that way.

But flag-by-flag defences only cover the three routes known today. The general
one:

> **Treat every empty result as a claim that needs a positive control.** Run the
> same pattern, through the same command, against something you *know* contains
> it. If the control also comes back empty, **the command is broken rather than
> the codebase clean.**

That catches all three routes and the fourth nobody has found yet, and it costs
one extra line. Worked example from the #531 re-check: before recording *"no
`watch` tool on the Agent's wall"*, the same grep was run for `github_status`,
`remember` and `sessions_find` against the same file — all three returned, so
the empty answer for `watch` was the codebase talking and not the tool.

### What was re-verified, and the one correction

**Every absence claim in §4 was re-run under `/usr/bin/grep -a`, with positive
controls, after the hazard was found. No verdict flipped.** That includes #632,
#633, #543, #520, #577, #622, #516, #541, #488, #665, #490, #587, #594, #547,
#660 and #634 — and the five claims written into **#531's closing comment**
(`unwatch`, `deadlineMs`, `policy_timeout`, project `core`, fan-out cap), which
were re-checked specifically because a closure rests on them. All five hold:
`Project` carries `id`, `environmentId`, `name`, `root`, `createdAt`,
`updatedAt` and no `core`; the Agent's wall has `github_status`, `remember` and
`sessions_find` but no `watch`.

**Two supporting details were wrong and are corrected here.** Neither changes a
verdict, and both were found only by re-running:

- **#665** — reported as *"the only project mutation in settings is
  `RemoveProjectSection`"*. **False**: `api.updateProject` exists and
  `projects-page.tsx` calls it at `:407` and `:634`. The verdict is unchanged
  and the issue is in fact *better* answered — see the row in §4.
- **#586** — reported as *"one `text/event-stream` in the whole engine"*. There
  are **two**: the Agent's SSE route at `daemon.ts:1968`, and an outbound
  `accept:` header at `mcp-oauth.ts:279`. Only the first is a route the engine
  *serves*, so "no session-event feed, no `/v2/sessions/stream`" stands — but
  the count was wrong, and the wrapped grep is why.

**A scope limit worth stating plainly:** `node_modules` is **not installed in
this worktree at all**, so no claim in this note covers dependency internals.
Nothing here asserts what a library does or does not do. #632 and #633 are the
two issues where that boundary matters — both are settled on Telar's own source
and on measurements already recorded in the issues, not on reading `bun`'s
implementation.

---

## 4. Per-issue evidence

`main` @ `19f6e55e`. "Open" means verified still-undone, not unexamined.

### Closed

| Issue | Evidence |
|---|---|
| **#463** iOS `InboxStore.remember()` double read | **Fixed in #502** (`c2f8f8be`, merged 2026-09-14T22:56Z — 17 h after filing). `remember(_ data: Data?)` now takes the bytes the poll earned (`InboxStore.swift:435-439`); `liveSessionsData` and `sessionData` deleted outright. Credited `Refs #499`, which is why nothing pointed back. No remainder. |
| **#531** Built-in Agent on LangGraph.js | **Shipped in #533 + #536** (both merged 2026-09-16T08:00Z — 5.5 h after filing). Verified part by part: `apps/engine/src/agent/` runtime + checkpointer + store, `agent.json` / `threads.sqlite`, all eight `/v2/agent/*` routes incl. `/stream`, argument-aware gate in `approval.ts`, idempotent runId from `toolCallId` (`sessions-tools/tools.ts:935`), `telar` driver kind removed, web `/agent` + `/hosts/[hostId]/agent`, iOS `AgentView.swift` et al., full test suite + live smokes. Remainder mapped to #541 / #543 / #563 in the closing comment. |

### Open — the five that arrived with a prior read

| Issue | Verdict | Settled by |
|---|---|---|
| **#660** ⌘1..⌘9 in the browser panel | Open | `command-keys.js:133-141` — all nine `jump-N` still carry `menu: "file"`. `browser-live.tsx:1549-1579` unchanged, comment and all. `claimChords` has one caller: `project-palette.tsx:428`. The focus-scoped claim was never built. |
| **#657** model picker | Open | Commented. The remaining ask **conflicts with a shipped decision**: `composer-controls.tsx:680-687` deliberately fixes the popover so *"the rail, the search field and the footer never move"*, and search is provider-scoped at `:602-603`. Meanwhile favourites + provider rail (which Facundo scoped *out*) did ship. |
| **#634** Spotlight / Time Machine | Open | `/usr/bin/grep -a` for `metadata_never_index\|tmutil\|addexclusion\|spotlight\|time machine\|mdutil` across `apps/ docs/ scripts/`: **zero hits**. Not even the documentation half. |
| **#646** the gigabyte | Open | Commented. #661 shipped parts 1–2, #685 reviewed. Part 3 (retention) unbuilt and is @Facundo-Barbera's; growth unbounded at ~30–50 MiB/day. Closes when the file stops growing, not when 3 of 4 plan items settle. Remainder: #542, #686, #658. |
| **#544** dictation | Open | Substantial landing (engine `dictation/` incl. `keyterms.ts` = the project-vocabulary half; web + iOS composers). But **#711 and #712 filed today** and a live session mid-flight. Also worth recording on the issue: *"transcription on the engine" did not fail to land — Facundo superseded it 2026-09-16.* Wants a fresh read once that session settles. |

### Open — the bulk

| Issue | Verdict | Settled by |
|---|---|---|
| **#594** provider env var scrub | Open | `provider-instances.ts:129` is byte-for-byte the rule quoted in the issue; `:131` still blanks all of `OWNED_ENV`. No warning surface exists. |
| **#622** Electron tests in CI | Open | `package.json:31` maps `test:desktop` → `test:desktop:unit`. `electron-test` appears in **no** workflow file. `verify.yml:132` states it deliberately. Both halves open. |
| **#629** rail polling ~97k req/day | Open | `hosts/proxy.ts:63` still has all four `LIST_READS`; not even the cheap coalescing landed. `daemon.ts:953` names it open in a live comment. |
| **#632** no fsync | Open | `atomic.ts:32-37` is `writeFileSync` + `renameSync`. Zero `fsyncSync\|fdatasync\|F_FULLFSYNC` across `apps/engine/src`, `apps/desktop`, `packages/`. |
| **#633** bun hardlinking | Open | No `backend` key in any `bunfig.toml`, no `--backend` anywhere. |
| **#658** `items.json` whole-rewrite | Open | `state.ts:12422` `writeItems` still opens `const rows = [...items.values()]` and stores the whole array. Quadratic intact. |
| **#665** storage has no shape | Open | No bulk-project tool and **no re-point verb: `root` is not patchable by any route.** `api.updateProject` (engine-client `index.ts:965`) takes `name`, `iconName`, `iconEmoji`, `defaultModel`, `envMode`, `dataScience`, `latex`, `plugins` — and not `root`. That settles the issue's own open question: a registration holds all eight of those, so deregister-and-re-add loses every one. A design pass, not a feature. |
| **#563** Agent turn cost | Open | Item 3 (prompt caching) shipped in #612 + #613. **Items 1 and 2 remain**, partly overtaken by #603/#607/#608. |
| **#587** 700k context | Open | No compaction pressure, no concurrency cap; `opus[1m]` still the default. Its own body: *"Filed to track. No work planned yet."* |
| **#577** notification row grouping | Open | No grouping of consecutive notification turns in `transcript.tsx`. `NotificationRow` exists from #572/#575 — that is item 4 (the row's *contents*); items 1–3 absent. |
| **#586** no session-event feed | Open | One `text/event-stream` in the engine (`daemon.ts:1968`, the Agent's). No `/v2/sessions/stream`. |
| **#547** queue per-fold re-parse | Open | **See §2.** The resemblance is total and every commit predates the issue. |
| **#541** Agent v2 | Open | A, B and F shipped. **C, D, E, G, H unbuilt** — no `unwatch`, no `deadlineMs`, no `policy_timeout`, no project `core`, no fan-out cap anywhere. |
| **#543** scheduled tasks | Open | No `schedules` table, no `/v2/schedules`, no `nextRunAt`. Deferred behind #541 by its own body. |
| **#521** Codex + `mac` server | Open | `entities.ts:1393`: `COMPUTER_USE_DRIVERS = ["claude", "opencode"]`. The one-line change was never made. |
| **#520** delegation not carried forward | Open | No `delegation` on `Turn`, no "delegated this through" wording. `entities.ts:729`'s `z.literal("delegation")` is #378's shelf stamp — a false positive. |
| **#516** query-based session tools | Open | The `sessions-tools` wall has **none** of the six. `sessions_find` / `_outline` / `_answer` exist only on the Agent's wall; `_step` / `_steps` / `_grep` nowhere. The `turn_summary` projection (`turn-summary.ts`) did land. |
| **#515** bound every tool answer | Open | Items 1, 2, 3, 4, 6, 7 shipped and tested — `tool-budgets.test.ts` is the exact fixture asked for (500 sessions / 5,000 events / 200 notes) and asserts both the ceiling and that the answer still parses. **Item 5 is incomplete**: it names *"notes, display, warp, browser tools"*, and the 350-char cap is enforced only on the sessions + notes walls (`tool-budgets.test.ts:333`) and browser (`BROWSER_DESCRIPTION_MAX_BYTES`). Measured on `main`: **`display_open` is 655 chars, `warp` is 2,988** — against a 350-char cap, so **~3.3 KB sitting in every session's context on every turn, whether or not either tool is called.** That is **one small PR**, not a project: cap the two descriptions and extend the existing `tool-budgets.test.ts` assertion to cover the display and warp walls. |
| **#490** data loading and storage | Open | The scouting-pass deliverable — a written audit with a ranked list of ten offenders — was never produced; no doc names #490. The three `performance-2026-09-1x.md` docs all predate it. The two commits referencing it are individual fixes, not the deliverable. |
| **#488** desktop `getAppMetrics()` | Open | `main.js:2549` feeds the #487 watchdog only. No IPC bridge in `preload.js`, no API route, no section on the Usage page. |

### Not examined, by instruction

**#49, #198, #199, #471, #528, #542, #253** — with Facundo, pinned, or waiting
on someone outside. Do not close. (#528 appeared on both the work list and the
do-not-close list; the do-not-close wins.)

---

## 5. What to carry forward

1. **A fix that credits the wrong issue leaves the right one open for ever.**
   §1. Both stale issues here had that single shape. Worth a habit on the
   authoring side, not just the auditing side: when a PR fixes something it was
   not opened against, say so in the body.
2. **Assume an open issue is open.** The base rate measured here is 2 stale out
   of 28, and neither was findable by looking harder at the list.
3. **Check the timestamp before closing on a commit.** §2.
4. **Treat every empty result as a claim needing a positive control.** §3. Three
   separate routes produce a false absence here — the binary skip, `.gitignore`,
   and a shell error that eats the command — and the control catches all three
   plus the next one.
5. **A closure names what it does not cover, and what was superseded.** The
   remainder and the supersession are both invisible from the issue text. See
   the third category in §1.
