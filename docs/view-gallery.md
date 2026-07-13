# View gallery (`/gallery`) — dev-only design-review surface

A dev-only surface that renders **every view and state of a loom** using the
**real production components** fed with **fake fixture data**. Its purpose is
design review: click through the whole catalog to decide what to improve or mock
up next. It is built to be deleted — see [Deletion](#deletion).

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

### GALLERY-SEAM edits to existing files

**There are ZERO `// GALLERY-SEAM` edits to existing files.** The gallery adds
only new files under the two directories above — nothing else to revert. No
production code path imports from the gallery directories, and no production UI
links to `/gallery`.

## File map

| Path | Role |
| --- | --- |
| `apps/web/app/gallery/layout.tsx` | Banner + interceptor mount + nav shell |
| `apps/web/app/gallery/gallery-fetch-interceptor.tsx` | `window.fetch` wrapper (the entire seam glue) |
| `apps/web/app/gallery/gallery-nav.tsx` | Sidebar nav + shared group ordering/labels |
| `apps/web/app/gallery/page.tsx` | Grouped catalog index |
| `apps/web/app/gallery/[id]/page.tsx` | Entry chrome (description, hints, pager) + stage |
| `apps/web/app/gallery/gallery-stage.tsx` | Mirror of `looms/[id]/page.tsx` routing over a fixture bundle |
| `apps/web/lib/gallery-fixtures/**` | Fixtures + `resolveGalleryFetch` + validation test (Lane F) |

## Known limitation

`SessionView` (the planner/discuss session shell and the loom Chat tab's live
streaming) is a chat **runtime**, out of fixture scope. The Chat tab renders
seeded history statically; the planner/discuss shells render the real component
with a benign-stubbed `/api/chat`. This is the real component with no live
backend — **not a fork**.
