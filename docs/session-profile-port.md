# The SessionProfile port

`packages/core/src/session-profile.ts` resolves session configuration ONCE,
before the route body runs, as typed data rather than as another branch
through a 1900-line handler (AD-9/AD-10/AD-11). This document holds the full
design reasoning; the source file holds only the point-of-use notes a
reader needs while editing it.

## What it replaces

`apps/web/app/api/chat/route.ts` used to compute session shape inline:
`manifest = getProject(project).manifest`, then `const workspace =
manifest.root` feeding `cwd`, guardrails and `settingSources` for both
providers, and three role-derived flags (`isPlannerSession`,
`isSteererSession`, `isEscalationSession`) branching the `systemPrompt`,
`allowedTools` and `disallowedTools` that follow. Those first three values
are literally AD-9's first three profile fields, which is why AD-9 calls
this a REFACTOR of what the handler already builds rather than a new
concept. Three epics are queued to add a fourth, fifth and sixth session
kind against that shape. Without this port each of them adds another `if`
to the one file the Human-Accept Moat rides on.

## The trade-off, stated plainly

This is the decision most likely to be re-litigated: making session config
DATA is exactly the move that could turn a structural invariant into a
configurable one. AD-10 names the failure — "the moat degrading from
structural to configurable; a mis-authored profile silently omitting it."
Three properties, not the field list, are what keep that from happening,
and every one of them is enforced rather than reviewed:

1. The `PreToolUse` guardrail is wired OUTSIDE the profile and runs for
   every session regardless of profile. No field here can reach hook
   registration — there is no `hooks`, no `canUseTool`, no
   `permissionMode`, no `skipGuardrail`, and INV-6a in
   `packages/core/test/invariants.test.ts` pins the field set to exactly
   eight names so adding one is a deliberate act that fails a test.
2. `ToolPolicy` is intersect-only BY ITS TYPE, not by review. The spine's
   own words: "'we will review for it' is not a mechanism."
3. An unmet capability is a hard error BEFORE the stream opens
   (`unmetCapabilities` + the route's existing pre-SSE 400). AD-11: "No
   silent degradation, ever."

The rejected alternative was a nominal/branded `SessionProfile` that only
the resolver could mint. Core has no branded-type precedent (grepped: zero
`unique symbol`, zero `__brand`, zero phantom type parameters) and the
house mechanism for "this cannot be expressed" is the enumerable union. It
is also unnecessary: `toolPolicy` is the ONLY tool-granting field, and its
own type forbids widening whether or not the enclosing object came from the
resolver.

## Scope: this resolves; it does not apply

Story 2.1 landed the port and the capability gate; story 2.2 MIGRATED THE
LIVE PATH ONTO IT, so the route no longer computes
`cwd`/`guardrails`/`settingSources`/`allowedTools`/`disallowedTools`/
`systemPrompt` a second time — it reads the resolved profile. That is why
`BASE_ALLOWED_TOOLS` now names the whole auto-run vocabulary and why the
fold unions the manifest's deny set into `toolPolicy.deny`: a consumer
reads ONE field per decision and cannot drop half of it.

What is still NOT here is `mcpServers` — the route's set is built by
CONSTRUCTING in-process MCP servers that close over a variable the SDK
mutates mid-stream, which is a side effect and not data. Epic 5's
project-less master profile is the story with a reason to pay for that
restructure; until then every spec omits the field and it resolves to `{}`.

**Story 5.6 measured that restructure and did NOT route it through this
field.** The reason is #28's persistent runtime rather than anything about
profiles: the four servers are constructed inside
`acquireSessionRuntime`'s `create` callback — once per session RUNTIME, not
once per POST — and each closes over getters that read live state
(`self().sessionId`, `slots.runId`) so a reused runtime's tool calls
attribute to the CURRENT turn. A builder runs EAGERLY, before the stream
opens (INV-6c pins that ordering), so it can only produce values; a builder
that constructed them would capture the first POST's ids forever. What the
kind selects is therefore a FACTORY, and factories live in a parallel
kind-keyed registry, `apps/web/lib/session-mcp.ts`. `mcpServers` keeps its
meaning for what it CAN carry — statically-configured servers, which is
what CAP-13's external MCP roster will be — and the route now spreads both,
so a profile that declares one is no longer silently dropped.

## AD-5/AD-20 — no state-root composition

This module owns NO state subtree and composes NO path off `TELAR_HOME`. It
reads no env, opens no file, and imports none of `node:fs`, `node:os` or
`node:path`. That is not incidental tidiness — INV-3a pins the `TELAR_HOME`
path-composition inventory at an exact list of named sites, and a module
that resolved the state root would have to be added to it. Everything
path-shaped arrives already resolved, on the context.

**Forward note for epic 5, and how it actually resolved.** The note used to
read: "AD-9's project-less master profile needs `cwd:
<TELAR_HOME>/workspace/home`, so that story adds an optional `cwd` to the
spec — and it must reach that subtree through the owning module's exported
port, never by composing a path here." Story 5.6 kept the second half and
rejected the first.

`cwd` is not a restriction. `SessionProfileSpec` is deliberately a set of
fields a profile may only NARROW with (INV-6a pins the exact set, and
`GRANT_SHAPED_FIELDS` names what may never appear), and a spec field that
moved where a session RUNS would let every profile in the tree redirect its
own working directory — a grant, wearing a restriction's clothes.

So the DERIVATION moved instead. The route's `manifest =
getProject(project).manifest` became `resolveSessionAnchor({ kind, project
})`: a second registry, keyed by the same `SessionKind`, whose resolver
returns the `ProjectManifest` this kind runs against plus the key its
permission rules are stored under. For every project-anchored kind the
registered resolver IS `getProject(project).manifest`, throwing the same
error into the same `catch` and producing the same pre-SSE 400. The master
registers one that returns a manifest parsed with `root:
workspaceHomeDir()` — the owning module's exported port, never a path
composed here — and the synthetic permissions key `__master__`.

Core still composes no path and opens no file: it STORES a resolver and
calls it. The one that touches the disk lives in apps/web, and its suite
runs it in a child process with `TELAR_HOME` pointed at a temp directory.

The whole module is PURE (the project's Design Law: deterministic control
flow in code, non-determinism pushed to injected seams). No clock, no
randomness, no I/O, no seams at all — the fold takes an already-read
context and returns a value. That is why its suite needs no `TELAR_HOME`
sandbox.

## `sessionKindFromRole` vs. `resolveSessionKind`

`sessionKindFromRole` is the WIRE NARROWING and is still correct for what
it does: given a raw role and no other input, this is the kind. It is NOT
what the chat route resolves a session with any more — story 2.2 hoisted
`existingChat` and the loom-link validation into the pre-stream preamble
and the route now calls `resolveSessionKind`, which sees the persisted role
too. The objection story 2.1 recorded against that hoist ("a real store
read added to the hot path") dissolved on measurement: `getChat` already
ran on every resumed turn and `getLoom` on every turn-1 steerer/escalation
seed, so the hoist moves two reads EARLIER in the same request rather than
adding one.

`sessionKindFromRole` is kept exported because it is the correct answer to
a different question, and because it is the shape a caller with only a
wire role (a future surface, a test, a non-chat entry point) needs.
Under-detection remains the safe direction wherever it is used: `project`
requires NO capability, so a mis-detected session gets a weaker requirement
and never a spurious 400.

`sessionRoleFromWire`'s "which strings are session roles" fact was written
twice before story 2.2 — the chat route's eight-line `rawRole` ternary and
`sessionKindFromRole` — and `resolveSessionKind` became the third consumer
of the same fact. One home, three readers.

## `resolveSessionKind`'s precedence order

The precedence — escalation, then steerer, then planner, then plain — is
measured from the chat route's own `systemPrompt` ternary chain, and ORDER
IS LOAD-BEARING. A session can satisfy two predicates at once: a resumed
chat persisted as `steerer` whose client also sends `role: "planner"`
matched both `isSteererSession` and `isPlannerSession` in the old route,
and the chain resolved it as STEERER. An unordered `Record` or a set of
independent `if`s would not reproduce that; this ordered fold does, and the
collision case has its own test.

The signature takes the MERGED LINK, not the raw persisted role, because
the route builds `loomLink` anyway (the loom MCP server mutates it during
the turn and `appendTurn` reads it back), so re-deriving the
persisted/wire merge inside core would duplicate logic that already has one
home. `linkRole` is `"planner"` IFF the persisted role is — the route's
fallback arm can only ever produce `"steerer"` or `"escalation"` — so
`role === "planner" || linkRole === "planner"` is exactly the old
`role === "planner" || existingChat?.role === "planner"`.

`loomId` must be VALIDATED (the loom exists AND belongs to the anchoring
project). A bad or foreign id leaves it undefined, which drops an
escalation request to `project` — failing SAFE to a plain session, exactly
as the route has always done, and never to a 400.

## The tool-name tuples

`LOOM_AUTO_TOOL_NAMES`, `ULTRA_AUTO_TOOL_NAMES` and `WORKSPACE_AUTO_TOOL_NAMES`
are declared here so a profile's `allow` can name them, duplicating the
canonical registrations in `apps/web/lib/loom-mcp.ts`, `ultra-mcp.ts` and
`workspace-mcp.ts` — core cannot import apps/web without inverting the
dependency, and these are tool-name STRINGS, not an import of web code.
What makes the duplication safe is not care, it is a test:
`apps/web/lib/session-profiles.test.ts` imports both copies and pins them
against each other, so drift in either indicts the other.

**MOAT:** `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are
ABSENT from `LOOM_AUTO_TOOL_NAMES`, and the absence is the property. Both
are human-gated commits (docs/loom-model.md §M.6 — the human's Approve
click IS the provenance stamp), both are excluded from `LOOM_AUTO_TOOLS`
for that reason, and keeping them out of this tuple makes them UNSPELLABLE
in any profile's `allow`, enforced by the compiler rather than by review.

`ultra_inspect` auto-runs alongside ultra's other three tools because it
reads a run's own durable record (journal.jsonl, per-agent transcripts) and
spends nothing. It exists because that record was unreachable: three
agents were diagnosed for hours as "hung" while their own transcripts said
`error_max_turns`.

`WORKSPACE_AUTO_TOOL_NAMES` auto-running all four is a product requirement,
not a convenience: ui-contract.md §5 says "The tool pills are real in v1",
so a permission card on every "what are the tasks here?" would be a
failure of the surface this story exists to build. Filing a task is
PREPARE, never COMMIT (NFR-OW-2): no workspace tool accepts anything,
deletes anything, promotes a sub-task or changes lane structure, and story
5.1's AC8 asserts each of those absences.

These three tuples (plus `BROWSER_READ_TOOL_NAMES`) are FULLY QUALIFIED
(`mcp__workspace__*`), unlike `invariants.test.ts`'s `MCP_INVENTORY`, which
pins the BARE names. The asymmetry is real and getting it wrong is silent:
`BASE_ALLOWED_TOOLS` is matched against what the SDK reports, which is the
qualified form, so bare names here would produce tools that never auto-run
AND that `resolveSessionProfile`'s runtime filter drops without a word.

## `BASE_ALLOWED_TOOLS`

Twenty-four names: the six built-in read/web tools, then loom's, then
ultra's three, then the workspace store's four. It was TWENTY until story
5.1, when the workspace tools joined — and the twenty were exactly the
route's own literal order, which is where this tuple's ordering came from.
`unionOrdered` preserves that order and the fold filters without
reordering, so a resolved non-escalation `allow` comes out
element-for-element identical to the array it is derived from. Order is
irrelevant to the SDK; it matters because it makes the equivalence
assertion a `toEqual` on arrays rather than an argument about sets. The
workspace names go LAST, so the first twenty still reproduce the route's
old array exactly and the growth is visible as a suffix rather than as a
reshuffle.

It was SIX until story 2.2. Six meant a spec could name only six of twenty
and the route had to keep composing the other fourteen — and any
composition the route keeps is a place a future profile cannot narrow.
Growing it is what makes `toolPolicy` the whole truth about tool grants,
which is what AD-10 wants it to be.

The alternative — PARAMETERISING the base set so the surface passes its own
vocabulary in — was rejected and must stay rejected: `BaseAllowedTool` is
derived FROM this tuple, so a parameterised base widens the element type
back to `string`, over-granting compiles, and INV-6b's
`expect(allow?.type).toBe("readonly BaseAllowedTool[]")` becomes a true
statement about a dead mechanism.

**Deviation from the house shape, and it is load-bearing:** this const
carries `as const` and NO `readonly BaseAllowedTool[]` annotation, unlike
`ADMISSION_CLASSES` or `SESSION_KINDS`. The annotation would erase the
literal types, and the literal types are the entire mechanism behind AC3 —
`BaseAllowedTool` is derived FROM this tuple, so an annotated const would
widen the element type back to `string` and make over-granting compile.

## `ToolPolicy`, enforced twice

The type cannot express "grant a tool the base policy denies". `allow` is
keyed to the BASE union, so a name outside it is not assignable; `deny` may
name anything, because denying more is always safe; there is no third
field. AD-10 — it "may deny more, never grant more — enforced by its type,
which carries deny lists and allow-narrowing only. No profile field can
re-enable an accept path." The alternative rejected in the spine is review:
"'we will review for it' is not a mechanism."

Enforced TWICE, which is AD-1's own doctrine applied one level down: the
type forbids authoring a widening, and `resolveSessionProfile` intersects
against `BASE_ALLOWED_TOOLS` again at runtime, so an `as` cast, a
`JSON.parse` or a future deserialization boundary cannot widen either.

## `SessionProfileSpec` — what a surface authors, and what it cannot

Note what is NOT here, and that each absence is the guarantee rather than a
comment about it:

- no `guardrails` — a spec may only ADD restriction, via the two
  add-prefixed fields, so a mis-authored profile cannot hand back an empty
  guardrail set and widen access;
- no `cwd` — the context supplies it, so no profile can redirect where a
  session runs. STILL TRUE AFTER STORY 5.6: the project-less master got its
  `<TELAR_HOME>/workspace/home` from the ANCHOR REGISTRY (see the epic-5
  note above), which resolves a manifest per kind, rather than from a new
  spec field every other profile would also have gained;
- no field of any kind that could reach hook registration. INV-6a pins
  that.

## `SessionProfile` — what the resolver returns

AD-9's seven config fields, all folded, PLUS `kind`. Eight in total, and
the distinction is load-bearing for INV-6a's pin: `kind` is the REGISTRY
KEY, not session configuration, so it can carry no grant. Describe this as
"AD-9's seven plus the registry key", never as "seven".

`mcpServers` is a name-keyed `Record`, not an array. AD-9 writes
`mcpServers[]`, but the SDK, the chat route and core's own
`resolveProjectMcpServers` all key MCP servers by NAME because the SDK
requires the name as the key. Converting to an array and back would lose
the keys for no gain, and a record also makes duplicate names structurally
impossible.

`systemPromptAppendix` is `""` when none — no `undefined` at the seam. The
route's `systemPrompt` is ALWAYS `{ type: "preset", preset: "claude_code",
append?: string }`, so this text can only ever be added AFTER the SDK's
preset. A field that could REPLACE the preset would be a widening of
exactly the kind AD-10 forbids.

## `SessionResolutionContext`

`role` is kept alongside `kind` because a builder may want to distinguish
"no role sent" from "role sent and recognised" even though both can fold to
the same kind (see `sessionKindFromRole`'s under-detection note above).

`loomId` is only meaningful for steerer/escalation, and VALIDATED — the
route establishes it pre-stream by reading the resumed chat's persisted
link or checking a turn-1 wire seed against `getLoom(id)` AND
`loom.project === project`. A bad or foreign id never reaches here.

The contract INVERTED in story 2.2 and the inversion is the point: an
earlier version of this field's comment said "NOT validated pre-stream…
a builder must not treat this as a resolved loom id", which was true while
the route validated inside its stream closure. The steerer and escalation
builders now hand this id to `buildSteererContext`/`buildEscalationContext`,
so a builder that could reach an UNVALIDATED id would be a builder that can
read another project's loom. Whoever changes where this value comes from
owns that sentence.

`ultraAnnotated` is the composer Ultra chip's annotation for THIS TURN ONLY
(docs/plans/ultra-harness.md §4 — "opt-in is a REQUEST, not a behavior
flag"; never a stored or session-level flag). It reaches the context
because the note it produces is part of the system-prompt appendix, and the
old route composed that note as
`ultraAnnotated && !isEscalationSession ? … : ""` — a session-kind
conditional. Moving the note into the builders is what removes it; that
requires the per-turn flag to reach them. REQUIRED, not optional,
deliberately: an omission would silently drop the user's explicit ask, and
"silently drop the thing that made this turn what it is" is the exact
failure AD-11 exists to end.

`sessionId` is the SDK session id this turn belongs to, when there is one.
Added by story 4.1 (Track D) so a builder can compose per-turn context keyed
by session — concretely, the completed-Ultra-run block that FR-UW-1's
mid-conversation half (AC2) requires. OPTIONAL, unlike `ultraAnnotated`, and
the asymmetry is deliberate: an omission here drops nothing the user asked
for. Turn 1 of a fresh session genuinely has no id yet (the SDK mints it
inside the stream), and a session with no id has no pending wakes BY
CONSTRUCTION — a wake exists only for a run whose manifest already names a
session.

Both `ultraAnnotated` and `sessionId` are safe with respect to INV-6a: that
invariant pins the field sets of `SessionProfile` and `SessionProfileSpec`,
NOT this type. Adding a field to `SessionResolutionContext` breaks nothing.

**Forward owner note:** three tracks now push per-turn context through this
type one field at a time. The clean end state is a contributor registry any
module can add an appendix fragment to; it is recorded in
`deferred-work.md` with epic 5's project-less master profile as owner,
because that is the first story with a reason to pay for it. STORY 5.6 DID
NOT PAY FOR IT AND COULD NOT HAVE: the master profile carries NO appendix
at all (its words — the briefing bands, the receipt, the desk — are the
later stories in that epic), so it added no field to this type and the
item's ownership moves to whichever of those stories first composes the
master's prompt from more than one source.

## The registry

Modelled on `event-bus.ts`'s `declareEvents`, because it is the same shape
and that design is already paid for. It is a REGISTRY and not a switch or a
`Record<SessionKind, Builder>` table for one concrete reason: WORK-SPLIT
gives tracks D, E and F "a SessionProfile" as their seam and gives them no
write access to this file. A switch would mean every new session kind edits
the resolver.

A duplicate kind is a real collision — two modules each believing they
define what a "steerer" session is — not a last-writer-wins convenience.
Throwing is the only way the second module ever finds out.

**A SECOND REGISTRY SITS BESIDE IT SINCE STORY 5.6** — `registerSessionAnchor`
/ `resolveSessionAnchor`, same key, same idioms (module-scope registration,
throw on duplicate, throw on unresolved, cleared by the same
`resetSessionProfiles()` seam). It answers the other half of "what is this
session", the half the fold cannot: WHAT IT RUNS AGAINST. A surface now
registers both halves in the same function, and a kind that registers only
one fails in the route's pre-stream preamble rather than mid-turn.

`resetSessionProfiles` is a test seam, exported for exactly the reason
`resetBus()` and `resetAdmission()` are: bun runs EVERY test file in one
process, so this module-scope `Map` leaks across suites and a
duplicate-registration throw from one file would take down another, in an
order that is not stable.

## The fold, in `resolveSessionProfile`

Guardrails UNION; they never replace. A spec asking for nothing still gets
the manifest's entries, which is what makes "no profile field can widen a
grant" true of guardrail data and not only of `toolPolicy`.

`deny` ALWAYS wins over `allow`, matching the SDK's own documented
guarantee that a disallow beats any allow rule — the one lever the app has
against a repo widening its own access.

**The guardrail's deny set is unioned in, manifest entries first**, so the
manifest's own ordering is what a reader sees. Before story 2.2 the chat
route composed `[...manifest.guardrails.disallowedTools, "AskUserQuestion",
…extras]` itself, which meant a consumer of `toolPolicy.deny` alone would
have silently received HALF the deny set. One field, one read, no chance of
dropping the project's own configuration.

**The redundancy is deliberate** and a reviewer will otherwise read it as
duplication: afterwards `guardrails.disallowedTools ⊆ toolPolicy.deny`, and
BOTH fields are consumed, for DIFFERENT mechanisms. `guardrails` feeds
`makeGuardrailDecision` (the PreToolUse hook and `canUseTool`, and it is the
only carrier of `protectedPaths`); `toolPolicy.deny` feeds the SDK's own
`disallowedTools`. That is AD-1's "enforced twice" applied one level down —
two independent gates on the same rule, so neither one going quiet takes
the rule with it.

**The one case where this CHANGES the resolved value**, stated because it
is the sharpest test of the port's faithfulness: if the manifest denies a
BASE tool (say "Read"), the "deny beats allow" filter now drops it from
`allow`. The route used to pass "Read" in BOTH arrays and lean on the SDK's
disallow-wins guarantee. Same outcome by a different route — and a tool
that is neither allowed nor denied falls through to `canUseTool`, where
`makeGuardrailDecision` denies it on that same manifest entry.

`cwd` comes from the CONTEXT, never from the spec — so no profile in this
story can redirect where a session runs. See the epic-5 forward note above.

## `unmetCapabilities`

Pure, and deliberately HTTP-ignorant: it returns names and NEVER throws and
NEVER formats a response. AD-11 says the failure "matches the route's
existing pre-SSE 400", so the response has to be shaped by the route, which
owns that vocabulary — and a thrown error crossing into a route handler
would need a try/catch the surrounding code does not use for this class of
failure.
