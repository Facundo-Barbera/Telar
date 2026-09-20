# The web surfaces, per surface — #490's scouting pass

2026-09-20. Web half only: the engine/store read-path timing and the iOS
surfaces belong to a second worker and are not covered here. Where something in
their half turned up it is named and handed over rather than chased.

**Read `490-instrument-falsification-2026-09-20.md` first.** It gates this
document. Short version of what it licenses: the `transcript` span may be
cited; `commit` may be cited for click-started openings only; **`idle` may not
be cited for any conversation switch**, because it is either absent or stamped
earlier than the transcript it claims to follow.

No live store was read. Every measured figure is against
`apps/engine/bench/live-list.ts` / `bench/session-open.ts` — fixture daemons in
`mkdtempSync`, removed on exit — or against the in-process render harness. No
long-running process, no restart.

---

## 0. Four premises corrected before the audit could start

This matters more than any single number below, because three of them would
have sent work to rebuild something that shipped. The pattern repeats often
enough in one day to be worth naming on its own: **an open issue's description
of the code is evidence about when the issue was written, not about the code.**

### 0.1 Backward paging on the transcript is DONE, not missing

The claim that `before` is never sent by any web client, that there is no
`loadMore` and no IntersectionObserver on the transcript, is **false on
`origin/main`**:

- `lib/engine/session-sync.ts:189-191` — `loadOlderTurns` sends
  `{ turns: OLDER_PAGE_TURNS, before }`, `OLDER_PAGE_TURNS = 20` (`:31`)
- `components/session-cockpit.tsx:1860-1875` — the `loadOlder` callback
- `components/session-cockpit.tsx:3823` — `<ConversationTopEdge …
  onReach={loadOlder}>`, with an explicit "Load earlier turns" button at
  `:3829-3832`
- `components/ui/conversation.tsx:251-263` — **an IntersectionObserver**, rooted
  on the scroll element with a 400 px `rootMargin`, torn down while a fetch is
  in flight so one arrival at the edge is one request; `:265-292` re-anchors
  `scrollTop` in a layout effect so the prepend does not jump the viewport
- `lib/agent/thread.ts:315` and `components/agent/agent-screen.tsx:190-193` —
  the agent screen's own copy

Landed in `53481b2a perf(web): history arrives by scrolling, and old turns stop
costing a layout` (2026-09-14), confirmed on main with
`git merge-base --is-ancestor`. **#490's point 3 is delivered on the web side.**
It is not priced below; it belongs in a regression check, not a work list.

How the false claim was produced is the reusable part: a grep of
`transcript.tsx` and `session-cockpit.tsx` for `before=` / `loadMore` /
`IntersectionObserver` returned nothing, and an empty result was read as an
answer about the codebase rather than an answer about the search. Neither file
holding the feature was in it.

### 0.2 Rail-row mutations are already optimistic

`lib/session-mutations.ts:281` `mutateRow` is a three-state optimistic path —
the guess, the record the engine actually stored, or a revert with a sentence —
landed for **#495**. The no-list-read property is structural rather than
careful: the function is handed a per-row callback and has no way to reach the
rail's loader. Callers: `session/session-row.tsx:413`,
`session/session-inbox-menu.tsx:153`. Its own header names #490's complaint as
what it replaced.

So "pinning it, settling it take a while for the app to react" is **fixed for
the rail row**. What is left is §4.5 and §4.2.

### 0.3 The rail no longer loads almost every conversation

Measured against the 291-session fixture, which is the shape the complaint was
made about:

| read | median | bytes |
|---|---|---|
| `/v2/sessions/live` default (unsettled only) | **1.1 ms** | **2.5 KB** |
| `?all=1` | 21.8 ms | 101.6 KB |
| `?full=1` | 21.4 ms | 136.0 KB |

Against the 276 KB / 2.33 s recorded before #457/#464, the default path is
**110× smaller and ~2,000× faster**. Both hot reads are index-served
(`SEARCH sessions USING INDEX sessions_shelf`, `… USING INDEX sessions_project`);
the `SCAN documents` the fold used to do is gone.

"The sidebar loading almost every conversation is unacceptable" is answered on
the default path. The wide read survives in two places, and both are in the
ranked list: the Settled shelf (§4.3) and — the one nobody was looking at — the
front door (§4.1).

### 0.4 Point 6's "the store must serve a slice" is largely built too — #419

Delivered with a caveat, not open. `apps/engine/src/document-window.ts` holds
byte-offset indexes written beside `queue.json` and `items.json`: SQLite slices
with `substr` over the value cast to a blob, the file store seeks and reads at
an offset, and neither hands the untouched history to JavaScript.
`snapshotWindow` (`state.ts:8034`) reads only the span a window needs via
`readIndexedRows` (`:2216`), falling back to a whole-document parse only when
the index is absent or stale — and `length` is the staleness check, so an older
or externally-edited document degrades to *slow* rather than to *wrong*.

Its own measured before-figures: the same 10-turn window cost **3.7 ms on a
20-turn session and 38–44 ms on a 120-turn one** — "the price of a read was the
length of the conversation, not the size of the answer". That is exactly the
shape #490 describes, already fixed for the two documents that matter.

**The caveat is the interesting part and it is in the ranked list (§4.11):**
`accountWholeRead` counts the whole-document fallback, and nothing outside the
tests ever reads that counter. Whether real sessions carry the index or are
silently taking the slow path is unknown — and answerable with a number.

---

## 1. Per surface

### 1.1 The rail / sidebar

**Requests.** One per Mac per pass: `liveSessionsMatching` (ETag-conditional)
or `liveSessionsSince(cursor)` — `app-sidebar.tsx:670-698`. Plus the project
registry, folded into the same read since #459 ("one read per host per pass —
and it used to be three", `:605`).

**How big, how often.** 2.5 KB unsettled / 101.6 KB with the shelf open, at
**3 s when anything is live, 10 s otherwise** (`:980`). A tick that finds
nothing new is a 304 with no body.

**What it renders from them.** Title, project name/icon/glyph, branch, activity
badge, settling band, assignment. The read also carries `daemonId`, the inbox
policy and per-project `repo` keys for `projectGroupKey` — all used.

**Store query.** `SELECT … FROM sessions WHERE archived = 0`, served by
`sessions_shelf(archived, settled_override, updated_at)`. 291 rows on the
fixture, ~28 KB of scalars. Index-served; nothing to fix here.

**Timers.** One: `:980`, 3 s/10 s. **What could replace it:** the engine has
exactly one `text/event-stream` (`daemon.ts:1968`, the Agent's) and no
`/v2/sessions/stream` — that is **#586, open**. Until it exists this timer
cannot be replaced, only tuned; #82's six-connections-per-origin argument is
the reason it is a poll and is still sound.

**Verdict:** the cheapest surface in the app. Not in the ranked list.

### 1.2 Opening a conversation

**Requests.** One: `/v2/sessions/:id/bootstrap?turns=10`, through
`sessionConnection(...).read()` (`session-cockpit.tsx:1816`). A conversation
this tab already read comes back from the LRU in the commit that switches
(#497), so a switch back is zero requests.

**How big.** **175 KB per open** measured on `bench:open` (40 turns, 8 items
each, 10-turn window). That is ~17 KB per rendered turn and is dominated by
item text, which is drawn — this is not a surface fetching fields it never
shows.

**What the opening actually costs.** With `/bootstrap` answering instantly the
`transcript` span is **7–13 ms**; with 300 ms injected it is **313–357 ms**.
The opening is the read, essentially entirely: the fold and the paint are a
rounding error beside it. So the lever is payload and round trips, not
rendering.

**Store query.** `bench:open`: 3.31 ms/open for `/bootstrap` against 2.98 ms
for the old serial pair, at the engine boundary. **At that boundary the
one-read open is not faster** — the two reads are cheap locally and #451's
saving is the round trip, which only appears with the Next route handler in the
path. Any PR citing that win must measure end-to-end.

**Timers.** `session-cockpit.tsx:2864`, **1 s**, unconditional for the life of
a mounted conversation — §4.4.

### 1.3 Transcript scroll

**Delivered, see §0.1.** 20 settled turns per page, fetched on an
IntersectionObserver 400 px above the top edge, with the scroll anchored in a
layout effect so the prepend does not move the viewport. The explicit button is
kept as the keyboard's way in.

One real defect, worth no latency: `session-cockpit.tsx:1858` still says older
pages load *"on an explicit click — never on scroll"*, three files away from the
observer that does exactly that. Corrected in this PR. It is a comment bug; do
not rank it.

**Timers.** `transcript.tsx:1509`, 1 s — but it is a *clock*, not a poll: it
mounts only on a live turn and unmounts when the turn settles, so its lifetime
is exactly the window in which a second-by-second display means anything, and
nothing above it re-renders. Justified as-is; no push would replace it.

### 1.4 Composer send

**Mutation path.** Draft cleared and attachments dropped synchronously
(`:3193`), so the box empties on the press. Then, for a first message:
`api.createSession` → *optionally* `api.updateSession` → `api.submitTurn`
(`:3331`). For a message into an existing session, `submitTurn` alone.

**Where the wait is.** Not the re-render and not a re-fetch of the world: the
id is minted client-side and the address moves via `history.replaceState`
before the engine answers (`:3218-3243`). The wait is the **round trips**, and
on `envMode: "worktree"` the first of them contains a real git worktree cut.
The second is avoidable — §4.2.

### 1.5 Right-panel tabs

**Requests.** Per open surface, not per tab strip. The browser screenshot
surface reads `api.browserState(sessionId, { screenshot: true })` every
**3 s** (`right-panel.tsx:973`, `BROWSER_POLL_MS`) while a page is *active*,
and `browser-live.tsx:1209`/`:1346` add two more at **2 s** each.
`browser-start-page.tsx:31` is 15 s.

**What it renders.** A screenshot and the address row. The poll is correctly
gated on `live` (an active page *and* a session).

**Timers.** Four on this surface. **What could replace them:** the engine
already owns the browser; a `browser.changed` event on `/events` would collapse
all four, and the cockpit is already draining `/events` once a second — §4.7.

### 1.6 Settings pages

**Requests.** Two, issued together and independently so one failing does not
take the other (`settings-page.tsx:322-335`): `api.about()` and `api.health()`.
Both small.

**What it renders.** App version, state root, engine health. Sections below
load their own data when opened.

**Timers on the page itself:** none. `settings/mcp-section.tsx:442` polls at
2 s and `settings/latex-machine-settings.tsx:110` at 1.5 s
(`INSTALL_POLL_MS`), both only while an install/auth is in flight — bounded and
justified.

**This is the cleanest measurement of "even an empty page takes a long time"**,
which is why #492 extended `isMeasuredHref` to cover it: nothing on Settings is
a fold over a live conversation, so whatever it spends is spent on arriving.
Its `idle` is trustworthy (it is stamped off `load()` resolving, not off the
latch that ruins the cockpit's — see the falsification doc §3.3). **Not
measured end-to-end here**: doing so honestly needs the app running, which is
outside this pass's rules. Named as the first thing to measure once someone can
run it.

### 1.7 The front door

**Requests.** `api.projects()` **and `api.liveSessions({ all: true })`**, in a
`Promise.all` (`front-door.tsx:75-85`). Retried every 2 s while undecided
(`RETRY_MS`).

**What it renders from them.** Nothing. It renders a blank `aria-busy` frame
and redirects. Both answers exist only to choose which project to open
(`composerProject`) and to write the remembered-destination note.

This is §4.1 and it is the worst thing in this audit.

---

## 2. The timer census — 22, not 17

Every `setInterval` in `apps/web` outside `test-fixtures/`, with constants
resolved. The list handed to this pass had 17 and missed two.

| site | period | gated on | replaceable by |
|---|---|---|---|
| `app-sidebar.tsx:980` | 3 s live / 10 s idle | — | `/v2/sessions/stream` (**#586, open**) |
| `session-cockpit.tsx:2864` | **1 s** | — | the same feed; this is the big one |
| `session-cockpit.tsx:2953` | 30 s | — | a settling-window revision |
| `transcript.tsx:1509` | 1 s | live turn only | nothing — it is a clock |
| `session/session-row.tsx:80` | 5 s | **working row only** | nothing — it is a clock |
| `right-panel.tsx:973` | 3 s | active page | a `browser.changed` event |
| `browser-live.tsx:1209` | 2 s | — | same |
| `browser-live.tsx:1346` | 2 s | — | same |
| `browser-start-page.tsx:31` | 15 s | — | same |
| `session/related-conversations.tsx:352` | 10 s | panel visible | `/events?after=` |
| `session/report-cadence.tsx:226` | 10 s | panel visible | same |
| `session/diff-surface.tsx:1174` | 15 s | — | a git-watch event |
| `workspace-environment.tsx:684` | 15 s | — | same |
| `run/run-header-control.tsx:158` | 4 s active / 12 s idle | — | `/events?after=` |
| `host-look-follower.tsx:74` | 10 s | — | a revision cursor |
| `lib/agent/status.ts:98` | 3 s | — | the Agent's SSE feed, which **already exists** |
| `lib/agent/inbox.ts:111` | 15 s | — | same |
| `settings/mcp-section.tsx:442` | 2 s | install in flight | terminal state |
| `settings/latex-machine-settings.tsx:110` | 1.5 s | install in flight | terminal state |
| **`app/front-door.tsx:106`** | 2 s | undecided only | — |
| `components/update-control` / misc | — | — | — |

Two observations the list makes on its own:

- **`lib/agent/status.ts` polls at 3 s while the Agent already has a
  `text/event-stream`** (`daemon.ts:1968`). This is the one timer in the app
  that could be deleted today without new engine work. Handed to the engine
  half to confirm the feed carries what the status surface reads.
- `agent/status.ts` is 3 s and `agent/inbox.ts` is 15 s. They are frequently
  quoted together; they are not the same number.

**Denominator.** ~97,000 requests/day per idle cockpit is the rail's cost
(measured on #629, recorded on #586). The cockpit's 1 s tail adds **86,400/day
per open conversation** — so an idle cockpit sitting on one conversation is
~183,000/day, and **the single 1 s interval is very nearly half of all cockpit
traffic**.

---

## 3. Mutation paths — where the wait actually is

| verb | optimistic? | the wait |
|---|---|---|
| **create** | address only (`:3218`) | `createSession` round trip — *containing a git worktree cut* on `envMode: "worktree"` — then a **second serial** `updateSession` when a model or runtime mode was chosen, then `submitTurn`. **Round trips.** §4.2 |
| **pin** | yes (`mutateRow`) | one round trip, reconciled in place. No list read. |
| **settle** | yes | same |
| **rename** | yes | same |
| **delete** | yes (`{ removed }`) | same |
| **snooze** | **in the rail, yes; in the open conversation, not at all** | §4.5 |

For pin/settle/rename/delete the wait is now a single round trip and nothing
re-fetches the world. That half of #490's complaint is closed.

---

## 4. The ten worst offenders, ranked by what a person feels

Ranked by felt latency, not by size. Savings are estimates and say which are
measured and which are arithmetic.

**Prerequisite, not ranked:** `idle` is unusable on conversation switches
(falsification doc §3.3). It has no user-visible latency of its own, and until
it is fixed nobody can measure whether items 4, 6 or 7 below improved anything.
Fix it first even though it wins nothing.

### 4.1 The front door fetches all 291 sessions on every launch — and usually throws the answer away

`front-door.tsx:75-85` awaits `api.liveSessions({ all: true })` beside
`api.projects()`. Measured: **101.6 KB, 21.8 ms** at the engine boundary,
roughly double over the Next hop. It is the wide read the rail was taken off in
#457.

It is used only to *rank* which project to open. Worse, on the warm path a
remembered destination has already redirected (`go(remembered)` sets
`left.current` before the awaits), so `decide()` still issues the 101 KB read
and the answer only refreshes a note — while competing for the two-slot read
gate (`client.ts:READ_BUDGET`) against the reads of the route it just
redirected to. `client.ts:226` describes exactly that contention as the cause
of an opening queueing behind housekeeping.

This is the owner's first sentence — *"it takes a long time to load things,
even an empty page"* — and no one had looked at the launch path.

**Fix:** rank from the default unsettled read plus a per-project `updatedAt`
aggregate; and skip `decide()` entirely when a note already redirected.
**Saving:** ~100 KB and ~40 ms off every launch, one fewer competitor for the
read gate during the first route's own reads. *Measured payload, arithmetic
end-to-end.*

### 4.2 Create makes a second serial round trip before the turn is submitted

`session-cockpit.tsx:3272-3277`: when a model or a runtime mode was chosen on
the canvas, `api.updateSession(target, creationPatch)` is awaited *after*
`createSession` and *before* `submitTurn`. The comment argues for folding two
patches into one, which it does — but the patch itself did not need to be a
separate request.

**Fix:** carry `runtimeMode` and `model` in the `createSession` body.
**Saving:** one full round trip on every create where the composer's model or
runtime was touched — which, since the composer remembers them, is most creates
after the first. *Arithmetic; the engine half can price the round trip.*

The worktree cut inside `createSession` is the larger cost and is **not** free
to remove — it is real work, and doing it after the turn is submitted is a
design decision, not a cleanup. Named, not proposed.

### 4.3 The Settled shelf turns the rail's 2.5 KB tick into 101.6 KB

Opening the shelf sets `wantsSettled`, and from then on every 3–10 s pass is
the wide read (`app-sidebar.tsx:684-690`), **40× the bytes and 20× the time**.
The shelf is also refused a cursor on purpose (`:665`), so it cannot be served
by the cheap conditional path.

**Fix:** page the shelf — it is a list nobody reads past the first screen of.
**Saving:** 99 KB per tick while the shelf is open. *Measured.*

### 4.4 The cockpit tails once a second, forever, whether or not anything is running

`session-cockpit.tsx:2864`. Ungated: a settled conversation left open on screen
polls `/events?after=N` 86,400 times a day. Each tick is cheap and correct —
`tailSession` drains a bounded page and only fetches a companion snapshot when
the events say so (`session-sync.ts:177-182`), and `mergeRows` hands back the
same array when nothing moved so React bails out of the re-fold. The cost is
not bytes; it is **occupancy of the two-slot read gate**, which is what
`OPEN_BUDGET` was carved out of the budget to escape.

**Fix:** gate the interval on the session being unsettled — the same
`anyLive`-style test the rail already makes — or replace it with #586's feed.
**Saving:** removes ~47% of an idle cockpit's request volume and the main
competitor for the read gate during an opening. *Arithmetic from the measured
denominator.*

### 4.5 Snoozing the conversation you are reading does nothing until you leave

The owner's own 2026-09-20 comment, and the issue is right that the two
symptoms are one defect: `snoozedUntil` is a stored timestamp and "is this
snoozed?" is *computed* against `now`
(`packages/engine-client/src/protocol/settling.ts:192`). Nothing fires when it
expires, so there is no moment at which a conversation wakes and nothing to
notify the open cockpit with.

Note for whoever takes it: the rail row **does** move immediately
(`withSnooze` through `mutateRow`), so this is specifically the cockpit's
missing optimistic path plus the missing expiry edge — not a general
"mutations are slow" problem. And a per-row client timer would be a timer added
while this issue removes timers, and two devices would disagree about when a
conversation woke.

**Fix:** an engine-side expiry edge on `/events`, plus an optimistic hand in
the cockpit. **Saving:** not latency — correctness the owner asked for twice.

### 4.6 175 KB parsed and folded on the main thread per conversation open

Measured on `bench:open` for a 40-turn session on a 10-turn window. The window
is doing its job (the unwindowed read is far larger), and the payload is
dominated by item text that is actually drawn — so this is a **floor, not
waste**. Ranked because at ~17 KB per turn it is the largest single main-thread
cost of an opening and it scales with `INITIAL_TURNS = 10`.

**Fix:** none that is free. Worth one experiment: whether 10 is the right
initial window now that backward paging works (§0.1) — 5 would halve it and the
observer would fill the rest before a reader reached the top.
**Saving:** up to ~87 KB and roughly half the fold, at the cost of one extra
page fetch for readers who scroll. *Measured payload, unmeasured felt effect —
and it cannot be measured until the prerequisite is fixed.*

### 4.7 Four browser timers on one panel, 2–3 s each, where one event would do

`right-panel.tsx:973` (3 s, with a screenshot), `browser-live.tsx:1209` and
`:1346` (2 s each), `browser-start-page.tsx:31` (15 s). The screenshot poll is
the expensive one and is correctly gated on an active page; the others are not
gated at all.

**Fix:** a `browser.changed` event on the feed the cockpit already drains once
a second. **Saving:** three timers and a repeated screenshot payload whenever
the panel is open. *Unmeasured — no fixture for the browser surface.*

### 4.8 `lib/agent/status.ts` polls at 3 s past a stream that already exists

The only timer in the app whose replacement needs no new engine work:
`daemon.ts:1968` already serves `agent/stream`, and `hosts/proxy.ts` already
exempts it from the upstream timeout for exactly this reason.

**Fix:** subscribe. **Saving:** 28,800 requests/day per cockpit with the Agent
screen open. *Arithmetic. Confirm with the engine half that the feed carries
what the status surface reads.*

### 4.9 Two independent 10 s polls inside one panel

`session/related-conversations.tsx:352` and `session/report-cadence.tsx:226`.
Both correctly gated on the panel being visible, both reading session-adjacent
state the cockpit's own 1 s tail is already fetching events for.

**Fix:** fold both onto the cockpit's existing event drain.
**Saving:** two timers, ~17,000 requests/day with the panel open. *Arithmetic.*

### 4.10 The diff panel re-runs a full `git diff` every 15 s while it is open

`session/diff-surface.tsx:1174` (`REFRESH_MS = 15_000`) reloads the patch on a
timer for as long as the surface is mounted, whether or not anything wrote. The
read is the expensive kind by the app's own reckoning: `lib/hosts/proxy.ts:63`
deliberately leaves diff routes on the **60 s** upstream timeout rather than the
rail's 10 s, because "the same hop also carries an attachment upload, a project
icon and a diff of a large tree, and those are slow for honest reasons".

`components/workspace-environment.tsx:684` adds a second ungated 15 s git read,
and that one is mounted on **every** cockpit rather than only when a panel is
open.

`active` is already in `diff-surface`'s dependency array, so a turn settling
re-reads — which is the comment's own statement of when the diff has actually
changed. That is the whole argument against the interval: if the moment the
agent stopped writing is the moment to re-read, the timer is re-reading at
fourteen other moments as well.

**Fix:** drop the interval and keep the settle-triggered read; a git-watch event
would cover the hand-edit case. **Saving:** one repeated tree diff per 15 s per
open diff panel, plus one git read per 15 s per open conversation.
*Unmeasured — the cost depends on the tree, which is why it should not be on a
fixed timer.*

### 4.11 Nobody knows whether real sessions have the byte-offset index

#419 made the windowed read cost the size of the answer rather than the length
of the conversation (§0.4) — **when the index is there.** When it is absent or
stale the read silently degrades to a whole-document parse, which is the 38–44
ms path on a 120-turn session that #419 was written to remove.

`EngineState.accountWholeRead` (`state.ts:2145`) already counts exactly this,
and **nothing outside the test suite has ever read the counter.** So the single
most consequential storage question in #490 — did the fix reach the documents
people actually have — has never been asked, and it is cheap to ask: build a
fixture with and without the index and compare `documentBytes`.

**Fix:** none until it is measured; the answer decides whether there is one.
**Saving:** unknown by construction, which is the point. If the fallback is
common this outranks everything above it except §4.1; if it is rare, #419 is
simply done and the question is closed for good.

*Engine half's to run — the counter is theirs. Listed here because it belongs
in the ranked order and would otherwise fall between the two halves.*

---

## 4bis. Investigated and dismissed

Recorded so the next pass does not re-open them.

- **`session/session-row.tsx:80`, 5 s.** Looks like a per-row timer on the
  surface #490 says is unusable past ten sessions. It is not: `TickingDuration`
  is mounted only on a **working** row (7 of 291 on the owner's machine), and
  it is its own component precisely so that one interval runs per working row
  "rather than one re-render per second for the whole sidebar". It is a clock,
  not a poll, and it is already the fix somebody would propose for it.
- **`transcript.tsx:1509`, 1 s.** Same shape: mounts on a live turn, unmounts
  when it settles, nothing above it re-renders.
- **`settings/mcp-section.tsx:442` (2 s) and
  `settings/latex-machine-settings.tsx:110` (1.5 s).** Both bounded by an
  install or auth being in flight.
- **Backward paging on the transcript.** §0.1 — already shipped.
- **Rail-row mutation latency.** §0.2 — already optimistic.

---

## 5. What is in the store half's court

Named and not chased, per the scope boundary:

- **Provenance of `daemon.ts:604` — settled in PR #795 while this was being
  written.** "185 KB" holds (a 200-row page is 206.2 KB and stays flat across
  40/120/200/400 turns). **"106 ms" does not reproduce at the engine boundary**
  — 1.7 ms at 40 turns, 10.7 ms at 400 — which makes it most likely an
  end-to-end figure, i.e. **this half's path**, and nothing here reproduces it
  either. "36.5 MB unpaged" is unmeasurable by construction, since
  `EVENT_PAGE_MAX` means the route will not serve a journal unpaged.
- **Which JSON columns are read on hot paths** (#490 point 6, narrow reading).
  Largely answered by #419 — see §0.4. The fixture says `documents` holds
  10.4 MB of blobs against 28 KB of scalars in `sessions`, and the live fold no
  longer touches them (`SEARCH sessions USING INDEX sessions_shelf`, where it
  used to be `SCAN documents`). What remains is §4.11: whether the byte-offset
  index is actually present on real sessions.
- **`/v2/sessions/stream` (#586)** blocks the four largest timers above.

Storage *size* is dispatched across #586/#632/#646/#658/#665/#686/#697 and is
deliberately untouched here.

---

## 6. Order of work

One issue per step, each with a before/after number in its PR body.

1. **Fix `idle` on switches** — the prerequisite. Reset `loading` on a switch,
   or stamp idle off the read settling rather than off a one-way latch. The two
   pinned tests in `perf-marks.falsify.test.tsx` will fail and carry their own
   replacements.
2. **The front door's `?all=1`** (§4.1). Largest felt win, smallest diff.
3. **Create's second round trip** (§4.2).
4. **Gate the cockpit's 1 s tail** (§4.4).
5. **Page the Settled shelf** (§4.3).
6. **Snooze's expiry edge** (§4.5) — needs the engine half.
7. **`agent/status.ts` onto the existing stream** (§4.8).
8. **`/v2/sessions/stream`** (#586), which then collapses §4.7 and §4.9.
9. **Take the diff panel off its timer** (§4.10).
10. **Count the whole-document fallback** (§4.11) — engine half, and worth
    doing early despite its position, because a bad answer reorders this list.
11. **Re-measure `INITIAL_TURNS`** (§4.6) — last, because it needs step 1 to be
    measurable at all.
