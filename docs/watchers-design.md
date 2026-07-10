# Loom Watchers — Background reaction to loom state

**Status:** Draft for review · 2026-07-10
**Scope:** let a working session *watch* a loom and react to its state changes —
surface them and ask the owner how to proceed — as a TRUE background process:
the user keeps chatting; the watcher reacts when the change happens. Not a
blocking tool call that occupies the turn.
**Related:** ROADMAP Phase B ("Watchers as background processes") ·
Phase C (`phase-2-runner-plan.md`) · `loom-model.md` §5/§A · `runtime-architecture.md` §A

---

## 1. Goal & non-goals

**Goal.** A session registers a watch on a loom. When that loom transitions to a
state that needs its owner — `needs-review` / `blocked` / `failed` / `done` /
`ready` — the watcher (a) surfaces an actionable alert in the session and (b)
injects a synthetic turn so the agent reacts *in-conversation* and can drive the
loom with the tools it already has (`steer_loom` / `reject_loom` / `resume_loom`
/ `cancel_loom`, `loom-mcp.ts`). The user is never blocked: they can keep
typing; the reaction lands when the state change occurs.

**Non-goals / the moat holds.**
- The watcher **surfaces and asks — it never acts autonomously.** `accept`→`done`
  stays a human click; there is deliberately no `accept_loom` tool. A watcher may
  propose steer/reject/resume, but committing work to `done` remains the owner's
  manual sign-off (`loom-model.md` §M.6).
- No auto-accept, no auto-approve of the steering tools' *effects* beyond what the
  existing auto-run allow-list already grants.

---

## 2. What the substrate already gives us

**Loom events are disk-backed and tailable.** `readEvents(id, afterLine)`
(`looms.ts:393`) and `appendEvent` (`looms.ts:226`) are the append-only log; state
transitions land as events + a `saveLoom`. The per-loom SSE route
(`app/api/looms/[id]/events/route.ts`) polls disk every 400ms (`POLL_MS`, line 7),
emits a full `run` snapshot on first sight (line 63) and again whenever
`loom.updatedAt` moves (lines 74-77), each `ev`, and `end` on a terminal state
(`TERMINAL`, line 6: `done` / `needs-review` / `halted` / `failed` / `skipped`).
**Key:** the watcher must key off the `run` snapshot's `loom.state`, NOT `end` —
`ready` and `blocked` are non-terminal in that route (the stream stays open and
keeps polling), so they arrive only as `run` snapshots.

**States** — `WorkUnitState` (`schemas.ts:155-169`). Owner-actionable trigger set:
`needs-review`, `blocked`, `failed`, `done`, `ready`.

**A session turn is a request-scoped, detached run.** `POST /api/chat`
(`route.ts:123`) = one turn, run in a `ReadableStream` closure; `send()`
(`route.ts:281-296`) is the SSE writer; the run is detached from the request
(`registerChatRun`, `route.ts:264-265`; registry in `chat-runs.ts:21-59`) and
persists in `finally` via `appendTurn` (`route.ts:1373`). **There is no existing
way to inject a follow-up/synthetic turn from outside** — the only thing that
starts a turn is a client `POST` carrying a `message`. The one adjacent primitive
is the synthetic `user` header event the live-log writes (`session-log.ts:26-37`)
and the client renders (`applyServerEvent` "user" case, `session-view.tsx:1199-1206`)
— but that's a *display* artifact for reconnect, not a real agent turn.

**Client send + subscribe hooks.** `send(text)` (`session-view.tsx:1588`) POSTs the
turn (body at 1610-1630), guarded by `busy` in `handleSubmit` (1699-1703). The §1b
reconnect subscriber (`session-view.tsx:1543-1586`) is the exact shape a watcher
subscriber copies: a `useEffect` that opens a streaming reader — except the reconnect
one is gated on idle (`statusRef.current === "ready"`, no `abortRef`, once per
sessionId); a watcher subscriber must run **continuously**, independent of turn state.

**No notification/toast library exists** (grep: only the SDK's `task_notification`
message subtype and Codex JSON-RPC notifications — no UI toast, no browser
`Notification`). The reusable surfacing primitive is the **loom-handoff banner**:
state `loomHandoff` (`session-view.tsx:971`), dismissible actionable card rendered at
`2068-2097`, set from a tool_result (`1383-1401`). The watcher alert reuses this
exact pattern.

---

## 3. The single-process constraint (why v1 is tab-scoped)

All agent compute runs **inside the Next.js dev-server process**
(`runtime-architecture.md` §A.1, lines 28-56). There is no persistent session
daemon: the in-flight-turn registry is `globalThis`-backed in-process memory
(`chat-runs.ts:15-16`) that dies on hot-reload/restart. A client's EventSource on a
loom's `/events` lives only **in the browser tab**.

- **While the tab is open:** the browser can hold a background EventSource on the
  watched loom and react — this is v1, no new infra.
- **While the tab is closed:** nothing server-side reacts, because there is no
  long-lived process to run the reactor or to inject a turn. That requires the
  out-of-process runner — **Phase C** (`phase-2-runner-plan.md`; ROADMAP Phase C).
  This is v2.

Nice property that softens v1's limit: the loom SSE route sends a full `run`
snapshot on connect (`route.ts:63`), so a state change that happened while the tab
was closed is caught the moment the tab reopens and the watch re-attaches.

---

## 4. Data model — a watch record

Persisted server-side (so the client can re-attach on mount and the v2 runner can
read the same registry). Suggested store: `~/.telar/watches.json` (atomic rewrite,
mirroring `secrets.ts`), or a `watches[]` field on the Chat record in `store.ts`.

```ts
type Watch = {
  id: string;                 // watch_<base36>
  loomId: string;             // the watched loom
  sessionId: string;          // the owning session (chat id)
  triggerStates: WorkUnitState[]; // default: [needs-review, blocked, failed, done, ready]
  createdAt: number;
  status: "active" | "fired" | "cancelled";
  lastFiredState?: WorkUnitState; // de-dupe: don't re-fire on the same state
};
```

De-dupe rule: fire once per (watch, state) — re-arm only when the loom moves to a
*different* trigger state, so the 400ms poll can't spam the session.

---

## 5. How the agent sets one up — a `watch_loom` MCP tool

Add `watch_loom` to `loom-mcp.ts` and to `LOOM_AUTO_TOOLS` so it auto-runs (no
permission card — registering a watch is inert; it spends nothing). Signature
mirrors the other lifecycle tools (`resolveLoomId` defaulting to the session's
linked loom):

- **Inputs:** `loomId?` (defaults to the linked loom), `triggerStates?: WorkUnitState[]`
  (defaults to the owner-actionable set).
- **Effect:** write/replace a `Watch` record for `(sessionId, loomId)`;
  `sessionId` is `opts.getSessionId()`, never model-supplied.
- **Output:** `{ watchId, loomId, triggerStates }` and a one-line confirmation. It
  **returns immediately** — the tool does not block on any loom event.

**Rejected alternative — the blocking await.** A `wait_for_loom(loomId)` tool that
awaits the next state change and resolves inside the turn was considered and
rejected: it occupies the turn (burns the `maxTurns` budget, `route.ts:890`), pins
the agent so the user *can't keep chatting*, and dies with the turn. That is exactly
the "true background process" requirement inverted. `watch_loom` registers and
returns; the reaction arrives as a *new* turn later.

---

## 6. v1 — client-driven watcher (works while the tab is open)

No out-of-process infra. Everything hangs off `session-view.tsx`.

1. **Registration.** Agent calls `watch_loom` → a `Watch` record is persisted;
   the tool returns at once (§5).

2. **Background subscriber.** Add a `useEffect` in `SessionViewInner`, sibling to
   the reconnect subscriber (`session-view.tsx:1543`), that reads this session's
   `active` watches (seeded from the server on mount + refreshed after each turn
   completes) and, per watch, opens a **background** EventSource on
   `/api/looms/[watch.loomId]/events`. Unlike the reconnect subscriber it is **not**
   gated on `statusRef === "ready"` / `!abortRef` — it must keep running while the
   user chats and while a turn is in flight. New component state:
   `watches: Watch[]`, `watcherAlerts: WatcherAlert[]`, and a pending-injection queue.

3. **Trigger.** On a `run` event whose `loom.state ∈ watch.triggerStates` and
   `!== watch.lastFiredState`:
   - **(a) Surface** a `WatcherAlert` card — reuse the loom-handoff banner pattern
     (`session-view.tsx:2068-2097`): loom title, the state it hit, a "View god-view"
     link, and a dismiss. This lands immediately, regardless of turn state.
   - **(b) Inject a synthetic turn.** Compose
     `"[watcher] loom <id> (<title>) hit <state> — <short context>. How do you want to proceed?"`
     and enqueue it. When `status` next becomes `"ready"` (composer idle — the
     `busy` guard at `1701` forbids injecting mid-turn), dispatch it through the
     existing `send()` path (`session-view.tsx:1588`). The agent then reacts in the
     conversation and can call `steer_loom`/`reject_loom`/`resume_loom`/`cancel_loom`
     — already auto-run.
   - Mark the watch `lastFiredState = state` (de-dupe).

4. **Render the injected turn as a watcher bubble, not a user bubble.** Minimal
   option: pass an optional `origin: "watcher"` alongside `message` on the
   `POST /api/chat` body (`route.ts:124`, echoed to the live log via
   `session-log.ts` so reconnect matches) and branch the "user" render
   (`session-view.tsx:1199`) on it. Cheapest option for a first cut: just send it as
   a normal user turn with the `[watcher]` prefix. Either way the server path is
   unchanged — it is still just a `message`.

**Limitation (call it out in the UI):** the subscriber is a browser EventSource, so
reaction only happens **while the tab is open**. Close it and no injection fires
until the tab reopens — at which point the watch re-attaches and the loom SSE's
connect-time `run` snapshot (`route.ts:63`) catches any state change missed while
away. Persisting the watch record is what makes that re-attach possible.

---

## 7. v2 — server-side watcher (survives tab close; rides Phase C)

Depends on the out-of-process runner (`phase-2-runner-plan.md`). Same `Watch` data
model (§4), same trigger semantics — the reactor just moves off the browser.

- **Watch reactor in `telar-runner`.** The runner already hosts loom execution and
  writes/reads loom state on disk. Add a reactor that, on a loom transition into a
  trigger state (it can hook `saveLoom`/`appendEvent` directly, or tail
  `events.ndjson` — same `readEvents` primitive), looks up active watches for that
  `loomId` and fires.
- **Two firing modes:**
  1. **Push a notification** — write a durable "watcher alert" record the web can
     surface on next connect, and/or (later) a browser push / OS notification.
  2. **Queue a turn** — enqueue the synthetic `"[watcher] …"` turn via the runner's
     session-dispatch path (`phase-2-runner-plan.md` §2b, "Sessions out of process"),
     so the reaction runs even with no tab open; the user sees it when they return
     (the turn already lives in the live log / transcript).
- **Boot recovery** reconciles watches the same way it reconciles looms: re-arm
  `active` watches on runner start.

v2 is a sketch and is explicitly **blocked on Phase C** — do not build it before the
runner exists.

---

## 8. Recommended path & phased tasks

Ship **v1 now** (client-driven, zero new infra, directly satisfies "keep chatting,
it reacts"), evolve to **v2** when Phase C lands. v1's `Watch` data model and
`watch_loom` tool are forward-compatible — v2 only relocates the reactor.

**Phase W1 — client-driven watcher (now)**
- [ ] `Watch` type + a small persisted registry (`~/.telar/watches.json` or a
      `store.ts` Chat field) with `add`/`list`/`cancel`.
- [ ] `watch_loom` MCP tool in `loom-mcp.ts`; add it to `LOOM_AUTO_TOOLS`;
      `sessionId` server-derived via `getSessionId`.
- [ ] Route to read a session's active watches on mount + after each turn.
- [ ] Background watch subscriber `useEffect` in `session-view.tsx` (sibling to the
      reconnect one at `1543`, but ungated on idle); per-watch EventSource on
      `/api/looms/[id]/events`, keyed off `run.state`.
- [ ] `WatcherAlert` card (reuse the loom-handoff banner, `2068-2097`) + a
      queued-injection path through `send()` (`1588`) that fires when `status` is
      `"ready"`; de-dupe on `lastFiredState`.
- [ ] (Optional) `origin:"watcher"` on the POST body + user-render branch
      (`route.ts:124`, `session-view.tsx:1199`) so the injected turn reads as a
      watcher, not the user.
- [ ] "Only reacts while this tab is open" affordance on the card.

**Phase W2 — server-side watcher (with Phase C)**
- [ ] Watch reactor in `telar-runner` reading the same registry.
- [ ] Fire mode: durable alert record + (later) push notification.
- [ ] Fire mode: queue a synthetic turn via the runner's session dispatch
      (`phase-2-runner-plan.md` §2b).
- [ ] Re-arm active watches in the runner's boot recovery.

**Moat check (every phase):** the watcher only ever *asks*. No `accept_loom`; `done`
stays a human click.
