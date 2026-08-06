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

## The focus rule (issue #16), and why it is uniform rather than composer-only

Every binding in the table NAVIGATES: `new-session` and `new-tab` replace or
open a fresh composer, `jump-N` and `settings` both leave the current view.
None of them insert a character — `CommandOrControl+letter` is not a
text-editing chord anywhere in this app — so intercepting one never "steals a
keystroke" in the literal sense of eating text the user meant to type.

What it CAN steal is the VIEW itself. The composer's draft is plain component
state (`session-view.tsx`'s `input`) — unlike a QUEUED message (issue #5's
localStorage fix, `lib/message-queue.ts`), an unsent draft is never
persisted, so navigating away mid-sentence would silently delete whatever was
half-typed. That is a worse outcome than the shortcut simply not firing, so
the rule is: every binding is suppressed while focus is anywhere editable —
the composer, but also a session-rename field, the sidebar's search box, a
settings input. Nothing here special-cases the composer alone: losing a
half-edited session title or search query to a slipped `cmd+N` is the same
class of surprise as losing a half-typed message, so both are guarded the
same way, uniformly, rather than by a growing list of "except when focus is
in THIS particular field".

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
