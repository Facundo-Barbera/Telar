# The web port of the command-key table (issue #16)

`apps/web/lib/command-keys.ts` is the web half of Telar's application command
keys. This document holds the reasoning behind its shape; the source file
holds only the point-of-use notes a reader needs while editing it.

## Why the binding table lives in `apps/desktop`, and web imports it by relative path

The binding TABLE itself is defined exactly once, in
`apps/desktop/command-keys.js` — a plain, dependency-free CommonJS module so
Electron's main process (real Node, no TypeScript, no bundler) can `require`
it directly to build the app menu's native accelerators.
`apps/web/lib/command-keys.ts` is the only place that reaches across the app
boundary to import it; everywhere else in `apps/web` that wants a binding
imports *this* file, never the desktop one directly, so there is exactly one
seam to keep an eye on if the two apps' layout ever moves.

**Why a relative import into `apps/desktop` instead of a `packages/*`
workspace package** (the pattern `@telar/core` uses)? Electron's packaged
build ships `main.js` via an explicit `files` whitelist in
`apps/desktop/package.json`, not ordinary `node_modules` resolution — a new
workspace dependency would need `bun install` to relink it AND
electron-builder to prove it survives packaging, and this repo's hard rule
against launching Electron in most task contexts makes the second half of
that difficult to verify. A same-directory file that already ships by the
mechanism every other desktop source file uses (`browser-manager.js`,
`preload.js`, …) has no such unknown. See `apps/desktop/command-keys.d.ts`
for why this still typechecks cleanly.

## `EditableTargetLike` is typed `unknown`, not an all-optional object

The type is loose and duck-typed ("is this an editable surface") deliberately
NOT `Element`, so the exact same function runs against a real DOM node in the
browser and against a plain object in a test (this repository has no DOM
test harness — see `components/conversation/items.test.ts`).

It is typed `unknown` rather than an all-optional object because
TypeScript's "weak type" check rejects assigning a real `EventTarget` (which
declares neither `tagName` nor `isContentEditable`) to an object type whose
properties are all optional, and `event.target` is exactly an `EventTarget`.
So the looseness has to be at the boundary (this type), not inside the
function, which still reads both properties safely regardless of what it is
handed.

## The focus rule, as revised by issue #46 (born uniform in #16)

The rule today: a binding is suppressed while focus is anywhere editable
ONLY when its chord carries no command/control modifier. Since every binding
in the table is a `CommandOrControl` chord, the guard currently suppresses
nothing — it exists for the first future bare-key binding, where a naked
`n` over a focused field must keep typing an `n`.

The rule as issue #16 shipped it was unconditional — every binding
suppressed from every editable target — and that turned out to be the whole
bug of issue #46: in Telar the composer is a TEXTAREA and holds focus nearly
all the time, so there was no state in which most bindings could fire. The
owner tested them in the running app and none worked, while the tests
passed, because they asserted the suppression itself rather than the
user-visible behavior. A modifier chord is exactly the mechanism by which a
shortcut stays reachable while typing — `⌘N`, `⌘T`, `⌘,` all work inside a
text field in every macOS application.

The original rationale was draft protection: every binding NAVIGATES, and an
unsent draft was plain component state, so a slipped chord could silently
delete a half-typed message. Two things ended that argument. Drafts now
persist (`telar:draft:*` in localStorage, keyed per session, restored on
return), so navigation no longer destroys anything. And the cost had the
wrong sign anyway — a shortcut that never fires is a permanent defect, while
a slipped chord was always recoverable by navigating back.

The rule is enforced in exactly ONE place, `resolveWebCommandKeyAction`.
It used to be applied twice — there and again in `use-command-keys.ts`'s
menu-invoke handler — and two copies is how one gets fixed and the other
does not (that second copy is precisely what kept the Electron menu path
dead). The menu path needs no copy at all: every accelerator is a chord,
and chords are exempt. `command-keys-wiring.test.ts` pins the absence.

## Why `open-tab` degrades to in-place navigation on desktop

`CommandKeyDestination`'s `open-tab` kind means, on web, a real separate
browser tab (`window.open`) — the current tab and its in-flight turn are left
exactly alone. Desktop has no tab strip and today only ever manages ONE
`BrowserWindow` (`main.js`'s `browserManager` is a module-level singleton
bound to it) — spawning a second top-level window is real, unbuilt
multi-window support, out of this issue's scope, and could not be verified
without launching Electron. So on desktop this degrades, on purpose, to the
same in-place navigation as `new-session` rather than silently doing nothing
or risking the singleton.

## The hold-⌘ hints (discoverability)

Hold the CommandOrControl modifier alone for `HINT_HOLD_MS` and the sidebar
elements a binding reaches label themselves: `⌘1..9` on the recent
conversations, `⌘N` on New Session, `⌘,` on Settings. Release, press any
other key (a chord means you found what you wanted), or leave the window
(`⌘Tab`'s keyup lands in another app) and they vanish.

The gesture is a pure three-state machine in `lib/command-key-hints.ts` —
tested directly, since this repo has no DOM harness — and the DOM hook
(`lib/use-command-key-hints.ts`) is a thin translator pinned structurally
by `command-keys-wiring.test.ts`. The jump numbers are keyed by session ID,
not row position: `⌘1..9` index the GLOBAL recent band while the sidebar
may be rendering a scoped, filtered, or searched list in another order, so
a row wears its true global number or nothing. `⌘T` gets no hint — it
targets the same `/` as `⌘N`, as a new browser tab, and has no distinct
element to label. `⌘K` needs none: the search field already wears a
permanent one.

## What each binding id means, and how that was decided

Decided from how routing and session creation actually work, not assumed:

- `"new-session"` is exactly the sidebar's own global New Session control
  (`TelarSidebarHeader` / the composer-icon button), which both link to `"/"`
  rather than a project-scoped `sessions/new` — `"/"` is `app/page.tsx`'s own
  front door, and it already resolves to the most-recently-active project's
  fresh composer server-side. `Cmd+N` mirrors that exact destination rather
  than introducing a second, project-scoped meaning of "new".
- `"new-tab"` is the same destination, opened without disturbing where you
  already are — see the `open-tab` degradation above for what that means on
  each platform.
- `"settings"` is the sidebar footer's own Settings link (`"/settings"`).
- `"jump-N"` is `recentSessionsForCommandKeys`'s Nth entry (`session-list.ts`)
  — the sidebar's own unfiltered "Recent" band, in the exact order it is
  rendered in.
