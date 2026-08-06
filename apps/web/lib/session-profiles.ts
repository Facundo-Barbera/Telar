// Track B's session-profile catalogue: one SessionProfileSpec builder per
// session kind that exists today, registered into @telar/core's profile
// registry at MODULE SCOPE. packages/core/src/session-profile.ts owns the
// TYPE, the fold and the registry; this file owns the DATA — the split is
// what lets tracks D, E and F add a session kind by registering their own
// builder, with no write access to this file. Full design reasoning,
// including what story 2.1 left inert and what 2.2 closed, and the
// `mcpServers` omission's justification: docs/session-profiles-catalogue.md
//
// SIDE-EFFECT IMPORT, and nothing else will do it for you: these builders
// register when this module is EVALUATED, so app/api/chat/route.ts carries a
// bare `import "@/lib/session-profiles";` alongside its named imports.
// Without that line the registry is EMPTY at request time and
// resolveSessionProfile throws on every chat request — and no gate catches
// it, since there is no test file for app/api/chat/route.ts anywhere in the
// tree. NOT a precedent for packages/core/src/ultra/events.ts's
// declareEvents, which deliberately registers through a self-healing
// accessor instead — read that file's header before copying either pattern.
import {
  NATIVE_CLAUDE_SETTING_SOURCES,
  registerSessionProfile,
  type SessionProfileBuilder,
} from "@telar/core";
import {
  LOOM_ESCALATION_DISALLOWED_TOOLS,
  LOOM_ESCALATION_READONLY_TOOLS,
} from "@/lib/loom-mcp";
import { ULTRA_AUTO_TOOLS } from "@/lib/ultra-mcp";
import { WORKSPACE_AUTO_TOOLS } from "@/lib/workspace-mcp";
import {
  BROWSER_CONTROL_NOTE,
  escalationAppendix,
  plannerAppendix,
  projectAppendix,
  steererAppendix,
} from "@/lib/session-prompts";

// Every ordinary session uses Claude's native configuration stack. The user
// source resolves from the selected provider instance's CLAUDE_CONFIG_DIR (or
// ~/.claude for the default instance), so alternate instances stay isolated
// while the default behaves like `claude` launched in a terminal.
const CLAUDE_SETTING_SOURCES = NATIVE_CLAUDE_SETTING_SOURCES;

// Disallowed for every kind, measured from the route's own `disallowedTools`
// array, which lists it unconditionally: the chat UI has no widget to answer a
// structured question, so the model must ask clarifying questions as plain chat
// messages instead.
const ALWAYS_DENIED_TOOLS = ["AskUserQuestion"] as const;

// The ordinary project session — no `role` on the wire, and also where a
// session lands when its kind cannot be detected pre-stream. Requires
// NOTHING: under-detection then yields a weaker requirement, never a
// spurious 400 (AC5 — must keep working unchanged on BOTH providers).
//
// `toolPolicy.allow` is OMITTED here and on planner/steerer, deliberately:
// an absent `allow` resolves to the WHOLE base set, and writing
// `allow: [...BASE_ALLOWED_TOOLS]` would say the same thing while adding a
// second place for the two to drift apart. Only escalation narrows. Full
// reasoning + the historical array this must stay a superset of:
// docs/session-profiles-catalogue.md
export const buildProjectProfile: SessionProfileBuilder = (ctx) => ({
  kind: "project",
  settingSources: [...CLAUDE_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: [],
  // "" when the composer's Ultra chip is off (every ordinary turn); sessionId
  // is undefined on turn 1, which is correct — the SDK mints it mid-stream.
  // STORY 4.2 / AC8 — `ctx.provider` reaches a composer for the first time
  // HERE, because `ctx` is the only thing in the tree that holds it. NO
  // `requiredCapability` is added for the gate: `requiredCapabilities: []`
  // must keep passing on BOTH providers (AC5), so Codex degrades to no
  // reference rather than a 400. Full reasoning: docs/session-profiles-catalogue.md
  systemPromptAppendix:
    projectAppendix({
      ultraAnnotated: ctx.ultraAnnotated,
      sessionId: ctx.sessionId,
      provider: ctx.provider,
    }) + BROWSER_CONTROL_NOTE,
});

// The Loom planning session (docs/loom-model.md §5). The route's own comment
// on isPlannerSession is the whole definition of this kind: the flag "Drives
// ONLY the appended system-prompt guidance below — never loom tool
// access/gating." So the appendix IS the kind, and on Codex a planner session
// silently becomes a plain one (textbook AD-11 degradation) — which is why
// this requires `system-prompt-append` and deliberately not `mcp-servers`.
//
// NO LONGER PURE (an earlier version of this comment said it was): story 4.1
// added a live read of the completed-Ultra-run block, wrapped in its own
// safeLiveContext and degrading to the static prompt on failure. Full
// reasoning: docs/session-profiles-catalogue.md
export const buildPlannerProfile: SessionProfileBuilder = (ctx) => ({
  kind: "planner",
  settingSources: [...CLAUDE_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: ["system-prompt-append"],
  systemPromptAppendix:
    plannerAppendix({
      ultraAnnotated: ctx.ultraAnnotated,
      sessionId: ctx.sessionId,
      // Story 4.2 / AC8 — see buildProjectProfile above for why the gate is here.
      provider: ctx.provider,
    }) + BROWSER_CONTROL_NOTE,
});

// The embedded steering session (the loom Chat tab). Same reasoning as
// planner: the steerer flag drives "ONLY the appended system-prompt guidance
// + live-context block below, never loom tool access/gating" — exactly what
// Codex drops. THIS BUILDER IS NOT PURE: buildSteererContext(loomId) is a
// per-turn live read of the loom's bundle (objective, contract, steering
// log), still once per turn, wrapped fail-safe in session-prompts.ts. Full
// reasoning: docs/session-profiles-catalogue.md
//
// `ctx.loomId` is the VALIDATED loom id (route-checked against getLoom +
// `loom.project === project` before the profile resolves), never the raw
// wire value — a builder reaching an unvalidated id could read another
// project's loom.
export const buildSteererProfile: SessionProfileBuilder = (ctx) => ({
  kind: "steerer",
  settingSources: [...CLAUDE_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: ["system-prompt-append"],
  systemPromptAppendix:
    steererAppendix({
      loomId: ctx.loomId,
      ultraAnnotated: ctx.ultraAnnotated,
      sessionId: ctx.sessionId,
      // Story 4.2 / AC8 — see buildProjectProfile above for why the gate is here.
      provider: ctx.provider,
    }) + BROWSER_CONTROL_NOTE,
});

// The blocked-loom escalation chat (M11.3): a read-only loom toolset plus the
// answer_blocked-only write path. Provably impossible on Codex — the
// `provider === "codex"` fork returns before createLoomMcpServer is ever
// reached, so an escalation session there is non-functional today and says
// nothing about it (the silent degradation AD-11 exists to end).
//
// `allow` spreads LOOM_ESCALATION_READONLY_TOOLS, the same constant the
// route used, rather than restating it — the failure mode this avoids
// (`allow: []` shipped once in 2.1's first pass, silently stripping project
// inspection) is why every expectation here derives from a constant instead
// of a literal. `deny` is the route's escalation `disallowedTools` tail;
// the resolver folds the manifest's own guardrail deny set in front of it,
// so this array is the ADDITION and never the whole set. Full reasoning:
// docs/session-profiles-catalogue.md
//
// MOAT: mcp__loom__answer_blocked is in NEITHER list. It stays
// callable-but-human-gated — the only escalation write path, force-routed to
// the interactive card by the route's PreToolUse hook in every permission
// mode. A port that "tidies" it into `allow` breaks the moat; one that
// tidies it into `deny` breaks the surface. It is also unspellable in
// `allow` by type, because core deliberately kept it out of
// BASE_ALLOWED_TOOLS.
//
// The appendix is ESCALATION_SYSTEM_PROMPT plus a per-turn live read, and
// NEVER an Ultra note — escalationAppendix has no `ultraAnnotated` parameter
// at all, so that is enforced by the signature rather than remembered.
export const buildEscalationProfile: SessionProfileBuilder = (ctx) => ({
  kind: "escalation",
  settingSources: [...CLAUDE_SETTING_SOURCES],
  toolPolicy: {
    allow: [...LOOM_ESCALATION_READONLY_TOOLS],
    deny: [
      ...ALWAYS_DENIED_TOOLS,
      ...LOOM_ESCALATION_DISALLOWED_TOOLS,
      ...ULTRA_AUTO_TOOLS,
      // STORY 5.1 — the workspace server IS registered for an escalation
      // session (the route's mcpServers is unconditional), and this builder
      // sets `allow` explicitly, so an un-denied workspace name would fall
      // through to canUseTool as a WRITE path on a read-only discuss wall.
      // Deny makes it truly uncallable. Full reasoning:
      // docs/session-profiles-catalogue.md
      ...WORKSPACE_AUTO_TOOLS,
    ],
  },
  requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
  systemPromptAppendix: escalationAppendix({
    loomId: ctx.loomId,
    cwd: ctx.manifest.root,
  }),
});

// Registration at module scope — the side effect the route's bare import
// exists to trigger. Exported so a suite can re-register after
// resetSessionProfiles() without re-importing this module (bun runs every test
// file in ONE process, so a module is evaluated once and its module-scope
// registration cannot be replayed by importing it again).
export function registerSessionProfiles(): void {
  registerSessionProfile("project", buildProjectProfile);
  registerSessionProfile("planner", buildPlannerProfile);
  registerSessionProfile("steerer", buildSteererProfile);
  registerSessionProfile("escalation", buildEscalationProfile);
}

registerSessionProfiles();
