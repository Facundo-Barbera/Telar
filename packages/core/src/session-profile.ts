// The SessionProfile port (AD-9/AD-10/AD-11): session configuration resolved
// ONCE, before the route body runs, as typed data rather than as another branch
// through a 1900-line handler. Full design reasoning — what this replaces in
// apps/web/app/api/chat/route.ts, the AD-10 trade-off and the three enforced
// properties that keep it from degrading, why `mcpServers` is still not here,
// and the AD-5/AD-20 no-state-root-composition argument — lives in
// docs/session-profile-port.md; keep this file to point-of-use notes only.
//
// THE THREE PROPERTIES A CHANGE HERE MUST NOT BREAK (AD-10's moat, enforced
// rather than reviewed):
//   (1) No field can reach hook registration — INV-6a pins this module's two
//       public types to exactly eight field names combined, so adding one is
//       a deliberate act that fails a test.
//   (2) ToolPolicy is intersect-only BY ITS TYPE (see below), not by review.
//   (3) An unmet capability is a hard error BEFORE the stream opens
//       (unmetCapabilities + the route's existing pre-SSE 400).
//
// AD-5/AD-20: this module owns NO state subtree and composes NO path off
// TELAR_HOME — INV-3a pins the path-composition inventory at an exact list of
// named sites. Everything path-shaped arrives already resolved, on the
// context. The whole module is otherwise PURE: no clock, no randomness, no
// I/O, no seams — which is why its suite needs no TELAR_HOME sandbox.
//
// STORY 5.6 QUALIFIED THAT LAST SENTENCE IN EXACTLY ONE PLACE, and the
// qualification is worth stating precisely because the rest still holds: the
// ANCHOR REGISTRY at the bottom of this file STORES resolvers that do I/O (the
// project one reads the project registry; the master one ensures its own
// directory exists). This module still opens nothing itself, imports no
// node:fs/os/path, and composes no path — the master's cwd arrives through the
// workspace store's exported workspaceHomeDir(), which is the owner of that
// subtree. The fold below is unchanged and still pure.
import type {
  McpServerConfig as SdkMcpServerConfig,
  PermissionMode,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProjectManifest, ProviderId } from "./schemas";
import { providerCapabilities, type ProviderCapability } from "./providers";

// --- The kinds ---------------------------------------------------------------

// The session kinds that exist TODAY, named from the chat route's own
// vocabulary: the wire `role` is "planner" | "steerer" | "escalation" |
// "master" | undefined, and undefined is the ordinary project session.
//
// The union stays CLOSED even though registration (below) is open. A new kind
// adds a member here — one line, in core, reviewed — and registers its builder
// in the owning surface's own file. The TYPE is a contract core owns; the DATA
// is the surface's.
//
// "master" is SPEC-organization-workspace's project-less front door (its CAP-1,
// story 5.6), and it is the FIRST kind that is not anchored to a project. That
// is why this story also had to add the ANCHOR registry at the bottom of this
// file: every other kind derives its manifest from `getProject(project)`, which
// 400s when there is no project, and AD-9 says a new surface adds a profile
// rather than an `if` in the handler — so the derivation itself became
// per-kind data instead of a branch the route keeps.
export type SessionKind = "project" | "planner" | "steerer" | "escalation" | "master";

// Every value the union can take, in one place, so a test can enumerate the
// whole space (the ADMISSION_CLASSES idiom, admission.ts).
export const SESSION_KINDS: readonly SessionKind[] = [
  "project",
  "planner",
  "steerer",
  "escalation",
  "master",
] as const;

// The wire `role` a chat request may carry. Mirrors the route's own narrowing:
// anything that is not one of these four collapses to undefined, so a stray
// value can never be mistaken for a real loom turn — or, since story 5.6, for a
// project-less master turn.
export type SessionRole = "planner" | "steerer" | "escalation" | "master";

// Which kind a request is, from what the WIRE reliably carries — and nothing
// else. Deliberately UNDER-detects: it is NOT what the chat route resolves a
// session with any more (see resolveSessionKind below, which also sees the
// persisted role); it is kept exported as the correct answer for a caller
// with only a wire role. Under-detection stays the safe direction: `project`
// requires NO capability, so a mis-detected session degrades to a weaker
// requirement and never a spurious 400. Full reasoning:
// docs/session-profile-port.md
// "master" joins the pass-through arm rather than getting a case of its own:
// the wire word and the kind are the same word, exactly as they are for the
// three loom roles. What it does NOT do is change the fallback — an
// unrecognised role still lands on `project`, so the under-detection above
// still degrades toward the kind that requires no capability and anchors to a
// real project.
export function sessionKindFromRole(role?: string): SessionKind {
  return role === "planner" || role === "steerer" || role === "escalation" || role === "master"
    ? role
    : "project";
}

// "Which strings are session roles", in ONE place — resolveSessionKind below
// is the third consumer of this same fact (see docs/session-profile-port.md
// for the other two). Anything that is not one of the three collapses to
// undefined, so a stray or hostile wire value can never be mistaken for a
// real loom turn.
export function sessionRoleFromWire(raw: unknown): SessionRole | undefined {
  return raw === "planner" || raw === "steerer" || raw === "escalation" || raw === "master"
    ? raw
    : undefined;
}

// The kind, from EVERYTHING the pre-stream preamble knows: the wire role, the
// merged session<->loom link's role, and the VALIDATED loom id.
//
// PRECEDENCE ORDER IS LOAD-BEARING (master, escalation, steerer, planner,
// plain) —
// measured from the chat route's own systemPrompt ternary chain, including
// its collision case (a resumed steerer chat whose client also sends
// `role: "planner"` resolves as STEERER). An unordered Record or independent
// `if`s would not reproduce that. Full reasoning for the signature shape and
// the `loomId` fail-safe: docs/session-profile-port.md
//
// Pure, like everything else here: no I/O, no clock, no seams.
export function resolveSessionKind(input: {
  // The narrowed WIRE role (sessionRoleFromWire above).
  readonly role?: SessionRole;
  // The role this chat was PERSISTED with, when it is a resume (store.ts's
  // Chat.role). Story 5.6's review added it: see the master arm below.
  readonly persistedRole?: SessionRole;
  // loomLink.role — the merged persisted/wire link role. Never "master": a
  // master session has no loom to link to (see LoomLinkRole below).
  readonly linkRole?: LoomLinkRole;
  // loomLink.loomId — VALIDATED, never the raw wire value.
  readonly loomId?: string;
}): SessionKind {
  // MASTER FIRST, and the ordering is a statement about what the other three
  // are: every one of them is a LOOM role, and a loom belongs to a project the
  // master does not have. `linkRole` cannot be "master" by type and a master
  // request carries no validated `loomId` (validation checks
  // `loom.project === project`, and there is no project), so this arm cannot
  // collide with the three below — it is first for readability, not to win a
  // fight.
  //
  // IT READS `role` AND `persistedRole` AND NOTHING ELSE, WHICH IS THE WHOLE
  // POINT — those are exactly the two inputs the chat route also has BEFORE it
  // resolves the anchor. The route calls this function twice: once with just
  // those two (to pick the anchor, before a project exists to validate a loom
  // id against) and once with everything. The extra inputs the second call adds
  // can only sharpen the answer AMONG THE PROJECT-ANCHORED KINDS, so the two
  // calls can never disagree about the one distinction the anchor turns on.
  // That is the structural version of a claim story 5.6's first cut left to
  // coincidence — it derived the anchor kind from a DIFFERENT function
  // (sessionKindFromRole) and nothing pinned the two together.
  //
  // `persistedRole` is also what makes a master chat RESUMABLE. Wire-only was
  // the first cut's rule, defended as fail-safe; a review measured the failure
  // it is safe INTO — a master row carries no project, so a resumed turn whose
  // client omitted `role` anchored to `getProject("")` and 400'd. Reading the
  // row the session itself wrote is not trusting the client; the row was
  // written by this route.
  if (input.role === "master" || input.persistedRole === "master") return "master";
  if (input.role === "escalation" && input.loomId) return "escalation";
  if (input.linkRole === "steerer") return "steerer";
  if (input.role === "planner" || input.linkRole === "planner") return "planner";
  return "project";
}

// The three roles a SESSION<->LOOM LINK can hold — every session role except
// the master's, because a master session has no loom. Derived from SessionRole
// by Exclude rather than restated, so adding a project-less kind to the union
// above cannot silently make it spellable as a link role.
export type LoomLinkRole = Exclude<SessionRole, "master">;

// Narrow a session role to a loom link role. The chat route persists ONE role
// per chat (store.ts's Chat.role) and reads it back as both — this is the one
// place that conversion happens, so a project-less role can never be written
// into a loom link, and a future project-less kind gets the same treatment for
// free.
export function loomLinkRoleOf(role?: SessionRole): LoomLinkRole | undefined {
  return role === undefined || role === "master" ? undefined : role;
}

// --- The tool policy ---------------------------------------------------------

// The loom MCP server's AUTO-RUN tool names, declared HERE so a profile's
// `allow` can name them. Duplicated on purpose from apps/web/lib/loom-mcp.ts's
// LOOM_AUTO_TOOLS — core cannot import apps/web — and kept honest by a test:
// apps/web/lib/session-profiles.test.ts imports both copies and pins them
// against each other.
//
// MOAT: `mcp__loom__start_loom` and `mcp__loom__answer_blocked` are ABSENT.
// Both are human-gated commits (docs/loom-model.md §M.6), so keeping them out
// of this tuple makes them UNSPELLABLE in any profile's `allow`, enforced by
// the compiler rather than by review.
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

// The ultra MCP server's three auto-run tool names — same duplication
// contract as above, canonical copy in apps/web/lib/ultra-mcp.ts's
// ULTRA_AUTO_TOOLS. All three auto-run (they spend nothing on their own; the
// script they launch goes through the same admission controller every other
// agent call does).
export const ULTRA_AUTO_TOOL_NAMES = [
  "mcp__ultra__ultra",
  "mcp__ultra__ultra_status",
  "mcp__ultra__ultra_stop",
  // Reads a run's own durable record (journal.jsonl, per-agent transcripts)
  // and spends nothing, so it auto-runs on the same terms as the other
  // three. See docs/session-profile-port.md for why this tool exists.
  "mcp__ultra__ultra_inspect",
] as const;

// The workspace MCP server's four auto-run tool names — same duplication
// contract, canonical copy in apps/web/lib/workspace-mcp.ts's
// WORKSPACE_AUTO_TOOLS.
//
// ALL FOUR AUTO-RUN as a product requirement (ui-contract.md §5: "the tool
// pills are real in v1"), safe because filing a task is PREPARE, never COMMIT
// (NFR-OW-2) — no workspace tool accepts, deletes, promotes or restructures.
//
// FULLY QUALIFIED (`mcp__workspace__*`), UNLIKE invariants.test.ts's
// MCP_INVENTORY, which pins the BARE names — getting this asymmetry wrong is
// silent: a bare name here produces a tool that never auto-runs and that the
// runtime filter drops without a word. See docs/session-profile-port.md.
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

// The whole AUTO-RUN vocabulary a profile may narrow: the six built-in
// read/web tools, then loom's, then ultra's three, then the workspace
// store's four — TWENTY-FOUR names, in the route's own historical order
// (`unionOrdered` preserves it, so a resolved non-escalation `allow` comes
// out element-for-element identical to this array). Growing it is what makes
// `toolPolicy` the whole truth about tool grants (AD-10) rather than
// something the route still partially composes. Full history (six → twenty →
// twenty-four) and why a parameterised base set was rejected:
// docs/session-profile-port.md
//
// DEVIATION FROM THE HOUSE SHAPE, AND IT IS LOAD-BEARING: `as const` and NO
// `readonly BaseAllowedTool[]` annotation, unlike ADMISSION_CLASSES or
// SESSION_KINDS above. The annotation would erase the literal types that
// AC3's whole mechanism depends on — BaseAllowedTool is derived FROM this
// tuple, so an annotated const would widen the element type back to `string`
// and make over-granting compile.
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
// is keyed to the BASE union; `deny` may name anything (denying more is
// always safe); there is no third field. AD-10 — "may deny more, never grant
// more — enforced by its type… 'we will review for it' is not a mechanism."
//
// Enforced TWICE (AD-1's doctrine one level down): the type forbids
// authoring a widening, and resolveSessionProfile below intersects against
// BASE_ALLOWED_TOOLS again at runtime, so an `as` cast or a JSON.parse
// cannot widen either.
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
//   - no `cwd` — the context supplies it, so no profile can redirect where a
//     session runs. STILL TRUE AFTER STORY 5.6, which is the story
//     docs/session-profile-port.md predicted would add one: the project-less
//     master needed `cwd: <TELAR_HOME>/workspace/home` and got it from its
//     registered ANCHOR (below), which is the context's own source, rather
//     than from a field here that every other profile would also have gained;
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
// `kind`. Eight in total; `kind` is the REGISTRY KEY, not session
// configuration, so it can carry no grant — that split is what INV-6a's pin
// depends on. Describe this as "AD-9's seven plus the registry key", never as
// "seven".
export type SessionProfile = {
  readonly kind: SessionKind;
  readonly cwd: string;
  // manifest ∪ spec additions. Reuses core's zod-owned shape rather than
  // redefining it (AD-6: schemas for persisted entities are owned here and
  // never redefined).
  readonly guardrails: ProjectManifest["guardrails"];
  readonly settingSources: readonly ProfileSettingSource[];
  // A name-keyed Record, not an array — the SDK, the chat route and core's
  // own resolveProjectMcpServers all key MCP servers by NAME, and a record
  // also makes duplicate names structurally impossible.
  readonly mcpServers: Readonly<Record<string, SdkMcpServerConfig>>;
  readonly toolPolicy: ResolvedToolPolicy;
  readonly requiredCapabilities: readonly ProviderCapability[];
  // "" when none — no undefined at the seam. The route's systemPrompt is
  // ALWAYS { type: "preset", preset: "claude_code", append?: string }, so
  // this text can only ever be added AFTER the SDK's preset — a field that
  // could REPLACE the preset would be the kind of widening AD-10 forbids.
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
  // distinguish "no role sent" from "role sent and recognised" even though
  // both can fold to the same kind (sessionKindFromRole's under-detection).
  readonly role?: SessionRole;
  // Only meaningful for steerer/escalation, and VALIDATED against getLoom +
  // `loom.project === project` before this context is built — never the raw
  // wire value. A builder that could reach an unvalidated id is a builder
  // that can read another project's loom. (This contract INVERTED in story
  // 2.2 — see docs/session-profile-port.md before changing where this value
  // comes from.)
  readonly loomId?: string;
  readonly permissionMode: ProfilePermissionMode;
  // The composer Ultra chip's annotation for THIS TURN ONLY (docs/plans/
  // ultra-harness.md §4 — "opt-in is a REQUEST, not a behavior flag"; never a
  // stored or session-level flag). REQUIRED, not optional: an omission would
  // silently drop the user's explicit ask, the exact failure AD-11 exists to
  // end. Safe w.r.t. INV-6a — that invariant pins SessionProfile/
  // SessionProfileSpec's field sets, not this type.
  readonly ultraAnnotated: boolean;
  // The SDK session id this turn belongs to, when there is one (story 4.1 /
  // Track D) — lets a builder compose per-turn context keyed by session (the
  // completed-Ultra-run block FR-UW-1 requires). OPTIONAL, unlike
  // `ultraAnnotated` above: turn 1 of a fresh session genuinely has no id yet
  // (the SDK mints it inside the stream), and a session with no id has no
  // pending wakes BY CONSTRUCTION, so "absent" and "no wakes" are the same
  // fact. Also safe w.r.t. INV-6a, for the same reason.
  //
  // FORWARD OWNER NOTE: three tracks now push per-turn context through this
  // type one field at a time; the clean end state (a contributor registry) is
  // recorded in deferred-work.md with epic 5's master profile as owner.
  readonly sessionId?: string;
};

// A surface's contribution: a pure function from the context to a spec.
export type SessionProfileBuilder = (ctx: SessionResolutionContext) => SessionProfileSpec;

// --- The registry -------------------------------------------------------------

// Modelled on event-bus.ts's declareEvents — a REGISTRY and not a switch or a
// Record<SessionKind, Builder> table, because WORK-SPLIT gives tracks D, E and
// F "a SessionProfile" as their seam and no write access to this file. A
// switch would mean every new session kind edits the resolver.
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
//
// It clears BOTH maps — builders and anchors — because they are two halves of
// one registration (the module that declares a kind declares both), and a reset
// that emptied one would leave a suite able to resolve an anchor for a kind
// whose builder is gone. One seam, one meaning: "no kind is declared".
export function resetSessionProfiles(): void {
  builders.clear();
  anchors.clear();
}

// Which kinds currently have a builder. Exported so a caller (and a test) can
// see the registry's contents without reaching into the Map.
export function registeredSessionKinds(): readonly SessionKind[] {
  return SESSION_KINDS.filter((k) => builders.has(k));
}

// --- The anchor ---------------------------------------------------------------

// WHAT A SESSION IS ANCHORED TO, resolved BEFORE the profile and by the same
// registry idiom. Story 5.6 (SPEC-organization-workspace CAP-1) added it for
// the master session, which has NO project.
//
// The problem it solves, stated as the route used to state it:
// `manifest = getProject(project).manifest` inside a try/catch that returns a
// plain 400 — the "one hard coupling" of brownfield.md, and the thing that
// makes a project-less session impossible. AD-9 forbids the obvious fix ("a new
// surface adds a profile, it does not add an `if`"), and skipping the gate for
// one kind was refused outright by the story: the profile REPLACES the
// derivation for its kind rather than stepping past it. So the derivation moved
// here, keyed by kind, exactly like the builders.
//
// WHY IT IS A SECOND REGISTRY AND NOT A FIELD ON THE SPEC — the ordering makes
// it one. `manifest` is an INPUT to SessionResolutionContext: the fold reads
// `ctx.manifest.root` for `cwd` and unions `ctx.manifest.guardrails`, so a
// profile cannot supply what the profile is resolved from. Note what this
// preserves: `SessionProfileSpec` still has no `cwd` and no `guardrails`, so
// INV-6a's field pin is untouched and no profile can redirect where a session
// runs or hand back an emptier guardrail set than its anchor's. See
// docs/session-profile-port.md for the `cwd`-on-the-spec alternative this
// replaced, and why.
export type SessionAnchor = {
  // The manifest the fold derives `cwd` and guardrails from. For every
  // project-anchored kind this is the registry's own manifest, byte for byte
  // what `getProject` returned before. For a project-less kind it is a
  // SYNTHETIC manifest whose `root` is that surface's own directory — and it
  // must be the REAL directory the session will run in, because `root` is what
  // becomes `cwd`; a placeholder here would be a lie the whole route reads.
  readonly manifest: ProjectManifest;
  // The key this session's stored permission rules live under
  // (apps/web/lib/permissions.ts is keyed by project name). A project-less
  // session still needs somewhere to remember "always allow Write" — the
  // master's is the synthetic `__master__` — and a resolver that returned
  // another kind's key would let one surface inherit another's allow-rules,
  // which is why this value is declared beside the manifest instead of being
  // re-derived at each call site.
  readonly permissionsKey: string;
  // WHICH PROJECT THIS SESSION IS ACTUALLY ANCHORED TO — absent for a
  // project-less kind, and the reason it exists is a REVIEW FINDING against
  // the first cut of story 5.6.
  //
  // That cut let the anchor answer "cwd, guardrails, permissions key" and left
  // the wire `project` field live for everything else. So a request carrying
  // `{ role: "master", project: "aurora" }` was anchored project-lessly and
  // then, three hundred lines later and INSIDE the stream, still had aurora's
  // `telar.yaml` MCP servers spread onto its mount and its chat row persisted
  // under aurora — while a bogus name turned the route's pre-SSE 400 into a
  // mid-stream SSE error, because `resolveProjectMcpServers` throws. A wire
  // field that no resolver validated was still deciding behaviour.
  //
  // This is the fix, and its shape is the point: the anchor is the ONE answer
  // to "which project, if any", so the route shadows the wire field with it and
  // there is no second reader left to disagree. For every project-anchored kind
  // it is byte-identical to the wire string (the resolver returns the name it
  // just looked up); for the master it is `undefined`, which is what makes the
  // project-only code paths downstream collapse to nothing rather than needing
  // a kind check.
  readonly project?: string;
};

// A surface's contribution. NOT pure, unlike a builder's contract as originally
// written: the project resolver reads the project registry off disk. That I/O
// belongs to the module that registers it — this file still opens nothing,
// composes no path and reads no env, so AD-5/AD-20 and INV-3a are untouched.
export type SessionAnchorResolver = (input: { readonly project?: string }) => SessionAnchor;

const anchors = new Map<SessionKind, SessionAnchorResolver>();

// Same collision rule, same reasoning as registerSessionProfile above: two
// modules each deciding what a kind is anchored to would make the answer depend
// on import order.
export function registerSessionAnchor(kind: SessionKind, resolve: SessionAnchorResolver): void {
  if (anchors.has(kind)) {
    throw new Error(
      `session-profile: cannot register an anchor for "${kind}" — one is already declared. ` +
        `Two modules each deciding what a kind is anchored to would make cwd, guardrails and ` +
        `the permissions key depend on import order, which is not stable. Extend the existing ` +
        `resolver in the module that owns this kind.`,
    );
  }
  anchors.set(kind, resolve);
}

// Which kinds currently have an anchor. The asymmetry with
// registeredSessionKinds() is deliberate and is what a test wants: the two
// lists must be EQUAL, and only two accessors can say so.
export function registeredAnchorKinds(): readonly SessionKind[] {
  return SESSION_KINDS.filter((k) => anchors.has(k));
}

// The registered resolver itself, by kind — exported for ONE purpose, and it is
// a review finding's mechanism rather than a convenience.
//
// The chat route derives a kind TWICE per request: once pre-anchor from what
// the wire and the resumed chat row reliably carry, and once (sharper, with a
// validated loom id) for the profile. Two derivations that disagree would give
// one request its cwd from one kind and its tool surface from another. They
// cannot disagree about ANYTHING ELSE cheaply — but they must not disagree
// about the ANCHOR, and identity of the registered resolver is exactly that
// claim, testable over the closed input space without resolving anything (no
// project registry, no `ensureWorkspace`). apps/web/lib/session-profiles.test.ts
// enumerates every role × persisted-role × loom-id triple against it.
export function sessionAnchorResolverFor(kind: SessionKind): SessionAnchorResolver | undefined {
  return anchors.get(kind);
}

// THE SYNTHETIC-KEY SHAPE, RESERVED — `__master__` and anything else spelled
// like it. A project-less kind's permissions key shares one namespace with real
// project names (apps/web/lib/permissions.ts keys stored allow-rules by name),
// and story 5.6's first cut relied on `__master__` merely being "not a shape a
// real project is given". That is a convention, not a guard: nothing stopped a
// project registered under the literal name `__master__` from sharing the
// master's rule bucket AND its pending-approval coalescing group.
//
// A SHAPE RATHER THAN A LIST, so core does not have to know every surface's
// synthetic key: the rule is leading AND trailing double underscores, which no
// directory basename a human scaffolds from produces. Enforced where names
// enter the registry (manifest.ts's rememberProject), deliberately NOT in the
// ProjectManifest schema — the master's own anchor PARSES a manifest named
// `__master__`, so a schema refusal would break the very surface this protects.
export function isReservedProjectName(name: string): boolean {
  return /^__.+__$/.test(name.trim());
}

// Resolve what this request is anchored to. Called by the route BEFORE the
// profile, from the wire role alone (sessionKindFromRole's under-detection is
// the correct narrowing there — the loom-link reads that sharpen the kind need
// a project, which is the very thing being resolved).
//
// THROWS TWICE OVER, and both throws are the route's existing pre-SSE 400:
// once when no module declared the kind (a missing side-effect import), and
// once when the registered resolver itself refuses — which is exactly what
// `getProject` does for an unknown project. The route's try/catch around this
// call is the SAME try/catch it always had around getProject.
export function resolveSessionAnchor(input: {
  readonly kind: SessionKind;
  readonly project?: string;
}): SessionAnchor {
  const resolve = anchors.get(input.kind);
  if (!resolve) {
    const known = registeredAnchorKinds();
    throw new Error(
      `session-profile: cannot anchor "${input.kind}" — no module declared one. ` +
        `Declared kinds: ${known.length > 0 ? known.join(", ") : "(none)"}. ` +
        `An anchor registers at MODULE SCOPE beside its builder, so the module that owns this ` +
        `kind has to be imported for its side effect before the first request reaches it.`,
    );
  }
  return resolve({ project: input.project });
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

  // The runtime half of AD-1's "enforced twice" (see ToolPolicy above). `deny`
  // ALWAYS wins over `allow`, matching the SDK's own documented guarantee.
  //
  // THE GUARDRAIL'S DENY SET IS UNIONED IN, manifest entries first. Before
  // story 2.2 the chat route composed the deny array itself, so a consumer of
  // `toolPolicy.deny` alone would have silently received HALF the deny set —
  // now one field, one read, no chance of dropping the project's own config.
  //
  // THE REDUNDANCY BELOW IS DELIBERATE, not duplication: afterwards
  // `guardrails.disallowedTools ⊆ toolPolicy.deny`, and BOTH fields are
  // consumed, for DIFFERENT mechanisms — `guardrails` feeds
  // makeGuardrailDecision (PreToolUse + canUseTool, and the only carrier of
  // protectedPaths); `toolPolicy.deny` feeds the SDK's own disallowedTools.
  // Two independent gates on the same rule, so neither going quiet takes the
  // rule with it. Full reasoning, including the one case where this changes
  // the resolved value: docs/session-profile-port.md
  const deny = unionOrdered(guardrails.disallowedTools, spec.toolPolicy.deny);
  const requested: readonly string[] = spec.toolPolicy.allow ?? BASE_ALLOWED_TOOLS;
  const allow = unionOrdered(requested).filter(
    (t): t is BaseAllowedTool =>
      (BASE_ALLOWED_TOOLS as readonly string[]).includes(t) && !deny.includes(t),
  );

  return {
    kind: ctx.kind,
    // From the CONTEXT, never from the spec — so no profile can redirect where
    // a session runs. A project-less kind changes its cwd by registering a
    // different ANCHOR (see "The anchor" above), which moves BOTH cwd and the
    // guardrails they must agree with, together, and cannot move one of them
    // for one kind while the route keeps reading the other.
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
