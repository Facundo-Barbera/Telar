# The Spool's loops

Status: **agreed direction, 2026-08-16.** This doc records the conversation
pass that followed the room's first real use. It does not replace
`docs/spool-definition.md` — the definition still governs what the Spool *is*
(assistant, memory, moat at landing). This doc governs what the Spool is
*connected to*, because the honest diagnosis of the built system is that it is
connected to nothing.

---

## 1. The diagnosis

What exists after the first build rounds is three layers:

1. **A memory** — the item store: items, lanes, threads. Real and solid.
2. **A clerk** — the chat agent. It can file, mark, question, focus. It moves
   only when spoken to.
3. **A stance** — a screen that sorts the memory by whose turn it is.

What does not exist is the thing the Spool was redefined to be: anything that
works while the user is gone, or anything that connects the prepared work to
the place where work happens. The surface promises an assistant; behind it is
a filing cabinet with a polite clerk. "In its hands" is currently a lie —
nothing is ever in its hands.

The user's words for the failure, verbatim in spirit: *"It looks like it did
its job, but it isn't useful to me. I can't do anything with this. We are
treating it as a database that sometimes an agent can use. I cannot trust that
context because it doesn't work for me."*

Two named symptoms:

- **Trust.** The store is a snapshot from the day it was populated. It was
  stale the moment anyone else pushed. Context that cannot be verified fresh
  is worse than no context — everything must be re-checked anyway.
- **Reach.** The prepared packet is unreachable from a working session, and a
  working session cannot write back. The Spool organizes context *for agents
  and for the user*, but no agent outside its own chat can see it.

## 2. The four loops

The Spool is not a task system. It is **the connective tissue between the
user's sessions and the user's world.** Four loops, of which zero are built:

1. **World → Spool.** The Spool keeps itself current about the places its
   subjects live — by *looking when it has a reason to*, never by
   subscribing. This is exactly the definition's §11 mapping (convergent,
   read-only, self-initiating); it was defined and never turned on.
2. **Spool → Session.** "Work on this" lands the user in a real Telar session
   that is already briefed: the packet, the raw words, the dependency chain,
   and the delta since the user's last look, injected as opening context. The
   Spool's whole job was preparation; today the prepared thing cannot reach
   the place where work happens.
3. **Session → Spool.** Any normal session's agent gets the spool toolkit
   (it already exists behind the one-pure-function wall; it is merely wired
   only to the master session). A mid-session "we should also fix X" gets
   filed without leaving the room.
4. **Session → World.** Sessions alter projects: they produce issues, PRs,
   modifications. The Spool does not need to know a session did it. The world
   is truth; the Spool holds *its last look at it*. Loop 1's reconcile sees
   the session's changes the same way it sees a teammate's.

The trust failure is loop 1's absence. The "I can't do anything with this"
failure is loop 2's absence. Loop 3 is the cheapest (the tools exist). Loop 4
costs nothing — it is a consequence of loops 1 and 3 plus honesty about who
owns truth.

Build order agreed: **loop 2 first** (the moment the Spool pays the user
back), **loop 1 second** (trust), **loop 3 third** (capture). Loop 4 falls
out.

## 3. Terrain

The primitive under loop 1 is not "a GitHub integration." It is much smaller:

**A subject knows its terrain.** A terrain is an address plus a few facts:
*"I live in `ozom-ai/ozom-gv`, reachable via `gh`; milestones are Hitos;
`needs-approval` is the accept gate."* Stated once by the user, or discovered
by the Spool and confirmed. A handful of lines, not a sync engine.

Rules:

- **Subjects are the user's; terrains are optional.** A subject may be a
  repo, a client, a paper, or a vague idea with no terrain at all. The Spool
  works identically on all of them; a terrain just gives it one more place to
  look.
- **Terrain types are plural from day one.** A repo, a directory, a URL,
  nothing. If a mechanism only works for the GitHub case, it is not core.
- **The no-code test:** every core feature must be equally useful for a
  subject that has no code at all. This is the overfit guard — the first
  draft of this design was a repo-shaped morning, and it was wrong.

## 4. Reconciliation and freshness

**Reconcile-on-look.** Whenever the Spool has a reason to look — the user
arrives, a subject gets focused, a night mapping runs — it reads the terrain
through the tools it already has, diffs against its memory, and files what
changed as observations in plain words: *"PR #420 merged since your last
look. #412's chain may be unblocked. Someone added an issue to Hito 1."*

- Same mechanism regardless of who changed the world: the user, a session, a
  teammate. It notices deltas, not actors.
- This is pull-never-push, unchanged from the definition. The world never
  interrupts; the Spool glances when it sits down, the way a person would.
- **Freshness is shown, honestly, always.** "Looked 7:40 this morning" on
  every terrain-backed subject. Trust starts existing the moment the room can
  say when it last looked and what moved. A surface that hides its staleness
  is the database the user said they didn't want.

## 5. The morning, generalized

Not a repo digest. One line across everything:

> *Since Thursday: movement in 2 subjects, 3 things now need you, 1 question
> I couldn't resolve.*

Ranked by whose turn it is, never by project. A merged PR in a terrain-backed
subject and a no-terrain idea that ripened into a draft sit in the same band,
in the same grammar. Each moved thing carries at most two verbs — one that
opens work on it, one that acknowledges it.

**Briefed arrival** generalizes the same way: "pick it up" means *arriving
anywhere prepared* — a session with the packet loaded, or just the packet
opened with everything it accumulated. The coding-session-on-a-repo case is
only the flashiest instance, not the definition.

## 6. Wide and focus — the aperture, committed

Two postures, one room.

**Why it's right:** wide answers *"what does my life need?"* — visited
briefly, at arrival, to decide where to spend yourself. Focus answers *"what
does this need?"* — lived in while working. They are different postures, and
one screen serving both at once is exactly how the earlier illegible versions
happened: everything collapsed into folds. The machinery half-exists
(`spool_set_focus`, the aperture); this commits to the split.

**The standing critique (kept on purpose):** two views is how tools rot. The
wide view degenerates into a dashboard nobody reads, or focus becomes the
real app and wide a launcher. The worst trap: a week focused on one subject
makes the others invisible and they quietly die. Every view boundary gives
"where do I do X?" two answers. The rules below exist because of this
critique, and any future change must re-answer it.

**The cut:**

- **Same room, different aperture — never a different page.** Focus is a
  state of `/spool`, not a route. Same bands, same chat, same tray. Wide
  shows one line per subject ("ozom-gv: 3 need you, looked 8:02"); focused
  shows one subject's actual items in full grammar.
- **Wide is the arrival, focus is the residence.** Land wide by default only
  when unfocused. Leaving focused means returning focused — with one line
  above the room ("meanwhile: movement in aurora"). The periphery stays one
  glance away, never zero.
- **The chat is the hinge.** Narrowing and widening are chat moves — plus a
  visible aperture control for the same moves, so the capability is
  discoverable without knowing the words.
- **One capability set.** Anything possible focused is possible wide. Focus
  changes how much you see, never what you can touch.

The one-line law: **wide is for choosing, focus is for doing, and neither
hides the other's alarms.**

## 7. The workbench (added same day, after the loops shipped)

The user's verdict on the built loops: still not on board — *"there is no
place I can see tasks, a calendar… I'm missing a more tangible surface, and a
way of creating my own tasks without relying on AI, but that they become part
of the ingest and the AI notices them too."*

The diagnosis: the system had three legs — the assistant (chat), the world
(terrain) — and was standing without the third: **the workbench**, the part
the user manipulates with their hands, no intermediary. Everything passed
through language. Direct manipulation is where trust in a tool comes from:
you moved the thing, so you know where it is.

Three pieces, one principle — **your hand and its hand are the same ink**:
everything the workbench writes goes into the same store the assistant reads,
so a hand-made task is automatically part of the ingest with no extra wiring.

1. **Creating by hand.** A plain form — title, subject, lane, optional pin —
   writing straight to the store through the human API. Zero model calls. The
   chat sees it next turn; reconcile ties it to the world; night can map it.
2. **The board.** The desk as a tangible surface: lanes as columns, items as
   cards, drag to re-file and re-rank. The room stays the front door
   (whose-turn-is-it); the board is where you go to *arrange*.
3. **The calendar.** Week and month. Items pinned to days, dragged between
   days. Governed by the amended §3.2 law (see the definition): the calendar
   belongs to the human — the system draws your dates plainly and may respect
   them, never wield them.

**The pin** is a real property of an item (`pinned: {day}`), human-owned,
with teeth in all three directions:

- **You** see it on the grid and drag it; moving a task to Thursday is
  editing the store by hand, same standing as anything the chat writes.
- **The room** surfaces it when its day comes — it joins "Needs you" on the
  day you chose. That is you interrupting yourself, not the system knocking.
  A slipped pin is recorded honestly, not punished: "you pinned this to
  Tuesday — it's still here," same quiet voice, no red.
- **The night** treats pins as constraints: prepared-by-its-day beats
  interesting; nothing pinned to Friday is picked up early without a permit.

The workbench lives inside `/spool` — one front door still. The stance, the
board and the calendar are one room's postures, not routes.

## 8. Areas, colors, and smart scopes — one room for a whole life

Added 2026-08-16, after the workbench landed. The user: *"maybe I'd like to
use Telar for non-work related stuff too… What I used a lot before is the
Reminders app and the Calendar app from Apple. I'd like some inspiration
driven from that."*

What those two apps got right, translated into the Spool's laws — the core
insight is that **groupings are identity, not status**. A Reminders list has
a color and a name and it is *yours*; the app never invents a group, never
recolors one because a deadline neared.

1. **Areas** (Reminders' list-groups). A subject gains an optional `area` —
   a free-text group name the user states: "Trabajo", "Personal". The wide
   stance groups subject lines under area headers, so work and life share
   one room without contaminating each other. Subjects without an area sit
   ungrouped, last, unpunished.
2. **Subject colors** (Calendar's per-calendar hues). A subject gains an
   optional identity color from a closed palette of quiet tokens. It marks
   the subject's line, its cards on the board, its pins on the calendar —
   the Apple Calendar overlay feeling: many calendars, one grid, each
   recognizably its own. **The law that guards it: color may say WHOSE
   something is, never how urgent it is.** Identity hues are constant,
   never derived from state, never red-for-late. The no-state-color and
   no-red laws stand untouched; the `--spool` accent budget is unchanged.
3. **Smart scopes** (Reminders' Today / Scheduled). The aperture learns two
   computed scopes beside subject focus: **Today** — pinned-to-today plus
   what needs you, across all subjects; the morning glance — and
   **Scheduled** — everything pinned, in day order, the flat list Reminders
   showed. Both are computed only from properties the user set (pins,
   work-states), never from the system's opinions. They are apertures, not
   routes: same room, same capability set, chat as hinge (§6's laws apply
   whole).
4. **Non-work needs nothing new.** The no-code test (§3) already made a
   terrain-less "Casa" subject first-class through every mechanism — filing,
   ripening, pins, briefed arrival. This pass only makes it *feel* owned.

Provenance holds: areas and colors are stated by the user (in chat or with
the hand), recorded by agents only when stated, never invented.

### 8.1 The aperture slot and area ceilings (same day, closing two seams)

- **The aperture is shared state, not a log.** The chat can now change what
  the room shows ("muéstrame lo de hoy") through a single current-value slot
  — `{view: everything | today | scheduled}` — that the hand's clicks write
  too, so chat and hand share one source of truth. Deliberately NOT the
  focus store and NOT a history: the focus log narrates work, and a glance
  is not work. Subject focus remains the deeper aperture.
- **Area ceilings.** An area may carry a permit ceiling, stated by the user,
  never assumed — "Personal" gets one only when its owner says so. The
  ceiling CLAMPS every member subject's effective permit (down, never up):
  one function, `effectivePermits(subject)`, sits in front of every
  enforcement point, so a night pass physically cannot work a subject past
  its area's ceiling. Stated permits stay visible beside effective ones —
  the clamp is shown, not silent.

## 9. The hand closes — the checkbox amendment

Added 2026-08-17, after the user walked the built room as a human: *"there is
no way for me to use this right now if I don't entirely depend on the
integrated AI."* The diagnosis found a law at the root: `SpoolItem` carried
no done field on purpose — "the absence is the whole moat." That law
overcorrected exactly as the clock law did. The moat ever needed only this:
**no agent may declare a thing done.** It never needed: *the user can't.*
A human closing their own task is the purest form of "nothing lands without
the human" — it IS the human.

The amendment:

1. **Items close by hand.** A checkbox on every task — stance row, board
   card, calendar line, packet. The close verb exists ONLY on the human API;
   it does not exist on the agents' tool wall at all, so no model can ever
   touch it, spoof it, or be talked into it. Reopening is equally the
   hand's: a checkbox unticks.
2. **One gesture, everything over.** Closing an item quietly settles its
   open threads, each recording the honest answer "the user closed the
   task" with attribution and the stored label. A human closing a task has
   answered every question the system had about it; bureaucracy after a
   checkbox is how trackers die.
3. **Closed drains, never deletes.** Closed items leave the active desk
   into a visible Done shelf. The conservation count holds. "You closed 3
   things this week" is drawable from records — and only your hand can have
   made it true.
4. **The parity rule** (retroactive for every future pass): every verb the
   chat has, the hand gets as a visible control — and the room's verbs live
   on the rows where a person looks for them, not only inside trays.

## 10. The shelf, the search, and the socket — absorbing bixkuOS

Added 2026-08-17. The user's earlier project **bixkuOS**
(github.com/Facundo-Barbera/bixkuOS) was "a personal operating system — one
place for tools, accounts and automations, built to grow without rules." Its
built slice: nested knowledge folders ("contexts") of markdown documents,
RAG search over them, and an MCP server exposing the knowledge base to any
LLM client. Telar has quietly become that project's successor, so this pass
absorbs its organs rather than resurrecting it. One constraint stated
plainly: **no external embedding models for now** — Telar does not support
them, so search is lexical and honest about it.

1. **The shelf.** A subject holds DOCUMENTS — markdown notes with tags —
   beside its items. Knowledge that is not work stops wearing task clothing
   (the "NO TOCAR #302/#304" guard note has squatted in unfiled as a fake
   task since day one). Notes are written by the hand or by agents when
   asked; agent-written notes carry their author. Retiring a note drains it;
   nothing deletes.
2. **The search.** One deterministic, model-free lexical search over
   everything the Spool holds — items, threads, notes, observations — with
   field-weighted scoring. A hand control in the room and a `spool_search`
   tool on the wall. Semantic search waits, named, until Telar supports
   local or provider embeddings; a lexical hit list that exists beats a
   vector index that can't run.
3. **The socket.** The engine exposes the Spool as an OUTWARD MCP server —
   Streamable HTTP with its own dedicated secret — so any LLM client (Claude
   Desktop, a fleet agent in another repo, anything that can `claude mcp
   add`) reaches the same tool wall a Telar session gets: file, list, look,
   pin, question, search. The wall's laws ride along unchanged — no close,
   no accept, provenance rules in the descriptions. One store, every agent
   the user owns.
4. **Tags.** Free-text labels on items and notes, filterable — the
   cross-cutting axis lanes and areas can't express.

With §8's volume work this completes the turn the user asked for: the digest
(compress-never-multiply applied to movement), movement placed BELOW "Needs
you", bulk verbs (noted-all, settle-all-answered, close-many), and the
selection model — the hand's verbs finally compound.

## 11. Two places, one shell — the switcher (agreed 2026-08-18, NOT built)

The user: Telar and Spool are "different, but part of the same system —
overlap one on top of the other." The Spool has been a page inside Telar's
chrome, squeezing three columns into one main region while Telar's left
sidebar (sessions, projects) sits irrelevant beside it.

- **The switcher**: the "telar" wordmark becomes a dropdown — **Telar**
  (new capital-T glyph, same drawn style as the Spool's) and **Spool** (its
  glyph, `--spool` hue as place mark). Chrome, not routing: `/spool` and
  `/projects/…` deep-links still land correctly; the sidebar's little Spool
  button retires.
- **The Spool's place**: LEFT sidebar = the warehouse nav — search on top,
  apertures (Everything/Today/Scheduled), Areas → subjects tree with
  identity dots and honest counts, lanes, tag filters. MAIN = stance/board/
  calendar at real width. RIGHT sidebar = the conversation, tray sliding
  over it when summoned.
- **Laws that bend, named**: "navigation does not move" → "…within a
  place"; one-front-door and the single master chat unchanged; the
  place-switcher entry occupies the header-glyph slot of the `--spool`
  five-mark budget.

## 12. What this pass deliberately did not decide

- The concrete shape of a briefed session handoff (what exactly is injected,
  and how a session declares it wants the spool toolkit).
- Terrain's storage shape and its confirm/discover flow.
- When reconcile runs beyond "on arrival" and "on focus" — the night
  scheduling question from §11 stays where §11 left it.
- Anything about the visual language. The user has flagged separately that
  the Spool's surface diverges from the rest of the app (which is rounded);
  that is a real complaint and a different pass.

## 13. THE SHAPE — the re-entry machine (agreed 2026-08-18, governs the surface)

After living in the built room the user rendered the verdict that forced this
section: the Spool had become "a convoluted conjunction of tiny things" —
five passes each keeping their furniture, four organizing principles
(whose-turn bands, lanes/days, subjects, time apertures) competing on one
screen. This section replaces them with ONE. Where anything in §6–§11
contradicts §13, §13 wins; the laws of the definition (moat, no-red, quiet,
provenance, calendar-belongs-to-the-human) are untouched and inherited.

**The product in one sentence:** the Spool lets a person who works on many
things at once walk into any of them and know, in ten seconds, where they
left off, what moved while they were gone, and what to do next — then start
that work already briefed. The user is a developer and a student across
several businesses (Ozom with their father, Focaltec as employer, a personal
business, a degree's worth of classes). The unit of value is a CHEAP CONTEXT
SWITCH. The organizing verb is RESUME, not review.

### 13.1 Two levels, never nested

- **Areas are worlds you belong to** — Ozom, Focaltec, the personal
  business, Uni, Personal. Few, stable for years. An area carries identity
  and POLICY: its permit ceiling is business-level law ("nothing in
  Focaltec's code drafts overnight"), stated once, clamping every subject
  inside (the §8.1 machinery, finally standing where it belongs).
- **Subjects are efforts you resume** — orchestrator, ozom-gv, each class.
  Many, churning; they retire when the semester ends. THE MEMBERSHIP TEST:
  if you would say "what was I doing in X?", X is a subject. Ozom fails
  (you resume its projects, not the business) — that is why it is an area,
  and why nothing ever nests. Small business chores need no ceremony: a
  terrain-less two-item subject is first-class (casa proved it).

### 13.2 The floor plan — you are always somewhere

- **The LOBBY** (landing) is mission control, RANKED, NEVER ENUMERATED: a
  subject earns a card by having a session running, needing you, or having
  moved — everything else folds to a quiet line under its area header
  ("Uni — 4 classes, nothing needs you"). Twenty subjects exist; three
  speak. A card's primary action is ENTER BRIEFED.
- **A SUBJECT'S ROOM opens on the BRIEF**, not a task list: where you left
  off (the pickup), what moved since (the look's diff, honestly dated),
  what's still open, what's next — with RESUME SESSION as the headline
  verb. Behind the brief, as tabs: its tasks, board, calendar slice, notes,
  threads. Bookkeeping is reference, not the doorway.
- **TODAY and SCHEDULED are rooms**, cross-subject, day-shaped, built purely
  from the user's own pins. Not apertures, not state — places.
- **The RAIL is the floor plan and nothing else**: lobby, Today, Scheduled,
  subjects by area. Every click GOES somewhere. No stacking view axes, no
  resident filters. Filters are transient chips on the content they filter,
  each with a visible exit.
- **The CHAT rides beside every room, scoped to where you stand.** One
  assistant, one store, whether you type, click, or a session files
  something from inside the work.

### 13.3 The content laws — how it stays small

1. **Provenance or nothing.** An item exists only if it can cite its
   source: you said it, the world stated it, or a session produced
   something needing your eyes. Agents never mint tasks from inference.
2. **Mirror, don't import.** The world's items stay in the world. The Spool
   holds only what crosses the attention boundary (assigned, needs-approval,
   blocking you, named by you) as a mirrored claim with its #N. The rest
   stays reachable by look and search, never resident.
3. **The outside is quarantined.** Anything from beyond — the MCP socket,
   another session, a future feed — lands as a raw capture in the subject's
   inbox. Ripening into a task happens in conversation or by the hand.
4. **Breakdown never multiplies.** Subtasks live inside their parent; the
   count never grows from decomposition. (Standing law, restated.)
5. **Only the hand closes.** (§9 stands.) When the world says something is
   done, the agent's ceiling is a PROPOSED SETTLE WITH EVIDENCE — one
   checkbox cascades the rest. Untouched items FOLD quietly; at most the
   brief once says "these three look dead — say the word."

### 13.4 The smart part — a librarian and a scout

Four jobs, all compression, never population: keep every brief TRUE
(reconcile on look, honestly dated); RIPEN captures into work-ready packets;
PREPARE overnight under area ceilings into reversible containers; FILE and
ANSWER in chat. The assistant's output is always a smaller, truer picture —
the moment it manufactures work it has failed.

### 13.5 What this deletes, and what survives

DELETED: the global stance bands as the front door, the global board and
calendar as top-level postures, the aperture slot as stacking state, subject
focus as view state, the three-axes machine, the warehouse rail of §11 (the
rail becomes the floor plan above). SURVIVES UNCHANGED: the store and every
content law, threads and confrontations, reconcile/looks, the night and
permits, the moat, the tools and the socket, the shelf, the search, the
place switcher of §11 — and the VISUAL LANGUAGE the user likes (quiet
rounded cards, identity colors, the chips, three text levels, bg-sidebar
rails); this is an interaction-model rebuild wearing the same clothes.

### 13.6 The assistant's two doors (amended 2026-08-18, supersedes the
"chat rides beside every room" line of §13.2)

Living in the built §13 room surfaced a column problem: rail + room + tray +
docked chat could stack FOUR columns, and the resident right sidebar paid a
permanent column for an assistant used in bursts. The amendment: **the
assistant has a room of its own and can be summoned over any other; it is
never resident.**

- **One assistant, one transcript, two doors.** There is still exactly one
  master conversation. Its two surfaces render the same braid.
- **The assistant's room** is an entry in the rail floor plan — Lobby /
  Today / Scheduled / **Assistant** / areas. Full-width conversation,
  scoped to everything; where filing sprees and long exchanges live.
- **The summoned layer**: from any room, one key (⌘J) or the header button
  slides the assistant over the right edge — same transcript, stamped with
  the room it was summoned from. The TRAY DISSOLVES INTO THIS LAYER: a
  packet face, a note editor, or the conversation are ONE slot; two of them
  can never stack columns again. "Answer in chat" summons it with the
  question loaded. An expand control on the layer navigates to the
  assistant's room — the doors join.
- **Every room defaults to two columns** (rail + main). Three only while
  summoned, only for as long as you keep it. The resident right sidebar
  dies in the Spool place; Telar's place keeps its own right-panel behavior
  untouched.
- The docked chat's suggestion chips move: at most one quiet hint line
  where they still earn their place (the lobby), the rest live in the
  assistant's surfaces.

### 13.7 Depth is for names, never for work (amended 2026-08-18)

Amends §13.1's "never nested" with precision about which half was
load-bearing. The floors that do not move: **subjects never nest** (the
resume test lives at that level) and **items never multiply through
breakdown**. Above the subjects, the hierarchy is only LABELS — nothing can
live inside "Work" except other labels — so nesting there creates no place
for work to hide.

- **An area's name is a path.** "Work / Focaltec", "Life / Personal". The
  store keeps ONE string per subject (no parent pointers, no tree tables);
  segments split on " / ", trimmed. Depth is a naming convention the user
  adopts, not a structure the system maintains.
- **Rendering: containers all the way down.** Every path node is a real
  container row — disclosure chevron, collapsible, visual weight DESCENDING
  with depth (the container is never lighter than its contents; the old
  inversion — tiny muted area names above full-weight subject rows — is the
  bug this fixes). Each container row carries its rollup facts: subject
  count, what needs you beneath it, its ceiling when set. The "AREAS"
  meta-caption dies; containers introduce themselves. Un-areaed subjects
  sit under a ghost container, never floating. The lobby uses the same
  container grammar, so both surfaces teach the same shape.
- **Drag files at any node.** Dropping a subject on a node makes that path
  its area ("Work" itself is a legal area). Dragging a container onto a
  container renames the prefix — recategorizing a world is one gesture
  (bounded writes: one PATCH per subject in the moved subtree).
- **Ceilings clamp down the path.** A ceiling stated on "Work" clamps every
  area and subject whose path sits beneath it; where several apply, the
  MOST restrictive wins. Down-only, as ever.
- **The warning, written here on purpose:** every level is a decision paid
  at filing time. Two or three segments is where real lives sit; deeper
  paths are gardening the cabinet instead of working. The tool permits,
  this doc discourages.

### 13.8 The map is content, not chrome (agreed 2026-08-19; amends §13.2,
### dissolves the Warehouse)

The Warehouse (built 2026-08-19, dissolved the same day) was a symptom: a
separate room to MANAGE things existed only because the rooms where things
LIVE didn't let you touch them, and the structure lived in a sidebar too
cramped to hold it. The diagnosis, in the user's words: a sidebar is quick
access, not the form of the product. The correction, in Reminders' grammar:
the home screen IS the map, every screen is a list, and every row is
editable exactly where it sits.

- **The Lobby is the home screen.** The whole structure, in the content
  pane: Today and Scheduled as smart tiles with live counts up top, then
  the areas as §13.7 container sections holding subject rows with their
  counts. Re-entry survives as the map's ARRANGEMENT, not as a feed: a
  subject that needs you carries its badge and floats its card open
  (§13.2's fold law, relocated); everything else sits folded as plain
  structure you can stand on. All structure gestures — drag to file,
  reorder, rename, new area, ceilings — happen HERE, in the room that has
  space for them.
- **Navigation is walking the map.** Lobby → area page (that subtree's
  subjects and rollups, same container grammar) → subject room. A
  breadcrumb walks back up. There is always an obvious answer to "where am
  I and how do I reach X" — that answer is never a dialog.
- **The rail shrinks to quick access.** Lobby, Today, Scheduled, Assistant,
  then pins. It never renders the area tree again; every tree gesture it
  grew (drag, inline inputs, reorder) moves to the Lobby map and is DELETED
  from the rail.
- **Rows edit in place.** The subject room is the task list: click a title
  and it is a text field; the circle closes by hand (§9 unchanged); a new
  task is typing into the empty row at the bottom, not a dialog; each row
  discloses its details (lane, pin, tags, note) on the row itself. The
  brief shrinks to a dismissible strip above the list — re-entry when you
  arrive, gone when you're working.
- **What this deletes.** The Warehouse room: Areas tab → the map; Subjects
  tab → each room's About; Lanes and Tags → edited where they appear as
  chips; Done → a "show completed" foot on each list; Connections → a quiet
  card at the Assistant room's foot (connecting agents is the assistant's
  business). Dialogs survive only where a second
  thought is the point (confirmations, the settle-all).
- **The floors under all of it do not move:** subjects never nest, items
  never multiply through breakdown, closes are by hand, ceilings clamp
  down, quiet by default.
