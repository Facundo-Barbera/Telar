# Opening a conversation — measured, 2026-09-13

Issue #407: "switching between conversations and opening New conversation take
noticeably long." Follows `performance-2026-09-12.md`, which fixed the engine's
write path; this one is about the READ path and the navigation around it.

---

## READ THIS BEFORE ANY NUMBER BELOW

**No number here was taken from a running app.** This branch's session was
instructed not to start a dev server, a dev Electron shell, or a headless
browser, so every figure is a **unit-level bench** against code or against a
store this repository builds for the purpose:

- `bun run --cwd apps/web bench:journal` — the transcript fold, in isolation.
- `bun run --cwd apps/engine bench:open` — a session opened over the daemon's
  real loopback HTTP, against a store seeded through the public write path.
- `bun run --cwd apps/web build` — what Next decides each route is.

**The four navigation timings the issue asks for are therefore NOT in this
document.** Click → route commit → first transcript paint → cockpit idle need an
app to navigate. `apps/web/lib/perf-marks.ts` is the instrument that produces
them (`performance.mark` in any build, `window.telarNavTimings()` to read the
ring out of a packaged one, console lines in development); the coordinator takes
them on the nightly. Everything below is either **measured** as labelled, or
called out as **reasoned from the code**.

**The machine was loaded**: load average 31–40 on 8 cores throughout, other
agents working. Every bench therefore runs **two alternating passes** and prints
both, as `append-cost.ts` does. A single sweep on this machine put the same row
at 0.13 ms and 2.7 ms. Ratios that survive both passes are the change; absolute
milliseconds are worth roughly a third of what a quiet machine would show.

---

## Where the time was, read off the code

Four costs, and they are different in kind. Only the first three are fixed here.

1. **Every navigation was a server round trip before any client code ran.**
   `/` was a `force-dynamic` server component that awaited `listProjects()` and
   then `liveSessions()` before answering with a redirect; the canvas awaited
   `listProjects()` for the project's NAME; the remote canvas forwarded that read
   **through the other Mac's proxy**. None of these could paint. No route under
   `sessions/` had a `loading.tsx`, so the router held the old screen until the
   new one's server render returned — which is precisely "the click did nothing".

2. **Opening a session was two SERIAL reads.** `hydrateSession` asked for the
   snapshot, then asked for the journal *from the cursor the snapshot stamped*.
   The second could not be issued until the first returned, and each crossed a
   Next route handler as well as the engine.

3. **A quiet second cost a full re-render, a full re-fold and an IndexedDB
   write.** The cockpit tails at 1 Hz. On a tick with nothing new, the tail
   returned the *same row objects* — but `mergeRows` and the connection's event
   merge both built fresh arrays, so `useState` saw new values, the whole
   transcript was re-projected, and `remember()` re-folded it again and wrote the
   photograph back to IndexedDB. Once a second, per open conversation, forever.

4. **The snapshot read itself scales with the whole session, not the window.**
   Measured below. Not fixed here — it lives in `state.ts`, which this branch was
   scoped out of.

---

## What a tick costs the transcript fold

`bun run --cwd apps/web bench:journal [turns] [itemsPerTurn] [reps]`, 300 ticks,
two alternating passes. 330 items is the shape 2026-09-12 measured on the
dogfood store (327 items in a 10-turn window).

**330 items (10 turns × 33)**

| tick | whole fold | memoised | |
|---|---|---|---|
| quiet — nothing arrived | 0.130 / 0.066 ms | **0.004 / 0.002 ms** | 30× |
| streaming — one delta on the live turn | 0.083 / 0.082 ms | **0.023 / 0.034 ms** | 3× |
| fresh snapshot — every row a new object | 0.067 / 0.066 ms | 0.088 / 0.087 ms | **1.3× worse** |

**600 items (10 turns × 60)**

| tick | whole fold | memoised | |
|---|---|---|---|
| quiet | 0.178 / 0.135 ms | **0.005 / 0.006 ms** | 27× |
| streaming | 0.157 / 0.152 ms | **0.042 / 0.033 ms** | 4× |
| fresh snapshot | 0.139 / 0.152 ms | 0.154 / 0.167 ms | **1.1× worse** |

**The last row is a real cost, reported rather than buried.** A companion
snapshot replaces every row with a fresh object, so every cache entry misses and
the bookkeeping is pure overhead. It is bounded: when nothing at all can be
reused the projector folds the whole journal in ONE call rather than one call per
turn (before that fallback existed the same row was **2× worse**, not 1.1×).
Companion snapshots ride queue-changing events — a turn accepted, started,
completed, a request opened — which are rare beside deltas and ticks.

**And the quiet row is now mostly moot, which is the better fix.** With
`mergeRows` and the connection returning the arrays they were given when nothing
moved, a quiet tick no longer changes any state — so React bails out, the fold is
not called at all, and the recording is not rewritten. The 0.004 ms above is what
it costs when something does call it.

---

## What it costs to open a session, over the wire

`bun run --cwd apps/engine bench:open [turns] [itemsPerTurn] [reps]` — a real
daemon, real loopback HTTP, store seeded through claim/run/ingest/complete. Two
alternating passes.

| shape | snapshot + events (serial) | bootstrap (one read) |
|---|---|---|
| 40 turns × 8 items, 175 KB | 3.79 / 4.39 ms | **2.97 / 3.68 ms** |
| 40 turns × 33 items, 710 KB | 7.96 / 8.01 ms | **7.14 / 7.53 ms** |
| 120 turns × 33 items, 711 KB | 66.3 / 215.0 ms | **54.9 / 84.7 ms** |

**About 0.8 ms per open at the engine boundary, and roughly twice that in the
app** — reasoned, not measured: each of these requests also crosses a Next route
handler that forwards to this same socket, so removing one request removes two
hops. It is a small number and it is honest: the round trip was never the
expensive part of opening a conversation.

### The expensive part, which this branch does not fix

Same 10-turn window, same 175 KB response, only the session's TOTAL length
changing:

| session length | snapshot + events | bootstrap |
|---|---|---|
| 20 turns | 7.36 / 3.67 ms | 3.96 / 4.90 ms |
| 60 turns | 4.95 / 4.37 ms | 4.75 / 3.56 ms |
| **120 turns** | **38.0 / 44.2 ms** | **28.1 / 19.0 ms** |

**An open costs what the SESSION holds, not what the window returns** — the
payload is identical across all three rows. `readQueue` and `readItems` parse the
whole document and `snapshotWindow` filters afterwards, so a long conversation
pays for its entire history on every read, including each 1 Hz companion
snapshot. On the owner's store this is where the remaining seconds are. It is a
`state.ts` change (an index, or a windowed read) and this branch was scoped to
`daemon.ts` plus one new module, so it is recorded here rather than attempted.

---

## What each route is now

`bun run --cwd apps/web build`:

| route | before | after |
|---|---|---|
| `/` | `ƒ` dynamic — two engine reads, then a redirect | **`○` static** — prerendered; the decision is a client fold over a remembered note |
| `/projects/:id/sessions/new` | `ƒ` + `listProjects()` on the server | `ƒ`, no engine read, **`loading.tsx`** |
| `/hosts/:host/projects/:id/sessions/new` | `ƒ` + a read **forwarded to the other Mac** | `ƒ`, no engine read, **`loading.tsx`** |
| `/projects/:id/sessions/:sessionId` | `ƒ`, no skeleton | `ƒ`, **`loading.tsx`** |
| `/hosts/:host/…/sessions/:sessionId` | `ƒ`, no skeleton | `ƒ`, **`loading.tsx`** |

The `loading.tsx` files are the change that should move the click → commit
number most, and the one this document cannot put a figure on: without a Suspense
boundary the router does not commit a dynamic navigation until the server render
returns, and with one it commits immediately. That is a shape change, not a
speed-up, which is why it needs an app to observe rather than a bench.

---

## Verified

`bun run typecheck` clean in `apps/web`, `apps/engine` and
`packages/engine-client`. `bun test --cwd apps/engine` **2,432 pass / 3 skip / 0
fail**; `bun test --cwd apps/web` **2,615 pass / 0 fail**; `bun test --cwd
packages/engine-client` **119 pass / 0 fail**. `bun run --cwd apps/web lint`
**0 errors, 13 warnings**, all pre-existing and none in a file this branch
touches. `next build` succeeds. `bun.lock` unchanged.

## Found and left

- **The snapshot read scales with session length** — the table above. The
  largest remaining cost on a long conversation, and the only one of the four
  this branch did not touch.
- **`subscriptions` rides the bootstrap and nothing reads it yet.** The issue
  asks for it and it is genuinely this session's own state, folded at the same
  instant for free. The Agents panel still does its own read because it also
  needs `liveSessions`, which is not session-scoped and does not belong in a
  session's bootstrap. Threading the seed through `right-panel.tsx` would save
  one request on a panel that only fetches when opened.
- **A launch with a dead engine now lands on a canvas rather than on the
  first-run screen**, when a previous launch left a note. That is the cost of
  redirecting on the first frame instead of after two engine reads. Without a
  note — a first run, a cleared store — the unreachable screen is unchanged.
- **The packaged-build sink for the navigation marks is `window`, not a network
  route.** The issue suggests posting them to an engine diagnostics route; no
  such route exists, and adding one was outside this session's ownership.
  `performance.mark` reaches a DevTools timeline in a packaged build, and
  `window.telarNavTimings()` reads the ring, which is enough to measure a
  nightly.
