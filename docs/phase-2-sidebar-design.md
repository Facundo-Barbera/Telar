# Phase 2b — one sidebar

## 0. Status, and what this document is for

**Status:** proposed, not built, not approved. Nothing here has shipped and no commit in this
series exists yet. This is the design for **phase 2b** of `docs/t3code-convergence-plan.md` — the
execution of decision #1 ("three columns, not five"), which was taken and is not relitigated here.
Phase 1 (palette, `--control-radius`, the resizable `components/ui/sidebar.tsx`) landed in
`569bdb2` / `6785011`. Phase 2a — extracting `app-sidebar.tsx`'s pin/reorder/recents state into
tested pure modules and unifying the four copies of per-project signal derivation into
`lib/project-signal.ts` — is behaviour-preserving groundwork and is specified separately; **2b is
where pixels change, and it should not start until 2a has landed**, because 2b's list ordering is
2a's `deriveProjectSignals` with the deprecated `legacyActive` field finally deleted. This
document is blocked on the owner answering §7. Several of those questions change §1's layout, not
just its details, so building against this document before they are answered is building against a
draft.



## 1. The target

One sidebar, mounted once in `app/layout.tsx:53`, present on every route, resizable, and containing
a **flat list of sessions** rather than a tree of projects. Reading top to bottom:

**Chrome header** — unchanged from today in spirit: the `telar` wordmark linking to `/`, and a
`SidebarTrigger`. Fixed height, bottom border.

**Fixed header block, two rows, never scrolls.** Row one is a search field and a New-session icon
button. Row two is a project scope menu — a full-width button reading **All projects** or the
scoped project's name — and a New-project icon button. The scope menu carries a per-project
ellipsis that opens the project dialog (§4). This is t3code's shape verbatim
(`SidebarV2.tsx:2588-2761`), for the reason its own comment gives at `SidebarV2.tsx:1371-1373`:
scoping filters the list *without* making the sidebar's width depend on how many projects you have
or how long their names are. Telar's projects are directory names — `telar`, `some-client-app` —
so this matters more here than there.

**Nav.** Three rows, kept exactly as today: Dashboard, Projects, Looms, with the pulsing count
badge on Looms. This is the one place I am deliberately *not* following t3code, which has no nav at
all. Telar has two enumerated entities where t3code has one: sessions and looms. `/looms` is where
the human-accept moat is exercised, and it must stay one click away from everywhere. The badge's
number changes in 2a (`counts.inFlight`, not the current widened non-terminal count — see the
convergence plan's D-4), but the row survives. Whether Dashboard survives is open question 2.

**The list.** Sessions for the current scope, in **three bands**:

1. **Needs you** — a header row, then any loom in `awaitingDecision` or `awaitingAccept`, then any
   session whose loom is parked on it. This band is the concession to Telar's richness: it is the
   only place a loom appears in the list, and its header links to `/looms`. It is absent at count
   zero. t3code has no equivalent because t3code has no moat.
2. **Sessions** — no header. Every non-archived session, newest-first. This is the band that
   replaces `SessionsRail` wholesale.
3. **Settled** — a collapsible shelf, `Settled (N)` when collapsed, holding sessions untouched for
   N days. Whether Telar wants auto-settle at all is open question 4; if the answer is no, band 3
   is simply archived sessions and the shelf stays collapsed by default.

**Footer** — the account wheels and Settings, unchanged. The wheels are Telar-specific and have no
t3code counterpart; they are also the surface the owner has never complained about.

Two properties are load-bearing and worth stating as rules rather than leaving implicit:

- **Position is creation order, and activity never reorders the list.** t3code's
  `sortThreadsForSidebarV2` (`Sidebar.logic.ts:479-491`) makes this explicit — "a row holds its
  position from open until settled, so the screen only moves at lifecycle transitions." Telar's
  current `SessionsRail` sorts by `updatedAt` (`lib/store.ts:228`), so **this is a change**, and it
  is the single change most responsible for the sidebar feeling calm. Open question 3.
- **The open session never hides.** If the route's session falls past a collapsed shelf or past a
  "Show more" boundary, it renders anyway (t3code's two survival exceptions,
  `SidebarV2.tsx:1682-1693` and `1718-1730`).

Width: resizable, `storageKey` on `lib/sidebar-width.ts`'s existing store, default and minimum both
`SIDEBAR_RESIZE_MIN_WIDTH` (256px, `sidebar-width.ts:37`), `shouldAcceptWidth` = `keepsRoomForMain`
(`sidebar-width.ts:97`) with a main-content floor. Those functions exist, are tested, and have
never had a consumer; this is that consumer.

### Default

```
┌──────────────────────────────┐
│ telar                    [▣] │  chrome: wordmark · trigger
├──────────────────────────────┤
│ [🔍 Search           ]   [✎] │  search · new session
│ [📁 All projects      ▾] [＋]│  scope · new project
├──────────────────────────────┤
│ ⌂  Dashboard                 │
│ ▤  Projects                  │
│ ⧗  Looms                 (3) │  badge = in-flight looms
├──────────────────────────────┤
│ NEEDS YOU (2) ───────────────│
│ ▸ telar · charter review     │
│ ▸ acme · ready to accept     │
│                              │
│ ▪ telar   Rework the rail    │  ← current route, highlighted
│   2h ago              $1.24  │
│ ▪ telar   Palette pass       │
│   5h ago              $0.31  │
│ ▪ acme    Fix the webhook    │
│   yesterday           $2.07  │
│ ▪ telar   Sidebar spike      │
│   2d ago              $0.88  │
│                              │
│ ▾ Settled (14) ──────────────│
├──────────────────────────────┤
│ ◕ personal   ◔ work      ⟳   │  account wheels
│ ⚙  Settings                  │
└──────────────────────────────┘
```

### Searching

The list is *replaced*, not filtered in place — shelf headers, band headers and the Needs-you band
all disappear, and what remains is a flat `role="listbox"` of hits with `aria-activedescendant`
keyboard navigation and no per-row actions. That is t3code's `SidebarV2.tsx:2764-2814`, and the
reason to copy it exactly is that a search result list which still has bands invites you to believe
the bands mean something about the hits. They don't.

```
┌──────────────────────────────┐
│ telar                    [▣] │
├──────────────────────────────┤
│ [🔍 webhook          ] [✕][✎]│  clear button appears
│ [📁 All projects      ▾] [＋]│  scope still applies to the search
├──────────────────────────────┤
│ ⌂  Dashboard                 │
│ ▤  Projects                  │
│ ⧗  Looms                 (3) │
├──────────────────────────────┤
│ ▪ acme   Fix the webhook     │  ← highlighted, ↑↓ wraps, ⏎ opens
│ ▪ acme   Webhook retry loop  │
│ ▪ telar  webhook signature   │
├──────────────────────────────┤
│ ◕ personal   ◔ work      ⟳   │
│ ⚙  Settings                  │
└──────────────────────────────┘
```

Empty: a single `role="status"` line, `No sessions found`.

### Scoped to one project

Scope is a filter over the same list, not a different screen. The project's name replaces
"All projects" in the trigger; the Needs-you band, the session band and the shelf all narrow; the
per-row project label disappears from every row, because it is now redundant with the header.

```
┌──────────────────────────────┐
│ telar                    [▣] │
├──────────────────────────────┤
│ [🔍 Search           ]   [✎] │  ✎ now creates in `telar` directly
│ [📁 telar             ▾] [＋]│  ⋯ per row in the menu → project dialog
├──────────────────────────────┤
│ ⌂  Dashboard                 │
│ ▤  Projects                  │
│ ⧗  Looms                 (1) │  ← scoped? open question 5
├──────────────────────────────┤
│ NEEDS YOU (1) ───────────────│
│ ▸ charter review · epic-4    │
│                              │
│ ▪ Rework the rail            │  no project column
│   2h ago              $1.24  │
│ ▪ Palette pass               │
│   5h ago              $0.31  │
│ ▪ Sidebar spike              │
│   2d ago              $0.88  │
│                              │
│ ▾ Settled (6) ───────────────│
├──────────────────────────────┤
│ ◕ personal   ◔ work      ⟳   │
│ ⚙  Settings                  │
└──────────────────────────────┘
```

Scope is `useState`, session-local, not persisted — t3code's choice (`SidebarV2.tsx:1373`), and the
right one, because a persisted scope is a filter you forget you set and then file a bug about. Two
invariants ride along, both copied: if the scoped project disappears, scope snaps back to all
(`SidebarV2.tsx:1392-1396`); and navigating into a session in project X does **not** silently set
scope to X. Scope is a thing you choose, never a thing that happens to you.



## 2. What moves

Every element of both components, accounted for. "Deleted" means no successor exists anywhere and
§3 owes an explanation for it.

### `components/session/sessions-rail.tsx` (96 lines, one mount at `sessions/[id]/page.tsx:150`)

| Element | Where it is now | Fate |
| --- | --- | --- |
| The `<aside w-64 hidden md:flex>` column itself | rail | **Deleted.** This is the whole point: one region fewer. The route's flex row (`page.tsx:149`) loses its first child and keeps two. |
| Back-link `← {project}` | rail header | **Merged** into the scope menu. The scope trigger names the project; its ellipsis reaches the project dialog. The `/projects/{name}` route still exists in 2b. |
| **New session** button | rail header | **Merged** into the header's `✎` icon button. Behaviour follows t3code (`SidebarV2.tsx:2562-2576`): scoped or single-project → create immediately in that project; unscoped and many projects → a project picker. |
| Per-row title (`s.title \|\| "Untitled session"`) | rail row | **Kept**, as the session row's first line. |
| `fmtAgo(s.updatedAt)` | rail row | **Kept**, and becomes the app's only relative-time formatter for sessions — `app-sidebar.tsx:170`'s private `fmtShort` dies with it (a 2a extraction, a 2b string change; see §3). |
| `fmtCost(s.costUsd)` | rail row | **Kept**, right-aligned, monospace. This is Telar richness with no t3code counterpart and it stays. Requires cost on the sidebar's `ChatMeta` — see the API note below. |
| `aria-current="page"` + `bg-muted` active row | rail row | **Kept**, but derived from `usePathname()` rather than an `activeId` prop, because the sidebar is global and has no page to hand it one. |
| `ArchiveButton`, hover-revealed | rail row | **Kept** as a hover action on the session row, in the fixed-width action slot described in §3. |
| Empty state "No sessions yet. Start one to plan a change." | rail | **Kept**, restated three ways as t3code does (`SidebarV2.tsx:3001-3022`): no projects / no sessions in this project / no sessions at all. |
| `hidden … md:flex` (rail vanishes below `md`) | rail | **Deleted** as a rule; replaced by the sidebar's own mobile sheet, which is strictly better — the list becomes reachable on small screens instead of unreachable. |
| Server-rendering (no `"use client"`, data from `listChats`) | rail | **Lost.** The merged list is client-side, because a global sidebar cannot be re-rendered by one route's server component. §3. |

### `components/app-sidebar.tsx` (1,273 lines)

| Element | Lines | Fate |
| --- | --- | --- |
| `TelarSidebarHeader` — wordmark → `/`, `SidebarTrigger` | 949-968 | **Kept**, restyled to match t3code's `SidebarChromeHeader` proportions. |
| `NavGroup` — Dashboard / Projects / Looms | 908-946 | **Kept** as-is. The Looms badge's *number* changes in 2a; the row does not. |
| Looms badge `activeLooms.length` | 1173, 932-939 | **Kept**, fed from `counts.inFlight`. |
| Pinned group + `PinIcon` label | 1193-1206 | **Deleted.** There is no pin in the new list; position is creation order. §3, and open question 6 — this is the affordance most likely to be missed. |
| `togglePin`, `PINNED_KEY` localStorage | 1111-1114, 53 | **Deleted** with the group. Note `app/projects/page.tsx:64`'s rival `telar:pinnedProjects` store is a *different* key with a different shape and survives untouched; unifying them stops being necessary because one of the two ceases to exist. |
| Recent group, `RECENTS_LIMIT = 6` | 1208-1226, 50 | **Deleted.** Projects stop being an enumerated list in the sidebar; they become one dropdown. |
| `ProjectRow` disclosure (`open`, expander button) | 812-906, 826 | **Deleted.** "No tree, no expand/collapse state" is the scoped decision. |
| `ProjectRow` nested session list (`todayChats`) | 890-903 | **Merged** into the flat session list — this is the duplicate the whole phase exists to remove. The `isToday` narrowing (180-182) goes with it. |
| `ProjectRow` nested loom list (`StateBadge` links) | 877-889 | **Merged** into the Needs-you band, but only for looms awaiting a human. In-flight looms stop appearing per project and are represented by the nav badge alone. §3. |
| `ProjectRow` active pulse dot + loom count | 855-864 | **Merged** into the Needs-you band. The pulse-as-glyph disappears; 2a already establishes that it was pulsing for three states where nothing is running (D-3). |
| `ProjectRow` pin toggle (hover-revealed) | 866-875 | **Deleted** with pins. |
| Collapsed icon-rail branch: `RailProject`, `ProjectGlyph`, the divider | 1175-1190, 780-810 | **Deleted.** Collapse becomes offcanvas, not an icon strip. §6. |
| `RailWheels` (vertical wheels for the collapsed rail) | 696-733 | **Deleted** for the same reason — there is no collapsed strip left to render into. |
| Usage wheel components and drag-reorder helpers | 207-778 | Removed when external quota indicators were retired; the footer now contains Settings only. |
| Refresh button + `refreshing` + `telar:refresh` dispatch | 1000-1011 | **Kept.** The dispatch is the app's only cross-surface invalidation convention and phase 3 depends on it. |
| Ledger line (session / weekly telar-measured spend) | in `ExpandedList` | **Kept.** |
| Auto-refresh-if-stale + `autoRefreshed` ref | 1053-1066, 981 | **Kept**, moved intact by 2a. Its dep array changes every render and the ref is the only thing stopping a refresh storm; do not "clean it up". |
| `SettingsButton` | 1249-1264 | **Kept**, in the footer, as t3code's footer settings row. |
| `loadAll` — four uncoordinated fetches, 10s interval | 1013-1051 | **Kept in shape, one endpoint heavier.** It gains sessions-for-every-project, which it already fetches (`/api/chats`); it drops nothing. The missing `AbortController` and response-ordering guard remain a known defect, unchanged, out of scope. |
| `parseStoredList` / `useStoredList` | 105-150 | **Halved.** Loses the pin key, keeps the wheel-order key. 2a moves it onto the `useSyncExternalStore` idiom of `lib/ui-prefs.ts`. |
| `fmtShort` (`"3m"`) | 170-178 | **Deleted**, superseded by `lib/format.ts`'s `fmtAgo` (`"3m ago"`). A visible string change, which is exactly why it is 2b and not 2a. |
| `fmtReset`, `ringTone`, `dotClass`, `isToday` | 160-206 | `fmtReset`/`ringTone`/`dotClass` **kept** (wheels). `isToday` **deleted** with the today-filtered nested list. |
| `SidebarProject` type, `derived`, `recents`, `pinnedList`, `highlightName` | 94-100, 1070-1109 | **Deleted**, replaced by 2a's `lib/project-signal.ts` plus a new session-list derivation. |

### Elsewhere, touched by this phase

| Element | Where | Fate |
| --- | --- | --- |
| `sessions/[id]/page.tsx`'s two-child flex row | `:149-152` | **Kept**, one child lighter — and now the right shape for phase 3's third column. |
| `listChats(name)` filtered to non-`steerer`/non-`escalation` | `page.tsx:133` | **Relocated** to the client fetch. `/api/chats` already applies the same filter server-side (`app/api/chats/route.ts:16-25`), so this is a deletion, not a reimplementation. |
| `costUsd` on the sidebar's chat shape | — | **New.** `app-sidebar.tsx`'s local `ChatMeta` has no `costUsd`; the rail's `RailSession` does. `/api/chats` must return it, or the cost column dies. Verify before committing to the column. |
| Project detail route, git tab, gates, settings | `app/projects/[name]/page.tsx` (1,282 lines) | **Untouched in 2b.** Phase 3 re-homes git; phase 5 dissolves the route. §4 says what the scope menu reaches in the meantime. |



## 3. What is lost

Collapsing a region does not preserve its affordances; it deletes some of them and asks you to
notice later. Here is the list, with an honest verdict on each. Several of these are the reason
§7 exists.

**1. Collapsing the sidebar now costs you session switching.** Today the app sidebar and the
sessions rail are independent: collapse the sidebar to its icon strip and the rail is still there,
full width, listing every session in the project. After 2b there is one region, and collapsing it
takes the session list with it. This is the single largest regression in the phase and it is
structural, not cosmetic. Mitigations: the trigger stays visible outside the sidebar at all times
(§6), a keyboard toggle, and — the real answer — the sidebar becomes wide enough and calm enough
that you stop wanting to collapse it. t3code lives with exactly this and pins its trigger outside
the sidebar for exactly this reason (`AppSidebarLayout.tsx:92-116`). **Not replaced. Accepted
cost.**

**2. Server-rendered freshness on the session list.** `SessionsRail` renders from `listChats(name)`
inside the route's server component (`sessions/[id]/page.tsx:133`), so navigating to a session
always paints a correct, complete list with zero client work. The merged list is a client fetch on
`app-sidebar.tsx`'s existing 10-second `loadAll` loop. Consequence: **a session you just created
can be absent from the sidebar for up to ten seconds**, where today it appears the moment the route
renders. Partially replaced — `SessionView` already dispatches into the app's `telar:refresh`
convention and the sidebar already listens (`app-sidebar.tsx:1043-1051`), so the fix is to dispatch
on the `saved` event. That must land in the same commit as the list, not after; the convergence
plan's standing rule about `telar:refresh` and `git-tab` is the same rule.

**3. Project pins.** Gone entirely. There is no pin, no favourite, no star anywhere in the new
sidebar, because position is derived from creation order and a pin is by definition a manual
override of position. The nearest thing left is the scope menu — "the project I am working in
today" — but scope is session-local and not persisted, so it is not a replacement for "these three
projects matter to me permanently." t3code has no pin either
(`SidebarV2.tsx`, no `pin` anywhere) and appears not to miss it, but t3code's users have far fewer
projects than a Telar user with a registry of client repos might. **Genuinely gone. Open question
6.**

**4. The at-a-glance project roster.** Today the sidebar answers "which projects am I in the middle
of" without a click: Pinned, then six Recents, ordered active-first. After 2b that question is
answered by opening a dropdown, or by going to `/projects`. This is the deliberate trade the
decision buys — fewer regions means fewer things visible at once — but it should be named as a
loss rather than reframed as focus. **Moved, to the scope menu and the `/projects` index.**

**5. Per-project session disclosure without navigation.** `ProjectRow`'s expander let you peek at
another project's sessions from wherever you were, then collapse it again. Scope replaces the
capability but not the gesture: scoping is modal (it changes what the whole list means) where
expanding was additive. **Replaced, imperfectly.**

**6. The collapsed icon rail's project glyphs.** `RailProject` (798-810) put a clickable coloured
glyph per project into the 48px collapsed strip, with a pulse for active. After 2b, collapsed means
offcanvas — nothing. **Gone**, as a direct consequence of loss 1 and §6's collapse decision.

**7. The per-project pulsing activity dot.** Gone from the sidebar. Its successor is the Needs-you
band (for work owed to a human) plus the nav badge (for work in flight). Worth recording: 2a
already established that this dot was *wrong* — it pulses for `charter-review`, `ready` and
`blocked`, three states in which nothing is running and a human is the blocker (convergence
research, D-3), and it goes dark for `needs-review` and `failed`, the two states that most need
attention (D-2). So this is a loss of a signal that was misinforming. **Replaced, and corrected.**

**8. In-flight looms are no longer visible per project.** The Needs-you band deliberately holds only
`awaitingDecision` and `awaitingAccept`. A project with four looms mid-run shows nothing in the list
and contributes to a single aggregate badge. That is the t3code instinct — "working threads aren't
your problem yet" (`SidebarV2.tsx:472-481`) — and I think it is right, but it means the sidebar
stops being a place you can watch a weave progress. `/looms` is that place. **Moved.**

**9. Sessions stop jumping to the top when you touch them.** If open question 3 resolves toward
creation order, then replying to an old session no longer moves it. This is the change that makes
the list calm, and it is also a genuine loss of the "where was I" affordance that recency ordering
gives. Reversible in one comparator; that is why it is a question and not a decision.

**10. `fmtShort` → `fmtAgo`: strings change.** `"3m"` becomes `"3m ago"` in every place the sidebar
showed a session time. Trivial, listed because it is the kind of thing that gets called a
regression if it is not written down first.

**11. The "today" narrowing on nested sessions disappears.** Today the sidebar shows only sessions
touched today; the new list shows all of them, paged. Strictly more information, but the sidebar
gets longer, and the settled shelf is now the only thing standing between a user with 400 sessions
and a 400-row list. If open question 4 resolves against auto-settle, this loss becomes a scrolling
problem and needs a second answer.

**12. The back-link from a session to its project.** `SessionsRail`'s `← telar` was one click to
`/projects/{name}`. Its successor is the scope menu's ellipsis → project dialog, which is two
interactions and reaches a dialog rather than the route. **Moved, and slightly worse, until phase 5
makes the dialog the real destination.**

**13. A freshly-minted session still has no row.** True today (the rail's own comment,
`sessions/[id]/page.tsx:125-131`) and still true after: a session whose first turn has not persisted
is not in `listChats` and so not in the list. Unchanged, but loss 2 makes the window longer. Worth
one line of empty-state honesty rather than a fix in this phase.

**Not lost, despite looking like it should be:** account wheels and their drag-reorder, the plan
usage tooltip, the ledger line, the refresh button, archive, cost per session, the Looms badge,
mobile access (which improves).



## 4. The project-richness problem

A t3code project is a workspace root, a display name, a favicon and a grouping rule — four fields,
all of them presentational (`SidebarV2.tsx:3025-3208`). A Telar project is a **contract with the
engine**: `account`, `baseBranch`, `charterPolicy`, `gates[]`, `guardrails.disallowedTools`,
`guardrails.protectedPaths`, `urls.{dev,preview,prod}`, `designRules`, `devCommand`,
`verifyCommand`, `templateDb`, `mcpServers` (`packages/core/src/schemas.ts:290-345`), plus a live
git subsystem of 5,315 lines. Copying t3code's sidebar and stopping there would silently discard
the thing that makes Telar worth using. It must not.

The resolution is a distinction the current UI does not draw: **a declaration is not an
observation.**

- A **declaration** is a fact the human states about the project and then leaves alone —
  `charterPolicy`, `gates`, `guardrails`, `baseBranch`, `devCommand`, `verifyCommand`, `designRules`,
  `templateDb`, `mcpServers`, `account`. Read rarely, edited rarely, consequential when edited.
- An **observation** is project state that changes under you — branch, ahead/behind, dirty files,
  diff, PR status, running dev server. Watched continuously while you work.

Three homes follow, and each is the right home for a reason that is not "it fits there."

**The scope menu holds identity, and nothing else.** Glyph, name, and a per-row ellipsis. No
counts, no status dots, no branch. This is t3code's stated reason at `SidebarV2.tsx:1371-1373` —
the header's width must not depend on the number or length of project names — and it applies with
more force here, because Telar project names are directory names. A scope menu that showed gate
counts would be a project index with extra steps, and we already have one at `/projects`.

**Declarations live in a project dialog, opened from that ellipsis.** A dialog is right precisely
because it is modal and infrequent: these fields are edited when a project is set up or when its
verification story changes, not while working. It is also the only shape that survives phase 5,
where "project detail becomes a dialog off the scope menu, not a 1,282-line route" is already the
plan. So 2b does not build the dialog — **in 2b the ellipsis links to `/projects/{name}`, which
still exists** — but it puts the affordance in its final place so phase 5 is a body swap rather
than a re-navigation. Three fields the convergence plan flagged as reaching no UI at all today
(`devCommand` — the PATCH route accepts it and nothing sends it — plus `verifyCommand` and
`designRules`) get their first surface there, in phase 5.

**Observations live in the right panel, phase 3.** Git is the whole argument: `git-tab.tsx` (286) +
`lib/server/git-tab.ts` (1,569) + 3,746 lines of sub-views. It is watched while you work, it is
per-session as often as per-project (a loom's worktree is not the project's checkout), and it is
too large to render in a 256px column without becoming a worse version of itself. The standing rule
applies — surfaces are hosted, never forked — so git moves once, into the panel, and the project
route loses the tab rather than gaining a rival.

Two things must not be filed away under any of the three:

**`charterPolicy` is moat-relevant and needs a second surface.** It decides whether a drafted
charter pauses for a human (`schemas.ts:290-300`). Its *declaration* belongs in the dialog, but its
*effect* must be legible at the moment it acts — on the charter-review card in `/looms`, which is
where the human accepts. Burying "why did this pause / why did this not pause" behind a settings
dialog would make the moat harder to reason about, and the moat is not negotiable.

**`guardrails` is display-only in 2b and in the dialog.** `disallowedTools` and `protectedPaths`
feed permission wiring. Nothing in this phase — no dialog field, no scope menu, no list row —
touches permission wiring, hook registration, `restrictTools`/`disallowedTools`/`settingSources`,
or the loom ready-to-done gate. If the dialog eventually edits these, that is its own change with
its own invariant, and the invariant is rewritten before the mechanism moves.

The honest summary: the new sidebar is *poorer* about projects than the old one, on purpose, and
the richness does not disappear — it relocates to two surfaces that can actually hold it. The
failure mode to watch for is a phase-3 or phase-5 slip that leaves the richness homeless in the
interim. That is why the ellipsis points at the existing route from day one.



## 5. Migration order

Nine commits. The ordering rule is stricter than "each one leaves the app working": **no commit may
leave the sidebar half-collapsed** — no state in which an affordance has been removed and its
successor has not landed. Where that forces a choice, the series prefers a brief *duplication*
(commits 5-6) over a brief *absence*, because a duplicated list is ugly for one commit and a missing
New-session button is a broken app.

Prerequisite: **phase 2a is merged.** `lib/project-signal.ts` exists, its `legacyActive`
escape hatch exists, the pin/reorder/recents helpers are pure and tested, and `useStoredList` has
moved onto the `useSyncExternalStore` idiom. 2b deletes `legacyActive` in commit 7; that
deletion is the intended visual delta 2a deferred.

2a deferred a second, much smaller one to the same commit: `app-sidebar.tsx` keeps a local
`isToday` and re-filters `ProjectSignal.chatsToday` through it, because the sidebar's boundary was a
same-calendar-day compare and the module's is `>= local midnight`. They differ only for a session
dated in the future — clock skew, or a restored file. Deleting the filter is one line and lets the
sidebar agree with the Projects index; note that it also un-disables the row's disclosure chevron
for a project whose only nested item is such a session.

**1. `feat(2b): the session list, as a pure module.`** `apps/web/lib/session-list.ts` +
`session-list.test.ts`: banding (`needsYou` / `sessions` / `settled`), the comparator, scope
filtering, and title search, all taking an injectable `now`. Precedent is `lib/plan-window.ts` and
t3code's `Sidebar.logic.ts:479-550`, which is pure and has a 46k test file for exactly these rules.
Nothing imports it. Zero pixels.

**2. `feat(2b): sessions announce themselves.`** `SessionView` dispatches `telar:refresh` on its
`saved` event; the sidebar already listens (`app-sidebar.tsx:1043-1051`). This lands *before* the
list that depends on it, so the freshness gap in §3 loss 2 never opens. Effectively zero pixels
today; load-bearing from commit 5.

**3. `feat(2b): cost on the chat summary.`** `/api/chats` returns `costUsd`; the sidebar's local
`ChatMeta` widens to match `RailSession`. Additive, nothing renders it yet. If it turns out
`costUsd` is not on the summary the store already builds, this is where that is discovered — before
a column depends on it.

**4. `feat(2b): the sidebar's geometry.`** `collapsible="icon"` → `"offcanvas"`; `resizable` with
`storageKey`, `SIDEBAR_RESIZE_MIN_WIDTH`, and `keepsRoomForMain` as `shouldAcceptWidth`; the
always-visible external `SidebarTrigger` (§6). Deletes the collapsed-rail branch and everything
that only existed to render into it — `RailProject`, `ProjectGlyph`, `RailWheels`. The expanded
sidebar is pixel-identical; the collapsed one becomes "gone" instead of "icons". Self-contained, and
first because every later commit would otherwise have to keep a collapsed strip alive for a body it
is about to delete.

**5. `feat(2b): sessions replace projects in the list.`** Pinned and Recent groups out; the flat
session list in, unscoped, no search, no bands. Deletes `ProjectRow`, `togglePin`, `PINNED_KEY`,
`isToday`, `fmtShort`, `SidebarProject`, `derived`/`recents`/`pinnedList`/`highlightName`.
`SessionsRail` is **still mounted** — for this one commit the app shows two session lists, and that
is the deliberate choice above. Biggest single visual change in the phase.

**6. `feat(2b): one region.`** The header block — search field, New-session button, scope menu, New-
project button — and, in the same commit, the deletion of `sessions-rail.tsx` and its child in
`sessions/[id]/page.tsx:150`. Same commit because this is where the rail's two unique affordances
(New session, back-to-project) acquire successors. The scope menu's ellipsis links to
`/projects/{name}`; the dialog is phase 5. Search is present but its behaviour is commit 7's — ship
it disabled or ship it as a plain substring filter and refine; do not ship a field that does
nothing.

**7. `feat(2b): the Needs-you band.`** Looms awaiting a human, above the sessions, header linking to
`/looms`. Deletes `legacyActive` (the `ProjectSignal` field) and `isLoomLegacyActive` (the predicate
behind it) from `lib/project-signal.ts` — both symbols, and the test that pins the second as the
exact complement of `looms/utils`' `isTerminal` — and repoints the nav badge at
`counts.inFlight`. This is the commit where the pulse stops lying (§3 loss 7) and where the badge
starts agreeing with the page it links to.

**8. `feat(2b): shelves and empties.`** The settled shelf with its count and "Show more" paging,
plus the three empty states, plus the search listbox with `aria-activedescendant`, arrow-key
wrapping, `Escape` to clear, and the IME guard (`SidebarV2.tsx:1834-1871` — copy the guard, it is
not optional). Content-visibility containment per row rather than virtualisation
(`SidebarV2.tsx:903`).

**9. `chore(2b): the sweep.`** Dead exports, the `ChatMeta`/`RailSession` type merge, a stale-key
note for `telar:pinned-projects` (orphaned by commit 5; `app/projects/page.tsx`'s rival
`telar:pinnedProjects` is untouched and still works), invariant updates, and this document marked
built.

Two ordering constraints worth stating so they are not rediscovered mid-series: commit 4 must
precede 5 (the collapsed branch reads the project derivations that 5 deletes), and commit 2 must
precede 5 (or the ten-second window in §3 loss 2 ships as a regression and gets reported as one).



## 6. The SidebarRail inheritance

Phase 1 shipped the resizable primitive with zero mount sites and said so in its own comment
(`components/ui/sidebar.tsx:316-318`: "When Phase 2 mounts a real rail…"). `AppSidebar` today
renders `<Sidebar collapsible="icon">` with no `<SidebarRail />`, no `resizable`, no `storageKey`.
2b is the first mount, and it inherits a documented behaviour split:

```
canResize = resizable !== null && open            (sidebar.tsx:519)
```

- **Expanded + resizable → the rail is a resize handle and nothing else.** Its click handler
  `preventDefault`s and returns rather than toggling, because "a click that collapsed it would be
  indistinguishable from a drag that went nowhere" (`sidebar.tsx:706-711`). `aria-label` reads
  `"Resize Sidebar"`, the title reads `"Drag to resize sidebar"`, and `touch-none` is applied so a
  touchscreen laptop's pan gesture does not steal the drag.
- **Collapsed → the rail is a toggle again.** `canResize` is false, the click calls
  `toggleSidebar()`, and under `collapsible="offcanvas"` the rail parks 2px off the screen edge
  with a hover fill (`sidebar.tsx:737-739`).

So, concretely, for the merged sidebar:

**Collapse mode: `offcanvas`.** Not `icon`. Once the body is a session list rather than a project
roster, there is nothing meaningful to render in a 48px strip — §2 deletes `RailProject`,
`ProjectGlyph` and `RailWheels` for exactly this reason, and t3code reached the same conclusion
(`AppSidebarLayout.tsx:189`, `collapsible="offcanvas"`). Collapsed means gone.

**Collapsing is `SidebarTrigger`, and the trigger is always visible.** Today the trigger lives
inside the sidebar header (`app-sidebar.tsx:963`), which is fine while collapse leaves an icon
strip behind and fatal once collapse means offcanvas — the button would vanish with the thing it
toggles. It moves **outside** the sidebar, pinned to the top-left of the shell, exactly as t3code
pins it (`AppSidebarLayout.tsx:92-116`, `aria-label="Toggle main sidebar"`). It is present in both
states and is the only affordance that collapses.

**Expanding is either the trigger or the rail.** The rail's collapsed-state toggle is kept — the
edge strip with the hover fill is a pleasant way back — but it is a bonus, never the only route.
`SidebarRail` is `tabIndex={-1}` and `hidden sm:flex` (`sidebar.tsx:718`, `:731`), so it is
unreachable by keyboard and absent below `sm`. Any design that made it the sole expand affordance
would be inaccessible on both axes.

**Resize is the rail, expanded, with real bounds.** `storageKey` on the existing
`lib/sidebar-width.ts` store — which persists collapse *and* width under one key and is already
tested. `minWidth: SIDEBAR_RESIZE_MIN_WIDTH` (256, `sidebar-width.ts:37`, chosen so opting into
resize never moves the sidebar on its own). `shouldAcceptWidth: keepsRoomForMain` with a
main-content floor; note `sidebar-width.ts:90-96` says outright that its tests pin two clauses
rather than any real behaviour, and that the first consumer should change the rule and its tests
together if it wants different semantics. **2b is that consumer and owes that judgement**, not a
green suite inherited from a function nobody had used. The floor to pick is whatever keeps the
chat column usable once phase 3 adds a third column beside it — t3code uses 640px
(`threadSidebarWidth.ts:4`) and that is a defensible starting number.

**A keyboard shortcut.** shadcn's provider ships `Cmd/Ctrl+B` already; t3code additionally binds it
on the capture phase so a focused rich-text editor cannot swallow it (`AppSidebarLayout.tsx:88`).
Telar's composer is a text area in the chat column, i.e. the same hazard. Worth copying.

**Mobile is unchanged and improves.** `isMobile` forces the sheet and disables resize
(`sidebar.tsx:267`). The session list becomes reachable below `md` for the first time, since
`SessionsRail` was `hidden … md:flex`.



## 7. Open questions for the owner

Answers 1-6 change the layout in §1, not just its details. Nothing should be built against this
document until they land.

1. **Should looms appear in the sidebar list at all?** §1 proposes a "Needs you" band holding only
   looms awaiting a human, with in-flight looms represented solely by the nav badge. The alternative
   is a sidebar that is purely sessions and sends you to `/looms` for everything. — *band / none*
2. **Keep the Dashboard nav row?** The convergence plan already asks whether `app/page.tsx` (628
   lines, four uncoordinated fetches) survives at all. If it is going, the row goes with it and the
   nav shrinks to two. — *keep / delete*
3. **Order sessions by creation, or by last activity?** Creation order is t3code's calm
   (`Sidebar.logic.ts:479-491`: nothing moves except at lifecycle transitions). Last-activity is
   what Telar does today (`lib/store.ts:228`) and what most people expect. This is one comparator
   and the single biggest determinant of how the sidebar *feels*. — *creation / activity*
4. **Auto-settle sessions after N quiet days?** t3code defaults to 3 and it is what stops the active
   band growing forever. Without it, the settled shelf holds only explicitly archived sessions and a
   heavy user gets a long list. — *yes / no* (if yes: how many days)
5. **Does the Looms badge respect the project scope?** Scoped to `telar`, does the badge count that
   project's looms or all of them? A scoped badge is consistent with the list; a global badge is a
   better alarm. — *scoped / global*
6. **Do you want project pins back in some form?** §3 loss 3 says they are gone entirely. If your
   registry has twenty client repos, the scope dropdown becomes the only way to reach the three you
   actually use, and it is unordered. — *gone / keep-somewhere*
7. **Do loom-born sessions (`role: "steerer"`/`"escalation"`) belong in the list?** They are excluded
   today, both by `/api/chats` and by the rail. Keeping them excluded is the safe default; including
   them would make the sidebar a complete index of every conversation. — *exclude / include*
8. **Keep the per-session cost column?** It is Telar richness with no t3code counterpart, it costs a
   `costUsd` field on `/api/chats`, and it puts a second line on every row. — *keep / drop*
9. **Should the project scope persist across reloads?** t3code deliberately does not
   (`SidebarV2.tsx:1373`). A remembered scope is a filter you forget you set. — *session / persist*
10. **New session while unscoped, with many projects: picker, or last-used project?** t3code opens a
    project picker. Defaulting to the last-used project is fewer clicks and occasionally wrong in an
    expensive way. — *picker / last-used*
11. **Is a two-column shell acceptable between phase 2b and phase 3?** 2b deletes a region and phase
    3 (5-6 weeks, git is 5,315 lines of it) adds the one that justifies it. In between, the app is
    `sidebar | chat` and the project's git surface is still a tab on a route we intend to dissolve.
    — *ship / wait*
12. **Does the demo-gallery harvest block this phase?** It was left explicitly undecided in the
    convergence plan. `app-sidebar.tsx` is not itself a gallery-specced surface, but the session row
    and the empty states are exactly the kind of thing the gallery has opinions about, and 12+
    production files cite it in header comments. — *blocks / accepted loss*
