# #204 — remote-host conversation switching and sidebar identity

Evidence is source reading, an isolated two-host reproduction, and a
**rendered-sidebar regression harness** that mounts the real `AppSidebar`.
Nothing was reproduced against a live paired Mac, and no installed app, pairing
store or remote data was touched. The one-line fix in `app-sidebar.tsx` was
applied by that file's owner; this session wrote only investigation and fixture
files.

## Confirmed root cause

**The sidebar's "local" read follows the address bar, so while the cockpit is on
a remote Mac the rail reads that remote Mac twice — once labelled as itself and
once labelled as local.**

Three lines, all in code paths that are individually correct:

- `apps/web/lib/hosts/client.ts:65` — `pathnameFetcher` resolves the host from
  `window.location.pathname` **per call**. Correct default: a screen whose
  subject is the current address should follow it.
- `apps/web/components/app-sidebar.tsx:119` — `const api = createEngineApi()`,
  i.e. that pathname-following fetcher.
- `apps/web/components/app-sidebar.tsx:403` — `const hostApi = host ? createEngineApi(hostFetcher(host.id)) : api;`
  Remote reads are pinned with `hostFetcher(id)`; the **local** read uses the
  pathname-following `api`.

`lib/hosts/client.ts:48-50` already states the rule this breaks: callers that
know which host they mean *regardless of the URL* — "the sidebar fanning out
over all of them" — must pass `hostFetcher(id)`. The remote arm does; the local
arm does not.

### What follows from it, in one rail pass on `/hosts/<B>/…`

1. `loadHost(undefined)` is answered by **B**: `/api/sessions/live` is rewritten
   to `/api/hosts/<B>/sessions/live`.
2. Those rows are built with `toSidebarSession(..., host === undefined)`
   (`app-sidebar.tsx:428`), so they carry **no `hostId` and no `hostName`** —
   no host badge, and `sessionHref` (`lib/session-list.ts:396`) emits a **local**
   URL for a remote conversation.
3. Clicking one has two outcomes, both bad:
   - id exists only on B → this Mac answers **404 `not_found`**: the screenshot's
     *"Request failed — session does not exist"*, after which the header falls
     back to the raw project id and the composer waits for a session that will
     never arrive. This is a **valid wrong-host 404, not a transport failure** —
     the request completed, against the wrong engine.
   - id exists on both Macs (legal — ids are minted per engine) → **200**, and
     the reader silently opens *this* Mac's conversation of that id. No error,
     nothing on screen saying the subject changed. This is the worse case.
4. `rememberRows(cache, LOCAL_HOST, …)` (`app-sidebar.tsx:475`) writes B's rows
   into the **local** slot of `telar-sidebar-cache`, so the mislabelled rows
   survive a reload and are later shown, dimmed, as this Mac's own.
5. Both reads carry B's `daemonId`, so `dedupeAcrossHosts` folds them by
   `(daemonId, session id)` and the local read wins by order
   (`lib/session-groups.ts:96-105`): the **correctly stamped `/hosts/<B>/…` row
   is discarded in favour of the mislabelled one**. Same rows, different badge
   and different link, depending on where the address bar was when the pass ran —
   which is exactly why the two screenshots disagree about badges and grouping.
6. `app-sidebar.tsx:484`'s self-pair check compares B's `daemonId` (from the
   "local" read) with B's own, decides B *is* this Mac, and drops B from
   `remoteProjects` — so while viewing B, the New menu loses B.
   `setProjects(local.value.projects)` similarly shows B's projects as local,
   which is the raw-project-id/duplicate-name confusion in the report.

The reproduction prints each of these with the URL, the engine actually reached
and the status.

## What is NOT broken

Checked because the issue asks for the failure to be located rather than assumed:

- **Route tree and page params.** `/hosts/[hostId]/projects/[projectId]/sessions/[sessionId]`
  exists and does not pass `hostId` to the cockpit — which is fine, because
  `session-cockpit.tsx:816` derives it with `hostFromPathname(pathname)`.
- **Cache keys are host-scoped.** `sessionConnection` keys on
  `[host, id, window]` (`lib/engine/session-connection.ts:49`), the snapshot
  store on `snapshotKey(host, id)`, and the cockpit's own `syncKey` on
  `[host, session]` with a generation counter that discards stale reads
  (`session-cockpit.tsx:967-979`). Overlapping ids across hosts do not collide
  in any of them.
- **In-flight reads keep their host across a navigation.** A URL is built when
  the request starts, so remote A → remote B → local → remote B with a reply
  held across each move lands against the Mac it was asked of (step 6 of the
  reproduction). The hazard is not the transport; it is a caller that *builds* a
  URL from the address bar for a subject that is not the address.
- **`/api/hosts` is never proxied** (`rewriteApiPath`), so the book itself is
  always this cockpit's own. That asymmetry — right book, wrong rows — is why
  the rail can show a remote's conversations under no host at all.
- **The proxy is faithful**: method, query, body and status pass through, the
  caller's credentials are stripped, and an unreachable Mac becomes
  `engine_unavailable` (503) rather than a 404, so "away" and "wrong host" are
  already distinguishable in the response.

## The fix, and the evidence it works

One line, applied by the sidebar's owner:

```ts
// apps/web/components/app-sidebar.tsx:403
const hostApi = createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID));
```

`hostFetcher(LOCAL_HOST_ID)` returns plain `fetch` (`lib/hosts/client.ts:51`),
so the local read is pinned to this Mac from any address, and every consequence
above disappears at the source: rows are stamped by the read they came from, the
cache slots stop crossing, dedupe compares two different daemons again, and the
self-pair check sees the real local identity.

`harness.tsx` mounts the REAL component against two fake Macs and judges the
rendered hrefs — a row served by engine X must link to engine X. Built twice
from the same source: as it stands, and with `BEFORE=1`, which reverts exactly
that expression **in memory during bundling** (the file on disk is untouched,
and the transform throws if the expression is missing, so it cannot silently
bundle the fixed code and call it "before"). Observed in the browser:

| scenario | BEFORE=1 | as it stands |
| --- | --- | --- |
| 1 · local read while the address is remote B | local read asked **NOT this Mac**; 4 reads reached B (read twice, once labelled local); verdict RED — `"REMOTE B — only there"` served by host_b → `/projects/…/session_b1`; the rail drops to two groups and **B's badged group disappears** | local read asked this Mac; 6 rows, each linking to its own Mac |
| 2 · remote A → remote B → local → remote B | not run (1 already red) | every row links to its own Mac at all four addresses |
| 3 · the shared session id | not run | all three copies reachable, each addressing its own Mac (local, host_b, host_a) |
| 4 · host-scoped cache across a reload | `cache[local]` held **2 rows belonging to host_b**; after reload, 1 row mislinked | `cache[local] / cache[host_a] / cache[host_b]` = 2 rows each, none foreign; rows still correct after reload |
| 5 · a read that lands after the move | not run | 1 reply held across the move; late rows arrived correctly addressed |

The BEFORE run also reproduces the screenshot symptom the issue could not
explain: standing on B, the rail renders **B's rows twice** — once badge-less
under a bare project name — and B's own badged group vanishes, so grouping and
badges both change with nothing but the reader's address.

## Follow-ups, decided separately

### The greeting picker, fixed (second instance of the family)

`components/session/fresh-greeting.tsx` had the same split: a host-following
READ and a local-only LINK. Now:

- It reads through **`lib/hosts/host-projects.ts`** (new), which keeps each
  answer with the host it came from (`HostProjects = { hostId, projects }`),
  drops a listing whose host no longer matches instead of relabelling it
  (`projectsForHost`), clears on a host change during render, and re-reads on
  the registry's own `PROJECTS_CHANGED_EVENT`. `lib/projects.ts` is untouched —
  no consumer of its API changed.
- Destinations are host-qualified: `canvasHref(project.id, hostId)`.
- **"Project settings…" is now local-only**, because there is no
  `/hosts/:id/projects/:id/settings` route — offering it on a remote canvas
  would push a local URL carrying a remote project id, which is the defect
  itself. Absent rather than disabled: a menu item that cannot go anywhere is
  noise. Behaviour change, deliberate; if remote project settings are wanted,
  they need that route first.

Evidence, from the same harness (scenario 6, which holds a reply across
B → A → B with the project id present on every engine):

| | BEFORE=1 | as it stands |
| --- | --- | --- |
| picking B's project while on B | `/projects/project_b_only/sessions/new` — **local URL, remote id** | `/hosts/host_b/projects/project_b_only/sessions/new` |
| after a held reply lands post-switch | (menu blocked mid-switch) | `/hosts/host_b/…` — "the picker stayed on host_b" |
| picking on this Mac | `/projects/project_local_only/sessions/new` | `/projects/project_local_only/sessions/new` |

`BEFORE=1` reverts this destination too, by the same in-memory transform.
`lib/hosts/host-projects.test.ts` pins the pure rule: a listing is handed back
only to the host it describes, and one from another Mac is dropped even when the
ids match.

- **`lib/projects.ts` call sites** (asked for in review). It has exactly one
  data consumer: `components/session/fresh-greeting.tsx`, via `useProjects()`.
  Every other importer takes only the change event (`app-sidebar.tsx`,
  `projects/register-dialog.tsx`, `settings/remove-project-section.tsx`), which
  is host-agnostic. `register-dialog` and `remove-project-section` read through
  their own module-level `createEngineApi()`, and their screens ARE about the
  current address — intentional current-host views, correct as they are.
  `fresh-greeting` was a **second instance of this family** — fixed above.
- **Where the guard should live long-term.** The harness is a browser fixture
  because `loadHost`/`loadAll` are not exported. If the rail ever exposes its
  per-host read, this becomes an ordinary unit test asserting "one read per Mac,
  each pinned".

## #82 reconciliation

#82's diagnosis does not apply to the current source, and its remedy is moot:

- It attributes navigation freezes to **six stacked SSE tails** exhausting the
  HTTP/1.1 per-origin cap, opened by `/api/chat`, loom-handoff and watcher tails,
  ultra run tails and the dock's `SessionRuntimeHost`.
- There is **no `EventSource` anywhere in `apps/web`**, no `text/event-stream`
  consumer, and none of those surfaces exists. The transcript is kept current by
  **short JSON polls**: the engine's `/events` returns immediately with
  `more: false` (`apps/engine/src/daemon.ts:3108`), and the cockpit coalesces
  reads through `SessionConnection.read()` plus a `tailInFlight` guard.
  `client-request-budget.ts`, cited by #82, is gone too.
- So slice 1 ("refcounted EventSource registry") has nothing to dedupe. #82
  should be closed as superseded, or rewritten against the poll architecture if
  the freeze is ever seen again.

One #82-adjacent risk does survive and is worth a separate measurement rather
than a fix here: a remote read is two hops, and the proxy holds an upstream
request for up to `UPSTREAM_TIMEOUT_MS = 60_000` (`lib/hosts/proxy.ts:27`). A
paired Mac that hangs rather than refuses occupies a Next server connection for
a minute per rail pass. Passes do not stack (`loadAllRunning`), so this is a
latency and server-connection question, not the reported symptom.

## Reproduction

Both live under `apps/web/test-fixtures/host-identity/`, share their two fake
engines (`engines.ts`), and are sanitized by construction: no tokens, no
credentials, no prompt text.

- `reproduce.ts` — the mechanism, at the seam. Production
  `createEngineApi`/`pathnameFetcher`/`hostFetcher`/`toSidebarSession`/`sessionHref`/
  `rememberRows`/`dedupeAcrossHosts`; a recording fetch reporting which engine
  each request reached; parked replies for the A → B → local → B walk. It
  MIRRORS `app-sidebar.tsx:402-508` rather than executing it, so it is not a
  regression test — it prints both compositions (pathname-following and pinned)
  and exits 0. `bun run …/reproduce.ts`.
- `harness.tsx` + `build.mjs` + `stubs/` — the regression test. The real
  `AppSidebar` in a browser, `next/navigation` and `next/link` stubbed so the
  address bar is a control (`history.pushState` moves the real
  `window.location` too, because `pathnameFetcher` reads it per call), the rail
  re-read through its own `announceProjectsChanged` trigger (its 10s timer is
  throttled to nothing in a background tab), and the verdict read off the
  rendered hrefs. `bun run …/build.mjs` → `/tmp/telar-host-identity-fixture/`,
  served on `127.0.0.1:43199`; `BEFORE=1` produces the pre-fix bundle at
  `/before.html`. Plain `.mjs` on purpose: it drives Bun's build API and never
  ships, so typing it would mean relaxing the app's types for one file.
