# Runtime Architecture — Background Execution & per-project MCP

**Status:** Draft for review · 2026-07-10
**Scope:** two runtime gaps that share one root cause — (A) agent work that dies
when you look away, and (B) no per-project MCP servers / auth. Both are about
*how Telar hosts long-running agent work and its dependencies*.
**Related:** #36 (looms out-of-process), #33 (per-loom run initializer),
`docs/loom-orchestrator.md` (boot recovery).

---

## Why these two together

They meet at one seam: **how a run is dispatched, where its compute lives, and
how its dependencies (accounts, MCP servers) are wired in.** Fix the execution
model and the MCP-injection point falls out of the same plumbing.

The shared root cause today: **all agent compute runs inside the Next.js server
process**, and for *sessions* it is additionally chained to the HTTP request.
So a session dies on navigate/hot-reload, and MCP config has nowhere project-
scoped to live because there is no per-run "environment" step — every `query()`
just inherits the account's process env.

---

## Part A — Background execution (sessions & looms)

### A.1 Current state (grounded)

**A session's compute *is* its HTTP request.** `apps/web/app/api/chat/route.ts`:
one `POST` = one turn, run entirely inside a `ReadableStream` closure.

- `route.ts:249-250` — `const abort = new AbortController(); req.signal.addEventListener("abort", () => abort.abort());`
- `route.ts:868` — that `abort` is the SDK's `abortController`.
- ⇒ client disconnect (navigate, close tab, **hot-reload**) → `req.signal` aborts → `query()` subprocess is torn down mid-turn.
- Persistence happens **only in teardown** (`appendTurn`, `route.ts:1338`); there is **no server-side run object**, no registry, no detached promise. The turn's live state lives only in the closure.

**A loom's compute is a detached promise that persists as it goes.**
`packages/core/src/dispatcher.ts`:

- `startLoom` returns the loom **synchronously** while `executeLoom(...).catch(onFailure).finally(...)` runs un-awaited (`dispatcher.ts:164` and siblings). The only handle is a module-global `const active = new Map<string, AbortController>()` (`dispatcher.ts:42`).
- The executor writes durable state on every event: `onEvent → appendEvent` (→ `~/.telar/looms/<id>/events.ndjson`) and `onState → saveLoom` (→ `loom.json`).
- The god-view SSE route (`app/api/looms/[id]/events/route.ts`) **polls disk every 400ms** and streams it — fully decoupled from the executor. Navigating away closes *your* reader; the executor is untouched.

**The one-sentence difference:** a loom's producer (detached promise) and
consumer (SSE tailing disk) are decoupled through disk; a session's producer and
consumer are the same request.

**Both still die on hot-reload.** The `active` Map is in-process memory with no
rehydration (`docs/loom-orchestrator.md` calls out the "dispatcher orphan gap").
A Next dev restart kills every detached executor; `loom.json` is left in a
non-terminal state on disk with nothing advancing it. And because looms run
**in-process**, a build agent hammering the event loop starves the web UI — the
reason the god-view page carries a defensive plain-GET poll (`page.tsx:64-69`),
and the substance of task #36.

### A.2 Principle: compute ≠ request

An agent run should be owned by a **background Run**, persisted to disk as it
progresses, that any page can subscribe to and leave freely. The only things
that end a run are: it finishes, or it is **explicitly stopped**. "I navigated
away" must be a different signal from "I hit Stop." Today they are the same
(`req.signal`), which is the whole bug.

Looms already embody this. **Sessions should adopt the same model.**

### A.3 Target: one Run abstraction for sessions and looms

A run (session turn or loom) has:

1. **Dispatch** — fire-and-forget; the initiating request returns immediately.
2. **A disk-backed event log + state** — written incrementally as it runs (looms have this; sessions get a per-session events log alongside `chats.json`).
3. **Subscribers** — the page opens an SSE reader that tails the log. Connect/reconnect replays from disk. Closing it (navigate) does nothing to the run.
4. **An explicit Stop** — a control signal (a `POST …/stop`, or a stop flag on disk the runner watches), the *only* thing besides completion that aborts.

### A.4 Phase 1 — decouple sessions from the request (in-process)

The minimal change that stops sessions dying on navigate. Still in the Next
process, so still dies on hot-reload — but that's the smaller, dev-only pain.

- Lift the `query()` loop out of the `ReadableStream` closure into a **session run registry** mirroring the dispatcher (`active` Map + detached promise + `AbortController`).
- **Persist incrementally**: append streamed parts to a per-session event log on disk as they arrive, not only at teardown. `appendTurn` becomes the *finalizer*, not the sole writer.
- The chat SSE route becomes a **disk-tailing subscriber** (like `looms/[id]/events`): a fresh connection replays the in-flight turn from disk.
- **Sever `req.signal` from the run.** The run aborts only on `POST /api/chat/stop` (explicit Stop) or completion. Navigate/hot-reload no longer aborts.
- Keep resume semantics as-is (SDK `resume: sessionId` already restores conversation state).

**Outcome:** a session keeps working when you leave its page — the behavior the
user expects from looms. (Hot-reload still interrupts; see Phase 2.)

### A.5 Phase 2 — out-of-process runner (survive hot-reload/restart)

A separate long-lived process (`telar-runner`) hosts **all** runs. The Next
server becomes a thin client.

- **Dispatch** over a small control channel (spawn + a local socket / loopback HTTP): the web server asks the runner to start/stop a run; the runner does the compute.
- **Events/state** still go to disk exactly as today; the web SSE routes tail disk **unchanged from Phase 1** — so the read path doesn't move.
- **Boot recovery** (from `docs/loom-orchestrator.md`): on runner start, rehydrate — auto-resume `queued`/`preparing`, force `running`/`verifying` → `halted` for human/agent resume. Closes the orphan gap.
- **Fixes #36 for free**: build/critic agents run in the runner, not the web event loop, so they can't starve the UI. The god-view's defensive poll can eventually retire.

**Outcome:** runs survive the web server hot-reloading or restarting; the UI
never starves.

### A.6 Sequencing & risk

- Phase 1 is the high-value, lower-risk step and unblocks the user's complaint immediately. Do it first, standalone.
- Phase 2 is a larger lift (a new process + IPC + lifecycle) but reuses Phase 1's disk read-path verbatim.
- **Open decisions:** (a) runner as a standalone process vs a Node worker the web server spawns — lean standalone so it outlives web restarts; (b) Stop mechanism — HTTP endpoint vs a watched stop-flag file; (c) whether Phase 1 ships before Phase 2 or they land together.

---

## Part B — per-project MCP servers with manual token auth

Scope per decision: **manual, token-based auth per project.** Interactive/OAuth
login flows are **explicitly deferred** — most servers we need (e.g. Supabase)
authenticate with a token/PAT. Design for tokens now; leave a seam for OAuth.

### B.1 Current state (grounded)

- MCP is passed to the SDK in only two shapes: in-process `createSdkMcpServer` (the `loom` tools, `chat/route.ts:857`; the `emit_result` server, `engine.ts:176`) and hardcoded **stdio** Playwright (`verifier.ts:236`, `critic.ts:178`). **No `http`/`sse`, no per-project config.**
- The manifest (`ProjectManifest`, `packages/core/src/schemas.ts:153-192`, stored as `telar.yaml` per repo) has `gates`, `guardrails.{disallowedTools,protectedPaths}`, `urls`, … but **no `mcpServers` field**.
- **Auth is coupled to the account.** `accountEnv(profile)` (`engine.ts:107`) builds the subprocess env with the account's credential; every MCP server the run spawns inherits that same env. Switching a loom/session's Claude account rotates that env — which is exactly why an MCP server keyed to it breaks on account-switch.
- Secrets today: a 0600 file store `~/.telar/credentials.json` (`secrets.ts`), account-keyed, read by `accountEnv`. **No keychain, no UI write path, no per-project secrets.**

### B.2 The account-decoupling principle

MCP credentials must **not** ride `accountEnv`. Because Telar drives the SDK
directly, it can pass each MCP server's auth as **explicit `headers` (http) /
`env` (stdio)** on that server's own config — resolved from a store that has
nothing to do with the Claude account. Switch the account, the MCP token is
untouched. This is the core of the design and the thing native Claude Code
can't do (it keys MCP OAuth to the active account).

### B.3 Design

**1. Declare servers per-project in the manifest** — `telar.yaml` gains
`mcpServers` (committable; **holds no secrets**, only references):

```yaml
mcpServers:
  supabase:
    transport: stdio            # stdio | http
    command: npx
    args: ["-y", "@supabase/mcp-server-supabase@latest"]
    env:
      SUPABASE_ACCESS_TOKEN: { secret: supabase_pat }   # ← reference, not the token
  some-http-server:
    transport: http
    url: https://mcp.example.com
    headers:
      Authorization: { secret: example_token, prefix: "Bearer " }
```

A value can be a literal string **or** a `{ secret: <key>, prefix?: <str> }`
reference. `schemas.ts` gets an `McpServerConfig` zod type; `getProject().manifest`
already flows to both the session `query()` and every loom `agent()`.

**2. A per-project token store, keychain-backed.** Keyed by `(project, secretKey)`,
modeled on `secrets.ts` (name-keyed, atomic, 0600) but backed by the OS keychain
— on macOS via the `security` CLI (no native dependency), with the 0600-file
store as a cross-platform fallback. **Separate from account credentials**; it is
never read by `accountEnv`. Tokens are entered manually (Settings → project →
MCP) and never written to the repo.

**3. Resolve + inject at dispatch (account-decoupled).** One resolver:

```
resolveProjectMcpServers(project) : Record<string, SdkMcpServerConfig>
```

For each declared server, look up any `{ secret }` references in the keychain and
materialize concrete `headers`/`env`, producing the SDK config. Spread it into
`mcpServers` **alongside** the existing loom/playwright servers, at both call
sites:

- Session — `chat/route.ts`: `mcpServers: { loom: loomMcpServer, ...resolveProjectMcpServers(project) }`
- Loom build/critic — thread through `engine.ts` `extraMcpServers` from `executor.ts`.

Because each token is attached to its own server's `headers`/`env` and never to
`accountEnv`, account-switching can't disturb it — by construction.

### B.4 Decisions

- **Reference syntax:** structured `{ secret: key, prefix? }` over `${secret:…}` string interpolation — unambiguous, typed, no escaping. *(Recommended.)*
- **Keychain backend:** `security` CLI wrapper on macOS + 0600-file fallback, over a `keytar` native module (no native build, cross-platform). *(Recommended; implementation detail, revisit if we ship non-mac.)*
- **Config split:** servers declared in `telar.yaml` (committable, reviewable, secret-free); secret *values* entered via a Settings UI into the keychain. *(Recommended.)*
- **Out of scope (deferred):** interactive/OAuth MCP servers — the resolver leaves a seam (`{ oauth: … }`) but v1 only does tokens.

### B.5 Phasing

- **MCP-1** — `mcpServers` manifest schema + `resolveProjectMcpServers` + injection into session & loom, reading secrets from the existing `secrets.ts` store first (fastest path to a working Supabase server).
- **MCP-2** — keychain-backed per-project secret store + Settings UI to enter tokens.
- **MCP-3** *(deferred)* — interactive OAuth servers.

---

## What I'd build first

1. **A.4 (background sessions, Phase 1)** — directly fixes the "sessions stop when I look away" pain; self-contained.
2. **MCP-1** — get a real per-project token server (Supabase) working end-to-end, account-decoupled, storing the token in the existing 0600 store.
3. Then **MCP-2** (keychain + UI) and **A.5** (out-of-process runner) as the hardening pass.

Open decisions to confirm before code: the three in **A.6** (runner shape, Stop
mechanism, phase sequencing) and the recommendations in **B.4**.
