# Project notes — replacing the pinned environment

The composer's foot answered "where does this land?" with three controls restating facts
the cockpit header and the Changes panel already carry. What a person wants at the bottom
of the box is **the project's own notebook**: quick notes they can drop into a sentence.
This replaces the strip, keeps every create-time choice a session cannot be created
without, and opens the notebook to a second app over MCP.

## 0. What happened to the three old controls — nothing silently dropped

- **Project identity** — fresh canvas only, as the "Where this lands" trigger's label.
  Dropped from an existing session's foot because `session-cockpit.tsx:279` already names
  the project in the header: de-duplicated, not lost.
- **Worktree / local mode** — into the **"Where this lands"** popover, fresh canvas only.
  It always was a create-time choice; `/local` and `/worktree` still drive it.
- **Base-ref picker** (`BaseRefPicker`) — **kept whole**, the same popover's second row.
  Same props, same default-base effect, same Enter-takes-first-match.
- The third control's other half, the **branch readout on a live session**, is dropped
  from the strip: it was never editable there, and `diff-surface.tsx` already names the
  branch (with ahead/behind) in the Changes panel — which is exactly where the count
  below opens.
- The **dirty count** stays on the right edge in both states, and is now itself the
  button: it is the only path from the composer to that panel.

So a **fresh canvas** foot is `[Where this lands] · notes… · +`; an **existing session**
foot is `notes… · +`; the count rides on either.

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
was known, while a project note is a scratchpad, and a strip whose whole job is to stay
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

## 4. The strip

Chips: title, pinned first, then `order`. `+` opens a quick editor (title + markdown body,
autosave on blur, ⌘S). Clicking a chip opens **a popover anchored to that chip**, not the
right panel — a note is consulted *while writing a sentence*, and sending the reader to a
panel means leaving the sentence; the panel is also a tab-contended surface owned by other
work. Each chip is draggable: `text/plain` carries the body, `REFERENCE_MIME` the below.

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
