# Project notes — a notebook beside the branch

A place to draw quick notes about a project — the deploy incantation, what the reviewer
keeps asking for, the three URLs you look up every time — reachable from the composer
without leaving the sentence being written, and open to a second app over MCP.

## 0. Where it lives, and where it does not

This shipped once in the **composer's foot**, replacing the pinned environment
(`workspace-environment.tsx`). That was wrong twice over, per the user (#264): the
notebook belongs on the **pinned summary** — the ⧉ button beside Open, which is where a
person already looks to answer "what am I working in" — and the foot's **branch readout
was wanted where it was**.

So, as of #264:

- **The notebook is a section of `session/workspace-inspector.tsx`**, directly under
  Workspace and above everything that comes and goes, so its position never depends on
  how many sub-agents happen to be running. A row is the title plus the body's first
  line; it opens the quick editor **in place** (§4) and drags into the composer as the
  reference in §5. An add row sits outside the five-row cap, always reachable.
- **The foot is the pinned environment again**: project identity, checkout mode, branch
  with ahead/behind one click deep, and the uncommitted count on the right edge —
  `EnvironmentStrip`, the same strings it carried before.
- **"Where this lands" survives** as the fresh-canvas half: before the session exists,
  the workspace mode and the base-ref picker (`BaseRefPicker`, kept whole) are a single
  pending choice, so they are one popover rather than three controls two of which cannot
  be pressed yet.

## 1. Model

One note belongs to a **project**, not a session. `ProjectNote` mirrors `SpoolNote`
(`packages/engine-client/src/protocol/spool.ts`) field for field where the two mean the
same thing — `{label, at}` stamps, `author: "you" | "session"` stamped once and never
patched — so the other app can reuse a reader it already has. Three additions:
`projectId`, `pinned`, `order` (a hand-drag order; pinned sorts first, then `order`).

`author` is the enum and **not** `{ sessionId }`: a second spelling of provenance is worse
than a missing id, and a session id would be a cross-reference the notebook cannot keep
valid once the session is archived.

**Stored** one JSON file per project at `<engine root>/notes/<projectId>.json`, derived in
`notes.ts` from `EngineStatePaths.root` exactly as `shelfPath` derives from
`SpoolPaths.root`. **`state.ts` is not touched at all** — `notes.ts` imports the path type
and nothing else — so the sibling branches landing there rebase clean. Reads are tolerant
per row (a hand-edit that breaks one note must not lose the notebook); writes are loud,
with sentences. Same two-vocabulary contract as the shelf.

**Delete is a real delete**, unlike the shelf's retire: a shelf note is the record of what
was known, while a project note is a scratchpad, and a list whose whole job is to stay
short cannot accumulate tombstones. See §6.

## 2. Engine API

Bearer-authenticated like every other `/v2` route, and every one validates the project id
through `store.getProject` first, so an unknown project 404s rather than minting a file.

```
GET    /v2/projects/:id/notes              → { notes }
POST   /v2/projects/:id/notes              → { note }    {title, body, pinned?, author?}
GET    /v2/projects/:id/notes/:noteId      → { note }
PATCH  /v2/projects/:id/notes/:noteId      → { note }    {title?, body?, pinned?, order?}
DELETE /v2/projects/:id/notes/:noteId      → { deleted }
POST   /v2/projects/:id/notes/:noteId/pin  → { note }    {pinned}
```

**Events.** `PROJECTS_CHANGED_EVENT` (`apps/web/lib/projects.ts`) turns out to be a pure
*window* event with no engine feed — `announceProjectsChanged()` is called by local writers
after the engine accepts — so notes reuse that exact pattern rather than a journal event:
`announceProjectNotesChanged()` over `telar:project-notes`, plus a re-read on window focus.
The bound is stated rather than hidden: a note written by the **other app** appears on the
next focus or mount, not within the second.

## 3. The outward socket — the user's other app

`/v2/notes/mcp`, its own secret at `<engine root>/notes-mcp-secret.json`, over
`mcp-socket.ts`'s `ensureSecretFile` / `connectCard` / `handleSocketMessage` — so
`notes/socket.ts` is ~40 lines, like the spool's and the sessions'. Three doors, three
keys. `GET /v2/notes/mcp-info` returns the card, behind the normal bearer:
`{ "mcp": { "url": "http://127.0.0.1:<port>/v2/notes/mcp", "secret": "<32 bytes
base64url>", "addCommand": "claude mcp add --transport http notes <url> --header
\"Authorization: Bearer <secret>\"" } }`.

Tools: `notes_projects()`, `notes_list(projectId?)`, `notes_read(noteId)`,
`notes_write(projectId, title, body, noteId?)`, `notes_delete(noteId)` — the list is
`notesTools` itself through `collectTools`, so socket/session parity is structural and a
test asserts the two lists are equal.

**One deliberate deviation, stated rather than silent.** This wall carries a delete, which
`sessions-tools/tools.ts` and the spool both refuse on principle. It is kept because the
notebook has no retire to fall back on (§1) — but `notes_delete` **only deletes notes whose
`author` is `"session"`** and refuses a human's in a sentence. An agent may clean up after
agents; the user's own notes are the user's.

## 4. The section

Rows: title and the body's first line, pinned first, then `order`. The add row opens a
quick editor (title + markdown body, autosave on blur, ⌘S). Clicking a row opens that same
editor **in place, inside the popover** — not the right panel. A note is consulted *while
writing a sentence*, and sending the reader to a panel means leaving the sentence; the
panel is also a tab-contended surface owned by other work. No row carries a chevron:
every other row in that popover is a "go there" that opens the panel and closes the
popover, and a note is the opposite. Each row is draggable: `text/plain` carries the body,
`REFERENCE_MIME` the below.

## 5. References in chat — client-side insertion of the body, not server-side expansion

The brief preferred a `@note:<id>` token expanded in `submitTurn`. Refused, because both
`drag-reference.ts` and `composer-tokens.ts` state the opposite law in prose: *the draft is
plain text, and `turn.input` must be exactly what the model was given*. Expanding a token
at submit would make the transcript disagree with the box — the one divergence this
codebase refuses everywhere. `checkReference` is the standing precedent for a reference
that carries content, and it carries it inline.

`noteReference(note)` → `kind: "note"`, text `the "Title" project note (n-abc123):` then a
blank line then the body in a ```` ```note ```` fence — whose length is one backtick longer
than the longest run in the body, so a note containing its own fences cannot escape.
`composer-tokens.ts` matches the **head line only** (as a failing check's does), so the
chip does not swallow the block the reader dropped it *for*.

**`@` completion**: note titles ranked *beside* paths under the existing `@` trigger — no
second sigil. `detectComposerTrigger` produces one trigger kind for `@…`, and a `note:`
prefix would thread a second kind through the whole editor for a gesture whose whole
appeal is that `@arch` finds "Architecture decisions" next to `architecture.md`. Notes
take at most the first four rows (pinned first on an empty query); paths fill the rest.

## 6. The boundary with the Spool

The Spool's shelf is **knowledge across projects** — a guard note, a runbook, a client's
preferences — kept forever with its provenance and retired rather than deleted; a project
note is **this repository's scratchpad**, short-lived, deletable, and reachable from the
composer of every session on that project. They do not merge and neither store reads the
other.
