// Track B's session-profile catalogue: one SessionProfileSpec builder per
// session kind that exists today, registered into @telar/core's profile
// registry at MODULE SCOPE.
//
// WHY THIS FILE IS SEPARATE FROM THE PORT. packages/core/src/session-profile.ts
// owns the TYPE, the fold and the registry; this file owns the DATA. The split
// is what lets tracks D, E and F add a session kind without editing Track B's
// files — WORK-SPLIT gives each of them "a SessionProfile" as their seam and no
// write access here, so a switch statement in the resolver would have made
// every new kind a merge conflict. They add a union member in core and register
// their builder in their own module, exactly as this file does.
//
// SIDE-EFFECT IMPORT, and nothing else will do it for you. These builders
// register when this module is EVALUATED, and module scope only runs if
// something imports the module. app/api/chat/route.ts therefore carries a bare
// `import "@/lib/session-profiles";` alongside its named imports. Without that
// line the registry is EMPTY at request time and resolveSessionProfile throws
// on every chat request — and no gate would catch it: there is no test file for
// app/api/chat/route.ts anywhere in the tree, so bun test, tsc and lint all
// stay green while the app is broken. This is the first self-registering module
// in the repo (grepped: declareEvents has zero production call sites), so there
// is no precedent to remind you.
//
// WHAT 2.1 DELIBERATELY DOES NOT PUT HERE. Story 2.1 lands the resolver
// additively: the route resolves a profile for every request but consumes only
// the capability gate. Story 2.2 is the one that migrates the live chat path
// onto these values, and it is behind its own gate because it is the change
// that touches production traffic. So three fields are deliberately inert here
// and 2.2 fills them:
//   - `mcpServers` is omitted (resolves to {}). The route's real set is
//     { loom, ultra, ...resolveProjectMcpServers(project) }, and building it
//     means CONSTRUCTING the in-process MCP servers — a side effect, not data.
//   - `systemPromptAppendix` is "" for all four kinds. See the note on the
//     planner builder: the prompt constants are module-private to route.ts.
//   - `toolPolicy` narrows only the six tools core can name for itself.
//     LOOM_AUTO_TOOLS / ULTRA_AUTO_TOOLS join the base union in 2.2.
// The one field that is NOT inert is `requiredCapabilities` — that is what the
// pre-stream gate reads, and it carries this story's real behaviour change.
import {
  registerSessionProfile,
  type SessionProfileBuilder,
} from "@telar/core";

// Every kind loads the repo's own .claude (CLAUDE.md, skills, slash commands,
// settings, MCP servers) and deliberately NOT the user's. Measured from the
// route's `settingSources: ["project", "local"]`, whose comment records the
// decision: user-level settings stay out so the developer's personal
// config/tokens never reach the subprocess. The port's ProfileSettingSource
// type makes "user" unspellable here, so this cannot drift back.
const REPO_SETTING_SOURCES = ["project", "local"] as const;

// Disallowed for every kind, measured from the route's own `disallowedTools`
// array, which lists it unconditionally: the chat UI has no widget to answer a
// structured question, so the model must ask clarifying questions as plain chat
// messages instead.
const ALWAYS_DENIED_TOOLS = ["AskUserQuestion"] as const;

// The ordinary project session — no `role` on the wire. This is also where a
// session lands when its kind cannot be detected pre-stream (a resumed planner
// or steerer whose client omitted `role`), which is exactly why it must require
// NOTHING: under-detection then yields a weaker requirement and never a
// spurious 400. AC5 depends on it too — a project session has to keep working
// unchanged on BOTH providers.
export const buildProjectProfile: SessionProfileBuilder = () => ({
  kind: "project",
  settingSources: [...REPO_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: [],
  systemPromptAppendix: "",
});

// The Loom planning session (docs/loom-model.md §5). The route's own comment on
// isPlannerSession is the whole definition of this kind: the flag "Drives ONLY
// the appended system-prompt guidance below — never loom tool access/gating."
// So the appendix IS the kind, and on Codex there is no systemPrompt option at
// all — a planner session there silently becomes a plain session. Textbook
// AD-11 silent degradation, which is why this requires `system-prompt-append`
// and deliberately does NOT require `mcp-servers`: requiring a capability the
// kind does not use would gate it on something irrelevant.
//
// The appendix is "" in 2.1 and 2.2 supplies it. Measured reason, and it is a
// deviation worth stating: PLANNER_SYSTEM_PROMPT is a module-private const
// inside app/api/chat/route.ts, whose only export is POST. Reaching it from
// here would mean either exporting a second symbol from a Next.js route module
// or hoisting the constant out of the handler — both are larger edits to
// route.ts than AC5 allows, and copying the text would create a second source
// of truth for moat-adjacent prompt content. 2.2 hoists the prompts anyway (its
// AC1 removes the session-kind conditionals), so it is the right owner. Nothing
// consumes this field in 2.1.
export const buildPlannerProfile: SessionProfileBuilder = () => ({
  kind: "planner",
  settingSources: [...REPO_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: ["system-prompt-append"],
  systemPromptAppendix: "",
});

// The embedded steering session (the loom Chat tab). Same reasoning as planner,
// from the same comment: the steerer flag drives "ONLY the appended
// system-prompt guidance + live-context block below, never loom tool
// access/gating (which stays exactly as wired)". The appendix plus its
// live-context block is the distinguishing content, and it is exactly what
// Codex drops.
//
// The appendix stays "" for a second reason on top of the planner's: the real
// value embeds a PER-TURN live read (buildSteererContext(loomId)) that happens
// inside the stream body. Hoisting that read into the preamble is a behaviour
// change inside new ReadableStream, which AC5 forbids. 2.2 supplies it.
export const buildSteererProfile: SessionProfileBuilder = () => ({
  kind: "steerer",
  settingSources: [...REPO_SETTING_SOURCES],
  toolPolicy: { deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: ["system-prompt-append"],
  systemPromptAppendix: "",
});

// The blocked-loom escalation chat (M11.3): a read-only loom toolset plus the
// answer_blocked-only write path. Provably impossible on Codex, and this is the
// measurement rather than a guess: the `provider === "codex"` fork returns
// before createLoomMcpServer is ever reached, so there are NO loom tools at
// all, and answer_blocked's human gate is a PreToolUse comparison that does not
// run on that branch. An escalation session on a Codex account is
// non-functional today and says nothing about it — which is the silent
// degradation AD-11 exists to end.
//
// `allow: ["Read", "Grep", "Glob"]` is measured, not defensive: the route's
// escalation branch sets allowedTools to [...LOOM_ESCALATION_READONLY_TOOLS]
// (@/lib/loom-mcp), and THREE of core's six base tools appear in that array —
// Read, Grep and Glob, the project-root snapshot half of the read-only toolset.
// ESCALATION_SYSTEM_PROMPT advertises them by name ("Read / Grep / Glob —
// inspect the project root (your working directory)"), so dropping them would
// leave the session unable to do what its own prompt tells it to do. WebSearch,
// WebFetch and ToolSearch are the three the branch genuinely does not grant, so
// the narrowing drops exactly those. session-profiles.test.ts re-derives this
// array from BASE_ALLOWED_TOOLS ∩ LOOM_ESCALATION_READONLY_TOOLS rather than
// restating it, so the measurement cannot go stale silently again. (The
// mcp__loom__* read names in that same array, and the loom/ultra deny names the
// branch adds, live in @/lib/loom-mcp and @/lib/ultra-mcp; they join the policy
// in 2.2 alongside LOOM_AUTO_TOOLS/ULTRA_AUTO_TOOLS, per the port's
// BASE_ALLOWED_TOOLS note.)
//
// This shipped as `allow: []` in 2.1's first pass, on the claim that NONE of
// the six appeared. That was false, and the failure mode is worth naming: no
// test and no request could contradict it, because nothing consumes toolPolicy
// in 2.1 — 2.2 would have mapped an empty array onto query()'s allowedTools and
// silently stripped project inspection from every escalation session.
//
// The appendix stays "" for the steerer's reason: buildEscalationContext is a
// per-turn live read inside the stream body.
export const buildEscalationProfile: SessionProfileBuilder = () => ({
  kind: "escalation",
  settingSources: [...REPO_SETTING_SOURCES],
  toolPolicy: { allow: ["Read", "Grep", "Glob"], deny: [...ALWAYS_DENIED_TOOLS] },
  requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
  systemPromptAppendix: "",
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
