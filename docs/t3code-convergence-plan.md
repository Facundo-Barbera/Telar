# The t3code convergence plan

**Status:** agreed 2026-08-01. Supersedes nothing; this is the first plan of its kind.
**Reference clone:** `~/Projects/_refs/t3code` (shallow). Its `.repos/` directory is **vendored
third-party source** — never search or cite it. Scope everything to `apps/` and `packages/`.

## Why this exists

Two asks, in the owner's words: *"(1) the functionality under the hood — t3code made the harness
primitives so good that Claude and Codex both feel natural, I want that for Telar. (2) A much better
UI for Telar in general, based on t3code."* Plus a specific complaint — the projects UI is bad — and
a specific love — the right sidebar with browser tabs, and the chat input.

The plan below came out of a 12-agent research pass over both codebases (2.1M tokens, 558 tool
calls) that produced three competing strategies, a synthesis, and an adversarial critique. **The
critique falsified the synthesis's centerpiece.** What follows is the corrected version, with the
falsification recorded rather than quietly dropped — the wrong first move is instructive.

## Verified facts this plan rests on

Each was checked directly, not taken from the research summary.

| Fact | Evidence |
| --- | --- |
| The panel and the harness work are **independent tracks** | `apps/web/app/projects/[name]/sessions/[id]/page.tsx:149` is already a flex row with two children; a third child touches neither `session-view.tsx` nor `api/chat/route.ts` |
| **Stop already works** | `chat-runs.ts:37` AbortController. The session-scoped port therefore buys *steering* and mid-turn switch — not the stop button |
| `HarnessEvent` and `CodexNormalizedEvent` are the same 12 variants | Counted both. (The research said 13; it is 12.) |
| Swapping them is **not** a forcing function | `CodexNormalizedEvent` has exactly 3 references, all inside its own file. The swap produces **zero** compile errors anywhere |
| There is **no Claude adapter** | `route.ts:1361` calls `query()`; `:1514` maps SDK messages inline across ~400 lines inside a 2,115-line POST |
| `EngineEvent` is a **third** union on the moat path | `engine.ts:49-67`, 5 members, incompatible field names (`tool-result` vs `tool_result`); consumed by verifier, critic, scoping, ultra |
| No mobile app; desktop has no deep links | `apps/desktop/main.js:297` loads the root URL only — later route deletion is safer than assumed |

## Decisions taken

1. **Three columns, not five.** `SessionsRail` collapses into `AppSidebar`; sessions become a
   filtered list inside the one sidebar. Target shell: `sidebar | chat | right panel`. This is the
   decision that actually buys the simplicity — t3code feels simple because it has *fewer regions*,
   not prettier ones. Cost: `app-sidebar.tsx` (1,273 lines) gets rebuilt earlier than the research
   sequenced it.
2. **`EngineEvent` is left alone, deliberately.** The loom engine keeps its own vocabulary. It
   models agent runs *inside verification*, not interactive chat turns, and the two paths do not
   meet today. This is a decision, not an oversight — if someone later unifies them, the
   `acceptForSession` safety argument in the approvals phase must be re-derived, because today it
   holds only *because* the paths are separate.
3. **Multi-instance providers stay optional.** CLIProxyAPI already pools multiple logins, so this is
   a convenience over the gateway rather than a missing capability. Promote it only if hand-swapping
   `CODEX_HOME` becomes daily pain.

## The rejected first move, and why

The research's headline was: delete `CodexNormalizedEvent`, make `runCodexTurn` yield `HarnessEvent`,
and "every remaining gap becomes a compile error."

It does not. The union has three in-file references and nothing else compiles against it; widening a
union only breaks *exhaustive* consumers, and there are none. Worse, the conformance test meant to
replace that mechanism can only run against Codex, because extracting a Claude adapter is late-phase
work — so it would go green while asserting nothing on the Claude half. That is precisely the "true
statement about a dead mechanism" failure `session-profile.ts:274-287` already warns about.

The swap is still cheap and directionally right. It is simply **not a domino**, and it must not be
scheduled as one.

## Sequence

Estimates from the research were off by more than 2× on four of seven phases. The numbers below are
doubled where the critique demonstrated it. Treat them as order-of-magnitude.

### Phase 1 — Paint and geometry (~1 week)
Zero coupling to anything. Highest visual return in the repository.
- Replace `globals.css:51-118` — currently stock shadcn neutral (`--chart-1: oklch(0.87 0 0)` is
  literally grey) — with a real Telar palette. Add `--control-radius`.
- Port the resizable / `storageKey` / `shouldAcceptWidth` additions into
  `components/ui/sidebar.tsx` (same shadcn base component; no consumer edits).
- **Do not** ship t3code's `--workspace-topbar-*` titlebar-inset vars yet: their whole purpose is
  Electron titlebar alignment, and `main.js` sets no `titleBarStyle`. Without the desktop half they
  are decoration.
- Harvest `lib/demo-gallery/**` design rationale into docs **before** restyling any surface it
  specs — 12+ production files cite it in header comments. 23,196 lines; this is weeks as a blocker.
  *Decide explicitly whether it blocks.*

### Phase 2 — One sidebar (~2 weeks)
The decision above, executed before anything mounts a third column.
- Collapse `SessionsRail` into `AppSidebar`: search + new-session + an "All projects" scope menu over
  a flat, time-ordered session list. No tree, no expand/collapse state.
- Extract `app-sidebar.tsx`'s pin/reorder/recents inline state into a tested pure module;
  deduplicate the three copies of per-project signal derivation.

### Phase 3 — The right panel (~5-6 weeks)
The surface the owner named. Verified unblocked.
- Surface store on the `ui-prefs.ts` `useSyncExternalStore` + localStorage idiom (**not** zustand —
  `ui-prefs.ts:9-12` documents why there is no such dependency). **Add a version field and an
  eviction rule**: this is a per-session keyed store, unlike every existing single-key store.
- Tab strip: hover-revealed close, middle-click, context menu, `+` menu with disabled-reason
  tooltips, empty state.
- Mount as the third flex child in `sessions/[id]/page.tsx` — a route-level edit.
- **Ship a `telar:refresh` dispatcher in the same commit that moves `git-tab`.** That event is the
  app's only cross-surface invalidation convention (`app/page.tsx:257`, `looms/page.tsx:185`,
  `projects/page.tsx:325`); `git-tab.tsx:195` depends on it and has no live push. Move it without
  this and the panel's git state is *staler* than today's buried tab.
- Browser surface as an `<iframe>` behind the API a webview would later use. Say so honestly in the
  empty state where `frame-ancestors` blocks a page.
- **Extend INV-8's purity scan before these component trees exist**, not after
  (`invariants.test.ts:47` scopes it to `components/conversation/**` + `session-view.tsx`).
- Reality check: the git subsystem is **5,315 lines** (`git-tab.tsx` 286, `lib/server/git-tab.ts`
  1,569, plus 3,746 in sub-views). Re-homing it is larger than everything else in this phase
  combined.

### Phase 4 — The composer (~3-4 weeks)
Where the two tracks meet, and where two already-written modules finally get consumed.
- Wire `apps/web/lib/provider-options.ts` (currently zero importers) and
  `packages/core/src/runtime-mode.ts` (currently consumed only by its own test).
- One generic traits control with a joined `·` trigger label; a provider publishing nothing renders
  no control at all.
- The four-row Access select. **Do not** adopt t3code's `full-access` default — Telar defaults to
  `auto` (recorded in `runtime-mode.ts`).
- Delete the 19 remaining `provider === "codex"` forks in `apps/web` as descriptors replace them.
- Honest caveat: "a new service tier appears with zero client changes" requires a **server publisher**
  deriving options from a live catalog. `provider-options.ts` is static data today. That property is
  currently asserted, not funded.

### Phase 5 — Projects stop being a page (~4 weeks)
Its richest tenant already moved in phase 3, so this is mostly deletion.
- Project detail becomes a dialog off the scope menu, not a 1,282-line route.
- Expose manifest fields no UI reaches: `charterPolicy` (moat-relevant), `devCommand` (the PATCH
  route accepts it and nothing sends it), `verifyCommand`, `designRules`.
- Kill or wire `adapter` — zero engine readers, yet it owns a column and is searchable.
- Reality check: **149** non-gallery `/projects/` references across `apps/web`. Redirects needed.

### Phase 6 — Approvals and turn lifecycle as one vocabulary (~4-5 weeks)
Deliberately not earlier: Codex approvals already reach Claude's card through the same
`createPending`. This collapses a working side channel, it does not make approvals work.
- **Commit #1, non-negotiable:** rewrite INV-1g to assert the PreToolUse guardrail is wired *wherever
  the harness call lives*, rather than resolving `api/chat/route.ts` by relative path
  (`invariants.test.ts:1236`). It fails loud today — but only while that file still exists. This is
  four distinct structural claims plus a discrimination fixture: a session, not a bullet.
- Add `request_opened` / `request_resolved`, `turn_started` / `turn_completed`, item lifecycle, and
  a structured user-input channel to the union.
- Land INV-2i in the same commit as `ApprovalDecision`: `acceptForSession` must be structurally
  incapable of granting anything on the verification path.

### Phase 7 — Session-scoped port (~6-8 weeks)
The load-bearing architectural change, priced honestly and sequenced late *because stop already
works*. A stall here costs a paused branch and nothing the owner asked for.
- Replace `runTurn(req): AsyncGenerator` with `startSession` / `sendTurn` / `interruptTurn` /
  `respondToRequest` / `stopSession`; move the event stream to adapter level.
- Strangler: per-session flag, both paths live, old branch deleted only when the full suite (141 test
  files, 50,492 lines) is green on both.
- Extract a real Claude adapter here — which is what finally makes an event conformance test
  non-vacuous. **The event-union unification belongs here, not in phase 1.**

### Phase 8 — Optional upside
Each item independently droppable: persisted session directory + resume cursors; multi-instance
providers (deprioritised — CLIProxyAPI already pools); cross-provider model palette with ⌘1–⌘9;
native browser compositing (real Electron work against a 479-line `main.js`).

## Open questions still unanswered

1. **Codex verification.** `providers.ts:185` records that Codex has no `restrictTools` /
   `disallowedTools` / `settingSources` equivalent. Do we accept "builds on Codex, verifies on
   Claude" permanently, or fund a new enforcement mechanism? This is the one place where "both
   harnesses feel equally natural" has an honest caveat.
2. **`app/page.tsx`** (628 lines, four uncoordinated fetches) duplicates the projects index and the
   sidebar. In a t3code-shaped app the sidebar *is* the dashboard. Delete or restyle?
3. **Looms and the god-view.** Right-panel tabs beside the session that spawned them, or their own
   route? The accept path must be restyled and re-homed, never restructured — but *where acceptance
   lives* is a product question.
4. **The demo-gallery harvest** — blocker or accepted loss?

## Standing rules

- **Surfaces are hosted, never forked.** If a fix would have to land in two places, that surface
  migrates instead. This is what stops `git-tab` from existing in both a panel and a project page.
- **Rewrite the invariant before moving the mechanism it pins.** Not after.
- **Every phase ends at something a person can walk through.** No horizontal layer that strands value.
- **The human-accept moat is not negotiable** and is re-pinned per phase, never left stranded
  between tiers.
