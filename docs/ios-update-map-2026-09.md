# iOS update map after the September 10 desktop nightly

Source audit: 2026-09-10. Baseline: integration head `a3794340`, merged to main as `2e5f0ccc`, published as desktop `0.1.0-nightly.20260910.4`. Last iOS TestFlight build: tag `ios-nightly-20260907-1959` at `e9857bba`.

This is an implementation plan, not a claim of device-tested parity. No app was launched on a device for this audit. Every "current iOS" claim below was checked against `apps/ios/TelarMobile` at `2e5f0ccc`, and every route and type against `apps/web` and `packages/engine-client` at the same commit.

## What changed for iOS since the last TestFlight build

Four commits touch `apps/ios` between `ios-nightly-20260907-1959` and main. None has shipped to a phone.

| Commit | Effect |
| --- | --- |
| `693823e2`, `7a00df8c` | `nightly.sh` archives with `CODE_SIGNING_ALLOWED=NO` and re-signs at export. Build pipeline only. |
| `9aba103e` | Stop is split into `stopTurn` (withdraw one queued message) and `stopSession` (`scope: "session"` plus a `commandId`). `SessionStore.stopActiveTurn` now stops the session. |
| `da1c110c` | `Item` decodes `streamed`/`streamedThrough`; the journal fold is idempotent against replayed deltas; `Session.resumeCursor`; sync reconciles the snapshot cursor; the model pill and catalogue loader know the `opencode` driver; Send now is hidden for OpenCode sessions. |

The iOS unit suite on this tree passes: 105 tests, 0 failures, run on the iPhone 17 Pro simulator with Xcode 27.0 beta. No CI runs these tests; `nightly-ios.yml` only archives and uploads.

A TestFlight build from main today would carry the stop fix and the replay-safe fold without any of the parity work below. That is a reasonable first release on its own and is Step 0 in the sequence.

## What the phone already gets from the updated Mac

The native app calls the paired cockpit's `/api/**` routes and never the engine. Engine fixes therefore apply once that Mac is updated: Claude default-model resolution, Claude steering interruption, task-kind classification, clearer OpenCode provider failures, stop-from-every-origin, and faster engine recovery. These need no Swift.

Two consequences do need Swift. A Claude turn with no model may now sit `queued` for up to two seconds while the engine probes the catalogue, or fail with `provider_unavailable` and the sentence "Telar could not resolve a long-context Claude model". The phone must render both without inventing a window size.

iOS already implements host-scoped sessions and caches, the adaptive iPhone/iPad sidebar, pairing and device management, streamed journal updates, message queue and steering actions, approvals, model and effort controls, attachments, diff review, and automatic Live Activities. Preserve these rather than rebuilding them.

## Parity map

| Area | Current iOS source (verified) | Proposed update | Priority |
| --- | --- | --- | --- |
| Agent attribution and related work | `Turn` decodes 13 fields and none of `origin`, `sender`, `agentIntent`, `agentDelivery`, `assignmentScope`, `wakeReason`, `stopReason`, `steer`, `held` (`Protocol/TurnModels.swift:28-48`). `Session` omits `origin`, `startedFrom`, `agentMessagesBlocked` (`SessionModels.swift:86-91`). `SessionSnapshot` omits `assignments` (`EventModels.swift:164-188`). `TurnView` opens every turn with a user bubble (`TranscriptViews.swift:69`). | Decode the fields. A turn with `origin == "session"` is a peer task, report, or wake, never something the human typed. Add Working on behalf of, Awaiting review, Started from here, and Following, folded from `SessionSnapshot.assignments` and `Session.startedFrom`. | P0 |
| Steering and transcript boundaries | Live turns cut at seams (`segmentActivity`, `TranscriptViews.swift:119-135`). Settled turns split only at the last assistant message and fold everything earlier into one group (`:33-40`, `:254-285`); a mid-run human message is hidden behind the chevron and counted as "You steered". | Port `splitAtMessageBoundaries`: every `user_message` item opens a new response, live and settled alike, so a reload cannot move a message. Keep error and stopped states; render `stopReason`. | P0 |
| Model picker | Native `Menu` with driver sections and driver icons (`ModelPill.swift:85-92`), an "OC" text glyph for OpenCode. No search. `ProviderInstance` is decoded but never shown. Empty catalogue is a disabled "Loading models…" even when `catalogue.source == "builtin"` with a `message` (`:151-152`). | Searchable sheet on iPhone, popover on iPad. Rows carry the connection badge derived from the id's first `/` segment. Read `source` and `message` for loading, empty, error and retry states. Keep exact `provider/model` ids on the wire. Port `splitGenerations` with the one-generation-back rule so Codex 5.6 stays current. | P0 |
| Context window and streaming | `ContextWindow.label` is hardcoded to "1M" or "200k" (`Stores/ModelFamilies.swift:13-14`). `contextUsed`/`contextMax` are decoded (`Primitives.swift:23-28`) but never rendered; the overflow menu sums tokens only (`SessionView.swift:354-363`). Text renders straight from deltas (`Journal.swift:29-36`). | Show `ProviderModel.defaultWindow` for the selection and `usage.contextMax` for the measured window; never derive one from the other. Add the compact gesture as a turn with `kind: "compact"` where `PROVIDER_CAPABILITIES` allows it, with the 75% notice. Port the arrival-paced reveal with the same bounds and a Reduce Motion flush. | P1 |
| Run and Processes | No Run API methods, no Run or Processes views. Background tasks are filtered out of delegate chips at `TranscriptViews.swift:201-203`. | Typed wrappers for the ten Run verbs. Header Run control for configure, start, stop, restart, release. A separate Processes surface for background `JournalTask`s. Run state keyed by host plus session. | P1 |
| Plugin settings | `ProjectRef` is `{id, name}` (`SessionModels.swift:121-124`). Settings has Notifications and Cockpits only (`SettingsView.swift:21-45`). No plugin wrappers or views. | Per-Mac Plugins page under that Mac's settings reading `GET /api/plugins`. Project plugin settings below that. Effective enablement is Mac AND project; a missing Mac entry means allowed. A failed plugin's switch is shown off and disabled. | P1 |
| Markdown and scientific results | `MarkdownText.swift` splits on fences and renders inline-only Markdown; no tables, block lists, headings, math, images or PDF (`:5-6`, `:33-68`). | Block Markdown, tables, KaTeX-equivalent math with the web's policy (single dollar is not math, failed equations render their source in muted colour), images through the attachment route, PDF through the raw file route. | P1 |
| Files, notebooks and Data | `DiffView.swift` is the only file viewer. `listDirectories` lists directories for project registration only. Attachment upload exists. No workspace tree, notebook, plots or table surface. | Viewing first: listing, file, raw, table window, attachments with `tag=plot`, notebook read. Then text editing with the sha256 precondition and a retained draft. Then notebook edit and run and kernel controls. All execution stays on the Mac. | P2 |
| Desktop-specific controls | Nothing Electron-related exists in the iOS tree. | Do not port the updater, local checkout updater, native editor launch, or login-grant creation. Exported files use the iOS share sheet. | Out of scope |

## Cockpit route gaps that block iOS work

Two Next routes drop fields the engine sends and the web client declares. Fix both on the web side before the corresponding iOS step, or the phone will read nothing.

- `GET /api/sessions/live` rebuilds its JSON from `sessions` and `projects` only (`apps/web/app/api/sessions/live/route.ts:15-23`). The engine's live list carries `assignments` and the web sidebar reads them, but this hop never forwards them. Until fixed, iOS attribution must come from the per-session snapshot, which is authoritative and never windowed.
- `PATCH /api/projects/[projectId]` forwards only `dataScience` and `latex` (`apps/web/app/api/projects/[projectId]/route.ts:17-19`). The generic `plugins` patch that the web's own `enablePatch` produces is dropped. Project-level enablement for any other plugin cannot travel through the cockpit today.

## Contracts to decode

Field names and routes below are the ones on main. Keep every new Swift field optional so an older Mac still decodes.

**Turn** (`packages/engine-client/src/protocol/entities.ts:1035-1209`): `origin` is `user`, `provider` or `session`; `sender.sessionId`; `agentIntent` is `task`, `report`, `result` or `blocker`; `agentDelivery` is `passive` or `wake`; `agentSourceRunId`; `assignmentScope`; `assignmentDetachedAt`; `wakeReason` with `kind`, `sessionId`, `runId`, `requestId`; `stopReason` is `user`, `agent`, `engine_restart` or `worker_unavailable`; `steer.intoRunId`; `held.reason`. Exactly one of `wakeReason` or `sender` is present on a session-origin turn.

**Item** `user_message` detail (`protocol/items.ts:233-256`): `text`, `attachments`, `sender`, `wakeReason`. Classify on these fields, never on a `[wake: …]` text prefix.

**Session** (`entities.ts:474-683`): `origin` absent means human; `startedFrom.sessionId` and `runId`; `agentMessagesBlocked`; `activity` is `blocked`, `working`, `queued`, `monitoring` or `idle`.

**SessionAssignment** (`protocol/assignments.ts:35-63`): `taskRunId`, `fromSessionId`, `sourceRunId`, `scope`, `receivedAt`, `runId` (the carrier), `outcome` in `completed`, `failed`, `stopped`, `detached`, `endedAt`, `unresolved`. Active means no outcome and not unresolved. Reviewable means an outcome other than detached. Only turns with `origin == "session"` and `agentIntent == "task"` count.

**Subscriptions**: `GET` and `POST /api/sessions/[sessionId]/subscriptions` with body `{ targetSessionId, events?, once? }`; `DELETE /api/subscriptions/[subscriptionId]` answers `{ removed }`. Drop a Following row only when `removed` is true, and carry a generation so an in-flight read cannot restore it.

**Events the fold must handle** (`protocol/events.ts`): `turn.steering` and `turn.steered` with `intoRunId`, `turn.released`, `turn.requeued`, `turn.ambiguous`, `turn.discarded`, `session.paused`, `session.resumed`. The iOS decoder currently handles 16 event types and maps the rest to unknown.

**Stop and read**: `POST /api/sessions/[sessionId]/stop` with `{ scope: "session", commandId }` or `{ runId }`; `POST .../read` with `{ runId }` names the turn read; `POST .../turns/[runId]/release` clears `held` without resuming the session.

**Catalogue**: `GET /api/models?driver=&instanceId=&refresh=1` answers `{ catalogue }` with `driver`, `models`, `source` in `provider` or `builtin`, `message`, `readAt`, `instanceId`. Each model has `id`, `label`, `isDefault`, `hidden`, `hiddenByUser`, `efforts`, `defaultEffort`, `resolves`, `defaultWindow`, `fastMode`. Overlay at `GET`/`PATCH /api/provider-instances/[instanceId]/models`.

**Provider marks**: vendor `apps/web/public/model-providers/*.svg` with its `ATTRIBUTION.md` (models.dev, MIT), plus the Claude and Codex paths inlined in `apps/web/components/session/provider-icon.tsx`. An unknown connection gets a two-letter monogram, never a wrong logo.

**Reveal pacing** (`apps/web/lib/streaming-reveal.ts:39-60`): maxLag 1200 ms per chunk from its own arrival, reserve 450 ms, floor 2 chars, drain slack 0.25 to 2.0, arrival EWMA weight 0.3. Only prefixes of the target are ever shown, every exit ends at the target, and the cut never splits a surrogate pair. Seed at full length on remount so a watched answer does not replay.

**Run** (`protocol/run.ts`, routes in `apps/web/lib/run/route-map.ts:56-103`): under `/api/sessions/[sessionId]/run`, `GET /configs`, `POST /configs`, `POST /configs/:id` (a patch; omitting `env` leaves it alone), `DELETE /configs/:id`, `GET /status`, `POST /start` with `{ configId, replace? }`, `POST /stop`, `POST /restart`, `POST /release` with `runId` required, `GET /output?runId=&after=`. `RunStatus` `unknown` is not terminal. A secret env value is absent from the view, not masked. Bound the log buffer at 2000 lines; a cursor that goes backwards means a different run. Poll at 1 s while starting or running, 3 s when ready, 5 s otherwise.

**Plugins** (`protocol/plugins.ts`): `GET /api/plugins` answers `{ plugins: PluginStatus[], machine: ProjectPlugins }`; `PATCH /api/plugins` takes `{ plugins: { [id]: { enabled, settings? } | null } }`. `PluginStatus` is `{ meta, state, error, initMs }` with `state` in `ready`, `failed`, `disposed`. Effective enablement is `machineAllows && pluginEnabled`. Toolchain status comes from `/api/latex/toolchain` and `/api/data-science/toolchain`.

**Files** (`entities.ts:1367-1436`): `GET /api/sessions/[sessionId]/files` with no path answers `{ listing }`, with `?path=` answers `{ file }` carrying `text`, `bytes`, `sha256` of the whole file even when truncated, `binary`, `truncated`. `PUT` with `{ text, expectedSha256 }` answers `{ written: true, file }` or `{ written: false, refusal, sha256? }` at HTTP 200; only `conflict` offers a re-read. `GET .../files/raw?path=` streams bytes with no-store. Project twins exist under `/api/projects/[projectId]/files`. `GET .../data/table?path=&offset=&limit=200&sort=&desc=1` answers a `TableWindow`.

**Notebook and kernel**: `POST /api/sessions/[sessionId]/ds/notebook/read` with `{ path, from?, to?, withOutputs? }`, `.../notebook/edit` with `{ path, edit }`, `.../notebook/run` with `{ path, cellId?, all?, stopOnError? }`; kernel state, interrupt, restart, vars and inspect under `.../ds/`. Cell image outputs carry an `attachmentId`, not bytes. A read failure is `missing` only when the engine's message says no such file in this workspace; anything else is unreadable with a retry, never an offer to create.

**Auth**: bearer `tlr_…` token; only `/api/ping` and `/api/pair` are exempt. An observer-paired phone may only GET and HEAD, so every write surface must degrade to read-only for that role rather than showing a failing button.

## Implementation sequence

### 0. Ship what main already has

Tag an iOS nightly from `2e5f0ccc`. It carries the unified stop and the replay-safe fold that are already tested. Run the 105-test suite first; it passed on this tree today.

### 1. Contract and conversation correctness

- Extend `Protocol/{TurnModels,SessionModels,EventModels,ItemModels}.swift` and `Sync/Journal.swift` with the fields above. Add fixtures for a wake turn, a peer task turn, a steered turn, and a snapshot with assignments.
- Keep a task's originating run distinct from the run carrying it out. A carrier outside the loaded window is `unresolved`, not running.
- Update `TranscriptViews.swift`: a session-origin turn never renders as a human bubble; reports and wakes are compact, identifiable rows; the Send now button and the "You steered" tally follow the boundary split.
- Port `splitAtMessageBoundaries` and `turnRenderOrder` so live and settled turns render through one rule.
- Add related-work rows to the session header from the snapshot's assignments and `startedFrom`. Add Follow and Unfollow with pending, failed and stale-response handling. Note the live-route gap above.
- Render `stopReason` and `held.reason`; surface the `provider_unavailable` Claude message as the engine sends it.

Acceptance: a Claude response interrupted from iPhone and iPad keeps its partial prose and the human's steering message visible after completion and reload. A coordinator on two Macs with identical session ids attributes correctly. A failed Follow or Unfollow never shows as successful. The older `ios-nightly-20260907-1959` fixtures still decode.

### 2. Model selection and reading

- Replace the `Menu` with a searchable picker. Match on label, raw id and connection name. Separate driver, provider instance and OpenCode connection; do not collapse distinct routes sharing a model name.
- Package the provider marks as iOS assets with attribution. Keep effort, fast mode and provider-supported options.
- Read `source` and `message` for error states. Show `defaultWindow` and measured `contextMax` separately.
- Port `splitGenerations` including the one-generation-back rule.
- Port the paced reveal into the transcript with the bounds above and a Reduce Motion listener.
- Replace `MarkdownText` with block rendering, tables and math. Cache settled renders and bound work per delta.

Acceptance: selecting the same model through OpenAI and through an OpenCode connection submits distinct ids. A catalogue of two hundred rows searches without lag. Codex 5.6 rows stay visible with GPT-6-Astra as default. Missing catalogue, provider auth failure, and the new Claude 1M default each show a truthful state. Long responses, Dynamic Type, VoiceOver and Reduce Motion are exercised.

### 3. Run monitoring and plugin controls

- Add the Run verbs and the plugin routes to `Networking/EngineAPI.swift`. The phone must not bypass pairing and call the daemon.
- iPhone opens Run configuration and Processes as sheets; iPad shows a session inspector beside the conversation. Header Run configures and launches; Processes monitors background tasks.
- Put the per-Mac Plugins page inside that Mac's settings. Global means that Mac, not all paired Macs.
- Add project plugin settings once the project PATCH route forwards `plugins`. Explain disabled-at-Mac versus disabled-at-project.

Acceptance: start and stop a harmless server, reconnect and observe its status, switch hosts during a delayed read, and confirm a backgrounded agent never appears as a run. Toggle a plugin at both scopes and confirm project settings survive a Mac-level disable.

### 4. Workspace and science surfaces

- Viewing first: workspace tree, file, PDF, images, plots gallery, windowed tables, notebook cells and outputs.
- Then text editing with a retained draft, the sha256 precondition, visible refusals, and a soft-wrap toggle that never inserts newlines.
- Then notebook edit and run and kernel controls. Missing file, missing route, disconnected Mac and kernel failure are four different states.
- Never open a run's `127.0.0.1` readiness URL on the phone as if it were the Mac.

Acceptance: open the synthetic exoplanet notebook, chart and dataframe and the compiled TeX PDF on iPhone and iPad. Edit a long Markdown paragraph, save, reload, toggle wrap and verify identical bytes. An unavailable notebook route shows an error, never Create notebook.

## Release boundaries and checks

Recommended TestFlight cadence: Step 0 now, then Steps 1 and 2 together, then Step 3, then Step 4. Conversation correctness ships before the large new surfaces.

For each release run the Swift suite, then the `TelarMobileUI` scheme against the preview server, then `bun test apps/web/lib/mobile`. Validate against the new nightly and an older paired Mac. Standard cases: two-host identity collisions, reconnects, background and foreground transitions, failed requests, observer role.

Profile a long streaming conversation, repeated host and session changes, and a large notebook output on a real device before setting budgets. The desktop memory pressure seen on September 10 is not evidence of the same cause on iOS.

Retest automatic Live Activities on a signed device after Step 1: Follow and Unfollow are a separate feature and must not make automatic activities opt-in per session.

## Source anchors

- `apps/ios/TelarMobile/Protocol/{TurnModels,SessionModels,EventModels,ItemModels}.swift`: fields decoded today.
- `apps/ios/TelarMobile/Views/TranscriptViews.swift`, `Sync/Journal.swift`: attribution and settled versus live rendering.
- `apps/ios/TelarMobile/Views/ModelPill.swift`, `Stores/ModelFamilies.swift`: picker and window labels.
- `apps/ios/TelarMobile/Views/{SettingsView,MarkdownText,SessionView}.swift`: settings, rendering and conversation controls.
- `apps/ios/TelarMobile/Networking/EngineAPI.swift`: the 27 protocol methods plus sidebar-layout and push extras.
- `packages/engine-client/src/protocol/{entities,items,events,assignments,plugins,run,common}.ts`: contracts.
- `apps/web/components/transcript.tsx`, `session/related-work.tsx`, `session/conversation-message.tsx`: boundary split and attribution rendering.
- `apps/web/components/composer-controls.tsx`, `lib/model-connections.ts`, `lib/model-generations.ts`: picker behaviour.
- `apps/web/lib/streaming-reveal.ts`, `lib/use-streaming-reveal.ts`: pacing.
- `apps/web/lib/run/{route-map,presentation,api}.ts`, `components/run/*.tsx`: Run.
- `apps/web/components/settings/{plugins-page,plugin-settings}.tsx`, `lib/plugins/sections.ts`: plugins.
- `apps/web/components/session/{file-view-surface,notebook-surface}.tsx`, `lib/editor-wrap.ts`, `lib/ds.ts`: files and notebooks.
- `apps/web/components/ui/message.tsx`, `lib/markdown-math.ts`: Markdown and math policy.
