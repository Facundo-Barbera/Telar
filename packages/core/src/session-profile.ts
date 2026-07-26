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
// SCOPE. This resolves; it does not apply. Story 2.1 lands the port and the
// capability gate. The live chat path still computes its own cwd/guardrails/
// settingSources/allowedTools inline — migrating it is story 2.2, deliberately
// behind its own gate because it is the change that touches production traffic.
// If you find yourself feeding a resolved toolPolicy into the route's
// `allowedTools`, that is 2.2, not this file.
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
// This deliberately under-detects, and under-detection is the safe direction.
// The route derives `existingChat` (a resumed session's persisted role) and
// `loomLink` INSIDE its stream closure, so nothing pre-stream can see them. A
// resumed planner or steerer session whose client omits `role` therefore
// resolves here as `project` — which requires NO capability, so it gets a
// weaker requirement and never a spurious 400. The opposite design (gating on a
// kind detectable only sometimes) produces a 400 that depends on whether the
// client happened to resend a field: a non-deterministic failure, which is
// worse than no gate at all.
//
// `escalation` is the one kind reliably knowable pre-stream, and the route says
// why in as many words: the client "sends it on every turn including reattached
// ones." So the wire role alone is sufficient — a validated loomId is NOT
// required here, because a Codex account cannot run an escalation session
// whether or not that id resolves.
//
// Do NOT "fix" this by hoisting the route's getChat call into the preamble.
// That is a real store read added to the hot path and a change to the validated
// pre-stream sequence; it is story 2.2's call, made when it migrates the kinds
// for real.
export function sessionKindFromRole(role?: string): SessionKind {
  return role === "planner" || role === "steerer" || role === "escalation" ? role : "project";
}

// --- The tool policy ---------------------------------------------------------

// The tools this port can name for itself, measured from what the chat route
// builds today for a non-escalation Claude session (its `allowedTools` array).
// The route's own list continues with ...LOOM_AUTO_TOOLS and
// ...ULTRA_AUTO_TOOLS, which are apps/web/lib constants: core importing them
// would invert the dependency, so they stay exactly where they are. A spec's
// `allow` therefore NARROWS these six and the MCP tool names stay in the route.
// That is a deliberate seam, not an oversight — story 2.2, which owns the
// migration, is where LOOM_AUTO_TOOLS/ULTRA_AUTO_TOOLS join the base union,
// either by moving those constants into core or by parameterising the base set.
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

// `user` is excluded BY TYPE, not by convention. The route's own comment
// records the decision: user-level settings stay out "on purpose (keeps the
// developer's personal config/tokens out of the subprocess)". A profile field
// that could re-add it would turn that decision into a setting — the same
// degradation AD-10 forbids for tool grants. Same utility-type family as
// critic.ts's Omit<> and runner/lease.ts's Pick<>.
//
// Stated honestly, because the type does NOT close it: settingSources
// ["project", "local"] still lets a repo's own settings.local.json widen its
// own access — it can grant permissions.allow or defaultMode:
// bypassPermissions, which the SDK honours BEFORE canUseTool is ever invoked.
// The route's comment spells this out as a deliberate, accepted trust decision.
// The mechanism holding against it is `disallowedTools`, which is why the fold
// below always feeds `deny` through and why guardrails union rather than
// replace.
export type ProfileSettingSource = Exclude<SettingSource, "user">;

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
  // Only meaningful for steerer/escalation, and NOT validated pre-stream — the
  // route validates it inside the stream closure. A builder must not treat this
  // as a resolved loom id.
  readonly loomId?: string;
  readonly permissionMode: ProfilePermissionMode;
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
  const deny = unionOrdered(spec.toolPolicy.deny);
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
