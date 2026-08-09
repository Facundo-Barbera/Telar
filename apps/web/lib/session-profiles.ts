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
  BROWSER_READ_TOOL_NAMES,
  ensureWorkspace,
  getProject,
  NATIVE_CLAUDE_SETTING_SOURCES,
  ProjectManifest,
  registerSessionAnchor,
  registerSessionProfile,
  workspaceHomeDir,
  workspaceStorePaths,
  type SessionAnchorResolver,
  type SessionProfileBuilder,
} from "@telar/core";
import {
  LOOM_ANSWER_BLOCKED_TOOL,
  LOOM_AUTO_TOOLS,
  LOOM_ESCALATION_DISALLOWED_TOOLS,
  LOOM_ESCALATION_READONLY_TOOLS,
  LOOM_START_TOOL,
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

// ── the master session (story 5.6) ──────────────────────────────────────────

// The synthetic permissions key for the project-less master, mandated verbatim
// by SPEC-organization-workspace's story 6 ("synthetic '__master__' permissions
// key"). apps/web/lib/permissions.ts stores allow-rules keyed by project name,
// and a session with no project would otherwise key its rules under the string
// "undefined" — one shared bucket that any future project-less surface would
// silently join.
//
// The double underscores are the guard: a project name is a registry key the
// user types, and `__master__` is not a shape a real project is given. It is
// ALSO this session's manifest `name`, so the master has exactly ONE synthetic
// identity rather than two that can drift.
export const MASTER_PERMISSIONS_KEY = "__master__";

// The built-in read tools the master keeps. Deliberately NOT the whole
// six-name built-in head of BASE_ALLOWED_TOOLS: WebSearch/WebFetch are the
// external-reference surface CAP-13 (story 12) is going to design properly,
// and a profile that pre-grants them would make that story's decision for it.
// The triad is what a receptionist needs to read a digest off disk.
const MASTER_READ_TOOLS = ["Read", "Grep", "Glob"] as const;

// THE PROJECT-LESS MASTER — SPEC-organization-workspace CAP-1, and the first
// session kind in Telar that is anchored to no project at all.
//
// What it supplies is fixed by the spec and every line of it is here rather
// than in the route (AD-9: "a new surface adds a profile, it does not add an
// `if`"):
//   - `settingSources: []` — zero ambient config discovery. brownfield.md's
//     harness finding: the master must not inherit the operator's ~/.claude or
//     any repo's `.mcp.json`, because it is not IN a repo.
//   - default guardrails — there is no project manifest to source them from, so
//     the anchor below hands the fold a manifest carrying the schema's OWN
//     defaults. The fold still unions; a profile still cannot empty them, and
//     `addProtectedPaths` below is this profile using the one channel a spec
//     HAS for guardrails: adding restriction, never removing it.
//   - `cwd` — TELAR_HOME/workspace/home, via the anchor. Not here: see the
//     "no `cwd`" note on SessionProfileSpec.
//   - MCP — the workspace server ONLY, mounted programmatically by
//     @/lib/session-mcp's master mount: Claude's `mcpServers` option, never a
//     config file. The route pairs that with `strictMcpConfig` whenever a
//     profile asks for no setting sources at all, which is this profile and no
//     other — see the `strictMcpConfig` line in app/api/chat/route.ts, and note
//     that an earlier version of THIS comment asserted the flag without the
//     route ever passing it.
//
// THE TOOL POLICY IS AN ALLOW-NARROWING, like escalation's and unlike the three
// project kinds', because the master's mount is narrower than theirs: loom and
// ultra are not mounted for it, so leaving their names un-denied would let one
// fall through to canUseTool as a permission card for a server that is not even
// there. Both halves are derived from their source constants — no restated
// tool-name literals in this file (see the header note on `allow: []`).
//
// NO APPENDIX, DELIBERATELY, AND IT IS THE STORY'S OWN BOUNDARY: story 6 is
// "backend only — no briefing intelligence and no chat UI". The master's words
// (the briefing bands, the receipt's conservation law, the desk) are stories 7,
// 9 and 10, and a placeholder paragraph written here would be prompt text
// nobody designed. An omitted appendix resolves to "" and requires no
// `system-prompt-append` capability, so it also cannot 400 a provider for a
// feature this profile does not use yet.
export const buildMasterProfile: SessionProfileBuilder = () => ({
  kind: "master",
  // Zero ambient config discovery — the one setting the spec states as a
  // literal, and the only builder in this file that is not the native stack.
  settingSources: [],
  // THE STORE IS OUTSIDE THIS SESSION'S WRITE BOUNDARY, AS A MECHANISM.
  //
  // SPEC-organization-workspace's story 6 states it as a parenthetical ("the
  // store above it stays outside the master's write boundary"), and the first
  // cut of this story implemented it as a DIRECTORY LAYOUT: lanes.yaml and
  // packets/ are siblings of the master's cwd, not children. A review measured
  // what that actually buys — siblings are `../lanes.yaml`; the master's
  // manifest guardrails are the schema's defaults, so `protectedPaths` was
  // empty; `Write`/`Edit`/`Bash` are absent from `allow`, which means ASK, not
  // blocked; and a full-access turn auto-allows every non-moat tool outright.
  // The layout defeated a relative-path accident and nothing else, while three
  // comments and a doc claimed a boundary.
  //
  // `addProtectedPaths` is the boundary. It is the ONE thing a spec may say
  // about guardrails (AD-10: may restrict more, never less), the fold unions it
  // onto the anchor's defaults, and `makeGuardrailDecision` runs FIRST at both
  // enforcement points — the PreToolUse hook and canUseTool — so its deny lands
  // before the full-access auto-allow and before any stored "always allow"
  // rule. Bash is covered too (guardrails.ts word-splits the command, which is
  // why `rm ../lanes.yaml` is caught and not just `Write`).
  //
  // IT COVERS DISCLOSURE TOO, AND THAT IS THE DECISION RATHER THAN A SIDE
  // EFFECT. `makeGuardrailDecision` consults `protectedPaths` for EVERY tool
  // name — there is no branch before `inputPaths` — so `Read`/`Grep`/`Glob` of
  // `../lanes.yaml` are denied at the PreToolUse hook exactly as `Write` is.
  //
  // TWO EARLIER COMMENTS GOT THIS WRONG IN OPPOSITE DIRECTIONS: the first
  // claimed a boundary the layout did not provide, and its replacement claimed
  // the boundary guards "MODIFICATION, not disclosure" and left a RED test
  // ("READING the store is NOT blocked") standing as the bookmark. The
  // remediation pass answered it in the code's favour, and the spec is why:
  // SPEC-organization-workspace says "Cross-surface access goes through the
  // in-process workspace MCP server, never through raw file tools". `lanes.yaml`
  // and `packets/` are the store's ON-DISK ENCODING; the master reads its items
  // through `mcp__workspace__list_items` (mounted, unscoped, auto-allowed) and
  // has no reason to open the encoding. The alternative — making
  // `protectedPaths` modification-only — would let every session in Telar `Read`
  // a project's `.env`, which is a far worse trade for a convenience the master
  // does not need. session-profiles.test.ts asserts the deny, in all three read
  // tool names, plus the discriminator that a read ELSEWHERE still works.
  //
  // The paths come from the store's own exported port, never composed here —
  // same AD-5 rule that puts `cwd` behind `workspaceHomeDir()`.
  addProtectedPaths: [...workspaceStorePaths()],
  toolPolicy: {
    allow: [...MASTER_READ_TOOLS, ...WORKSPACE_AUTO_TOOLS],
    deny: [
      ...ALWAYS_DENIED_TOOLS,
      // Every loom name, including the two the base vocabulary deliberately
      // cannot spell in `allow` (start_loom, answer_blocked). A master session
      // reaching a loom tool would be reaching one through a server it has no
      // project to address, and the moat's own two commits stay unreachable
      // here by the same rule that keeps them unreachable everywhere else.
      ...LOOM_AUTO_TOOLS,
      LOOM_START_TOOL,
      LOOM_ANSWER_BLOCKED_TOOL,
      ...ULTRA_AUTO_TOOLS,
      // AND THE BROWSER'S, WHICH THE FIRST CUT LEFT OUT — a review found the
      // asymmetry: the rule this deny set is built on is "a name for a server
      // this kind does not mount must not be left to fall through to a
      // permission card", and the browser server is not mounted for the master
      // (@/lib/session-mcp) for the same kind of reason ultra is not. Unlike
      // loom's and ultra's, these names ARE in BASE_ALLOWED_TOOLS, so they were
      // the ones an omitted `allow` would have granted silently. Either every
      // unmounted server's names are denied or none are; this is every.
      ...BROWSER_READ_TOOL_NAMES,
    ],
  },
  // ALL THREE ARE LOAD-BEARING, and this is the AD-11 gate that keeps a
  // Codex-backed master from silently becoming a session with no workspace at
  // all: `mcp-servers` is the workspace server itself, `pre-tool-use-hooks` is
  // the moat's second enforcement point, `tool-allow-deny-lists` is the
  // narrowing above.
  //
  // WHICH OF THE THREE ACTUALLY HOLDS THIS GATE SHUT FOR CODEX — re-measured
  // by story 13, which changed nothing here. It is `pre-tool-use-hooks` and
  // `tool-allow-deny-lists`, and it was already only those two: providers.ts
  // has published `mcp-servers` for codex since before this story, on the
  // grounds that `dynamicTools` is the same capability over a different
  // transport. What story 13 changed is that the claim is now true of EXTERNAL
  // servers as well as Telar's own — `runCodexTurn` carries a per-invocation
  // roster — so a comment elsewhere that read the gate as resting on
  // `mcp-servers` was stale before this story, not made stale by it. The other
  // two capabilities still have no app-server equivalent, so a Codex-backed
  // master still 400s pre-SSE, which is the intended state until that work
  // lands. Requiring `mcp-servers` remains correct on its own terms: this
  // profile really does mount servers, and a provider that cannot must not run
  // it. `setting-sources` is NOT required: `settingSources: []`
  // asks the harness for nothing, so requiring the capability would 400 a
  // provider over a feature this profile switches off.
  requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
});

// ── the anchors (story 5.6) ─────────────────────────────────────────────────

// What every project-anchored kind is anchored to — the registry's own
// manifest, and the project slug as the permissions key. This IS the chat
// route's old `manifest = getProject(project).manifest`, moved verbatim: it
// throws the same error for an unknown or missing project, the route's same
// try/catch turns it into the same pre-SSE 400, and the permissions key is the
// same wire string every readRules/addRule call used before.
const projectAnchor: SessionAnchorResolver = ({ project }) => {
  // `?? ""` reaches getProject, which throws for it — the missing-project case
  // stays a 400 and never becomes a session anchored to an empty name.
  const name = project ?? "";
  // `project` is returned as well as consumed, and it is the REGISTRY's name
  // rather than the wire string it was looked up by — getProject has already
  // agreed the two are the same, so this is the wire value having survived a
  // gate rather than the wire value being trusted. Everything downstream in the
  // route reads THIS (see SessionAnchor.project); nothing reads the wire field.
  return { manifest: getProject(name).manifest, permissionsKey: name, project: name };
};

// The master's anchor — where the project gate is REPLACED rather than skipped.
//
// `ensureWorkspace()` first, because a cwd that does not exist is not a cwd:
// Claude Code tolerates an empty directory but not a missing one, and Codex's
// `-C` requires the directory to exist. It is idempotent (AD-15) and it creates
// `home/` as a SIBLING of `lanes.yaml` and `packets/`, never a parent — so no
// path RELATIVE to this cwd lands on an item by accident. That layout is a
// convenience, NOT the write boundary the spec asks for (`../lanes.yaml` walks
// straight out of it); the boundary is `buildMasterProfile`'s
// `addProtectedPaths`, above.
//
// The path comes from the workspace store's exported `workspaceHomeDir()`.
// AD-5: that module owns TELAR_HOME/workspace and no other file composes a path
// into it — INV-3a pins the inventory, so composing `<telarDir>/workspace/home`
// here would be a new, unowned site.
//
// NEVER A HOME DIRECTORY. brownfield.md: "Never use /Users/facundo as cwd —
// trust never persists there." Both harnesses key session history, auto-memory
// and trust PER DIRECTORY, which is also the argument for this ONE stable
// directory over a throwaway scratch dir per turn: a stable home accrues one
// continuous bucket, scratch dirs fragment it.
//
// IT TAKES NO ARGUMENT, AND THAT IS THE FIX FOR A REVIEW FINDING, not just a
// tidy signature. A master request may still arrive with a `project` field on
// the wire — old clients send one on every POST — and the first cut of this
// story simply ignored it HERE while the route went on consuming the wire field
// directly for MCP composition, chat persistence and the browser scope. So a
// master session could be handed a project's `telar.yaml` MCP servers, and an
// unknown project name reached `getProject` INSIDE the stream, turning a
// pre-SSE 400 into a mid-stream SSE error. Discarding it is now meaningful
// because the anchor's `project` — absent here — is the only one the route
// reads: a field this resolver drops is a field the request cannot use.
const masterAnchor: SessionAnchorResolver = () => {
  ensureWorkspace();
  return {
    // NO `project` KEY, deliberately spelled by its absence rather than by
    // `project: undefined`: this session is anchored to no project, and every
    // project-only path downstream collapses to nothing without a kind check.
    // PARSED, NOT HAND-BUILT: `ProjectManifest.parse` fills the schema's own
    // defaults, so "default guardrails" here means literally the defaults the
    // schema declares ({ disallowedTools: [], protectedPaths: [] }) rather than
    // a second copy of them written out in this file. The fold unions the
    // spec's additions onto these, exactly as it does for a real project.
    manifest: ProjectManifest.parse({
      name: MASTER_PERMISSIONS_KEY,
      root: workspaceHomeDir(),
    }),
    permissionsKey: MASTER_PERMISSIONS_KEY,
  };
};

// Registration at module scope — the side effect the route's bare import
// exists to trigger. Exported so a suite can re-register after
// resetSessionProfiles() without re-importing this module (bun runs every test
// file in ONE process, so a module is evaluated once and its module-scope
// registration cannot be replayed by importing it again).
//
// EVERY KIND REGISTERS BOTH HALVES — a builder and an anchor — and story 5.6's
// suite asserts the two lists are equal. A kind with a builder and no anchor is
// a session that 500s in the route's pre-stream preamble; a kind with an anchor
// and no builder is one that 500s a few lines later.
export function registerSessionProfiles(): void {
  registerSessionProfile("project", buildProjectProfile);
  registerSessionProfile("planner", buildPlannerProfile);
  registerSessionProfile("steerer", buildSteererProfile);
  registerSessionProfile("escalation", buildEscalationProfile);
  registerSessionProfile("master", buildMasterProfile);
  // The three loom kinds are anchored EXACTLY as a plain project session is —
  // a steerer or escalation session is a project session with a loom on the
  // side, and its cwd has always been that project's root.
  registerSessionAnchor("project", projectAnchor);
  registerSessionAnchor("planner", projectAnchor);
  registerSessionAnchor("steerer", projectAnchor);
  registerSessionAnchor("escalation", projectAnchor);
  registerSessionAnchor("master", masterAnchor);
}

registerSessionProfiles();
