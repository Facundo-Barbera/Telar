// The SessionProfile port (AD-9/AD-10/AD-11): session configuration resolved
// ONCE, before the route body runs, as typed data rather than as another branch
// through a 1900-line handler.
//
// WHAT IT REPLACES. apps/web/app/api/chat/route.ts computes session shape
// inline: `manifest = getProject(project).manifest`, then `const workspace =
// manifest.root` feeds cwd, guardrails and settingSources for both providers,
// and three role-derived flags (isPlannerSession, isSteererSession,
// isEscalationSession) branch the systemPrompt, allowedTools and
// disallowedTools that follow. Those first three values are literally AD-9's
// first three profile fields, which is why AD-9 calls this a REFACTOR of what
// the handler already builds rather than a new concept. Three epics are queued
// to add a fourth, fifth and sixth session kind against that shape. Without
// this port each of them adds another `if` to the one file the Human-Accept
// Moat rides on.
//
// THE TRADE-OFF, stated plainly, because it is the decision most likely to be
// re-litigated: making session config DATA is exactly the move that could turn
// a structural invariant into a configurable one. AD-10 names the failure —
// "the moat degrading from structural to configurable; a mis-authored profile
// silently omitting it." Three properties, not the field list, are what keep
// that from happening, and every one of them is enforced rather than reviewed:
//
//   (1) The PreToolUse guardrail is wired OUTSIDE the profile and runs for
//       every session regardless of profile. No field here can reach hook
//       registration — there is no `hooks`, no `canUseTool`, no
//       `permissionMode`, no `skipGuardrail`, and INV-6a in
//       packages/core/test/invariants.test.ts pins the field set to exactly
//       eight names so adding one is a deliberate act that fails a test.
//   (2) ToolPolicy is intersect-only BY ITS TYPE (see below), not by review.
//       The spine's own words: "'we will review for it' is not a mechanism."
//   (3) An unmet capability is a hard error BEFORE the stream opens
//       (unmetCapabilities + the route's existing pre-SSE 400). AD-11: "No
//       silent degradation, ever."
//
// The rejected alternative was a nominal/branded SessionProfile that only the
// resolver could mint. Core has no branded-type precedent (grepped: zero
// `unique symbol`, zero `__brand`, zero phantom type parameters) and the house
// mechanism for "this cannot be expressed" is the enumerable union. It is also
// unnecessary: toolPolicy is the ONLY tool-granting field, and its own type
// forbids widening whether or not the enclosing object came from the resolver.
//
// SCOPE. This resolves; it does not apply. Story 2.1 landed the port and the
// capability gate; story 2.2 MIGRATED THE LIVE PATH ONTO IT, so the route no
// longer computes cwd/guardrails/settingSources/allowedTools/disallowedTools/
// systemPrompt a second time — it reads the resolved profile. That is why
// BASE_ALLOWED_TOOLS below now names the whole auto-run vocabulary and why the
// fold unions the manifest's deny set into `toolPolicy.deny`: a consumer reads
// ONE field per decision and cannot drop half of it. What is still NOT here is
// `mcpServers` — the route's set is built by CONSTRUCTING in-process MCP
// servers that close over a variable the SDK mutates mid-stream, which is a
// side effect and not data. Epic 5's project-less master profile is the story
// with a reason to pay for that restructure; until then every spec omits the
// field and it resolves to {}.
//
// AD-5/AD-20: this module owns NO state subtree and composes NO path off
// TELAR_HOME. It reads no env, opens no file, and imports none of node:fs,
// node:os or node:path. That is not incidental tidiness — INV-3a pins the
// TELAR_HOME path-composition inventory at an exact list of named sites, and a
// module that resolved the state root would have to be added to it. Everything
// path-shaped arrives already resolved, on the context. FORWARD NOTE FOR EPIC
// 5: AD-9's project-less master profile needs `cwd: <TELAR_HOME>/workspace/
// home`, so that story adds an optional `cwd` to the SPEC — and it must reach
// that subtree through the owning module's exported port, never by composing a
// path here.
//
// The whole module is PURE (the project's Design Law: deterministic control
// flow in code, non-determinism pushed to injected seams). No clock, no
// randomness, no I/O, no seams at all — the fold takes an already-read context
// and returns a value. That is why its suite needs no TELAR_HOME sandbox.
import type {
  McpServerConfig as SdkMcpServerConfig,
  PermissionMode,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectManifest, ProviderId } from "./schemas";
import { providerCapabilities, type ProviderCapability } from "./providers";

// --- The kinds ---------------------------------------------------------------

// The four session kinds that exist TODAY, named from the chat route's own
// vocabulary: the wire `role` is "planner" | "steerer" | "escalation" |
// undefined, and undefined is the ordinary project session.
//
// The union stays CLOSED even though registration (below) is open. A new kind
// adds a member here — one line, in core, reviewed — and registers its builder
// in the owning surface's own file. That split is honest about who owns what:
// the TYPE is a contract core owns; the DATA is the surface's. Epic 5's master
// profile and epic 6's node/steerer profiles both land that way, and neither
// has to edit the resolver to do it.
export type SessionKind = "project" | "planner" | "steerer" | "escalation";

// Every value the union can take, in one place, so a test can enumerate the
// whole space (the ADMISSION_CLASSES idiom, admission.ts).
export const SESSION_KINDS: readonly SessionKind[] = [
  "project",
  "planner",
  "steerer",
  "escalation",
] as const;

// The wire `role` a chat request may carry. Mirrors the route's own narrowing:
// anything that is not one of these three collapses to undefined, so a stray
// value can never be mistaken for a real loom turn.
export type SessionRole = "planner" | "steerer" | "escalation";

// Which kind a request is, from what the WIRE reliably carries — and nothing
// else.
//
// This deliberately under-detects. It is the WIRE NARROWING and it is still
// correct for what it does: given a raw role and no other input, this is the
// kind. It is NOT what the chat route resolves a session with any more — story
// 2.2 hoisted `existingChat` and the loom-link validation into the pre-stream
// preamble and the route now calls resolveSessionKind below, which sees the
// persisted role too. The objection story 2.1 recorded against that hoist ("a
// real store read added to the hot path") dissolved on measurement: getChat
// already ran on every resumed turn and getLoom on every turn-1 steerer/
// escalation seed, so the hoist moves two reads EARLIER in the same request
// rather than adding one.
//
// Kept exported because it is the correct answer to a different question, and
// because it is the shape a caller with only a wire role (a future surface, a
// test, a non-chat entry point) needs. Under-detection remains the safe
// direction wherever it is used: `project` requires NO capability, so a
// mis-detected session gets a weaker requirement and never a spurious 400.
export function sessionKindFromRole(role?: string): SessionKind {
  return role === "planner" || role === "steerer" || role === "escalation" ? role : "project";
}

// "Which strings are session roles", in ONE place. It was written twice before
// story 2.2 — the chat route's eight-line `rawRole` ternary and
// sessionKindFromRole above — and resolveSessionKind below became the third
// consumer of the same fact. One home, three readers.
//
// Anything that is not one of the three collapses to undefined, so a stray or
// hostile wire value can never be mistaken for a real loom turn. That is the
// route's own fail-safe idiom, moved rather than reinvented.
export function sessionRoleFromWire(raw: unknown): SessionRole | undefined {
  return raw === "planner" || raw === "steerer" || raw === "escalation" ? raw : undefined;
}

// The kind, from EVERYTHING the pre-stream preamble knows: the wire role, the
// merged session<->loom link's role, and the VALIDATED loom id.
//
// The precedence is measured from the chat route's own systemPrompt ternary
// chain — escalation, then steerer, then planner, then plain — and ORDER IS
// LOAD-BEARING. A session can satisfy two predicates at once: a resumed chat
// persisted as `steerer` whose client also sends `role: "planner"` matched both
// isSteererSession and isPlannerSession in the old route, and the chain
// resolved it as STEERER. An unordered Record or a set of independent `if`s
// would not reproduce that; this ordered fold does, and the collision case has
// its own test.
//
// THE SIGNATURE TAKES THE MERGED LINK, not the raw persisted role, and that is
// a decision rather than an accident: the route builds `loomLink` anyway (the
// loom MCP server mutates it during the turn and appendTurn reads it back), so
// re-deriving the persisted/wire merge inside core would duplicate logic that
// already has one home. `linkRole` is "planner" IFF the persisted role is —
// the route's fallback arm can only ever produce "steerer" or "escalation" —
// so `role === "planner" || linkRole === "planner"` is exactly the old
// `role === "planner" || existingChat?.role === "planner"`.
//
// `loomId` must be VALIDATED (the loom exists AND belongs to the anchoring
// project). A bad or foreign id leaves it undefined, which drops an escalation
// request to `project` — failing SAFE to a plain session, exactly as the route
// has always done, and never to a 400.
//
// Pure, like everything else here: no I/O, no clock, no seams.
export function resolveSessionKind(input: {
  // The narrowed WIRE role (sessionRoleFromWire above).
  readonly role?: SessionRole;
  // loomLink.role — the merged persisted/wire link role.
  readonly linkRole?: SessionRole;
  // loomLink.loomId — VALIDATED, never the raw wire value.
  readonly loomId?: string;
}): SessionKind {
  if (input.role === "escalation" && input.loomId) return "escalation";
  if (input.linkRole === "steerer") return "steerer";
  if (input.role === "planner" || input.linkRole === "planner") return "planner";
  return "project";
}

// --- The tool policy ---------------------------------------------------------

// The loom MCP server's AUTO-RUN tool names, declared HERE so a profile's
// `allow` can name them. The vocabulary is duplicated on purpose: the canonical
// registration lives in apps/web/lib/loom-mcp.ts's LOOM_AUTO_TOOLS and core
// cannot import apps/web without inverting the dependency. These are tool-name
// STRINGS, not an import of web code, and core already owns the loom domain
// (looms.ts, tick.ts), so the direction is unchanged.
//
// WHAT MAKES THE DUPLICATION SAFE is not care, it is a test:
// apps/web/lib/session-profiles.test.ts imports both copies and pins them
// against each other, so drift in either indicts the other. That file is the
// only place in the repo that can see both worlds.
//
// MOAT: `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are ABSENT, and
// the absence is the property. Both are human-gated commits (docs/loom-model.md
// §M.6 — the human's Approve click IS the provenance stamp), both are excluded
// from LOOM_AUTO_TOOLS for that reason, and keeping them out of this tuple
// makes them UNSPELLABLE in any profile's `allow`, enforced by the compiler
// rather than by review. That is strictly stronger than what existed before the
// tuple grew, and it has its own assertion.
export const LOOM_AUTO_TOOL_NAMES = [
  "mcp__loom__draft_bundle_file",
  "mcp__loom__propose_contract",
  "mcp__loom__read_bundle",
  "mcp__loom__list_looms",
  "mcp__loom__get_loom",
  "mcp__loom__steer_loom",
  "mcp__loom__reject_loom",
  "mcp__loom__answer_loom",
  "mcp__loom__resume_loom",
  "mcp__loom__cancel_loom",
  "mcp__loom__watch_loom",
] as const;

// The ultra MCP server's three auto-run tool names — same duplication contract,
// same anti-drift pin, canonical copy in apps/web/lib/ultra-mcp.ts's
// ULTRA_AUTO_TOOLS. All three auto-run (they spend nothing on their own; the
// script they launch is the thing that spends, and it goes through the same
// admission controller every other agent call does).
export const ULTRA_AUTO_TOOL_NAMES = [
  "mcp__ultra__ultra",
  "mcp__ultra__ultra_status",
  "mcp__ultra__ultra_stop",
] as const;

// The workspace MCP server's four auto-run tool names — same duplication
// contract, same anti-drift pin, canonical copy in
// apps/web/lib/workspace-mcp.ts's WORKSPACE_AUTO_TOOLS.
//
// ALL FOUR AUTO-RUN, and that is a product requirement rather than a
// convenience: ui-contract.md §5 says "The tool pills are real in v1", so a
// permission card on every "what are the tasks here?" would be a failure of the
// surface this story exists to build. It is also safe in the way LOOM_AUTO_TOOL_
// NAMES' exclusions are safe — there is no human-gated commit here to leave out.
// Filing a task is PREPARE, never COMMIT (NFR-OW-2): no workspace tool accepts
// anything, deletes anything, promotes a sub-task or changes lane structure, and
// story 5.1's AC8 asserts each of those absences rather than asserting them.
//
// FULLY QUALIFIED (`mcp__workspace__*`), like the two tuples above and UNLIKE
// invariants.test.ts's MCP_INVENTORY, which pins the BARE names. The asymmetry
// is real and getting it wrong is silent: BASE_ALLOWED_TOOLS is matched against
// what the SDK reports, which is the qualified form, so bare names here would
// produce tools that never auto-run AND that resolveSessionProfile's runtime
// filter drops without a word.
export const WORKSPACE_AUTO_TOOL_NAMES = [
  "mcp__workspace__list_items",
  "mcp__workspace__list_lanes",
  "mcp__workspace__create_item",
  "mcp__workspace__update_item",
] as const;

// Read-only access to the browser surface the human and agent share. The
// overloaded browser_tabs tool is intentionally absent because it can also
// create, select and close tabs; browser_list_tabs is the non-mutating alias.
export const BROWSER_READ_TOOL_NAMES = [
  "mcp__browser__browser_list_tabs",
  "mcp__browser__browser_snapshot",
  "mcp__browser__browser_take_screenshot",
  "mcp__browser__browser_console_messages",
  "mcp__browser__browser_network_requests",
] as const;

// The whole AUTO-RUN vocabulary a profile may narrow: the six built-in read/web
// tools, then the loom read/draft/lifecycle tools, then ultra's three, then the
// workspace store's four.
//
// TWENTY-FOUR names. It was TWENTY until story 5.1, when the workspace tools
// joined — and the twenty were exactly the route's own literal order, which is
// where this tuple's ordering came from. `unionOrdered` preserves that order and
// the fold filters without reordering, so a resolved non-escalation `allow` comes
// out element-for-element identical to the array it is derived from. Order is
// irrelevant to the SDK; it matters because it makes the equivalence assertion a
// `toEqual` on arrays rather than an argument about sets. The workspace names go
// LAST, so the first twenty still reproduce the route's old array exactly and the
// growth is visible as a suffix rather than as a reshuffle.
//
// It was SIX until story 2.2. Six meant a spec could name only six of twenty
// and the route had to keep composing the other fourteen — and any composition
// the route keeps is a place a future profile cannot narrow. Growing it is what
// makes `toolPolicy` the whole truth about tool grants, which is what AD-10
// wants it to be.
//
// The alternative — PARAMETERISING the base set so the surface passes its own
// vocabulary in — was rejected and must stay rejected: BaseAllowedTool is
// derived FROM this tuple, so a parameterised base widens the element type back
// to `string`, over-granting compiles, and INV-6b's
// `expect(allow?.type).toBe("readonly BaseAllowedTool[]")` becomes a true
// statement about a dead mechanism.
//
// DEVIATION FROM THE HOUSE SHAPE, and it is load-bearing: this const carries
// `as const` and NO `readonly BaseAllowedTool[]` annotation, unlike
// ADMISSION_CLASSES or SESSION_KINDS above. The annotation would erase the
// literal types, and the literal types are the entire mechanism behind AC3 —
// BaseAllowedTool is derived FROM this tuple, so an annotated const would widen
// the element type back to string and make over-granting compile.
export const BASE_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "ToolSearch",
  ...LOOM_AUTO_TOOL_NAMES,
  ...ULTRA_AUTO_TOOL_NAMES,
  ...WORKSPACE_AUTO_TOOL_NAMES,
  ...BROWSER_READ_TOOL_NAMES,
] as const;

export type BaseAllowedTool = (typeof BASE_ALLOWED_TOOLS)[number];

// MOAT: this type cannot express "grant a tool the base policy denies". `allow`
// is keyed to the BASE union, so a name outside it is not assignable; `deny`
// may name anything, because denying more is always safe; and there is no third
// field. AD-10 — it "may deny more, never grant more — enforced by its type,
// which carries deny lists and allow-narrowing only. No profile field can
// re-enable an accept path." The alternative rejected in the spine is review:
// "'we will review for it' is not a mechanism."
//
// Enforced TWICE, which is AD-1's own doctrine applied one level down: the type
// forbids authoring a widening, and resolveSessionProfile below intersects
// against BASE_ALLOWED_TOOLS again at runtime, so an `as` cast, a JSON.parse or
// a future deserialization boundary cannot widen either.
export type ToolPolicy = {
  readonly deny: readonly string[];
  readonly allow?: readonly BaseAllowedTool[];
};

// What the fold returns: both fields non-optional, so a consumer never has to
// interpret `undefined` as "everything" — the reading that would turn a missing
// field into a grant.
export type ResolvedToolPolicy = {
  readonly allow: readonly BaseAllowedTool[];
  readonly deny: readonly string[];
};

// --- The setting sources and the permission mode ------------------------------

// Native Claude sessions load the same complete setting stack as Claude Code:
// global user configuration, repository configuration, and local repository
// overrides. This is deliberately a harness-level constant rather than a list
// reconstructed by each surface. Restricted verifier/scoping agents continue
// to opt into `settingSources: []` at their own capability wall.
export const NATIVE_CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies readonly SettingSource[];

export type ProfileSettingSource = SettingSource;

// The permission modes a profile context may carry, derived from the SDK's own
// union rather than restated. The three excluded members are excluded for
// cause: "bypassPermissions" skips canUseTool entirely, and "plan"/"dontAsk"
// are not choices this product offers. The route already 400s all three; making
// the type narrower than the SDK's means a context cannot even carry one.
export type ProfilePermissionMode = Exclude<
  PermissionMode,
  "bypassPermissions" | "plan" | "dontAsk"
>;

// --- The two profile types ----------------------------------------------------

// What a surface AUTHORS. Note what is NOT here, and that each absence is the
// guarantee rather than a comment about it:
//   - no `guardrails` — a spec may only ADD restriction, via the two
//     add-prefixed fields below, so a mis-authored profile cannot hand back an
//     empty guardrail set and widen access;
//   - no `cwd` — the context supplies it, so in this story no profile can
//     redirect where a session runs;
//   - no field of any kind that could reach hook registration. INV-6a pins that.
export type SessionProfileSpec = {
  readonly kind: SessionKind;
  readonly settingSources: readonly ProfileSettingSource[];
  readonly mcpServers?: Readonly<Record<string, SdkMcpServerConfig>>;
  readonly toolPolicy: ToolPolicy;
  readonly requiredCapabilities: readonly ProviderCapability[];
  readonly systemPromptAppendix?: string;
  // Guardrail data the profile ADDS on top of the manifest's. The field NAMES
  // carry the guarantee, which is the cheapest form of it: there is no way to
  // spell "replace" here.
  readonly addDisallowedTools?: readonly string[];
  readonly addProtectedPaths?: readonly string[];
};

// What the RESOLVER returns — AD-9's seven config fields, all folded, PLUS
// `kind`. Eight in total, and the distinction is load-bearing for INV-6a's pin:
// `kind` is the REGISTRY KEY, not session configuration, so it can carry no
// grant. Describe this as "AD-9's seven plus the registry key", never as
// "seven".
export type SessionProfile = {
  readonly kind: SessionKind;
  readonly cwd: string;
  // manifest ∪ spec additions. Reuses core's zod-owned shape rather than
  // redefining it (AD-6: schemas for persisted entities are owned here and
  // never redefined).
  readonly guardrails: ProjectManifest["guardrails"];
  readonly settingSources: readonly ProfileSettingSource[];
  // A name-keyed Record, not an array. AD-9 writes `mcpServers[]`, but the SDK,
  // the chat route and core's own resolveProjectMcpServers all key MCP servers
  // by NAME because the SDK requires the name as the key. Converting to an
  // array and back would lose the keys for no gain, and a record also makes
  // duplicate names structurally impossible. Read `mcpServers[]` as "the set of
  // MCP servers", which this is.
  readonly mcpServers: Readonly<Record<string, SdkMcpServerConfig>>;
  readonly toolPolicy: ResolvedToolPolicy;
  readonly requiredCapabilities: readonly ProviderCapability[];
  // "" when none — no undefined at the seam. `Appendix` is the guarantee in the
  // name: the route's systemPrompt is ALWAYS
  // { type: "preset", preset: "claude_code", append?: string }, so this text
  // can only ever be added AFTER the SDK's preset. A field that could REPLACE
  // the preset would be a widening of exactly the kind AD-10 forbids.
  readonly systemPromptAppendix: string;
};

// What the pre-stream preamble already holds, handed to a builder. Everything
// here is a value the route has computed by the time the profile resolves —
// nothing is read, fetched or derived by this module.
export type SessionResolutionContext = {
  readonly kind: SessionKind;
  readonly provider: ProviderId;
  readonly manifest: ProjectManifest;
  readonly project?: string;
  // The RAW wire role, kept alongside `kind` because a builder may want to
  // distinguish "no role sent" from "role sent and recognised" even though both
  // can fold to the same kind (see sessionKindFromRole's under-detection note).
  readonly role?: SessionRole;
  // Only meaningful for steerer/escalation, and VALIDATED — this is the
  // resolved `loomLink.loomId`, which the route establishes pre-stream by
  // reading the resumed chat's persisted link or checking a turn-1 wire seed
  // against getLoom(id) AND `loom.project === project`. A bad or foreign id
  // never reaches here; it leaves the field undefined and the session falls
  // back to a plain one.
  //
  // The contract INVERTED in story 2.2 and the inversion is the point: this
  // comment used to say "NOT validated pre-stream… a builder must not treat
  // this as a resolved loom id", which was true while the route validated
  // inside its stream closure. The steerer and escalation builders now hand
  // this id to buildSteererContext/buildEscalationContext, so a builder that
  // could reach an UNVALIDATED id would be a builder that can read another
  // project's loom. Whoever changes where this value comes from owns that
  // sentence.
  readonly loomId?: string;
  readonly permissionMode: ProfilePermissionMode;
  // The composer Ultra chip's annotation for THIS TURN ONLY (docs/plans/
  // ultra-harness.md §4 — "opt-in is a REQUEST, not a behavior flag"; never a
  // stored or session-level flag). It reaches the context because the note it
  // produces is part of the system-prompt appendix, and the old route composed
  // that note as `ultraAnnotated && !isEscalationSession ? … : ""` — a
  // session-kind conditional. Moving the note into the builders is what removes
  // it; that requires the per-turn flag to reach them.
  //
  // REQUIRED, not optional, deliberately: an omission would silently drop the
  // user's explicit ask, and "silently drop the thing that made this turn what
  // it is" is the exact failure AD-11 exists to end. Every caller decides.
  //
  // Safe with respect to INV-6a: that invariant pins the field sets of
  // SessionProfile and SessionProfileSpec, NOT this type. Adding a field HERE
  // breaks nothing; adding one to either of those two is a deliberate act that
  // fails a test, and should stay that way.
  readonly ultraAnnotated: boolean;
  // The SDK session id this turn belongs to, when there is one. Added by story
  // 4.1 (Track D) so a builder can compose per-turn context keyed by session —
  // concretely, the completed-Ultra-run block that FR-UW-1's mid-conversation
  // half (AC2) requires: the outcome has to reach the model as context on the
  // NEXT turn, and the system-prompt appendix is the only per-turn channel that
  // exists today.
  //
  // OPTIONAL, unlike `ultraAnnotated` above, and the asymmetry is deliberate: an
  // omission here drops nothing the user asked for. Turn 1 of a fresh session
  // genuinely has no id yet (the SDK mints it inside the stream), and a session
  // with no id has no pending wakes BY CONSTRUCTION — a wake exists only for a
  // run whose manifest already names a session. So "absent" and "no wakes" are
  // the same fact, which is exactly when optional is the honest shape.
  //
  // Safe with respect to INV-6a for the same reason `ultraAnnotated` is: that
  // invariant pins the field sets of SessionProfile and SessionProfileSpec, NOT
  // this type. Adding a field HERE breaks nothing.
  //
  // FORWARD OWNER NOTE: three tracks now push per-turn context through this
  // type one field at a time. The clean end state is a contributor registry any
  // module can add an appendix fragment to; it is recorded in deferred-work.md
  // with epic 5's project-less master profile as owner, because that is the
  // first story with a reason to pay for it.
  readonly sessionId?: string;
};

// A surface's contribution: a pure function from the context to a spec.
export type SessionProfileBuilder = (ctx: SessionResolutionContext) => SessionProfileSpec;

// --- The registry -------------------------------------------------------------

// Modelled on event-bus.ts's declareEvents, because it is the same shape and
// that design is already paid for. It is a REGISTRY and not a switch or a
// Record<SessionKind, Builder> table for one concrete reason: WORK-SPLIT gives
// tracks D, E and F "a SessionProfile" as their seam and gives them no write
// access to this file. A switch would mean every new session kind edits the
// resolver.
const builders = new Map<SessionKind, SessionProfileBuilder>();

// A duplicate kind is a real collision — two modules each believing they define
// what a "steerer" session is — not a last-writer-wins convenience. Throwing is
// the only way the second module ever finds out.
export function registerSessionProfile(kind: SessionKind, build: SessionProfileBuilder): void {
  if (builders.has(kind)) {
    throw new Error(
      `session-profile: cannot register "${kind}" — a builder for that kind is already declared. ` +
        `Two modules each defining one kind would make session shape depend on import order, ` +
        `which is not stable. Rename the kind, or extend the existing builder in the module that owns it.`,
    );
  }
  builders.set(kind, build);
}

// Test seam, exported for exactly the reason resetBus() and resetAdmission()
// are: bun runs EVERY test file in one process, so this module-scope Map leaks
// across suites and a duplicate-registration throw from one file would take
// down another, in an order that is not stable. Call it in beforeEach.
export function resetSessionProfiles(): void {
  builders.clear();
}

// Which kinds currently have a builder. Exported so a caller (and a test) can
// see the registry's contents without reaching into the Map.
export function registeredSessionKinds(): readonly SessionKind[] {
  return SESSION_KINDS.filter((k) => builders.has(k));
}

// --- The fold -----------------------------------------------------------------

// Union, preserving order and dropping duplicates, first occurrence wins.
// Manifest entries are passed first everywhere this is used, so the manifest's
// own ordering is what a reader sees.
function unionOrdered(base: readonly string[], additions: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const v of base) if (!out.includes(v)) out.push(v);
  for (const v of additions) if (!out.includes(v)) out.push(v);
  return out;
}

// Resolve the profile for this request. Pure: no I/O, no clock, no state root.
//
// Throws only when no module has declared the kind — which, on the live path,
// means a surface forgot the side-effect import that runs its builders'
// registration at module scope.
export function resolveSessionProfile(ctx: SessionResolutionContext): SessionProfile {
  const build = builders.get(ctx.kind);
  if (!build) {
    const known = registeredSessionKinds();
    throw new Error(
      `session-profile: cannot resolve "${ctx.kind}" — no module declared it. ` +
        `Declared kinds: ${known.length > 0 ? known.join(", ") : "(none)"}. ` +
        `A builder registers at MODULE SCOPE, so the module that owns this kind has to be ` +
        `imported for its side effect before the first request reaches the resolver.`,
    );
  }
  const spec = build(ctx);
  if (spec.kind !== ctx.kind) {
    throw new Error(
      `session-profile: the builder for "${ctx.kind}" returned a spec for "${spec.kind}". ` +
        `The registry key and the spec's own kind are what a consumer joins on, so a mismatch ` +
        `would silently apply one kind's configuration under another kind's name. ` +
        `Return a spec whose kind matches the key it was registered under.`,
    );
  }

  // Guardrails UNION; they never replace. A spec asking for nothing still gets
  // the manifest's entries, which is what makes "no profile field can widen a
  // grant" true of guardrail data and not only of toolPolicy.
  const guardrails: ProjectManifest["guardrails"] = {
    disallowedTools: unionOrdered(ctx.manifest.guardrails.disallowedTools, spec.addDisallowedTools),
    protectedPaths: unionOrdered(ctx.manifest.guardrails.protectedPaths, spec.addProtectedPaths),
  };

  // The runtime half of AD-1's "enforced twice". The type already forbids
  // authoring an `allow` outside the base union; this intersects again so a
  // cast cannot widen. `deny` ALWAYS wins over `allow`, matching the SDK's own
  // documented guarantee that a disallow beats any allow rule — the route
  // states that guarantee in its own comment above `settingSources`, and it is
  // the one lever the app has against a repo widening its own access.
  //
  // THE GUARDRAIL'S DENY SET IS UNIONED IN, manifest entries first so the
  // manifest's own ordering is what a reader sees. Before story 2.2 the chat
  // route composed `[...manifest.guardrails.disallowedTools, "AskUserQuestion",
  // …extras]` itself, which meant a consumer of `toolPolicy.deny` alone would
  // have silently received HALF the deny set. One field, one read, no chance of
  // dropping the project's own configuration.
  //
  // THE REDUNDANCY IS DELIBERATE and a reviewer will otherwise read it as
  // duplication: afterwards `guardrails.disallowedTools ⊆ toolPolicy.deny`, and
  // BOTH fields are consumed, for DIFFERENT mechanisms. `guardrails` feeds
  // makeGuardrailDecision (our own PreToolUse hook and canUseTool, and it is
  // the only carrier of protectedPaths); `toolPolicy.deny` feeds the SDK's own
  // disallowedTools. That is AD-1's "enforced twice" applied one level down —
  // two independent gates on the same rule, so neither one going quiet takes
  // the rule with it.
  //
  // The one case where this CHANGES the resolved value, stated because it is
  // the sharpest test of the port's faithfulness: if the manifest denies a BASE
  // tool (say "Read"), the "deny beats allow" filter below now drops it from
  // `allow`. The route used to pass "Read" in BOTH arrays and lean on the SDK's
  // disallow-wins guarantee. Same outcome by a different route — and a tool
  // that is neither allowed nor denied falls through to canUseTool, where
  // makeGuardrailDecision denies it on that same manifest entry.
  const deny = unionOrdered(guardrails.disallowedTools, spec.toolPolicy.deny);
  const requested: readonly string[] = spec.toolPolicy.allow ?? BASE_ALLOWED_TOOLS;
  const allow = unionOrdered(requested).filter(
    (t): t is BaseAllowedTool =>
      (BASE_ALLOWED_TOOLS as readonly string[]).includes(t) && !deny.includes(t),
  );

  return {
    kind: ctx.kind,
    // From the CONTEXT, never from the spec — so no profile in this story can
    // redirect where a session runs. See the epic-5 forward note in the header.
    cwd: ctx.manifest.root,
    guardrails,
    settingSources: spec.settingSources,
    mcpServers: spec.mcpServers ?? {},
    toolPolicy: { allow, deny },
    requiredCapabilities: spec.requiredCapabilities,
    systemPromptAppendix: spec.systemPromptAppendix ?? "",
  };
}

// --- The capability check -----------------------------------------------------

// Which of this profile's required capabilities the provider does not publish.
// Empty means the session may proceed.
//
// Pure, and deliberately HTTP-ignorant: it returns names and NEVER throws and
// NEVER formats a response. AD-11 says the failure "matches the route's
// existing pre-SSE 400", so the response has to be shaped by the route, which
// owns that vocabulary — and a thrown error crossing into a route handler would
// need a try/catch the surrounding code does not use for this class of failure.
export function unmetCapabilities(
  profile: SessionProfile,
  providerId?: ProviderId,
): readonly ProviderCapability[] {
  const published = providerCapabilities(providerId);
  return profile.requiredCapabilities.filter((cap) => !published.includes(cap));
}
