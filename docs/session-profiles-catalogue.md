# Track B's session-profile catalogue

`apps/web/lib/session-profiles.ts` is one `SessionProfileSpec` builder per
session kind that exists today, registered into `@telar/core`'s profile
registry at MODULE SCOPE. This document holds the full design reasoning; the
source file holds only the point-of-use notes.

## Why this file is separate from the port

`packages/core/src/session-profile.ts` owns the TYPE, the fold and the
registry; this file owns the DATA. The split is what lets tracks D, E and F
add a session kind without editing Track B's files — WORK-SPLIT gives each
of them "a SessionProfile" as their seam and no write access here, so a
switch statement in the resolver would have made every new kind a merge
conflict. They add a union member in core and register their builder in
their own module, exactly as this file does.

## The side-effect import, and why nothing else will do it for you

These builders register when this module is EVALUATED, and module scope
only runs if something imports the module. `app/api/chat/route.ts`
therefore carries a bare `import "@/lib/session-profiles";` alongside its
named imports. Without that line the registry is EMPTY at request time and
`resolveSessionProfile` throws on every chat request — and no gate would
catch it: there is no test file for `app/api/chat/route.ts` anywhere in the
tree, so `bun test`, `tsc` and lint all stay green while the app is broken.

This was the first self-registering module in the repo. It is NOT a
precedent for `packages/core/src/ultra/events.ts`'s shape, though —
`declareEvents` deliberately does the opposite, registering through a
self-healing accessor rather than at module scope, because it throws on
re-declaration and `resetBus()` clears the registry out from under a cached
handle. Read that file's header before copying either pattern; they are
answers to different problems.

## What 2.1 left inert, and what 2.2 filled in

Story 2.1 landed the resolver additively: the route resolved a profile for
every request but consumed only the capability gate, so three fields
carried no decision. Story 2.2 — the story that migrated the live chat path
onto these values — closed two of them and consciously kept the third:

- **`systemPromptAppendix` — CLOSED.** The three prompts moved out of the
  route into `@/lib/session-prompts` (they were module-private consts
  inside a Next.js route module whose only export is `POST`, which is
  exactly why 2.1 could not reach them), and each builder now composes its
  own appendix from the static prompt, the per-turn live-context read, and
  the Ultra note. This is where the route's four-arm `systemPrompt` ternary
  went.
- **`toolPolicy` — CLOSED.** core's `BASE_ALLOWED_TOOLS` grew from six names
  to the whole auto-run vocabulary, so `allow` can name every tool the route
  grants and the route composes NOTHING. `deny` now carries the manifest's
  own guardrail deny set too, folded in by the resolver. (It was twenty
  names when 2.2 closed this; story 5.1 appended the workspace store's four,
  so it is twenty-four today. The invariant is "the WHOLE vocabulary", not a
  number — read the tuple, never this document, for the count.)
- **`mcpServers` — STILL OMITTED**, a disclosed, measured deviation rather
  than an oversight. The route's set is
  `{ loom, ultra, ...resolveProjectMcpServers(project) }` and it is
  UNCONDITIONAL — it does not branch on session kind, so AC1 never required
  moving it. Building it is a SIDE EFFECT and not data:
  `createLoomMcpServer`/`createUltraMcpServer` close over
  `getSessionId: () => capturedSession`, a variable the SDK's `system:init`
  message mutates INSIDE the stream. A pure builder cannot produce that
  without restructuring how the session id is threaded, which has more
  blast radius than this whole story. FORWARD OWNER: epic 5's project-less
  master profile is the first kind that genuinely needs a different MCP
  set, and it is the story with a reason to pay for the restructure.

## `buildProjectProfile`

The ordinary project session — no `role` on the wire. This is also where a
session lands when its kind cannot be detected pre-stream (a resumed
planner or steerer whose client omitted `role`), which is exactly why it
must require NOTHING: under-detection then yields a weaker requirement and
never a spurious 400. AC5 depends on it too — a project session has to keep
working unchanged on BOTH providers.

`toolPolicy.allow` is OMITTED here and on planner/steerer, and the omission
is the measured truth rather than a shortcut: an absent `allow` resolves to
the WHOLE base set, and the route's own non-escalation `allowedTools` array
was exactly `BASE_ALLOWED_TOOLS`'s FIRST TWENTY names, in the same order —
the twenty core held when story 2.2 migrated the live path onto this port.
Story 5.1 appended the workspace store's four, so the base set is now a
strict SUPERSET of that historical array rather than equal to it, and
`session-profiles.test.ts` pins both halves separately. Writing
`allow: [...BASE_ALLOWED_TOOLS]` would say the same thing while adding a
second place for the two to drift apart. Only escalation narrows.

The loom, ultra and workspace auto-tools are NOT gated on being a loom
session — a plain project session with no loom link gets the identical set.
Measured from the route's own array, which branched only on
`isEscalationSession`.

The `ultraAnnotationNote` handling is the route's old fallthrough arm:
`ultraAnnotationNote ? { …append } : { }`. `""` when the composer's Ultra
chip is off, which is every ordinary turn. `sessionId` (story 4.1) carries
the completed-Ultra-run block; undefined on turn 1 of a fresh session,
which is correct — the SDK mints the id inside the stream, and a session
with no id has no pending wakes by construction.

**Story 4.2 / AC8 — `ctx.provider` reaches a composer for the first time
here.** The gate for the script-authoring reference has to live in the
BUILDER and not in the composer, for a mechanical reason: `ctx` is the
builder's argument and NOTHING ELSE IN THE TREE HOLDS IT —
`projectAppendix`/`plannerAppendix`/`steererAppendix` take
`{ ultraAnnotated, sessionId, readWake }` and have no provider in scope.

No `requiredCapability` is added for the provider gate, deliberately:
`buildProjectProfile.requiredCapabilities` is `[]` and a project session is
asserted to pass the gate on BOTH providers (AC5 of story 2.1); adding one
to "fix" the Codex case would 400 every ordinary Codex session. Codex
simply gets no reference, which is the correct degradation — it is offered
no ultra tools either.

## `buildPlannerProfile`

The Loom planning session (docs/loom-model.md §5). The route's own comment
on `isPlannerSession` is the whole definition of this kind: the flag
"Drives ONLY the appended system-prompt guidance below — never loom tool
access/gating." So the appendix IS the kind, and on Codex there is no
`systemPrompt` option at all — a planner session there silently becomes a
plain session. Textbook AD-11 silent degradation, which is why this
requires `system-prompt-append` and deliberately does NOT require
`mcp-servers`: requiring a capability the kind does not use would gate it
on something irrelevant.

The appendix was `""` in 2.1 and 2.2 supplies it, from
`@/lib/session-prompts`'s `PLANNER_SYSTEM_PROMPT` — the const the route
used to hold privately. This is the arm of the route's `systemPrompt`
ternary guarded by `isPlannerSession`, moved intact: static guidance plus
the per-turn Ultra note, in that order.

**No longer pure**, and an earlier version of this comment said it was.
Story 4.1 added the completed-Ultra-run block, which is a live read of the
ultra subtree, to project, planner AND steerer — an Ultra run can be
launched from any of the three, so the outcome has to be able to come back
to any of the three. Planner performs exactly one live read, wrapped in its
own `safeLiveContext`, and a failure of it degrades to the static prompt.

## `buildSteererProfile`

The embedded steering session (the loom Chat tab). Same reasoning as
planner, from the same comment: the steerer flag drives "ONLY the appended
system-prompt guidance + live-context block below, never loom tool
access/gating (which stays exactly as wired)". The appendix plus its
live-context block is the distinguishing content, and it is exactly what
Codex drops.

The appendix embeds a PER-TURN LIVE READ — `buildSteererContext(loomId)`
walks the loom's bundle for the objective, contract and steering log —
which is why 2.1 could not supply it and why THIS BUILDER IS NOT PURE. That
is the one stated property this story bends, and it is the honest trade:
the kind → live-context mapping IS the registry, and any design that keeps
the read in the route puts the branch back in the route. The read is still
once per turn (one POST = one turn); it simply happens pre-stream now,
which is why `session-prompts.ts` wraps it fail-safe.

`ctx.loomId` is the VALIDATED loom id (the route resolves it against
`getLoom` + `loom.project === project` before the profile resolves), not
the raw wire value. A builder that could reach an unvalidated id is a
builder that can read another project's loom.

## `buildEscalationProfile`

The blocked-loom escalation chat (M11.3): a read-only loom toolset plus the
`answer_blocked`-only write path. Provably impossible on Codex, and this is
the measurement rather than a guess: the `provider === "codex"` fork
returns before `createLoomMcpServer` is ever reached, so there are NO loom
tools at all, and `answer_blocked`'s human gate is a `PreToolUse` comparison
that does not run on that branch. An escalation session on a Codex account
is non-functional today and says nothing about it — which is the silent
degradation AD-11 exists to end.

`allow` IS the route's escalation branch, spread from the same constant the
route used: `allowedTools: [...LOOM_ESCALATION_READONLY_TOOLS]`. All six
names — Read, Grep, Glob plus the three `mcp__loom__` read tools — are in
core's grown `BASE_ALLOWED_TOOLS`, so this spread TYPECHECKS against
`readonly BaseAllowedTool[]`, and that compile is itself the proof that the
base union covers the escalation toolset. (apps/web test files ARE seen by
`bunx tsc --noEmit` in this workspace, so no fixture spawn is needed for a
web-side compile claim.)

It shipped as `allow: []` in 2.1's first pass, on the claim that NONE of
core's six base tools appeared in that array; three did. It was corrected
to three names, and this story replaces the three with the whole six by
spreading the constant instead of restating any of it. The failure mode is
worth naming because it is the reason every expectation in the suites
derives from a constant: nothing consumed `toolPolicy` in 2.1, so no test
and no request could contradict a wrong value. This story is the first
consumer — an empty or short `allow` would now silently strip project
inspection from every escalation session, which is precisely what
`ESCALATION_SYSTEM_PROMPT` tells the agent to do ("Read / Grep / Glob —
inspect the project root").

`deny` is the route's escalation `disallowedTools` tail: `AskUserQuestion`,
the nine state-changing loom tools, and all three ultra tools. The resolver
folds the project manifest's own `guardrails.disallowedTools` in front of
these, so this array is the ADDITION and never the whole set.

**MOAT:** `mcp__loom__answer_blocked` is in NEITHER list. It stays
callable-but-human-gated — the only escalation write path, force-routed to
the interactive card by the route's `PreToolUse` hook in every permission
mode. A port that "tidies" it into `allow` breaks the moat; one that tidies
it into `deny` breaks the surface. It is also unspellable in `allow` by
type, because core deliberately kept it out of `BASE_ALLOWED_TOOLS`.

The appendix is `ESCALATION_SYSTEM_PROMPT` plus a per-turn live read, and
NEVER an Ultra note — `escalationAppendix` has no `ultraAnnotated` parameter
at all, so that is enforced by the signature rather than remembered.
Measured from the route's own `ultraAnnotated && !isEscalationSession`.

**Story 5.1 — a correctness fix, not a convenience,** for `WORKSPACE_AUTO_TOOLS`
being denied here: the same argument as the `ULTRA_AUTO_TOOLS` deny above.
The route's `mcpServers` literal is UNCONDITIONAL (its own comment records
story 2.2 correcting a claim to the contrary), so the workspace server IS
registered for an escalation session. This builder sets `allow` EXPLICITLY,
so growing core's `BASE_ALLOWED_TOOLS` does not reach it — which would leave
the four workspace names in NEITHER list, falling through to `canUseTool`:
an interactive permission card offering a WRITE path on what this profile's
own comment calls a narrow read-only discuss wall. Denying them makes them
truly uncallable (the SDK guarantees a disallow beats any allow).

## `buildMasterProfile` (story 5.6)

SPEC-organization-workspace's CAP-1 receptionist: the first session kind in
Telar anchored to NO project. Everything it supplies is fixed by that
spec's story 6, and every line of it is in the builder rather than in the
route — AD-9's own case, "a new surface adds a profile, it does not add an
`if`".

**`settingSources: []`** — zero ambient config discovery, and the only
builder here that is not `NATIVE_CLAUDE_SETTING_SOURCES`. `brownfield.md`'s
harness finding: the master must not inherit the operator's `~/.claude` or
some checkout's `.mcp.json`, because it is not IN a repo. The capability
`setting-sources` is deliberately NOT required — `[]` asks the harness for
nothing, so requiring it would 400 a provider over a feature this profile
switches off.

**`cwd` and default guardrails come from the ANCHOR, not from the spec.**
`<TELAR_HOME>/workspace/home`, resolved by `masterAnchor` in the same file
and reached through the workspace store's exported `workspaceHomeDir()`
(AD-5/INV-3a: that module owns the subtree and no other file composes a
path into it). The anchor calls `ensureWorkspace()` first, because a cwd
that does not exist is not a cwd — Claude Code tolerates an empty directory
but not a missing one, and Codex's `-C` requires it to exist. That call
creates `home/` as a SIBLING of `lanes.yaml` and `packets/`, which is what
makes SPEC.md's "the store above it stays outside the master's write
boundary" a fact about the filesystem rather than an intention. The
manifest is `ProjectManifest.parse`d, so "default guardrails" means
literally the schema's own defaults rather than a second copy of them
written out here. The full argument for why this is an anchor registry and
not a `cwd` field on `SessionProfileSpec` is in
`docs/session-profile-port.md`.

**NEVER A HOME DIRECTORY.** `brownfield.md`: "Never use /Users/facundo as
cwd — trust never persists there." Both harnesses key session history,
auto-memory and trust PER DIRECTORY, which is also the argument for ONE
stable directory over a throwaway scratch dir per turn: a stable home
accrues one continuous bucket, scratch dirs fragment it.

**`__master__`, the synthetic permissions key.** `apps/web/lib/permissions.ts`
stores allow-rules keyed by project name, and a session with no project
would otherwise key its rules under the string `"undefined"` — one shared
bucket every future project-less surface silently joins. The double
underscores are the guard: a project name is a registry key the user types.
It is ALSO the master manifest's `name`, so the master has exactly one
synthetic identity rather than two that can drift.

**The tool policy is an allow-NARROWING, like escalation's** and unlike the
three project kinds', because the master's MCP mount is narrower than
theirs. `allow` is `Read`/`Grep`/`Glob` plus `WORKSPACE_AUTO_TOOLS`, spread
from the constant rather than restated. Deliberately NOT the whole
six-name built-in head of `BASE_ALLOWED_TOOLS`: `WebSearch`/`WebFetch` are
the external-reference surface CAP-13 (story 12) will design, and a profile
that pre-granted them would make that story's decision for it. `deny` is
`AskUserQuestion`, every loom name — `LOOM_AUTO_TOOLS` plus the two moat
commits `start_loom` and `answer_blocked`, which are unspellable in `allow`
by type and would otherwise fall through to `canUseTool` as a permission
card for a server this session never mounts — and every ultra name.

**MOAT:** `mcp__workspace__weave_batch` is in NEITHER list, exactly as
`answer_blocked` is for escalation. In `allow` it would auto-run; in `deny`
the master's whole proposal surface would be gone. It stays
callable-but-human-gated (CAP-11 — approval-gated advance).

**No appendix, deliberately, and it is the story's own boundary.** Story 6
is "backend only — no briefing intelligence and no chat UI". The master's
words are stories 7, 9 and 10, and a placeholder paragraph written here
would be prompt text nobody designed. An omitted appendix resolves to `""`
and requires no `system-prompt-append` capability.

**Required capabilities are `mcp-servers`, `pre-tool-use-hooks` and
`tool-allow-deny-lists`** — the AD-11 gate that keeps a Codex-backed master
from silently becoming a session with no workspace at all (`runCodexTurn`
has no MCP plumbing; brownfield.md's gap, story 13's work).

## The anchors, and the MCP mount

Since story 5.6 `registerSessionProfiles()` registers TWO things per kind:
the builder above, and an ANCHOR (`registerSessionAnchor`) that answers
what the session runs against. Every project-anchored kind shares one
resolver, which is the chat route's old `getProject(project).manifest`
moved verbatim — same throw, same pre-SSE 400 — and returns the project
slug as its permissions key. A kind with a builder and no anchor 500s in
the route's pre-stream preamble; the suites assert the two lists are equal.

Which MCP servers a kind mounts is a THIRD registry,
`apps/web/lib/session-mcp.ts`, and it is a registry of FACTORIES rather
than a profile field: those servers are constructed once per session
runtime and close over live getters (#28), while a profile builder runs
eagerly before the stream opens and can only produce values. The project
mount is the route's own four-server literal (loom, ultra, workspace,
browser); the master mounts the workspace server ALONE and UNSCOPED — the
cross-project view CAP-1's briefing needs, and a property of how the server
was built rather than of anything a tool argument may ask for.
