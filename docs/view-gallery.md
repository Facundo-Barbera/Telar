# View gallery (`/gallery`) — dev-only design-review surface

A dev-only surface that renders **every view, state and composite component of
Telar** using the **real production components** fed with **fake fixture data**.
Its purpose is design review: click through the whole catalog to decide what to
improve or mock up next. It is built to be deleted — see [Deletion](#deletion).

## Sections

The catalog has three sections, shown in this order in the nav, the index and the
linear prev/next pager:

1. **Loom views** — every view and state of a loom (the loom cockpit). Grouped by
   lifecycle (Journey → Scoping → … → Chat).
2. **App views** — every remaining Telar page beyond the cockpit: the dashboard,
   the projects index / project detail / project settings, the looms index, the
   plain / empty / planner session surfaces, and the global settings (accounts +
   plan usage), each with its empty / error / missing / manifest-error variants.
3. **Components** — the interesting composite components rendered in isolation with
   labeled variant grids (operator/thread cards, verify/gate/critic pieces, the
   plan graph, permission card, blocked/discuss surfaces, page-header/empty-state,
   and a compact `ui/` primitives sheet).

### Navigation

- A **sticky sidebar** with collapsible grouped sections, an active-entry
  highlight and per-group coverage counts.
- An instant client-side **filter box** (matches entry id / title / description).
- **Keyboard nav**: `←`/`→` (and `j`/`k`) move to the prev/next entry — never
  while focus is in an input/textarea/select.
- **⌘K / Ctrl+K command palette** (reuses the app's existing `cmdk` dependency) to
  fuzzy-jump to any entry.
- Each entry page has a compact header: section breadcrumb, title, position
  (`n of N`), and a **copy-view-id** button (ids are how entries are referenced in
  `docs/design-pass.md` during a walkthrough).

## What it is (and isn't)

- Every entry renders the **same component modules production uses** (imported
  directly — `LoomGodView`, `CharterReview`, `EnvReview`, `DiscussEscalation`,
  `ScopingCharter`/`WorkstreamsPreview`/`ScopingFeed`, `AgentViewDrawer`,
  `SpecDrawer`, `LoomCard`, `SessionView`) plus the identical pure derivations
  (`deriveGodView`, `deriveThreadOperator`). **No component is copied or forked.**
- The gallery stage (`apps/web/app/gallery/gallery-stage.tsx`) is a faithful
  mirror of ~40 render lines of `apps/web/app/looms/[id]/page.tsx` (the state
  routing + the `deriveGodView` call). The only thing it replaces is the page's
  data plumbing (fetch / EventSource / polling) — which is exactly the part a
  fixture-driven gallery must replace.
- Components that fetch their own data (spec / evidence / chat, and the loom /
  threads GETs) are served from fixtures by a **client-side `window.fetch`
  interceptor** (`gallery-fetch-interceptor.tsx`). It matches **only** fixture
  loom-ids (prefix `gallery__`, which real ids `loom_<base36>_<rand>` can never
  collide with) plus `/api/chat`; every other URL delegates to the real fetch,
  and it uninstalls on unmount. **No component edits, no server routes.**

### The active-scene seam (App views + fetch-driven components)

The loom interceptor above keys on a loom id embedded in the URL. But the full
app pages render their **real default-export page component** (`DashboardPage`,
`ProjectsPage`, `ProjectDetailPage`, `ProjectSettings`, `LoomsPage`), and those
self-fetch **collection** endpoints with **no id** — `/api/looms`, `/api/projects`,
`/api/chats`, `/api/usage`, `/api/accounts`, `/api/mcp/oauth/status`,
`/api/permissions/[p]`, `/api/projects/[n]/mcp`, `POST /api/browse`. A URL-keyed
resolver can't answer those.

The additive fix (lane F's `scene.ts`): each app / fetch-driven-component entry
carries a **`GalleryScene`** describing the responses for those endpoints (a
per-endpoint `status` override drives the empty-vs-error variants). The stage
(`app-view-stage.tsx` / `session-stage.tsx` / `settings-stage.tsx` /
`component-stage.tsx`) publishes the scene into a module-level ref via
**`setActiveScene(entry.scene)` synchronously at the top of render** (and clears it
on unmount). The interceptor, after the frozen `resolveGalleryFetch` returns
`passthrough`, consults **`resolveGalleryAppFetch(input, getActiveScene())`**.

**Ordering matters**: React renders a parent before its children, and the
interceptor is the layout's first child, so the scene ref is already set before
any child page's fetch-on-mount effect fires. The active-scene ref is the **only**
new mutable state; `resolveGalleryFetch` stays frozen and untouched.

The **session-family** routes (plain / empty / planner) are server components whose
UI is 100% real client components. They get a **mirrored-wiring stage**
(`session-stage.tsx`) that feeds fixture props into the real `SessionsRail` +
`SessionView` — each stage's header comment cites the exact `page:lines` it mirrors.

## How to run

```sh
bun run dev          # from apps/web (or the repo's usual dev command)
```

Then visit **`http://localhost:3000/gallery`** — access is **typed-URL only**.
Nothing in the normal app links to `/gallery` (requirement 3). The index is a
grouped catalog in lifecycle order; each entry has a prev/next pager to walk the
whole catalog linearly. A persistent **`DEV GALLERY — FAKE DATA`** banner shows
on every gallery page.

## Fixture test

Every fixture parses through the **real `@telar/core` zod schemas** (a test
proves it, so fixtures can never drift from the real types):

```sh
NODE_OPTIONS= bun test apps/web/lib/gallery-fixtures
```

## Deletion

The gallery is fully isolated. To remove it entirely:

```sh
rm -rf apps/web/app/gallery
rm -rf apps/web/lib/gallery-fixtures
rm -f  docs/view-gallery.md
```

Then revert the **two GALLERY-SEAM edits** (search `GALLERY-SEAM` — 7 `export`
keywords across the two files in the table below):

```sh
grep -rn "GALLERY-SEAM" apps/web/components/session/session-view.tsx \
                        apps/web/components/looms/god-view.tsx
# remove the `export` keyword (and the seam comment) at each hit
```

### GALLERY-SEAM edits to existing files

The App-views + Components sections need **two export-only edits** to existing
files. Both are `export`-prefix-only — **zero logic / JSX change**, fully
reversible — and each is marked with a `// GALLERY-SEAM (delete with /gallery)`
comment. They exist because the product owner explicitly named module-private
composites (and permission-card states that are otherwise **live-stream-only** and
unreachable via props):

| File | Edit | Revert |
| --- | --- | --- |
| `apps/web/components/session/session-view.tsx` | `export` on `PermissionCard` + `export type PermissionPart` (the permission `Part` shape) | drop the two `export` keywords |
| `apps/web/components/looms/god-view.tsx` | `export` on `GateRunRow`, `CriticFindingRow`, `CriticVerdictRow`, `PlanGraph`, `OperatorCard` | drop the five `export` keywords |

No production code path imports from the gallery directories, and no production UI
links to `/gallery`.

## File map

| Path | Role |
| --- | --- |
| `apps/web/app/gallery/layout.tsx` | Banner + interceptor mount + nav shell |
| `apps/web/app/gallery/gallery-fetch-interceptor.tsx` | `window.fetch` wrapper (loom-keyed + active-scene resolvers) |
| `apps/web/app/gallery/gallery-nav.tsx` | Sticky sidebar (sections + filter + ⌘K palette) |
| `apps/web/app/gallery/gallery-groups.ts` | Pure catalog composition (sections + `orderedCatalog`) |
| `apps/web/app/gallery/gallery-entry-header.tsx` | Entry header (breadcrumb, position, copy-id, pager, keyboard nav) |
| `apps/web/app/gallery/page.tsx` | Grouped catalog index (three sections + coverage counts) |
| `apps/web/app/gallery/[id]/page.tsx` | Entry route — resolves id → the right stage + pager |
| `apps/web/app/gallery/gallery-stage.tsx` | Loom-cockpit stage — mirror of `looms/[id]/page.tsx` |
| `apps/web/app/gallery/app-view-stage.tsx` | Full-page stage — renders the real `DashboardPage`/`ProjectsPage`/… with an active scene |
| `apps/web/app/gallery/session-stage.tsx` | Mirrored-wiring stage for plain / empty / planner sessions |
| `apps/web/app/gallery/settings-stage.tsx` | Mirrored-wiring stage for global settings (accounts) |
| `apps/web/app/gallery/component-stage.tsx` | Component showcase — real composites in labeled variant grids |
| `apps/web/app/gallery/gallery-catalog.test.ts` | Lane G catalog-wiring test |
| `apps/web/lib/gallery-fixtures/**` | Fixtures + `resolveGalleryFetch` + `scene.ts` + `showcase.ts` + validation test (Lane F) |

## Known limitation

`SessionView` (the planner/discuss session shell and the loom Chat tab's live
streaming) is a chat **runtime**, out of fixture scope. The Chat tab renders
seeded history statically; the planner/discuss shells render the real component
with a benign-stubbed `/api/chat`. This is the real component with no live
backend — **not a fork**.
