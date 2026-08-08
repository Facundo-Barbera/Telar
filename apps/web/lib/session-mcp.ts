// WHICH IN-PROCESS MCP SERVERS A SESSION KIND MOUNTS — the project-less seam
// deferred-work.md has been holding open since story 2.2, built by story 5.6
// (SPEC-organization-workspace's master profile) because that is the first kind
// whose answer differs.
//
// ── WHY THIS IS NOT A FIELD ON THE PROFILE ───────────────────────────────────
// It looks like it should be `SessionProfileSpec.mcpServers`, and story 2.2
// recorded exactly that intent ("Owner: epic 5's project-less master profile,
// the first story with a reason to pay for the restructure"). Measured again
// here, the restructure does not fit through that field, and the reason is
// #28's persistent runtime rather than anything about profiles:
//
//   - `resolveSessionProfile` is EAGER and runs BEFORE the stream opens
//     (INV-6c pins that ordering), so a builder can only produce VALUES.
//   - These four servers are not values. They are constructed inside
//     `acquireSessionRuntime`'s `create` callback — ONCE PER SESSION RUNTIME,
//     not once per POST — and every one of them closes over getters that read
//     LIVE runtime state (`self().sessionId`, `slots.runId`) so a reused
//     runtime's tool calls attribute to the CURRENT turn instead of the turn
//     that happened to build them.
//   - A profile builder that constructed them would therefore capture the
//     FIRST POST's session id and run id forever — precisely the stale-closure
//     bug the persistent-runtime work fixed.
//
// So what the kind selects is a FACTORY, and a factory is what this registry
// holds. `SessionProfile.mcpServers` keeps its meaning for what it can actually
// carry — statically-configured servers, which is what CAP-13's external MCP
// roster (story 12) will be — and the route now spreads BOTH, so a profile that
// declares one is no longer silently ignored.
//
// ── WHAT THE MASTER CHANGES ──────────────────────────────────────────────────
// Before this file the route's mount was one unconditional object literal, and
// "unconditional" is exactly what a project-less session cannot use: `loom` and
// `ultra` are constructed with a project slug they dereference to a manifest
// root, and the master has no project. The master mounts the WORKSPACE SERVER
// AND NOTHING ELSE — which is also why its profile denies every loom, ultra and
// browser tool name rather than leaving them to fall through to a permission
// card for a server that is not there.
//
// "AND NOTHING ELSE" IS A CLAIM ABOUT THE WHOLE REQUEST, not just this registry,
// and the first cut of story 5.6 could not make it: the route unioned
// `resolveProjectMcpServers(project)` onto whatever this file returned, keyed on
// the WIRE `project` field, which nothing validated for a master request. A
// review caught it. The route now reads the ANCHOR's project (absent for the
// master), so the union contributes `{}` here by construction rather than by a
// kind check — see SessionAnchor.project in packages/core/src/session-profile.ts.
//
// The registry idiom (a Map keyed by SessionKind, filled at module scope, with
// a throw for an unregistered kind) is core's own, from
// packages/core/src/session-profile.ts — same reason: a switch here would mean
// every new session kind edits this file.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { SESSION_KINDS, type AccountProfile, type SessionKind } from "@telar/core";
import { createBrowserMcpServer } from "@/lib/browser-mcp";
import { createLoomMcpServer, type LoomSessionLink } from "@/lib/loom-mcp";
import { createUltraMcpServer } from "@/lib/ultra-mcp";
import { createWorkspaceMcpServer } from "@/lib/workspace-mcp";

/** Everything a mount may close over. Every field is a value or a getter the
 *  chat route already holds by the time `create` runs — nothing here is read,
 *  fetched or derived by this module. */
export type SessionMcpContext = {
  /** The project slug, absent for a project-less kind. A mount that needs one
   *  is a mount that must not be registered for a project-less kind. */
  readonly project?: string;
  /** The chat's own server-resolved account profile — never anything a model
   *  supplied. loom takes its `name`, ultra and workspace take the profile. */
  readonly account: AccountProfile;
  /** The turn's raw user message, used only to seed a lazily-created draft
   *  loom's objective. */
  readonly objectiveSeed: string;
  /** The session<->loom link object the route MUTATES IN PLACE during the turn.
   *  Passed by reference on purpose: loom tools write to it and `appendTurn`
   *  reads it back. */
  readonly link: LoomSessionLink;
  /** The live session id, read at CALL time (see this file's header). */
  readonly getSessionId: () => string | null;
  /** The live per-turn run id — Ultra's "messageId" link. */
  readonly getMessageId: () => string | null;
  /** The draft browser scope this turn started with, used until a session id
   *  exists to migrate to the canonical one. */
  readonly browserScopeKey: string;
};

/** A surface's contribution: which servers this kind mounts, by name. */
export type SessionMcpMount = (ctx: SessionMcpContext) => Record<string, McpServerConfig>;

const mounts = new Map<SessionKind, SessionMcpMount>();

export function registerSessionMcpMount(kind: SessionKind, mount: SessionMcpMount): void {
  if (mounts.has(kind)) {
    throw new Error(
      `session-mcp: cannot register a mount for "${kind}" — one is already declared. ` +
        `Two modules each deciding which servers a kind mounts would make the tool surface ` +
        `depend on import order, which is not stable.`,
    );
  }
  mounts.set(kind, mount);
}

/** Test seam, for the reason resetSessionProfiles() is one: bun runs every test
 *  file in ONE process, so this module-scope Map leaks across suites. */
export function resetSessionMcpMounts(): void {
  mounts.clear();
}

/** Which kinds currently have a mount — the list a test pins against
 *  `registeredSessionKinds()`, because a kind with a profile and no mount is a
 *  session that starts with no tools and says nothing about it.
 *
 *  FILTERED OVER `SESSION_KINDS`, NOT `[...mounts.keys()]`, and the difference
 *  is only visible to a test: core's two accessors filter the closed vocabulary,
 *  so they return declaration order while a Map returns INSERTION order. Both
 *  suites compare sorted, so three registries drifting apart in declared order
 *  would have stayed invisible. Same idiom in all three now. */
export function registeredMcpKinds(): readonly SessionKind[] {
  return SESSION_KINDS.filter((k) => mounts.has(k));
}

/** The servers this session mounts. Throws for an undeclared kind rather than
 *  returning `{}`: a session that silently comes up with no tool surface is the
 *  failure AD-11 exists to end, and it would look like a model that "forgot"
 *  how to read the user's items. */
export function resolveSessionMcpServers(
  kind: SessionKind,
  ctx: SessionMcpContext,
): Record<string, McpServerConfig> {
  const mount = mounts.get(kind);
  if (!mount) {
    throw new Error(
      `session-mcp: no MCP mount declared for "${kind}". Declared kinds: ` +
        `${registeredMcpKinds().join(", ") || "(none)"}. A mount registers at MODULE SCOPE, ` +
        `so @/lib/session-mcp has to be imported for its side effect before the first request.`,
    );
  }
  return mount(ctx);
}

// ── the mounts ──────────────────────────────────────────────────────────────

// THE PROJECT-ANCHORED MOUNT — the chat route's own literal, moved here
// unchanged, keys and construction arguments included. All four servers, for
// all four project-anchored kinds: `mcpServers` was UNCONDITIONAL before this
// file and stays that way for them, because what an escalation session does not
// get is loom's and ultra's TOOLS (its profile denies them), not their servers.
// Changing that here would be a behaviour change wearing a refactor's clothes.
export const projectSessionMcpMount: SessionMcpMount = (ctx) => ({
  // The "loom" server (docs/loom-model.md §5) — draft/read tools plus the
  // human-gated start_loom commit. `account` is the chat's own server-resolved
  // identity, never anything the model supplies: loom-mcp.ts's start_loom
  // stamps it as startLoomFromBundle's `by`/provenance.
  loom: createLoomMcpServer({
    // After the anchor gate a project-anchored kind ALWAYS has a project — the
    // resolver threw a pre-SSE 400 otherwise. `?? ""` is what the type system
    // needs at a seam that cannot see that gate, never a reachable value.
    project: ctx.project ?? "",
    objectiveSeed: ctx.objectiveSeed,
    account: ctx.account.name,
    link: ctx.link,
    getSessionId: ctx.getSessionId,
  }),
  // The "ultra" server (docs/plans/ultra-harness.md §4). `getMessageId` threads
  // the per-turn run id as Ultra's own message link — the finest-grained id a
  // chat turn has.
  ultra: createUltraMcpServer({
    project: ctx.project ?? "",
    account: ctx.account,
    getSessionId: ctx.getSessionId,
    getMessageId: ctx.getMessageId,
  }),
  // The "workspace" server (story 5.1) — the ONLY path a session has to the
  // user's item store, which lives under TELAR_HOME and deliberately outside
  // every session's cwd. SCOPED here, unscoped for the master below, and that
  // difference is a property of how the SERVER was built rather than of
  // anything a caller may ask for.
  workspace: createWorkspaceMcpServer({
    project: ctx.project ?? "",
    account: ctx.account,
    getSessionId: ctx.getSessionId,
  }),
  // One lazy, server-owned browser runtime backs both the human surface and the
  // agent tools; constructing this descriptor starts nothing. The scope is a
  // GETTER: draft until the session id exists, canonical after — matching the
  // client's adoptScope migration on the `session` event.
  browser: createBrowserMcpServer({
    scopeKey: () => {
      const sid = ctx.getSessionId();
      return sid ? `${ctx.project}:${sid}` : ctx.browserScopeKey;
    },
  }),
});

// THE MASTER MOUNT (story 5.6) — the workspace server, unscoped, and nothing
// else.
//
// Each absence is a decision, not an omission:
//   - `loom` and `ultra` both take a project slug and dereference it to a
//     manifest root inside their handlers. The master has no project, so those
//     servers would be constructed pointing at nothing.
//   - `browser` is the human-and-agent shared browser surface, and the master
//     chat surface does not exist yet (story 7). A mount with no surface is a
//     tool advertised to a model that cannot be observed using it.
//
// UNSCOPED IS THE POINT: `project: undefined` is workspace-mcp.ts's documented
// cross-project view — "story 5.6's project-less master session sees every
// project's items" — and CAP-1's briefing is a question about ALL projects at
// once. It is a property of this mount, never of a tool argument.
export const masterSessionMcpMount: SessionMcpMount = (ctx) => ({
  workspace: createWorkspaceMcpServer({
    account: ctx.account,
    getSessionId: ctx.getSessionId,
  }),
});

/** Registration at module scope — the side effect app/api/chat/route.ts's bare
 *  `import "@/lib/session-mcp";` exists to trigger, exported so a suite can
 *  re-register after resetSessionMcpMounts(). */
export function registerSessionMcpMounts(): void {
  registerSessionMcpMount("project", projectSessionMcpMount);
  registerSessionMcpMount("planner", projectSessionMcpMount);
  registerSessionMcpMount("steerer", projectSessionMcpMount);
  registerSessionMcpMount("escalation", projectSessionMcpMount);
  registerSessionMcpMount("master", masterSessionMcpMount);
}

registerSessionMcpMounts();
