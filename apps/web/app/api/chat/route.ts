import {
  query,
  type EffortLevel,
  type HookInput,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeCliUsable, claudeExecutableOptions, resolveClaudeCli } from "@/lib/claude-executable";
import { makeCompactionNotifiers, makePreToolUseGuardrail } from "@/lib/server/turn-hooks";
import {
  fromClaudeContextUsage,
  fromCodexContextUsage,
  type ContextUsageSnapshot,
} from "@/lib/context-usage";
import {
  accountEnv,
  accountHealth,
  ackUltraWakes,
  getAccount,
  getLoom,
  getProject,
  pendingUltraWakes,
  providerOf,
  resolveProjectMcpServers,
  resolveEnabledAccount,
  resolveSessionKind,
  resolveSessionProfile,
  loadPolicy,
  sessionRoleFromWire,
  signInCommand,
  unmetCapabilities,
  type AccountProfile,
  type ProjectManifest,
  type SessionRole,
} from "@telar/core";
import {
  DEFAULT_RUNTIME_MODE,
  claudePermissionMode,
  codexThreadConfig,
  isRuntimeMode,
  type RuntimeMode,
} from "@telar/core/runtime-mode";
import {
  CODEX_EFFORT_OPTIONS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  type CodexReasoningEffort,
} from "@/lib/models";
import { runCodexCompact, runCodexTurn } from "@/lib/codex-app-server";
import { isEscalationKickoff, resolveEscalationMessage } from "@/lib/escalation-kickoff";
import { logPermissionCheck, logPermissionOutcome } from "@/lib/permission-diagnostics";

/** The in-process MCP servers telar itself constructs and whose whole tool
 *  surface it wrote. Kept beside the `mcpServers` literal's own key list, which
 *  is the only other place these four names appear together. */
const TELAR_OWN_MCP_SERVERS = ["browser", "loom", "ultra", "workspace"] as const;
import {
  appendixCarriesUltraWake,
  isUltraWakeTrigger,
  resolveUltraWakeMessage,
} from "@/lib/ultra-wake";
import { generateTitle } from "@/lib/titles";
import { endChatRun, registerChatRun, setChatRunSession } from "@/lib/chat-runs";
import {
  acquireSessionRuntime,
  DETACHED_DENY_TEXT,
  type SessionRuntime,
} from "@/lib/server/session-runtime";
import {
  kickSessionQueue,
} from "@/lib/server/session-engine";
import {
  appendSessionEvent,
  clearSessionDeltas,
  endSessionDeltas,
  pushSessionDelta,
  startSessionLog,
} from "@/lib/session-log";
// LOOM_START_TOOL and LOOM_ANSWER_BLOCKED_TOOL are the MOAT CONSTANTS INV-1g
// pins BY IMPORT: it reads this statement, resolves both names in loom-mcp.ts,
// and requires the `input.tool_name === <CONST>` comparison form in
// preToolUseGuardrail. They are the two tools no profile can grant — core
// deliberately keeps both out of BASE_ALLOWED_TOOLS — and they are hard-routed
// to the interactive card here in EVERY permission mode. Story 2.2 removed the
// four tool-LIST imports (LOOM_AUTO_TOOLS, LOOM_ESCALATION_READONLY_TOOLS,
// LOOM_ESCALATION_DISALLOWED_TOOLS, ULTRA_AUTO_TOOLS) because the profile now
// carries every one of those names; these two stay, and the difference between
// "a name a profile may grant" and "a name only a human may approve" is exactly
// why.
import {
  createLoomMcpServer,
  loomTools,
  LOOM_ANSWER_BLOCKED_TOOL,
  LOOM_MCP_VERSION,
  LOOM_START_TOOL,
  type LoomSessionLink,
} from "@/lib/loom-mcp";
import { createUltraMcpServer, ultraTools, ULTRA_MCP_VERSION } from "@/lib/ultra-mcp";
import {
  createWorkspaceMcpServer,
  workspaceTools,
  WORKSPACE_MCP_VERSION,
} from "@/lib/workspace-mcp";
import {
  browserTools,
  BROWSER_MCP_VERSION,
  CODEX_BROWSER_TOOL_NAMESPACE,
  createBrowserMcpServer,
  isReadOnlyBrowserCall,
} from "@/lib/browser-mcp";
import { namespaceOf } from "@/lib/harness-tools";
import fs from "node:fs";
import { extractMentions } from "@/lib/project-files";
import type { TurnAttachment } from "@/lib/attachment-contract";
import {
  attachmentPath,
  bindAttachments,
  readAttachmentMeta,
} from "@/lib/attachments";
import {
  createPending,
  resolvePending,
  readRules,
  addRule,
  ruleFor,
  ruleMatches,
  ruleOptionsFor,
  makeGuardrailDecision,
  type PermissionDecision,
} from "@/lib/permissions";
import {
  appendTurn,
  getChat,
  logUsage,
  recordCompactions,
  sessionSpendUsd,
  upsertChatStub,
  type Part,
} from "@/lib/store";
// The compaction record (issue #25) — the same shapes and the same
// one-key-per-compaction reducer the client folds its transcript divider from,
// so the marker a reader sees live and the marker they see after a reload come
// out of one rule rather than two that agree by inspection.
import {
  compactionFacts,
  emptyCompactionFold,
  foldCompactionEvent,
  type CompactionEventName,
  type CompactionFacts,
} from "@/lib/compaction";
import { AGENT_SPAWN_TOOL_CANDIDATES, capToolInput, capToolOutput } from "@/lib/transcript";
// The SDKMessage→event projection and its teardown finalizers — the loop body
// that lived inline here from this route's birth until it moved to the server
// layer, where it is tested (see that module's header for the extraction's
// two reasons: projection without a POST in scope, and testability).
import {
  flushStreamingText,
  markInterruptedTools,
  newClaudeTurnState,
  projectClaudeMessage,
  rationToolDetail,
} from "@/server/providers/claude/project-message";
// SIDE-EFFECT IMPORT, and it is load-bearing. @/lib/session-profiles registers
// the four SessionProfileSpec builders at MODULE SCOPE, and module scope only
// runs if something imports the module. Without this line the profile registry
// is EMPTY at request time and resolveSessionProfile below throws on every chat
// request — a 500 on the live path that no gate would catch, because there is
// no test file for this route anywhere in the tree, so bun test / tsc / lint
// all stay green while the app is broken. Do not "tidy" it away as unused.
import "@/lib/session-profiles";

// MAX_DETAILED_TOOL_PARTS (the per-parent tool-detail ceiling) moved to
// server/providers/claude/project-message.ts with the rationing it bounds.

// The SDK's full EffortLevel set, single-sourced from lib/models.ts (also
// what the composer's Select renders) so the API's validation and the UI's
// offered choices can never drift apart. Typed as Set<string> (not the
// inferred Set<EffortLevel>) so the `.has(effort)` check below — where
// `effort` is narrowed to plain `string` by the `typeof effort === "string"`
// guard, not to the literal union — type-checks; the runtime membership test
// is identical either way.
const EFFORT_LEVELS: Set<string> = new Set(EFFORT_OPTIONS.map((o) => o.id));

// Same idea as EFFORT_LEVELS but for Codex's distinct reasoning vocabulary.
// The live cache narrows the UI per model; this route accepts the complete
// protocol union so a newly selected model never fails on a known effort.
const CODEX_EFFORT_LEVELS: Set<string> = new Set(CODEX_EFFORT_OPTIONS.map((o) => o.id));
CODEX_EFFORT_LEVELS.add("max");
CODEX_EFFORT_LEVELS.add("ultra");

// Title generation must never delay teardown beyond this — see the `finally`
// block's Promise.race. Deliberately short: a title that isn't ready by then
// just falls back to appendTurn's own message-prefix default.
const TITLE_RACE_MS = 2_000;

// THE THREE SYSTEM PROMPTS AND THE TWO LIVE-CONTEXT READERS MOVED, in story
// 2.2, to @/lib/session-prompts.ts. They were module-private consts inside
// this route module — whose only export is POST — so a SessionProfileSpec
// builder could not reach them, and copying ~90 lines of moat-adjacent prompt
// text would have made a second source of truth for it. Each one now composes
// the appendix for its own kind, which is what removed the four-arm
// `systemPrompt` ternary from the query() options below. Nothing in this file
// imports them any more: the route reads one field,
// `sessionProfile.systemPromptAppendix`, and branches only on whether it is
// empty.

/**
 * The block appended to a Claude turn's prompt naming this turn's attachments.
 *
 * It is phrased as a statement of fact rather than an instruction ("read these
 * now"): the user may have attached a screenshot purely as backup for a
 * question about something else, and a directive would spend a Read on every
 * file regardless. Absolute paths, because the agent's cwd is the project root
 * but an attachment lives under the Telar state root, outside it.
 */
function attachmentPromptBlock(attachments: readonly TurnAttachment[]): string {
  const lines = attachments.map((a) => `- ${a.name} (${a.mediaType}): ${a.path}`);
  return [
    "The user attached the following file(s) to this message. Read them with",
    "the Read tool if they are relevant to the request:",
    ...lines,
  ].join("\n");
}

// One POST = one turn. Continuation via `resume: sessionId`; the SDK restores
// full conversation state from the session transcript. Token-level streaming
// via includePartialMessages; client abort propagates to the subprocess.
export async function POST(req: Request) {
  const {
    message: rawMessage,
    sessionId,
    model: rawModel,
    project,
    browserScopeKey: rawBrowserScopeKey,
    account,
    effort: rawEffort,
    runtimeMode: rawRuntimeMode,
    // Legacy fields are accepted only to migrate callers that predate the
    // provider-neutral runtime mode.
    permissionMode: rawPermissionMode,
    sandbox: rawSandbox,
    approvalPolicy: rawApprovalPolicy,
    fastMode: rawFastMode,
    serviceTier: rawServiceTier,
    // Session<->Loom link (docs/loom-model.md §5): the client (session-view.tsx)
    // sends this IFF its `planner` OR `steerer` prop is true. "planner" and
    // "steerer" are the two recognized values on the wire — anything else
    // collapses to undefined so a stray/bad value can't be mistaken for a real
    // loom turn. This is how turn 1 knows it's a loom session BEFORE any Chat
    // record exists (existingChat below is undefined for a brand-new session,
    // so its own persisted `role` can't tell us yet). A "steerer" turn also
    // carries `loomId` (below), validated before it's trusted.
    role: rawRole,
    // Turn-1 wire seed for an embedded STEERER session (the loom Chat tab):
    // the loom this session steers. Validated below against the anchoring
    // project before it's ever trusted (a bad/foreign id fails safe to a plain
    // session). Only meaningful when role === "steerer" and no Chat exists yet.
    loomId: rawLoomId,
    // Client-generated id for THIS turn (docs/runtime-architecture.md §A.4).
    // Known before the SDK session id exists, so Stop can target a brand-new
    // session's first turn. Older clients omit it → we mint one (Stop-by-runId
    // just won't be reachable for them, which matches the old behavior).
    runId: rawRunId,
    // The composer Ultra chip's annotation for THIS turn only (docs/plans/
    // ultra-harness.md §4 "Opt-in is a REQUEST, not a behavior flag" — a
    // per-message user request, never a stored/session-level flag). Anything
    // but a literal `true` collapses to false, same fail-safe idiom as
    // `role` above — a stray value can never be mistaken for the user's
    // explicit ask. See `ultraAnnotated` below for where this reaches the
    // agent (a system-prompt note the `ultra` tool's own description tells
    // it to look for).
    ultra: rawUltra,
    // Composer attachments for THIS turn: ids minted by POST /api/chat/
    // attachments, which already holds the bytes. Resolved to absolute paths
    // below and handed to whichever harness is running — never inlined here.
    attachments: rawAttachments,
    // On-demand compaction (this route's trigger for BOTH harnesses, per
    // AD-11/AD-9's "resolve before the body runs" idiom — see the composer's
    // Compact affordance). A flag rather than a dedicated route: compact needs
    // the same project/account/session-profile resolution and the same SSE
    // contract every other turn already gets here, so a second route would
    // either duplicate ~300 lines of that setup or import this file's
    // internals — neither is cheaper than one more field. Anything but a
    // literal `true` collapses to false, the same fail-safe idiom as `ultra`
    // above.
    compact: rawCompact,
  } = await req.json();
  const compact: boolean = rawCompact === true;
  // Ids only, from the wire, narrowed the same fail-safe way as `role`: an
  // entry that isn't a string, or that names an upload this server has no
  // record of, collapses away rather than reaching a harness as a path.
  // `path` is REQUIRED here, unlike on the wire type: an entry only survives
  // the filter below if its bytes are on disk right now. Optional-on-the-wire
  // is for the persisted/tombstone case, which never reaches a harness.
  const turnAttachments: (TurnAttachment & { path: string })[] = (
    Array.isArray(rawAttachments) ? rawAttachments : []
  )
    .map((entry: unknown) => {
      const id = typeof entry === "string" ? entry : (entry as { id?: unknown })?.id;
      return typeof id === "string" ? readAttachmentMeta(id) : null;
    })
    .flatMap((meta) => {
      if (!meta) return [];
      const file = attachmentPath(meta.id);
      return file && fs.existsSync(file)
        ? [{ id: meta.id, name: meta.name, mediaType: meta.mediaType, size: meta.size, path: file }]
        : [];
    });
  // "Which strings are session roles" now has ONE home, in the profile port —
  // this eight-line ternary and core's own sessionKindFromRole were two copies
  // of the same fact, and resolveSessionKind below is the third reader. Same
  // fail-safe narrowing, same three recognized values: anything else collapses
  // to undefined so a stray or hostile wire value can never be mistaken for a
  // real loom turn.
  const role: SessionRole | undefined = sessionRoleFromWire(rawRole);
  const runId: string =
    typeof rawRunId === "string" && rawRunId ? rawRunId : crypto.randomUUID();
  const ultraAnnotated: boolean = rawUltra === true;
  // The Electron browser host is shared, but its tabs and tool namespace are
  // not. Existing chats have one canonical scope. Fresh composers provide a
  // unique draft scope that is adopted into the SDK session id when the first
  // `session` event arrives, preventing two new-session windows from sharing
  // tabs while still keeping one bounded desktop browser process.
  const canonicalBrowserScope = `${project}:${sessionId ?? ""}`;
  const suppliedBrowserScope = typeof rawBrowserScopeKey === "string"
    ? rawBrowserScopeKey.trim()
    : "";
  const draftPrefix = `${project}:draft:`;
  const browserScopeKey = sessionId
    ? canonicalBrowserScope
    : suppliedBrowserScope.startsWith(draftPrefix) && /^[\w.-]+$/.test(suppliedBrowserScope.slice(draftPrefix.length))
      ? suppliedBrowserScope
      : `${project}:draft:${runId}`;

  // M11 finding-1: the escalation surface auto-fires a HIDDEN first turn whose
  // wire message is the kickoff sentinel (see @/lib/escalation-kickoff). On a
  // fresh escalation session we swap it for the server-authored kickoff prompt
  // so the model opens from ESCALATION_SYSTEM_PROMPT + buildEscalationContext
  // (both now in @/lib/session-prompts, reached through the escalation
  // profile's systemPromptAppendix) with a genuine verification proposal.
  // Byte-identical passthrough for every
  // other turn (planner/steerer/plain/real escalation replies), so nothing else
  // changes. Substituted HERE, before generateTitle/query/log all read it.
  //
  // Story 4.1 / AC1 does the same thing for the completion wake, composed as a
  // second swap on the same line rather than as a second branch: the client
  // injects ULTRA_WAKE_SENTINEL as a hidden turn when a detached Ultra run
  // finishes on an idle session, and the server substitutes its own
  // instruction so THE CLIENT NEVER AUTHORS THE FACTS. The outcome itself
  // arrives through the system-prompt appendix (@/lib/session-prompts), not
  // through this string. Note the sentinel's session polarity is the OPPOSITE
  // of the kickoff's — a wake fires only on an already-resumed session — which
  // is why it is its own recognizer and not a case of this one.
  // Compact is a third machinery turn in the same family as the kickoff/wake
  // sentinels below: the wire carries no prompt text at all (the composer's
  // Compact button sends `compact: true` with whatever `message` was sitting
  // in the box, typically empty), and the server substitutes the real
  // instruction. Unlike the other two, that instruction is the SAME literal
  // string for both harnesses — Claude's slash command runs the SDK's own
  // built-in compaction, and the Codex branch (below) never actually sends
  // this text anywhere; it calls runCodexCompact() directly and this value
  // only matters for the `displayText`/kickoff-style bookkeeping that turn
  // shares with every other. Checked first because a compact turn can never
  // also be a kickoff or a wake.
  const message: string = compact
    ? "/compact"
    : resolveUltraWakeMessage(
        sessionId,
        resolveEscalationMessage(role, sessionId, rawMessage),
      );
  // Bug-B fix — the kickoff's resolved instruction ("The human just opened
  // this escalation...") is machinery fed to the model, never something the
  // human said. `message` above (the resolved prompt) still drives the SDK
  // turn unchanged — the seeded first response is untouched — but `isKickoff`
  // marks this turn so persistence/logging (below) never writes that
  // instruction text anywhere it could render as a "user" bubble, and title
  // generation (further below) skips it entirely.
  const isKickoff = !compact && isEscalationKickoff(role, sessionId, rawMessage);
  // Story 4.1 — the wake trigger is machinery for exactly the same reason the
  // kickoff is: its wire text is a sentinel, and the text the model runs is
  // server-authored. `hidden: true` on the client suppresses the user BUBBLE and
  // nothing else — the turn is still POSTed with that text and persistence is
  // governed server-side — so without `hideUserMessage` below, the trigger would
  // be invisible during the session and would reappear as a user bubble after a
  // page reload. Both machinery turns share one flag so neither can drift.
  const isUltraWake = !compact && isUltraWakeTrigger(sessionId, rawMessage);
  // Compact joins the hidden family too — "/compact" (or the Codex no-op
  // prompt) is never something the human typed, so it never earns a user
  // bubble either.
  const hiddenTurn = compact || isKickoff || isUltraWake;
  const displayText: string = compact
    ? "Compact conversation"
    : isKickoff
      ? "Discuss verification"
      : isUltraWake
        ? "Ultra run finished"
        : message;

  // Resolve the anchoring project up front — an unknown/missing project is a
  // plain 400, not an SSE error, so the client fails before any stream opens.
  let manifest: ProjectManifest;
  try {
    manifest = getProject(project).manifest;
  } catch {
    return Response.json(
      { error: `Unknown project "${project ?? ""}".` },
      { status: 400 },
    );
  }

  // Same treatment as the project check: an unknown account is a plain 400
  // before any stream opens, not something canUseTool/the SDK ever sees.
  if (account != null && !getAccount(account)) {
    return Response.json(
      { error: `Unknown account "${account}".` },
      { status: 400 },
    );
  }

  // Caller-supplied account wins (existing chats resume with their persisted
  // chat.account, passed explicitly here), else use the global enabled default.
  // See AGENTS notes on the account-lock: a session's resume transcript lives
  // under the account's config dir, so this route trusts whatever the client
  // sends — the picker being choosable only pre-first-turn is a client-side
  // rule, not enforced here. Resolved ahead of the effort/sandbox checks below
  // because both are provider-shaped (Claude's EffortLevel vs Codex's
  // ModelReasoningEffort; sandbox is Codex-only).
  //
  // A caller-supplied account was validated above. The no-account path exists
  // for API clients that have not adopted the session picker yet and follows
  // the same global default used by the new-session page.
  let profile: AccountProfile;
  if (account) {
    profile = getAccount(account)!;
  } else {
    const named = resolveEnabledAccount();
    if (!named) {
      return Response.json(
        {
          error: `Project "${project ?? manifest.name}" cannot start because no compatible account is enabled. Check Settings → Accounts.`,
        },
        { status: 400 },
      );
    }
    profile = named;
  }

  // Landmine guard: an account pinning a configDir whose login isn't on THIS
  // machine would otherwise wedge the subprocess on an interactive re-auth
  // prompt (and risk billing the wrong login). Refuse up front with the exact
  // remedy. Base-login accounts (no configDir) can't be fs-verified and pass
  // through unchanged.
  const health = accountHealth(profile);
  if (health.status === "missing-config-dir" || health.status === "never-logged-in") {
    return Response.json(
      {
        error: `Account "${profile.name}" is not logged in on this machine — run ${signInCommand(profile)}`,
      },
      { status: 400 },
    );
  }

  const provider = profile.provider ?? "claude";

  // On-demand compaction targets an EXISTING thread — there is nothing to
  // compact before the harness has named one — so unlike every other turn
  // kind here this is a plain 400 rather than a session-profile concern. Both
  // harnesses need this: Claude's "/compact" only means something inside a
  // resumed conversation, and Codex's runCodexCompact (below) resumes a
  // threadId it must already have.
  if (compact && !sessionId) {
    return Response.json(
      { error: "compact requires an existing sessionId." },
      { status: 400 },
    );
  }

  // UltraCode and Ultrathink briefly existed as Telar-only Claude presets.
  // Existing chats may still carry either value; retire them as an ordinary
  // model-default turn instead of breaking the next resume with a 400.
  const effort =
    provider === "claude" && (rawEffort === "ultracode" || rawEffort === "ultrathink")
      ? undefined
      : rawEffort;
  // Resolve the subprocess environment once. Besides preventing three reads
  const runtimeEnv = accountEnv(profile);

  // Omitting effort means "let the model/SDK pick its own default" — only a
  // present-but-invalid value is rejected. Validated up front, alongside
  // project/account, so a bad value is a plain 400 before any stream opens
  // rather than an opaque SDK error mid-turn.
  if (effort != null) {
    const valid =
      typeof effort === "string" &&
      (provider === "codex" ? CODEX_EFFORT_LEVELS.has(effort) : EFFORT_LEVELS.has(effort));
    if (!valid) {
      return Response.json(
        { error: `Invalid effort "${effort}".` },
        { status: 400 },
      );
    }
  }

  if (rawRuntimeMode != null && !isRuntimeMode(rawRuntimeMode)) {
    return Response.json(
      { error: `Invalid runtimeMode "${rawRuntimeMode}".` },
      { status: 400 },
    );
  }
  let legacyMode: RuntimeMode = DEFAULT_RUNTIME_MODE;
  if (rawPermissionMode === "default" || rawSandbox === "read-only") {
    legacyMode = "approval-required";
  } else if (rawPermissionMode === "acceptEdits") {
    legacyMode = "auto-accept-edits";
  } else if (rawPermissionMode === "bypassPermissions" || rawSandbox === "danger-full-access" || rawApprovalPolicy === "never") {
    legacyMode = "full-access";
  }
  const runtimeMode: RuntimeMode = isRuntimeMode(rawRuntimeMode) ? rawRuntimeMode : legacyMode;
  const permissionMode = claudePermissionMode(runtimeMode);
  const profilePermissionMode =
    permissionMode === "bypassPermissions" ? "auto" : (permissionMode ?? "default");
  const { sandbox, approvalPolicy, approvalsReviewer } = codexThreadConfig(runtimeMode);
  const fastMode = rawFastMode === true;
  const serviceTier =
    typeof rawServiceTier === "string" && /^[a-z0-9_-]{1,40}$/i.test(rawServiceTier)
      ? rawServiceTier
      : undefined;
  const claudeEffort = effort;
  // ATTACHMENTS REACH CLAUDE AS PATHS, NOT AS CONTENT BLOCKS. The SDK would
  // take image blocks, but only through streaming-input mode (`prompt` as an
  // AsyncIterable<SDKUserMessage>), and switching this call site to that shape
  // moves resume, canUseTool and the abort path onto a different code path in
  // the SDK for a benefit the agent already has without it: Read renders an
  // image file into the conversation as an image block by itself. A path also
  // matches what the Codex branch sends, so ONE wire shape serves both.
  // `@path` mentions the human typed into this turn, resolved against the
  // project root. Read back OUT of the final text rather than tracked by the
  // composer, so the two can never disagree — see extractMentions.
  //
  // The CLAUDE branch needs nothing further: the `@path` is already in the
  // prompt, the agent's cwd is this same root, and Read takes it from there.
  // The CODEX branch turns each one into a native `mention` input item below.
  const mentions = extractMentions(message, manifest.root);
  const claudePrompt = turnAttachments.length
    ? `${message}\n\n${attachmentPromptBlock(turnAttachments)}`
    : message;

  const model: string = rawModel ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);

  // Session<->Loom link (docs/loom-model.md §5), hoisted out of the stream
  // closure by story 2.2 because the session KIND is a function of it and the
  // profile resolves before the body. Seeded from the resumed chat's own
  // persisted loomId/role (a brand-new chat starts with neither).
  //
  // IT ADDS NO READ, which is what dissolved 2.1's objection to the hoist:
  // getChat already ran on every resumed turn and getLoom on every turn-1
  // steerer/escalation seed. Both simply run EARLIER in the same request.
  //
  // Without the hoist the profile would see only the wire `role`, so a RESUMED
  // planner/steerer/escalation chat whose client omits `role` would resolve as
  // `project` — and once query() is driven from the profile, that silently
  // strips the guidance that IS the kind from every resumed loom session. That
  // is the exact silent degradation AD-11 exists to end, reintroduced from the
  // other side.
  //
  // NEITHER READ THROWS: getLoom returns null on a malformed/traversal id and
  // getChat returns undefined for a missing one, so a bad or foreign loomId
  // still fails SAFE to a plain session and must NEVER become a 400 — a 400
  // that depends on whether a client resent a field is a non-deterministic
  // failure, which is worse than no gate.
  const resumeTarget = sessionId ?? null;
  const existingChat = resumeTarget ? getChat(resumeTarget) : undefined;
  // Turn-1 wire seed for an embedded steerer session (mirrors the planner
  // path, but steerer also binds a loomId). Validated: the loom must exist
  // AND belong to the anchoring project — a bad/foreign id fails safe to a
  // normal session, never binds to someone else's loom. Only ever consulted
  // for a brand-new chat (existingChat's own persisted link wins otherwise).
  // Both a STEERER (loom Chat tab) and an ESCALATION (blocked-loom "Discuss
  // with the orchestrator") turn-1 seed bind a loomId the same way, validated
  // identically.
  let wireLoomId: string | undefined;
  if (
    !existingChat &&
    (role === "steerer" || role === "escalation") &&
    typeof rawLoomId === "string" &&
    rawLoomId
  ) {
    const l = getLoom(rawLoomId);
    if (l && l.project === project) wireLoomId = rawLoomId;
  }
  const loomLink: LoomSessionLink = {
    loomId: existingChat?.loomId ?? wireLoomId,
    // Both steerer AND escalation are PERSISTED as a link role (store.ts's
    // Chat.role union is planner|steerer|escalation) — M11.3's discuss-
    // escalation.tsx fetches the most-recent persisted escalation chat for
    // a loom (GET /api/looms/[id]/chat?role=escalation) and reattaches it
    // on mount, so navigating away and back finds the SAME conversation,
    // not a blank one. This is not an auto-start: the surface only ever
    // reattaches a discussion the human already opened with an explicit
    // click; it never opens a fresh one on its own. Loom-born sessions
    // (steerer/escalation) are filtered out of the regular project
    // session list (GET /api/chats) — reachable only from the loom's own
    // UI (the Chat tab / the blocked-state Discuss surface).
    //
    // MUTATED IN PLACE later, by the loom MCP server's tools as this turn runs
    // (draft_bundle_file lazily sets loomId on first use) and read back by
    // appendTurn. The hoist moves the SAME OBJECT earlier — do not freeze it,
    // spread it, or hand the profile builder a copy that then diverges.
    role:
      existingChat?.role ??
      (wireLoomId && (role === "steerer" || role === "escalation") ? role : undefined),
  };

  // AD-9 — the session profile, resolved BEFORE the route body runs. Story 2.1
  // landed the resolve and the gate; story 2.2 made the handler CONSUME it, so
  // every session-kind decision below — cwd, guardrails, settingSources, the
  // two tool lists and the system-prompt appendix — is read off this value
  // instead of being computed a second time inline. There is no
  // isPlannerSession / isSteererSession / isEscalationSession any more:
  // INV-6e in packages/core/test/invariants.test.ts asserts both halves of
  // that (the three identifiers are gone AND the profile's fields are read).
  //
  // Named `sessionProfile`, NEVER `profile`: `profile` in this scope is the
  // AccountProfile resolved above, which feeds accountEnv, accountHealth,
  // generateTitle, logUsage's `account` and the chat stub's
  // `account` field. Shadowing it is a silent billing bug.
  //
  // The kind comes from resolveSessionKind, which reproduces the precedence the
  // old `systemPrompt` ternary chain had — escalation, then steerer, then
  // planner, then plain — over all three inputs the preamble now holds. Order
  // is load-bearing: a resumed chat persisted as `steerer` whose client also
  // sends `role: "planner"` satisfies two predicates and must resolve as
  // STEERER, exactly as it did before.
  const sessionProfile = resolveSessionProfile({
    kind: resolveSessionKind({ role, linkRole: loomLink.role, loomId: loomLink.loomId }),
    provider,
    manifest,
    project: typeof project === "string" ? project : undefined,
    role,
    // VALIDATED now, not the raw wire value: the steerer/escalation builders
    // hand this id to buildSteererContext/buildEscalationContext, and a builder
    // that could reach an unvalidated id is a builder that can read another
    // project's loom.
    loomId: loomLink.loomId,
    permissionMode: profilePermissionMode,
    ultraAnnotated,
    // Story 4.1 / AC2 — lets the project/planner/steerer composers read this
    // session's completed-Ultra-run mailbox and fold it into the appendix, so
    // the outcome reaches the model as PER-TURN CONTEXT on every turn rather
    // than only on a wake turn. That is what makes the mid-conversation case
    // work without a second delivery mechanism. `undefined` on turn 1 of a
    // fresh session, which is correct: no id yet means no wakes yet, by
    // construction.
    sessionId: typeof sessionId === "string" && sessionId ? sessionId : undefined,
  });

  // AD-11 — an unmet capability is a hard error BEFORE the stream opens, in the
  // same pre-SSE 400 shape as the eight checks above. No silent degradation:
  // today a planner session on a Codex account returns 200 and quietly drops
  // the appended system prompt that IS the kind.
  //
  // The placement is load-bearing, not cosmetic. It must precede
  // registerChatRun below, whose only cleanup is endChatRun inside the stream's
  // `finally` — a 400 after it would leave a registered run with no stream to
  // end, which POST /api/chat/stop would later try to abort. And it must
  // precede titlePromise, which spawns a real subprocess that is likewise only
  // awaited or aborted in that same `finally` — a 400 after it orphans a live
  // subprocess with no cleanup path.
  const unmetProfileCapabilities = unmetCapabilities(sessionProfile, provider);
  if (unmetProfileCapabilities.length > 0) {
    return Response.json(
      {
        error: `A "${sessionProfile.kind}" session needs ${unmetProfileCapabilities.join(", ")}, which the ${providerOf(provider).label} agent does not support. Run this session on a Claude account, or start it as a plain project session.`,
      },
      { status: 400 },
    );
  }

  // THE CLI GATE, in the same pre-SSE 400 shape and for the same AD-11 reason:
  // telar no longer bundles the Claude Code binary, so "is there one, and can we
  // talk to it" is a real precondition rather than an assumption. Refusing here
  // states the problem once, in words the user can act on; letting it through
  // produces a control-protocol failure that surfaces as tool calls being
  // cancelled with nobody able to say why (#28).
  //
  // Only "missing" and "incompatible" refuse. A drifted patch version passes —
  // gating on every unrecognised release would lock a user out of their own app
  // the day Claude Code ships faster than telar does.
  //
  // Codex-backed sessions never touch the Claude CLI, so they are not gated on
  // it: a Codex user with no Claude Code installed is a supported configuration.
  if (provider !== "codex") {
    const cli = resolveClaudeCli();
    if (!claudeCliUsable(cli)) {
      return Response.json({ error: cli.message, claudeCli: cli }, { status: 400 });
    }
  }

  // Reserve the session before consuming any one-shot context. This is the
  // engine-owned single-active-turn gate: two renderers racing the same
  // session cannot both reach startSessionLog (which truncates the live log)
  // or appendTurn (a whole-store read/modify/write). A duplicate run id is the
  // same conflict — overwriting its AbortController would orphan live work.
  const abort = new AbortController();
  if (!registerChatRun(runId, abort, typeof sessionId === "string" && sessionId ? sessionId : null)) {
    return Response.json(
      { error: "This session already has an active turn. Queue the message instead." },
      { status: 409 },
    );
  }

  // Story 4.1 / AC7 — CONSUME the wakes this turn's appendix ACTUALLY CARRIED,
  // so the same outcome is never stated twice and never stated zero times.
  //
  // THE WINDOW IS EXACT, and both edges are load-bearing. AFTER the capability
  // gate above: a pre-stream 400 would otherwise consume a wake no model ever
  // saw. AFTER the run reservation above: another renderer cannot win the
  // session between acknowledgement and execution. The whole block is caught,
  // so it cannot strand the reservation through an early return.
  //
  // ── THIS BLOCK CAN THROW, AND IT IS WRAPPED FOR IT (review B1) ──────────────
  // An earlier version of this comment claimed the ack "cannot fail" because
  // `ackUltraWakes` swallows an unwritable state root. That was true of
  // `ackUltraWakes` and false of the line as a whole: `pendingUltraWakes` has no
  // try/catch of its own, and it reaches `listUltraRuns` — whose `try` guards
  // only the `readdirSync`, not the per-id call — and then `getUltraManifest`,
  // whose self-heal `saveManifest(m)` is an UNWRAPPED WRITE. Two reproduced
  // escapes, both from a probe on a temp state root: a `running` manifest with
  // no `runId` key throws `invalid ultra runId: undefined`, and a well-formed
  // stale `running` manifest whose heal write cannot land throws that write's
  // errno. Neither is session-scoped — `listUltraRuns()` walks the whole
  // directory — so one bad manifest anywhere would 500 EVERY chat turn in the
  // app, including sessions that have never touched Ultra, with no SSE `error`
  // frame because the stream has not opened. The sibling read one screen away
  // (`ultraWakeAppendix` in lib/session-prompts.ts) already sits inside
  // `safeLiveContext` for exactly this reason; this one is wrapped to match.
  // The right fix for the underlying throw is in `getUltraManifest`'s contract,
  // which is fenced out of this story and recorded in deferred-work.md.
  //
  // ── AND IT IS GATED ON DELIVERY, NOT ON THE TURN EXISTING (review SF-3) ─────
  // Acking a wake the model was never shown marks it delivered having been
  // delivered ZERO times — the one failure packages/core/src/ultra/wake.ts's
  // header says is impossible. Two reachable ways this turn can consume an
  // outcome it does not carry, so both are filtered rather than assumed away:
  //   · THE COMPOSER'S READ FAILED. `ultraWakeAppendix` wraps its read in
  //     `safeLiveContext`, which degrades to "" — so the mailbox can be full
  //     while the block is absent, and the failure is silent by design.
  //   · THE PROVIDER DISCARDS THE APPENDIX. `runCodexTurn` below takes no
  //     `systemPrompt` at all, so on a Codex turn nothing composed here reaches
  //     the model. Ultra is Claude-only today, but a session that launched a run
  //     on Claude and then switched provider is an ordinary way to get here.
  // `appendixCarriesUltraWake` asks the composed prompt itself, against the same
  // marker the formatter renders, so the two cannot drift.
  //
  // A DELIBERATE SECOND READ, not a value threaded out of the composer. Every
  // appendix composer in session-prompts.ts returns a plain `string` — that is
  // the shape of all five — and changing one so it could hand back the records
  // it rendered would make the profile builder's return value carry data
  // SessionProfile has no field for. So the ids are re-read here. It is cheap
  // relative to what the turn is about to do, and it keeps the composer pure of
  // the ack.
  //
  // THE TWO READS CAN ONLY DISAGREE IN ONE DIRECTION, and the earlier comment
  // here had it backwards. `resolveSessionProfile` is EAGER — `const spec =
  // build(ctx)` — and nothing between it and this line awaits, so the
  // composer's read strictly PRECEDES this one and this one can only be a
  // SUPERSET. A run that settled in between is therefore in this read and NOT in
  // the appendix, which is precisely the case the delivery gate above filters
  // out; it stays pending for the next turn. Do not "fix" this into one read,
  // and do not restate it as "the newer wake simply stays pending" without the
  // gate — the gate is what makes that sentence true.
  if (typeof sessionId === "string" && sessionId && provider !== "codex") {
    try {
      const carried = pendingUltraWakes(sessionId)
        .map((w) => w.runId)
        .filter((runId) =>
          appendixCarriesUltraWake(sessionProfile.systemPromptAppendix, runId),
        );
      ackUltraWakes(sessionId, carried);
    } catch {
      // The mailbox could not be read. The wakes simply stay pending and are
      // re-stated on the next turn — the correct failure direction, and the one
      // the ack's idempotence already tolerates. Never a 500 on a turn path.
    }
  }

  // Fire title generation the instant the body is validated, in parallel
  // with the main turn below — only for a brand-new session (no resume
  // target: appendTurn only ever consults a supplied title when it's
  // CREATING the chat, so generating one for an existing session's turn
  // would just be wasted inference). Also skipped for the escalation kickoff —
  // `message` there is the server-authored instruction paragraph, not human
  // intent to summarize, and upsertChatStub's own displayText fallback
  // ("Discuss verification", below) is already the right title; wasting an
  // LLM call to re-derive it from machinery text would be pure overhead.
  //
  // ITS OWN CONTROLLER, no longer the turn's. The turn's `abort` now maps a
  // Stop to killing the whole session RUNTIME (see the listener beside the
  // runtime acquisition below) — a shared controller would mean "the title
  // finished, kill the session", which is how the #28 persistent-runtime
  // migration would have reintroduced the very sweep it exists to remove.
  // A Stop still cancels the title via the forwarding listener on `abort`.
  const titleAbort = new AbortController();
  abort.signal.addEventListener("abort", () => titleAbort.abort(), { once: true });
  const titlePromise: Promise<string | null> | null =
    sessionId || isKickoff ? null : generateTitle(message, profile, titleAbort.signal);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // client went away — keep consuming so we still persist the turn
        }
        // Mirror this event so a reconnecting client can tail the in-flight
        // turn (Phase 1b). capturedSession is only truthy after system:init,
        // which is exactly when startSessionLog has opened the file.
        if (capturedSession) {
          if (event === "delta" || event === "thinking_delta") {
            // Token firehose → bounded in-memory ring, kept OUT of the file
            // (contract §2). A reconnect replays it to stream the in-flight
            // block instead of watching it pop in whole on finalize.
            pushSessionDelta(capturedSession, event, data);
          } else {
            // A "text" (block finalize) or "thinking" (new block) event means
            // the deltas that built the prior in-flight block are now
            // superseded — the file carries the finalized "text", or thinking
            // is ephemeral (live-only, never persisted). Clear the ring BEFORE
            // appending so a reconnect never re-streams tokens the file's
            // finalized event already renders. (Node is single-threaded, so
            // this clear+append pair is atomic w.r.t. the /events reader.)
            if (event === "text" || event === "thinking") {
              clearSessionDeltas(capturedSession);
            }
            appendSessionEvent(capturedSession, event, data);
          }
        }
      };

      // The turn's projection state — parts, streaming-text accumulation,
      // parent flattening, usage/result capture. The SHAPE and its rules
      // (first-write-wins tool results, supersedes eviction, per-parent
      // detail rationing) live in server/providers/claude/project-message.ts,
      // where they are tested; this route owns one instance per turn. The
      // aliases are in-place references: the Claude path mutates them through
      // projectClaudeMessage, the Codex normalizer's switch below mutates
      // them directly, and the shared finally persists them.
      const turnState = newClaudeTurnState();
      const { parts, streamingText, parentFlatten } = turnState;
      // NOTE ON WHAT MOVED. `resumeTarget`, `existingChat`, `wireLoomId` and
      // `loomLink` used to be declared right here; story 2.2 hoisted all four
      // into the pre-stream preamble, because the session KIND is a function of
      // them and the profile resolves before this closure runs. The three
      // role-derived booleans that stood alongside them are GONE outright —
      // every decision they made is now a field on `sessionProfile`.
      // `resumeTarget` keeps its old contract: it is the client-supplied id and
      // stays untrusted until the SDK confirms it via system:init below, which
      // is why `capturedSession` (not `resumeTarget`) is what the finally block
      // persists against.
      let capturedSession: string | null = null;
      // The session runtime this turn attached to (Claude path only) — held at
      // stream scope so the shared finally can detach the turn's wiring and
      // close a spawn that never reached init (#28 persistent runtime).
      let runtimeRef: SessionRuntime | null = null;
      let usagePromise: Promise<any> | null = null;
      // Claude's stable control API returns the same structured attribution as
      // `/context`. It must be requested while the query is still
      // bidirectional: the SDK closes stdin as soon as it receives the final
      // result frame. Keep the latest successfully decoded snapshot instead
      // of retaining a request that teardown can invalidate.
      let contextUsage: ContextUsageSnapshot | undefined;
      let contextUsageWarningSent = false;
      // ISSUE #25 — every compaction this stream observes, persisted once at
      // teardown so the transcript keeps a record of where its history was
      // replaced by a summary.
      //
      // ONE COMPACTION IS TWO OR THREE EVENTS AND CARRIES NO ID (Claude:
      // PreCompact + PostCompact + the SDK's `compact_boundary`; Codex:
      // compact_start/compact_end, and its own auto-compaction through
      // compact_end ALONE — normalizeCodexAutoCompact has no start to pair
      // with). Which events belong to which compaction is therefore a rule, and
      // that rule lives in lib/compaction.ts, folded HERE over the events this
      // route sends and folded again on the client over the events it receives.
      // Same function, same order, same list: that is what keeps a reloaded
      // transcript from showing a different number of dividers than the reader
      // just watched appear.
      let compactionFold = emptyCompactionFold<CompactionFacts & { key: string }>();
      // Has anything measured the context since the newest compaction? A
      // compaction invalidates every measurement taken before it, and the next
      // one taken after it is what makes the persisted number true again (both
      // `contextUsage` assignments set this). Read at teardown, so the reloaded
      // wheel knows whether `Chat.contextTokens` post-dates the boundary or
      // predates it — the whole difference between a mid-turn auto-compaction
      // and a compact-only request, which the record's anchor cannot express.
      let contextRemeasured = false;
      const noteCompaction = (event: CompactionEventName, facts: CompactionFacts) => {
        compactionFold = foldCompactionEvent(compactionFold, event, facts);
        contextRemeasured = false;
      };
      // lastResult / lastMainUsage / costUsd live on turnState (see
      // ClaudeTurnState's field comments for the capture-don't-act rule the
      // old inline declarations documented here). Both provider paths write
      // them; only the finally below acts on them, exactly once per POST.
      const contextOf = (u: Record<string, number> | null) =>
        u
          ? (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          : 0;
      // Permission requests opened by THIS stream; drained (deny) on teardown so
      // a client disconnect never leaves canUseTool hanging or a pending leaked.
      const myPending = new Set<string>();

      // Interactive permissions, Claude Code-style: read tools are always
      // allowed; anything else asks the user through an SSE "permission"
      // event answered via POST /api/chat/permission. Guardrails hard-deny.
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        // The SDK's own `suggestions` (PermissionUpdate[]) is intentionally
        // never destructured/used here — see the comment below at the
        // "allow" return for why it's never forwarded as
        // `updatedPermissions`.
        //
        // `agentID` IS read, and its absence was a real hole. The SDK documents
        // it as "If running within the context of a sub-agent, the sub-agent's
        // ID", and this route's own design DEPENDS on sub-agent calls arriving
        // here: the agent-spawn tool is deliberately routed through canUseTool
        // rather than listed in `allowedTools` (see the comment below) so that
        // every tool a sub-agent goes on to call gates individually. That means
        // this function is, by design, the busiest permission surface in the
        // app during parallel agent work — and until now it rendered every one
        // of those requests identically, with nothing saying which agent was
        // asking. A queue of anonymous prompts is a queue nobody can answer.
        {
          signal,
          agentID,
        }: { signal: AbortSignal; suggestions?: PermissionUpdate[]; agentID?: string },
      ): Promise<PermissionResult> => {
        // #28 (opt-in, TELAR_DEBUG_PERMISSIONS=1). The ABSENCE of this line
        // beside a decline is the finding: it means the SDK never asked telar,
        // so telar decided nothing and the refusal came from somewhere else.
        logPermissionCheck(toolName, agentID);
        // disallowedTools / protectedPaths — shared with the PreToolUse hook
        // below (options.hooks) so the same checks apply whether or not this
        // particular call ever reaches canUseTool at all (auto/acceptEdits
        // mode can approve without invoking it — see the hook's own comment).
        //
        // AC2 — driven from `sessionProfile`, not from `manifest`, so the ONE
        // resolved guardrail set governs every seam that enforces it.
        // makeGuardrailDecision is STRUCTURAL (it takes `{ guardrails: … }`),
        // which is why a SessionProfile is assignable where a manifest was, and
        // the resolved guardrails are the manifest's UNIONED with whatever the
        // profile added — never fewer. The moat itself is unchanged and stays
        // OUTSIDE the profile: no profile field reaches this call site's
        // registration, only its data.
        const guardrail = makeGuardrailDecision(
          sessionProfile,
          sessionProfile.cwd,
          toolName,
          input,
        );
        if (guardrail.behavior === "deny") return guardrail;
        // The agent-spawn tool itself is auto-allowed (no interactive prompt —
        // every tool the subagent goes on to call still gates individually
        // through this same canUseTool), but it must still be ROUTED through
        // here rather than listed in `allowedTools`: the SDK's AgentInput
        // accepts a model-controlled `mode` field ("bypassPermissions" /
        // "acceptEdits" / "auto" / "dontAsk") documented as the "Permission
        // mode for spawned teammate", and a separate `isolation` field
        // ("remote" moves the subagent's execution off-box) — if the model
        // set either and the call never reached canUseTool at all, the
        // subagent's own tool calls could skip this gate entirely (silently
        // defeating protectedPaths/disallowedTools for everything it does),
        // or run somewhere telar never intended. Stripping both here (and
        // passing the rest through via updatedInput) closes that hole while
        // keeping spawning itself frictionless; local execution is always
        // correct for telar sessions.
        if ((AGENT_SPAWN_TOOL_CANDIDATES as readonly string[]).includes(toolName)) {
          const { mode: _mode, isolation: _isolation, ...safeInput } = input;
          // `run_in_background` passes through UNTOUCHED, and that is a
          // measured decision, twice over (#28). Under the old one-query-per-
          // turn shape, a backgrounded agent's tool calls were cancelled
          // wholesale the instant the main turn's result landed (2026-08-07,
          // session 9ec50a2e: 1-9ms turnarounds, `toolDenialKind: "cancelled"`,
          // even a pre-allowed Glob) — an interim fix forced sync spawns here.
          // The persistent session runtime (lib/server/session-runtime.ts)
          // removed the kill-zone itself: the same scenario replayed under
          // streaming input runs to completion, post-result tool calls and
          // all. Backgrounded agents are a feature again.
          return { behavior: "allow", updatedInput: safeInput };
        }
        // FULL ACCESS MEANS FULL ACCESS — INCLUDING FOR A SUB-AGENT (#28).
        //
        // Without this, "Full access" was a promise this function did not keep,
        // and it broke in one specific place: sub-agents. `full-access` maps to
        // the SDK's `bypassPermissions`, under which the SDK approves the MAIN
        // turn's calls itself and never invokes canUseTool — so the session
        // looked prompt-free and was. But every tool a sub-agent calls is
        // DELIBERATELY routed here (see the agent-spawn comment above), and
        // this function had no mode check at all. So it did what it does in
        // every other mode: opened a pending approval and awaited a human.
        //
        // Nobody could answer it. The card is addressed to a human who is
        // watching a session they were told needs no approvals, and the tool
        // call sat blocked until something upstream gave up on it — which the
        // model was then told, in the CLI's own words, was the user refusing.
        // Hence "phantom declines" that only ever appeared under parallel agent
        // work, never on a main turn, and never in an Ultra (whose agents are
        // spawned in-process by the executor and never reach this channel).
        //
        // The guardrail above still runs FIRST and its deny still wins, so
        // protectedPaths / disallowedTools are unaffected: this widens what a
        // mode may auto-approve, never what a guardrail permits.
        //
        // THE TWO MOAT TOOLS ARE EXCLUDED, and that exclusion is the whole
        // reason this is not a straight copy of the reference implementation.
        // t3code's ClaudeAdapter returns allow for full-access with no
        // exceptions, because it has no accept moat to keep. Telar does: §M.6
        // requires a human's click on start_loom and answer_blocked in EVERY
        // permission mode, and the PreToolUse hook force-routes both back here
        // precisely so that click cannot be skipped. They must keep asking.
        if (
          runtimeMode === "full-access" &&
          toolName !== LOOM_START_TOOL &&
          toolName !== LOOM_ANSWER_BLOCKED_TOOL
        ) {
          return { behavior: "allow", updatedInput: input };
        }
        const rule = ruleFor(toolName, input);
        // mcp__loom__start_loom is the loom moat's commit action (docs/
        // loom-model.md §M.6) — it must NEVER be satisfiable by a
        // previously-persisted "always allow" rule, or a human's one-time
        // approval of an earlier start_loom call would silently authorize
        // every later one for the rest of this project's lifetime. Skip the
        // stored-rules fast path for it unconditionally; it always falls
        // through to the interactive prompt below (see also the `always`
        // guard further down, which refuses to ever persist a rule for it).
        if (
          toolName !== LOOM_START_TOOL &&
          toolName !== LOOM_ANSWER_BLOCKED_TOOL &&
          readRules(project).some((r) => ruleMatches(r, toolName, input))
        ) {
          return { behavior: "allow", updatedInput: input };
        }
        if (signal.aborted) return { behavior: "deny", message: "Aborted." };

        // Narrow -> broad rule choices for the "Always allow" affordance
        // (contract: the card lets the USER pick how wide a rule to persist,
        // never a heuristic) — remembered on the pending entry so the
        // permission route can validate whichever one the client picks.
        const ruleOptions = ruleOptionsFor(toolName, input);
        const { id, promise } = createPending(project, toolName, input, rule, ruleOptions);
        myPending.add(id);
        // Respect the SDK's per-call signal: resolve the pending (deny) the
        // moment this tool call is aborted. There is no timeout — an
        // unanswered card parks until the user decides or the turn ends
        // (#28; see createPending).
        const onAbort = () => resolvePending(id, { behavior: "deny", reason: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        // `agentId` is undefined for the main turn and set for a sub-agent's
        // call. Undefined is meaningful here and must not be coerced to a
        // placeholder: "the session itself is asking" is a different statement
        // from "some agent is asking and we lost track of which".
        send("permission", { id, toolName, input, rule, ruleOptions, agentId: agentID });

        let decision: PermissionDecision;
        try {
          decision = await promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
          myPending.delete(id);
        }

        send("permission_result", { id, behavior: decision.behavior });
        if (decision.behavior === "allow") {
          // decision.rule is the option the user actually picked off the
          // card (validated against `ruleOptions` by the permission route,
          // see isOfferedRule) — falls back to the prefix rule ruleFor
          // computed above when the user just clicked the default button.
          // Never persisted for start_loom OR answer_blocked (see the readRules
          // skip above) — every commit/answer gets its own interactive approval,
          // no exceptions (§M.6 — the human's click is the provenance stamp).
          if (decision.always && toolName !== LOOM_START_TOOL && toolName !== LOOM_ANSWER_BLOCKED_TOOL) {
            addRule(project, decision.rule ?? rule);
          }
          // Never forward the SDK's own `suggestions` back as
          // `updatedPermissions`, even session-scoped ones. The SDK's
          // PermissionUpdate union includes `{type:'setMode', mode}` where
          // mode ranges over the FULL PermissionMode set — including
          // 'bypassPermissions', which this route's own 400-gate
          // (isValidPermissionMode) explicitly forbids a client from ever
          // selecting — plus 'addRules'/'replaceRules' whose `ruleContent`
          // is entirely SDK-determined and has no relation to the
          // ruleOptionsFor/isOfferedRule choices actually shown on the
          // permission card. Forwarding any of this would let it reach the
          // live session unvalidated, and — since the SDK would then
          // auto-approve matching future calls WITHOUT ever invoking
          // canUseTool again — silently bypass this function's own
          // SHELL_CHAIN-aware ruleMatches for every subsequent call it
          // covers. Our own store (~/.telar/permissions.json, checked via
          // readRules+ruleMatches at the top of every canUseTool call)
          // already covers not re-prompting for an approved rule; nothing
          // needs to reach the SDK's own permission state to get that.
          return { behavior: "allow", updatedInput: input };
        }
        // Distinguish a real user refusal from an abort so the model doesn't
        // treat a cancelled turn as a deliberate "no" and abandon the tool.
        const message =
          decision.reason === "aborted"
            ? "The request was cancelled before the user responded."
            : "Denied by the user in telar.";
        // #28: records WHICH of telar's denial texts the model got, so a
        // genuine telar denial is never mistaken for the CLI's interrupt
        // sentence. They are different strings; this makes that checkable.
        logPermissionOutcome(toolName, "deny", decision.reason);
        return { behavior: "deny", message };
      };

      // Guardrail integrity backstop (permissionMode auto/acceptEdits): the
      // SDK's own classifier (auto) or the accept-edits shortcut can approve
      // a tool call WITHOUT ever calling canUseTool above, which would
      // silently stop enforcing disallowedTools/protectedPaths the moment a
      // session leaves "default" mode. Hooks fire regardless of how
      // permission was decided, in every mode — this re-runs the exact same
      // check (makeGuardrailDecision) as canUseTool's own guardrail branch,
      // so both paths are covered (belt and suspenders).
      // AD-1's SECOND enforcement point, plus the compaction notifiers — both
      // in lib/server/turn-hooks.ts, where each one's closure surface is stated
      // in its signature rather than being the whole of this handler's scope.
      const preToolUseGuardrail = makePreToolUseGuardrail(sessionProfile);
      const { preCompactNotify, postCompactNotify } = makeCompactionNotifiers({
        noteCompaction,
        send,
      });

      try {
        if (provider === "codex") {
          // Codex path: same session/text/thinking/tool/tool_result/done/
          // saved send() vocabulary as the Claude branch below, produced by
          // normalizing the `codex app-server` JSON-RPC stream in
          // lib/codex-app-server.ts — see the mapping there. No hooks/
          // permissionMode (those are Claude SDK concepts), but approvalPolicy
          // (validated above) now drives the SAME interactive canUseTool-style
          // prompt via onCodexApproval below — the sandbox chosen up front is
          // no longer the only access control for this turn.
          //
          // Subagents: a "spawn" event names a Codex collabAgentToolCall's
          // new child thread — resolved through the SAME parentFlatten used
          // by the Claude branch below (childThreadId is the bucket id,
          // exactly like a Claude Agent/Task tool_use id), so nested
          // sub-subagent spawns collapse onto their top-level ancestor the
          // identical way. Every subsequent event tagged with that child's
          // threadId is attributed via parentId/`parent`, the same
          // contract the client already reads for the Claude path.
          // On-demand compaction, dispatched before any of the turn-shaped
          // machinery below is even built (approvals/dynamic tools/tool
          // namespaces all belong to a REAL turn; compact runs none of them).
          // runCodexCompact resumes the SAME threadId with a fresh app-server
          // subprocess (per-turn subprocess architecture — see
          // lib/codex-app-server.ts) and speaks exactly two events:
          // compact_start when thread/compact/start acks, compact_end when
          // runCodexCompact observes the compaction's own item/turn complete
          // (see that function's comment — NOT the deprecated
          // `thread/compacted` notification, which a live trace against a
          // real app-server showed is never actually sent). `capturedSession` and
          // `lastResult` are deliberately left unset for this whole branch —
          // the finally block below only logs usage, appends a turn, and
          // sends "saved"/"done" when one of those is set, so a compact-only
          // request never manufactures a spurious transcript entry for "the
          // harness reorganized its own history." `resumeTarget` is
          // guaranteed non-null here: the 400 guard above already refused
          // `compact: true` without a sessionId.
          if (compact) {
            for await (const nev of runCodexCompact({
              threadId: resumeTarget!,
              env: runtimeEnv,
              signal: abort.signal,
            })) {
              switch (nev.type) {
                case "compact_start":
                  noteCompaction("compacting", { at: Date.now(), trigger: nev.trigger });
                  send("compacting", { trigger: nev.trigger });
                  break;
                case "compact_end":
                  // The whole record for a Codex compaction: VERIFIED against
                  // runCodexCompact — `compact_end` carries a null summary and
                  // NO token counts of any kind, so this record is trigger-only
                  // and the client's wheel says it does not know rather than
                  // inventing a post-compaction number.
                  noteCompaction("compacted", { at: Date.now(), trigger: nev.trigger });
                  send("compacted", { trigger: nev.trigger, summary: nev.summary });
                  break;
              }
            }
            return;
          }

          const resolveCodexParent = (threadId?: string): string | undefined => {
            if (!threadId || threadId === capturedSession) return undefined;
            return parentFlatten.resolve(threadId) ?? undefined;
          };
          // Interactive approvals for Codex, reusing the EXACT SAME pending-
          // approval machinery (createPending/resolvePending from
          // lib/permissions.ts) and permission-card SSE contract
          // (send("permission", ...), answered by the client via POST
          // /api/chat/permission -> resolvePending) as the Claude branch's
          // canUseTool above — that card UI and endpoint are tool-agnostic
          // and need no Codex-specific changes. Every Codex approval request
          // — command or file-change — is shaped as a Bash-tool card
          // (toolName "Bash", input.command) since that's the one shape
          // ruleFor/ruleOptionsFor/the card's permissionPreview already know
          // how to preview and offer "always allow" choices for; a
          // file-change request (no `command` on the wire) falls back to a
          // synthesized command-shaped preview built from its `reason`.
          // Called from lib/codex-app-server.ts's answerApproval — never
          // throws, so a client disconnect (myPending drained "deny" by this
          // same stream's teardown below) or an unexpected error here still
          // resolves to a decline rather than leaving the app-server hanging.
          const onCodexApproval = async (req: {
            command?: string;
            cwd?: string;
            reason?: string;
            kind: "command" | "file";
          }): Promise<"accept" | "decline"> => {
            const input: Record<string, unknown> = {
              command:
                req.command ??
                (req.reason ? `[file change] ${req.reason}` : "Codex requested approval"),
              ...(req.cwd ? { cwd: req.cwd } : {}),
            };
            // AC6 / AD-1's tool-layer half, on the ONE pre-tool seam the Codex
            // harness has. `sessionProfile` (not `manifest`) so the profile's
            // guardrails govern BOTH providers — AC2's "by construction",
            // applied where it was otherwise silently inert: before this,
            // makeGuardrailDecision had exactly two call sites, both reachable
            // only as query() options, and query() is called only in the Claude
            // branch. A project configuring guardrails.disallowedTools or
            // guardrails.protectedPaths in its telar.yaml got both enforced on
            // Claude and NEITHER on Codex.
            //
            // Only for a COMMAND approval, and that restriction is MEASURED,
            // not cautious: this callback shapes BOTH request kinds as a "Bash"
            // card (a file change with no `command` gets a synthesized
            // `[file change] ${reason}` string), so running the check on a file
            // change would deny every file edit in a project whose guardrails
            // merely disallow the Bash TOOL — a false positive on a request
            // that is not a shell command at all. The file-change branch's
            // residual is recorded in
            // _bmad-output/implementation-artifacts/deferred-work.md, owned by
            // story 5.5, along with the two other holes this does not close.
            //
            // No card is created for a guardrail-denied action: showing the
            // human a card for something project policy already forbids invites
            // them to approve it. MEASURED before choosing send("error", …):
            // session-view.tsx's applyServerEvent handles an "error" event by
            // recording it on streamErrorRef and NOT terminating — the stream
            // drains to completion so the trailing "saved"/"done" still land,
            // and the message surfaces once the stream closes. So this is
            // informative rather than destructive, and the human learns WHY the
            // action was declined instead of watching Codex silently fail.
            if (req.kind === "command") {
              const guardrail = makeGuardrailDecision(
                sessionProfile,
                sessionProfile.cwd,
                "Bash",
                input,
              );
              if (guardrail.behavior === "deny") {
                send("error", { message: guardrail.message });
                return "decline";
              }
            }
            const rule = ruleFor("Bash", input);
            const ruleOptions = ruleOptionsFor("Bash", input);
            const { id, promise } = createPending(project, "Bash", input, rule, ruleOptions);
            myPending.add(id);
            const onAbort = () => resolvePending(id, { behavior: "deny", reason: "aborted" });
            abort.signal.addEventListener("abort", onAbort, { once: true });
            send("permission", { id, toolName: "Bash", input, rule, ruleOptions });

            let decision: PermissionDecision;
            try {
              decision = await promise;
            } finally {
              abort.signal.removeEventListener("abort", onAbort);
              myPending.delete(id);
            }
            send("permission_result", { id, behavior: decision.behavior });
            if (decision.behavior === "allow" && decision.always) {
              addRule(project, decision.rule ?? rule);
            }
            return decision.behavior === "allow" ? "accept" : "decline";
          };
          const onCodexDynamicTool = async (req: {
            namespace: string | null;
            tool: string;
            arguments: Record<string, unknown>;
          }): Promise<"accept" | "decline"> => {
            // THE MOAT IS CHECKED FIRST, AND IT IS NOT BROWSER-SCOPED (#28,
            // AD-1 §M.6). Everything below this block is about browser calls;
            // this block is not, and putting it after the namespace filter is
            // what left the hole it closes.
            //
            // On the Claude side, start_loom and answer_blocked are force-routed
            // to an interactive card by the PreToolUse guardrail in EVERY
            // permission mode. A CODEX session has no PreToolUse hook — that is
            // an SDK concept — so this callback is the only gate its tool calls
            // ever pass. And its first line used to return "accept" for every
            // non-browser namespace, while `codexToolNamespaces` below hands
            // Codex the full loom toolset. So an agent in a Codex session could
            // call start_loom — the one action in this toolset that spends money
            // autonomously — and have it auto-accepted, in every mode, with no
            // human in it. The tool handlers cannot catch this: `by` is
            // server-resolved, but nothing in loom-mcp.ts requires a click.
            //
            // Both names are checked against the CANONICAL mcp__<ns>__<tool>
            // spelling, the same one the rules store, the permission card and
            // LOOM_START_TOOL itself use, so the two sides cannot drift.
            const canonicalToolName = req.namespace
              ? `mcp__${req.namespace}__${req.tool}`
              : req.tool;
            const isMoatTool =
              canonicalToolName === LOOM_START_TOOL ||
              canonicalToolName === LOOM_ANSWER_BLOCKED_TOOL;

            // Other Telar dynamic tools retain their existing lifecycle gates.
            // Browser reads are safe to perform immediately; browser mutations
            // need the same user-facing permission card Claude receives unless
            // the selected runtime mode explicitly delegates approval.
            if (!isMoatTool) {
              if (req.namespace !== CODEX_BROWSER_TOOL_NAMESPACE) return "accept";
              if (isReadOnlyBrowserCall(req.tool, req.arguments)) return "accept";
            }

            const toolName = isMoatTool ? canonicalToolName : `mcp__browser__${req.tool}`;
            const guardrail = makeGuardrailDecision(
              sessionProfile,
              sessionProfile.cwd,
              toolName,
              req.arguments,
            );
            if (guardrail.behavior === "deny") {
              send("error", { message: guardrail.message });
              return "decline";
            }
            // `!isMoatTool` on BOTH escapes below, for the two different ways a
            // §M.6 tool could otherwise slip past: a runtime mode that delegates
            // approval wholesale, and a persisted "always allow" rule. The
            // second is the subtler one — it is why the Claude path skips its
            // own readRules fast path for these two names as well. A single
            // Approve click on one start_loom must never become standing
            // authorization for every later one.
            if (!isMoatTool && (runtimeMode === "full-access" || runtimeMode === "auto")) {
              return "accept";
            }

            const rule = ruleFor(toolName, req.arguments);
            if (
              !isMoatTool &&
              readRules(project).some((stored) => ruleMatches(stored, toolName, req.arguments))
            ) {
              return "accept";
            }
            if (abort.signal.aborted) return "decline";

            const ruleOptions = ruleOptionsFor(toolName, req.arguments);
            const { id, promise } = createPending(
              project,
              toolName,
              req.arguments,
              rule,
              ruleOptions,
            );
            myPending.add(id);
            const onAbort = () => resolvePending(id, { behavior: "deny", reason: "aborted" });
            abort.signal.addEventListener("abort", onAbort, { once: true });
            send("permission", {
              id,
              toolName,
              input: req.arguments,
              rule,
              ruleOptions,
            });

            let decision: PermissionDecision;
            try {
              decision = await promise;
            } finally {
              abort.signal.removeEventListener("abort", onAbort);
              myPending.delete(id);
            }
            send("permission_result", { id, behavior: decision.behavior });
            // Never persist a rule for a §M.6 tool, matching the Claude path's
            // own `always` guard. The readRules skip above already refuses to
            // honour such a rule, so this is the second of two halves that must
            // BOTH be present: one refuses to read it, this refuses to write it.
            // Keeping only one leaves a rule on disk asserting a standing
            // approval the human never gave.
            if (decision.behavior === "allow" && decision.always && !isMoatTool) {
              addRule(project, decision.rule ?? rule);
            }
            return decision.behavior === "allow" ? "accept" : "decline";
          };
          // TELAR'S OWN TOOLS, ON CODEX. The same three tool sets the Claude
          // branch registers as in-process MCP servers, handed to the
          // app-server as `dynamicTools` — same definitions, same handlers,
          // same server-resolved `project`/`account` that are never read from
          // tool input. See harness-tools.ts for the conversion and why this
          // is not an HTTP MCP server.
          //
          // This is the fix for the session where a user asked Codex to run an
          // Ultra: there was no ultra tool in its toolset, no error saying so,
          // and a model that narrated spawning three agents it never spawned.
          const codexToolNamespaces = [
            namespaceOf(
              CODEX_BROWSER_TOOL_NAMESPACE,
              BROWSER_MCP_VERSION,
              browserTools({ scopeKey: browserScopeKey }),
            ),
            namespaceOf("ultra", ULTRA_MCP_VERSION, ultraTools({
              project,
              account: profile,
              getSessionId: () => capturedSession,
              getMessageId: () => runId,
            })),
            namespaceOf("loom", LOOM_MCP_VERSION, loomTools({
              project,
              objectiveSeed: message,
              account: profile.name,
              link: loomLink,
              getSessionId: () => capturedSession,
            })),
            namespaceOf("workspace", WORKSPACE_MCP_VERSION, workspaceTools({
              project,
              account: profile,
              getSessionId: () => capturedSession,
            })),
          ];
          for await (const nev of runCodexTurn({
            prompt: message,
            // `@path` mentions, lifted out of the message text and handed over
            // as the app-server's own `mention` input items — the same thing the
            // Codex TUI's `@` produces. The text keeps the `@path` it always
            // had; this makes the file a first-class reference beside it rather
            // than a string the model has to notice.
            ...(mentions.length ? { mentions } : {}),
            // Note this is `message`, NOT `claudePrompt`: the Claude branch has
            // to name its attachments inside the prompt text, whereas here they
            // travel as their own typed input items. Sending both would state
            // the same paths twice.
            ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
            // AC2/AC3 — the same profile-resolved cwd the Claude branch uses.
            cwd: sessionProfile.cwd,
            env: runtimeEnv,
            model,
            ...(effort ? { reasoningEffort: effort as CodexReasoningEffort } : {}),
            sandbox,
            resume: resumeTarget,
            signal: abort.signal,
            approvalPolicy,
            approvalsReviewer,
            ...(serviceTier && serviceTier !== "standard" ? { serviceTier } : {}),
            onApproval: onCodexApproval,
            onDynamicTool: onCodexDynamicTool,
            tools: codexToolNamespaces,
            // The same appendix the Claude branch passes as
            // systemPrompt.append. It used to be built and then dropped on the
            // floor here, which is what made planner/steerer profiles a
            // non-session on this provider.
            instructions: sessionProfile.systemPromptAppendix,
          })) {
            switch (nev.type) {
              case "session": {
                capturedSession = nev.sessionId;
                setChatRunSession(runId, capturedSession);
                // Open the live log (truncate + write the `user` header) BEFORE
                // the first send() so the session event is the log's second line
                // and a reconnecting client can tail this turn (Phase 1b).
                // displayText (not the resolved kickoff instruction) so a
                // mid-turn reconnect's synthetic "user" event can never leak
                // the machinery prompt into a rendered bubble either.
                // `hiddenTurn` also suppresses the line entirely — neither the
                // escalation kickoff nor story 4.1's Ultra wake trigger renders
                // a user bubble on its local POST path, so a mid-turn reconnect
                // must not manufacture one for either.
                startSessionLog(capturedSession, displayText, hiddenTurn);
                send("session", {
                  sessionId: capturedSession,
                  slashCommands: [],
                  skills: [],
                  agents: [],
                });
                // Register-at-create (contract §1), same as the SDK path below:
                // persist a stub row NOW and emit the "saved" event the client
                // already handles, so chatPersisted flips at the START of the
                // turn. Idempotent by id; appendTurn updates this row in place.
                upsertChatStub({
                  id: capturedSession,
                  model,
                  effort,
                  account: profile.name,
                  project,
                  runtimeMode,
                  fastMode,
                  serviceTier,
                  loomId: loomLink.loomId,
                  role: loomLink.role,
                  userText: displayText,
                });
                send("saved", { chatId: capturedSession });
                break;
              }
              case "thinking_start": {
                const parent = resolveCodexParent(nev.threadId);
                send("thinking", parent ? { parent } : {});
                break;
              }
              case "thinking_delta": {
                const parent = resolveCodexParent(nev.threadId);
                send("thinking_delta", { text: nev.text, ...(parent ? { parent } : {}) });
                break;
              }
              case "text_delta": {
                const parent = resolveCodexParent(nev.threadId);
                // Accumulate streamed-so-far text symmetrically with the SDK
                // branch's content_block_delta handling, so the finally-block
                // flush persists whatever was already visible when a Codex turn
                // is aborted mid-stream (undefined main -> null key, as there).
                const key = parent ?? null;
                streamingText.set(key, (streamingText.get(key) ?? "") + nev.text);
                send("delta", { text: nev.text, ...(parent ? { parent } : {}) });
                break;
              }
              case "text": {
                const parent = resolveCodexParent(nev.threadId);
                parts.push({ type: "text", text: nev.text, ...(parent ? { parentId: parent } : {}) });
                send("text", { text: nev.text, ...(parent ? { parent } : {}) });
                // Block finalized -> its accumulated streaming text is now
                // superseded by the pushed part, same clear as the SDK branch.
                streamingText.set(parent ?? null, "");
                break;
              }
              case "tool": {
                const parent = resolveCodexParent(nev.threadId);
                const input = capToolInput(nev.input);
                const part: Extract<Part, { type: "tool" }> = {
                  type: "tool",
                  id: nev.id,
                  name: nev.name,
                  input,
                  ...(parent ? { parentId: parent } : {}),
                };
                parts.push(part);
                send("tool", { id: nev.id, name: nev.name, input, ...(parent ? { parent } : {}) });
                break;
              }
              case "tool_result": {
                const parent = resolveCodexParent(nev.threadId);
                const part = parts.find(
                  (p): p is Extract<Part, { type: "tool" }> =>
                    p.type === "tool" && p.id === nev.id,
                );
                // First write wins — same dedupe rule as the Claude branch's
                // "user" (tool_result) handling below.
                if (!part || part.output !== undefined) break;
                const output = capToolOutput(nev.output);
                part.output = output;
                part.isError = nev.isError;
                send("tool_result", { id: nev.id, output, isError: nev.isError, ...(parent ? { parent } : {}) });
                break;
              }
              case "spawn": {
                // The sender is a top-level (root) thread -> resolveCodexParent
                // returns undefined -> this spawn's own part has no parentId,
                // making it TOP-LEVEL bucket-worthy (see session-view.tsx's
                // agentBuckets: agent + id + parentOf===undefined). A sender
                // that's itself a subagent resolves to that ancestor's id
                // instead — same flattening the Claude branch does for a
                // subagent-of-a-subagent.
                const parent = resolveCodexParent(nev.parentThreadId);
                if (parent) parentFlatten.noteSpawn(nev.childThreadId, parent);
                const agent = { type: nev.model, description: nev.prompt };
                const input = capToolInput({ prompt: nev.prompt });
                const part: Extract<Part, { type: "tool" }> = {
                  type: "tool",
                  id: nev.childThreadId,
                  name: "spawnAgent",
                  input,
                  agent,
                  ...(parent ? { parentId: parent } : {}),
                };
                parts.push(part);
                send("tool", {
                  id: nev.childThreadId,
                  name: "spawnAgent",
                  input,
                  agent,
                  ...(parent ? { parent } : {}),
                });
                break;
              }
              case "spawn_result": {
                const part = parts.find(
                  (p): p is Extract<Part, { type: "tool" }> =>
                    p.type === "tool" && p.id === nev.childThreadId,
                );
                if (!part || part.output !== undefined) break;
                const output = capToolOutput(nev.output);
                part.output = output;
                part.isError = nev.isError;
                part.taskStatus = nev.status;
                send("tool_result", { id: nev.childThreadId, output, isError: nev.isError });
                send("task_status", { id: nev.childThreadId, status: nev.status });
                break;
              }
              case "usage": {
                // A measurement newer than any compaction so far (issue #25).
                contextRemeasured = true;
                contextUsage = fromCodexContextUsage({
                  model,
                  totalTokens: nev.usage.total_tokens,
                  modelContextWindow: nev.usage.model_context_window,
                  inputTokens: nev.usage.input_tokens,
                  cachedInputTokens: nev.usage.cache_read_input_tokens,
                  cacheWriteInputTokens: nev.usage.cache_creation_input_tokens,
                  outputTokens: nev.usage.output_tokens,
                  reasoningOutputTokens: nev.usage.reasoning_output_tokens,
                });
                turnState.lastMainUsage = {
                  // Codex's last.totalTokens is the exact figure its own UI
                  // uses for context occupancy. Cached input is already a
                  // subset of input, so do not add it again here.
                  input_tokens: nev.usage.total_tokens,
                };
                // Codex has no per-token billing (ChatGPT subscription — see
                // lib/models.ts's zeroed Codex pricing), so totalCostUsd is
                // always 0 here rather than derived from usage.
                turnState.lastResult = {
                  subtype: "success",
                  totalCostUsd: 0,
                  usage: nev.usage,
                };
                break;
              }
              case "compact_start":
              case "compact_end": {
                // CODEX'S OWN AUTO-COMPACTION, MID-TURN — and until issue #25
                // this switch had no case for it at all, so the one compaction
                // nobody asked for was the one the client was never told about.
                // normalizeCodexAutoCompact yields `compact_end` alone (there
                // is no start to pair with: this connection never requested the
                // compaction), and TWO of them in one turn are two compactions —
                // which is exactly what foldCompactionEvent's "a repeated event
                // opens a new compaction" rule reads them as. Same two client
                // events as the on-demand branch above; the client's indicator
                // and divider do not care which door a compaction came through.
                if (nev.type === "compact_start") {
                  noteCompaction("compacting", { at: Date.now(), trigger: nev.trigger });
                  send("compacting", { trigger: nev.trigger });
                } else {
                  noteCompaction("compacted", { at: Date.now(), trigger: nev.trigger });
                  send("compacted", { trigger: nev.trigger, summary: nev.summary });
                }
                break;
              }
              case "rate_limits": {
                // Provider quota events are intentionally ignored. Telar records
                // only the session usage it can attribute to this turn.
                break;
              }
              case "error": {
                const parent = resolveCodexParent(nev.threadId);
                send("error", { message: nev.message, ...(parent ? { parent } : {}) });
                break;
              }
            }
          }
        } else {
        // The "loom" in-process MCP server (docs/loom-model.md §5) — draft/
        // read tools plus the human-gated start_loom commit. `account` is
        // this chat's own server-resolved identity (profile.name), never
        // anything the model supplies — see loom-mcp.ts's start_loom, which
        // stamps it as startLoomFromBundle's `by`/provenance. `getSessionId`
        // reads `capturedSession` lazily: tool calls only ever run after the
        // SDK's system:init message below has already set it.
        // NOTE (#28 persistent runtime): these four servers are constructed
        // inside the runtime's `create` callback below, ONCE per session
        // runtime rather than once per POST. The getters they close over read
        // live runtime state (`self().sessionId`, `slots.runId`) so a reused
        // runtime's tool calls attribute to the CURRENT turn, not the creating
        // one. The creating POST's other captures (project, profile, loomLink,
        // sessionProfile) are all part of the runtime fingerprint, so a POST
        // that would disagree about them gets a fresh runtime instead of a
        // stale closure.
        const makeTelarMcpServers = (ctx: {
          slots: { runId: string | null };
          self: () => { sessionId: string | null };
        }) => ({
          loom: createLoomMcpServer({
            project,
            objectiveSeed: message,
            account: profile.name,
            link: loomLink,
            getSessionId: () => ctx.self().sessionId ?? capturedSession,
          }),
        // The "ultra" in-process MCP server (docs/plans/ultra-harness.md §4) —
        // ultra/ultra_status/ultra_stop, auto-run like the loom read/draft
        // tools (see ULTRA_AUTO_TOOLS's own comment for why this differs from
        // start_loom's human-gated moat). `account`/`project` are this chat's
        // own server-resolved values, never anything the model supplies (same
        // rule as loomMcpServer above). `getMessageId` threads the per-turn
        // `runId` (declared at the top of this POST) as Ultra's own
        // "messageId" link — the finest-grained id a chat turn has in this
        // app (see ultra-mcp.ts's UltraMcpOpts doc).
        //
        // CORRECTED BY STORY 2.2 — this comment used to claim the ultra server
        // is "not offered to an escalation session (excluded from mcpServers/
        // allowedTools below)". Measured: `mcpServers` below is UNCONDITIONAL,
        // so the server IS registered for an escalation session; what that
        // surface does not get is its TOOLS, which the escalation profile puts
        // in `toolPolicy.deny` (the SDK guarantees a disallow beats any allow,
        // so they are truly uncallable while the server is still registered).
        // Behaviourally identical to what the old comment described, but a
        // comment that misstates a moat-adjacent fact is worse than no comment
        // — and this is the sentence a reader consults when deciding what
        // `mcpServers` should carry. The escalation surface stays a narrow
        // read-only discuss wall; the TOOLSET enforces that, not the server
        // list.
          ultra: createUltraMcpServer({
            project,
            account: profile,
            getSessionId: () => ctx.self().sessionId ?? capturedSession,
            getMessageId: () => ctx.slots.runId ?? runId,
          }),
        // The "workspace" in-process MCP server (story 5.1) — the ONLY path any
        // session has to the user's item store, which lives under TELAR_HOME and
        // is deliberately outside every session's cwd. `project` and `account`
        // are this chat's own server-resolved values and are NEVER read from
        // tool input: a `project` argument on list_items would let any project
        // session enumerate and file into every other project's items, which is
        // the precise leak the tool-surface design exists to prevent. Bound as
        // `wsMcpServer` rather than anything starting with `workspace` because
        // INV-6e greps this file for the substring `const workspace` — a guard
        // left behind by story 2.2's removal of `const workspace = manifest.root`.
          workspace: createWorkspaceMcpServer({
            project,
            account: profile,
            getSessionId: () => ctx.self().sessionId ?? capturedSession,
          }),
        // One lazy, server-owned browser runtime backs both the human surface
        // and agent tools. Constructing this descriptor does not start a
        // browser; the Playwright MCP process launches only on first use.
          browser: createBrowserMcpServer({ scopeKey: browserScopeKey }),
        });
        // The composer-annotation note (doc §4's per-turn Ultra opt-in) used to
        // be composed HERE as `ultraAnnotated && !isEscalationSession ? … : ""`
        // — a session-kind conditional, and the smallest one AC1 had to remove.
        // It now lives with the builders in @/lib/session-prompts, reached
        // through `sessionProfile.systemPromptAppendix` below: project, planner
        // and steerer carry it when the chip is on; escalation never does, and
        // that is enforced by escalationAppendix having no `ultraAnnotated`
        // parameter at all rather than by a branch here.
        // Read ONCE per turn rather than inside the options literal — the file
        // read is cheap but it is still a read, and a config value that could
        // change midway through building one request is a config value two
        // fields could disagree about. `?? 0` normalizes the absent case so the
        // spread below tests one thing.
        const policyMaxTurns = loadPolicy().maxTurns ?? 0;

        // THE QUERY IS PER-SESSION NOW, NOT PER-TURN (#28's complete fix — the
        // post-result kill-zone; the whole story is lib/server/session-runtime.ts).
        // Everything the query is created WITH is captured in this fingerprint;
        // a turn that would disagree about any of it closes the old runtime
        // (gracefully, with `resume` picking the session back up) rather than
        // running under a stale closure. The appendix is the interesting entry:
        // it carries occasional per-turn live context (an Ultra wake block), and
        // restart-on-change is exactly the honest behaviour for it.
        const runtimeFingerprint = JSON.stringify({
          cwd: sessionProfile.cwd,
          model,
          effort: claudeEffort ?? null,
          permissionMode: permissionMode ?? null,
          fastMode: !!fastMode,
          account: profile.name,
          project: project ?? null,
          browserScopeKey: browserScopeKey ?? null,
          loomLink,
          appendix: sessionProfile.systemPromptAppendix,
          settingSources: sessionProfile.settingSources,
          allow: sessionProfile.toolPolicy.allow,
          deny: sessionProfile.toolPolicy.deny,
          policyMaxTurns,
          env: runtimeEnv,
          projectMcp: project ? Object.keys(resolveProjectMcpServers(project)) : [],
        });
        const { runtime, created: runtimeCreated } = acquireSessionRuntime({
          key: resumeTarget ?? runId,
          fingerprint: runtimeFingerprint,
          create: ({ slots, input, abort: runtimeAbort, self }) => {
            const telarMcpServers = makeTelarMcpServers({ slots, self });
            return query({
          prompt: input,
          options: {
            ...claudeExecutableOptions(),
            // AC2 — `cwd` arrives BY CONSTRUCTION. The fold sets it from
            // `ctx.manifest.root`, which is exactly what `const workspace =
            // manifest.root` used to compute here, so this is the removal of a
            // second computation rather than a new one.
            cwd: sessionProfile.cwd,
            ...(resumeTarget ? { resume: resumeTarget } : {}),
            model,
            ...(claudeEffort ? { effort: claudeEffort as EffortLevel } : {}),
            // `profile`, NOT `sessionProfile` — this is the AccountProfile, and
            // accountEnv is what dispatches the turn onto the right login. The
            // two names are one character apart and a mix-up bills the wrong
            // account; the whole neighbourhood was edited by story 2.2, which is
            // exactly the context in which such a slip happens.
            env: runtimeEnv,
            // Kind-specific guidance (docs/loom-model.md §5, adaptive-
            // verification.md §8) is ADDITIVE via the preset's own `append`, and
            // WHICH text that is has stopped being decided here: the profile's
            // builder composed it (static prompt + per-turn live context + the
            // Ultra note, per kind — see @/lib/session-prompts). What remains is
            // a branch on EMPTINESS, which is the identical shape the
            // `ultraAnnotationNote ? … : …` fallthrough already had and is what
            // preserves "a normal session's systemPrompt is byte-for-byte
            // unchanged".
            systemPrompt: sessionProfile.systemPromptAppendix
              ? {
                  type: "preset",
                  preset: "claude_code",
                  append: sessionProfile.systemPromptAppendix,
                }
              : { type: "preset", preset: "claude_code" },
            ...(permissionMode ? { permissionMode } : {}),
            ...(permissionMode === "bypassPermissions"
              ? { allowDangerouslySkipPermissions: true }
              : {}),
            ...(fastMode
              ? {
                  settings: {
                    fastMode: true,
                  },
                }
              : {}),
            // Load Claude's native user/project/local stack from the selected
            // provider instance. For the default instance this is ~/.claude;
            // an account with CLAUDE_CONFIG_DIR gets its own complete stack.
            // Those settings can grant `permissions.allow` or
            // `defaultMode: bypassPermissions`, which the
            // SDK honors BEFORE canUseTool is ever invoked — our guardrails
            // and the interactive prompt below are both bypassed for
            // whatever the selected configuration pre-allows. Hooks,
            // apiKeyHelper and MCP servers from those settings also run,
            // outside canUseTool entirely. `disallowedTools` is passed
            // explicitly below because the SDK guarantees a disallow always
            // wins over any allow rule (repo-settings or otherwise), which is
            // the one lever we have against a repo widening its own access.
            //
            // The canonical ["user", "project", "local"] list lives at the
            // provider/profile seam. Spread because the field is readonly and
            // the SDK's own SettingSource[] is not.
            settingSources: [...sessionProfile.settingSources],
            // The agent-spawn tool ("Agent"/"Task") is deliberately NOT in the
            // profile's allow set even though it's auto-allowed in effect: an
            // `allowedTools` entry is approved by the SDK before canUseTool
            // is ever invoked, which would let a model-supplied AgentInput
            // `mode` override reach the subagent unexamined (see canUseTool's
            // own dedicated branch above, which allows it AND strips that
            // field). Read/Grep/Glob plus the web tools are auto-allowed:
            // all are individually-safe read-only tools that never touch the
            // filesystem. Auto-allowing the web tools also keeps them prompt-
            // free inside a SUBAGENT. (An earlier version of this comment
            // claimed subagent canUseTool requests "fail closed with 'Stream
            // closed'" — false: that string exists nowhere, and subagent
            // requests DO reach the interactive channel; see this function's
            // own agentID handling and the full-access short-circuit above.
            // Their cards just land on Main with no parent attribution, so
            // pre-allowing read-only research tools spares a card queue, not
            // a failure.) The PreToolUse guardrail hook still runs for these.
            //
            // ZERO ARITHMETIC HERE, and that is the point of story 2.2. This
            // used to be a two-arm ternary composing six literals plus
            // ...LOOM_AUTO_TOOLS plus ...ULTRA_AUTO_TOOLS on one side and
            // [...LOOM_ESCALATION_READONLY_TOOLS] on the other. The profile
            // resolves the same names in the same order (core's grown
            // BASE_ALLOWED_TOOLS OPENS with the route's old array, element for
            // element — story 5.1 appended the four mcp__workspace__ names, so
            // it is now a strict superset rather than equal to it, and
            // session-profiles.test.ts pins the prefix and the suffix
            // separately), and any composition the route KEEPS is a place a
            // future profile cannot narrow. mcp__loom__start_loom and
            // mcp__loom__answer_blocked are absent from the base union
            // entirely, so no profile can spell them here — a strictly stronger
            // moat than the old literal array, enforced by the compiler.
            allowedTools: [...sessionProfile.toolPolicy.allow],
            // AskUserQuestion (and any sibling structured-question tool the
            // SDK exposes) is hard-disallowed for every kind: the chat UI has
            // no widget to answer a structured question, so the model must ask
            // clarifying questions as plain chat messages instead (see
            // PLANNER_SYSTEM_PROMPT in @/lib/session-prompts). An escalation
            // profile ADDS the state-changing loom tools (steer/reject/
            // answer_loom/resume/cancel/watch/draft/propose/start) PLUS all
            // three ultra tools: the SDK guarantees a disallow beats any allow,
            // so those tools — registered on the loom/ultra MCP servers for
            // other sessions — are truly uncallable there, even interactively
            // (never just falling through to canUseTool's card).
            // answer_blocked is deliberately NOT disallowed (it stays
            // callable-but-human-gated — the ONLY escalation write path).
            //
            // AC2 — `manifest.guardrails.disallowedTools` used to be spread in
            // front of this list by hand. The resolver folds it in now, so this
            // is ONE field and a reader cannot pick up half the deny set. The
            // redundancy with `sessionProfile.guardrails` is deliberate and is
            // AD-1's "enforced twice" one level down: guardrails feed
            // makeGuardrailDecision (our hook + canUseTool, and the only carrier
            // of protectedPaths), this feeds the SDK's own deny list.
            disallowedTools: [...sessionProfile.toolPolicy.deny],
            // The loom MCP server (see loomMcpServer above) — its tools
            // surface as mcp__loom__*, gated the same way every other tool
            // is: allowedTools for the safe read/draft ones, canUseTool +
            // the PreToolUse hook for start_loom. The ultra MCP server
            // (ultraMcpServer above) surfaces as mcp__ultra__* — Claude-only
            // for now (doc §7/Open-Q3: ships Claude-first; this whole branch
            // is already the non-Codex path, see the `if (provider ===
            // "codex")` split above, so no extra provider check is needed
            // here). Per-project MCP servers (docs/runtime-architecture.md
            // §B) with their OWN token-injected env/headers — resolved
            // decoupled from accountEnv above, so account-switching can't
            // rotate MCP auth.
            mcpServers: {
              ...telarMcpServers,
              // THE SPREAD IS LAST, AND THAT IS NOT A PROTECTION — object-literal
              // LATER KEYS WIN, so a project telar.yaml server named `workspace`
              // SHADOWS ours. Spread-FIRST would be the protection, and moving it
              // is a real behaviour change (a project's own server would then be
              // silently dropped instead), so it is not done here. Pre-existing:
              // one named `loom` or `ultra` already shadows those. Recorded in
              // deferred-work.md; the fix is a reserved-name guard in
              // resolveProjectMcpServers, not a reordering. Do not read this
              // ordering as the guard.
              ...(project ? resolveProjectMcpServers(project) : {}),
            },
            // Explicit Telar servers are added beside MCP servers from the
            // selected Claude configuration, matching a native Claude launch.
            //
            // TRAMPOLINES, NOT THE TURN'S OWN CLOSURES. The query outlives the
            // POST that created it, but `canUseTool` and the compaction
            // notifiers are wired to a live SSE response — so the query gets a
            // trampoline that reads the runtime's slots at call time. The
            // active POST installs its closures right after acquisition and
            // clears them in its finally. Between turns a gated call gets an
            // honest deny that blames nobody (DETACHED_DENY_TEXT) — reachable
            // only by a background agent that outlived its turn's quiet-grace
            // and then asked for a non-pre-approved tool.
            canUseTool: (toolName, toolInput, opts) =>
              slots.canUseTool
                ? slots.canUseTool(toolName, toolInput, opts)
                : Promise.resolve({
                    behavior: "deny",
                    message: DETACHED_DENY_TEXT,
                  } satisfies PermissionResult),
            hooks: {
              // Profile-scoped, not response-scoped — safe to bind at creation.
              PreToolUse: [{ hooks: [preToolUseGuardrail] }],
              PreCompact: [
                {
                  hooks: [
                    async (i: HookInput) =>
                      slots.preCompactNotify ? slots.preCompactNotify(i) : { continue: true },
                  ],
                },
              ],
              PostCompact: [
                {
                  hooks: [
                    async (i: HookInput) =>
                      slots.postCompactNotify ? slots.postCompactNotify(i) : { continue: true },
                  ],
                },
              ],
            },
            // NO TURN CEILING BY DEFAULT — omitted, not set to a big number.
            //
            // This used to be a bare `maxTurns: 25` with no comment and no way
            // to change it, and a session that hit it stopped mid-task with
            // "exceeded step count". On a long refactor that is not a safety
            // rail firing, it is the tool quitting on work the human asked for
            // and is still watching.
            //
            // A Telar session is the same shape as a Claude Code session, so it
            // gets the same posture: the SDK's `maxTurns` is optional
            // (sdk.d.ts's "Maximum number of conversation turns before the query
            // stops") and the CLI exposes `--max-turns` as an OPT-IN, so leaving
            // the field off is what matches the harness this wraps. Spreading
            // rather than passing `undefined` keeps that literal — an explicit
            // `maxTurns: undefined` is a field the SDK still sees.
            //
            // WHAT BOUNDS A RUNAWAY INSTEAD, since it is no longer this: the
            // human watching it with a Stop button (the abort controller wired
            // below), the admission controller's concurrency ceiling, and the
            // usage ledger. A turn cap was never the load-bearing one — it just
            // fired first, on the wrong sessions.
            //
            // The ceiling remains AVAILABLE, as the same override looms already
            // honor: `~/.telar/policy.json`'s `maxTurns` (ModelPolicy,
            // schemas.ts). Set it and this surface obeys it; that override
            // existed and this was the one place ignoring it.
            ...(policyMaxTurns ? { maxTurns: policyMaxTurns } : {}),
            includePartialMessages: true,
            // Relay full subagent conversation text (not just its tool
            // calls/results) on this same stream, each message tagged with
            // parent_tool_use_id — the basis for the client's per-subagent
            // tabs (contract: see route.ts's per-message `parent`/`parentId`
            // attribution below).
            forwardSubagentText: true,
            // The RUNTIME's controller, not the POST's: aborting it kills the
            // session process. The POST's `abort` maps a Stop onto it via the
            // listener below.
            abortController: runtimeAbort,
          },
            });
          },
        });
        // Stop keeps today's semantics exactly: the Stop button killed the
        // turn's process before, and background tasks died with it — so a Stop
        // kills the runtime, background tasks included. The gentler
        // interrupt()-only refinement is deliberately not taken in this change.
        abort.signal.addEventListener("abort", () => runtime.closeNow("stopped"), {
          once: true,
        });
        runtimeRef = runtime;
        // Install THIS turn's live wiring; the finally below clears it.
        runtime.slots.canUseTool = canUseTool;
        runtime.slots.send = send;
        runtime.slots.preCompactNotify = preCompactNotify;
        runtime.slots.postCompactNotify = postCompactNotify;
        const q = runtime.query;
        // A REUSED runtime emits no system:init — that fires once per query,
        // and this query started on an earlier turn. The session id is the
        // runtime's own key, so the init-branch bookkeeping runs here instead:
        // run registration, live-log open, stub upsert, usage capture. The
        // "session" SSE event is deliberately NOT re-sent — the client already
        // holds this session's slash-commands/skills/agents, and re-sending
        // them empty would clear that state.
        if (!runtimeCreated && resumeTarget) {
          const reusedSession: string = resumeTarget;
          capturedSession = reusedSession;
          setChatRunSession(runId, reusedSession);
          startSessionLog(reusedSession, displayText, hiddenTurn);
          upsertChatStub({
            id: reusedSession,
            model,
            effort,
            account: profile.name,
            project,
            runtimeMode,
            fastMode,
            serviceTier,
            loomId: loomLink.loomId,
            role: loomLink.role,
            userText: displayText,
          });
          send("saved", { chatId: reusedSession });
          const usageFn = (q as unknown as Record<string, () => Promise<unknown>>)
            .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
          usagePromise = usageFn ? usageFn.call(q).catch(() => null) : null;
        }
        const turnFeed = runtime.beginTurn(runId);
        runtime.push({
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: claudePrompt },
        });
        // TELAR'S OWN TOOLS ARE NOT THE CLASSIFIER'S BUSINESS.
        //
        // In `auto` mode a model classifier — a security monitor prompted to
        // catch "actions even a human developer shouldn't do unilaterally" —
        // approves or denies every call that reaches the permission-mode step.
        // That is the right posture for Bash and for edits. It is the wrong one
        // for the four in-process servers telar itself defines and whose entire
        // surface it wrote: filing a workspace item, reading a loom, inspecting
        // an Ultra run. Those are already gated by the PreToolUse guardrail
        // (which runs first, in every mode) and by this route's own
        // canUseTool, so classifying them adds no safety and one more way to
        // fail — including a denial the user never made, which is what a
        // classifier non-decision reaches the model as.
        //
        // The override is per SERVER NAME, so it names only servers telar
        // constructs. A project's own `telar.yaml` MCP servers are deliberately
        // absent: those are third-party surfaces this app did not write, and
        // they keep the classifier.
        //
        // AND A SHADOWED NAME IS SKIPPED, which is the sharp edge here. The
        // mcpServers literal above spreads the project's own servers LAST, and
        // later keys win — so a project that defines a server called
        // `workspace` REPLACES ours under that name. Exempting by name alone
        // would then hand a third-party server the exemption written for
        // telar's own, which is the one way this could weaken a boundary rather
        // than tidy one. The shadowing is pre-existing and recorded in
        // deferred-work.md; what must not be pre-existing is this override
        // trusting it.
        //
        // Best-effort by design. It is a refinement, not a guarantee — a
        // failure here must never take down a turn that would otherwise run,
        // so it is caught and dropped. Only available in streaming input mode,
        // WHICH THIS ROUTE NOW IS (#28's persistent runtime): before that
        // migration this loop ran on every turn and silently no-opped on every
        // one of them. Once per runtime — the override sticks for the
        // process's lifetime.
        if (runtimeCreated) {
          const projectServerNames = new Set(
            project ? Object.keys(resolveProjectMcpServers(project)) : [],
          );
          for (const server of TELAR_OWN_MCP_SERVERS.filter((n) => !projectServerNames.has(n))) {
            try {
              await q.setMcpPermissionModeOverride(server, "default");
            } catch {
              // An SDK that does not offer the override, or a name that no server
              // registered under, leaves the classifier in place — the status quo.
            }
          }
        }
        for await (const msg of turnFeed) {
          if (msg.type === "system" && msg.subtype === "init") {
            const init = msg as {
              session_id: string;
              slash_commands?: string[];
              skills?: string[];
              agents?: string[];
              tools?: string[];
            };
            capturedSession = init.session_id;
            setChatRunSession(runId, capturedSession);
            // Re-key the runtime from the creating turn's runId to the
            // SDK-confirmed session id, so the NEXT turn on this session finds
            // and reuses the live process (#28 persistent runtime).
            runtime.adoptSession(capturedSession);
            // Open the live log (truncate + write the `user` header) BEFORE the
            // first send() so the session event is the log's second line and a
            // reconnecting client can tail this turn (Phase 1b). displayText
            // (not the resolved kickoff instruction) so a mid-turn reconnect's
            // synthetic "user" event can never leak the machinery prompt.
            // `hiddenTurn` also suppresses the line entirely — neither the
            // kickoff nor story 4.1's Ultra wake trigger renders a user bubble
            // on its local POST path, so a mid-turn reconnect must not
            // manufacture one for either (M11.3 finding).
            startSessionLog(capturedSession, displayText, hiddenTurn);
            send("session", {
              sessionId: capturedSession,
              slashCommands: init.slash_commands ?? [],
              skills: init.skills ?? [],
              agents: init.agents ?? [],
            });
            // Register-at-create (contract §1): persist a stub chat row NOW —
            // the instant the session id is confirmed, before the first turn
            // finishes — then emit the SAME "saved" event the client already
            // handles (session-view.tsx's "saved" case just flips chatPersisted
            // + refreshes). So rename / minimize-to-dock unlock at the START of
            // the turn with zero new client event types. Idempotent by id: a
            // resumed session's row already exists (no-op), and the end-of-turn
            // appendTurn updates THIS row in place — never a duplicate.
            // best-available title now is the message-prefix fallback
            // (upsertChatStub derives it from userText); the generated title
            // upgrades it at end-of-turn via appendTurn.
            upsertChatStub({
              id: capturedSession,
              model,
              effort,
              account: profile.name,
              project,
              runtimeMode,
              fastMode,
              serviceTier,
              // Best-available loom link at init (existing chat's, else the
              // turn-1 wire seed); appendTurn narrows in any link a loom tool
              // establishes during the turn.
              loomId: loomLink.loomId,
              role: loomLink.role,
              userText: displayText,
            });
            send("saved", { chatId: capturedSession });
            // Capture the live session totals while the subprocess is still
            // alive; this is the fallback when navigation interrupts a final
            // result event.
            const usageFn = (q as unknown as Record<string, () => Promise<any>>)
              .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
            usagePromise = usageFn ? usageFn.call(q).catch(() => null) : null;
          } else {
            // The whole SDKMessage→event translation — parts bookkeeping,
            // parent flattening, first-write-wins tool results, supersedes
            // eviction, the capture-don't-act result rule — lives in the
            // TESTED projector (server/providers/claude/project-message.ts,
            // extracted verbatim from the branches that sat here). This loop
            // keeps only what needs the live query or the response in scope.
            const projection = projectClaudeMessage(msg, turnState);
            for (const ev of projection.events) send(ev.event, ev.data);
            if (projection.compaction) {
              // The counts, merged into the same record the PostCompact hook
              // above records (issue #25) — in whichever order the two arrive.
              noteCompaction("compact_boundary", projection.compaction);
            }
            if (projection.mainAssistantStep) {
              try {
                // Await before advancing to the final result frame. The SDK's
                // background reader can receive this control response while
                // the public message iterator is paused here; once `result`
                // arrives it deliberately ends stdin and a new request can no
                // longer be written.
                contextUsage = fromClaudeContextUsage(await q.getContextUsage());
                // A measurement newer than any compaction so far (issue #25) —
                // set only on success, so a failed control call leaves the last
                // compaction's verdict standing rather than claiming a
                // re-measurement that never happened.
                contextRemeasured = true;
              } catch (error) {
                // Older Claude Code builds may not expose this control call.
                // Preserve the provider-neutral estimate, but make a real
                // integration failure observable instead of silently
                // presenting it as a successful exact capture.
                if (!contextUsageWarningSent) {
                  console.warn("[context-usage] Exact Claude attribution unavailable", error);
                  contextUsageWarningSent = true;
                }
              }
            }
          }
        }
        }

      } catch (e) {
        if (!abort.signal.aborted) send("error", { message: String(e) });
      } finally {
        // Detach this turn's live wiring FIRST: a background agent's late
        // canUseTool call must hit the runtime's detached deny, never a dead
        // SSE controller (#28 persistent runtime).
        runtimeRef?.detachTurn();
        // Fail-closed teardown: deny any permission requests still open on this
        // stream so their canUseTool promises unblock and no pending is leaked.
        for (const id of myPending) resolvePending(id, { behavior: "deny", reason: "aborted" });
        myPending.clear();
        // A runtime whose query never reached system:init is a broken spawn —
        // close it rather than leaving a keyed-by-runId zombie no later turn
        // will ever find.
        if (!capturedSession) runtimeRef?.closeNow("init never arrived");
        // Persist in teardown, not in the happy path: a client disconnect
        // (navigation, closed tab) aborts the SDK loop with a throw, and the
        // turn must survive it — the SDK session already exists server-side.
        try {
          // The three teardown finalizers, in order (their reasoning lives
          // with them in server/providers/claude/project-message.ts): flush
          // in-progress streamed text so an abort doesn't drop what was
          // visible, flag outputless tool parts as interrupted, then ration
          // per-parent tool detail before the blocking chats.json write.
          flushStreamingText(turnState);
          const anyInterrupted = markInterruptedTools(turnState);
          // The interrupted flags are local-only (about to be persisted) —
          // without this broadcast, a live client watching this stream never
          // learns a tool call got flagged, so a subagent tab's status dot
          // shimmers as "running" forever after the turn is over. Payload-
          // free: the client applies the exact same "tool part still missing
          // output" rule locally (see markToolsInterrupted).
          if (anyInterrupted) send("interrupted", {});
          rationToolDetail(turnState);
          // Fetch the live session-cost control call unconditionally (not
          // gated on `lastResult`): a client disconnect/navigation aborts the
          // SDK loop with a throw rather than a final graceful "result"
          // message, so `lastResult` commonly stays null for a turn that
          // still did real, billable tool/model work. Without a fallback,
          // that spend simply vanishes from every accounting surface
          // (chat.costUsd, per-token totals, usage.ndjson) — see below.
          let u: any = null;
          if (usagePromise) {
            try {
              u = await Promise.race([
                usagePromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
              ]);
            } catch {
              // Experimental API — degrade silently. Final SDK result usage is
              // still the primary accounting path.
            }
          }
          // No "result" message ever arrived for this POST (aborted/errored
          // mid-flight) but the session did initialize, so `u.session` — the
          // same control call's own cost/usage totals — is the best
          // remaining source of truth. It's scoped to THIS query() process
          // the same way `result.total_cost_usd` already is (both are
          // "since this invocation started", not cumulative across the
          // resumed conversation's earlier turns — that's exactly why
          // appendTurn/chat.costUsd already ADD each turn's figure rather
          // than replacing it), so folding it in here as a substitute
          // `lastResult` is consistent with how a graceful completion would
          // have been accounted for, just recovered via a different SDK call.
          if (!turnState.lastResult && u?.session) {
            const modelUsages = Object.values(u.session.model_usage ?? {}) as Array<{
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }>;
            turnState.costUsd = u.session.total_cost_usd ?? 0;
            const usage = modelUsages.reduce(
              (acc, m) => ({
                input_tokens: acc.input_tokens + (m.inputTokens ?? 0),
                output_tokens: acc.output_tokens + (m.outputTokens ?? 0),
                cache_read_input_tokens: acc.cache_read_input_tokens + (m.cacheReadInputTokens ?? 0),
                cache_creation_input_tokens:
                  acc.cache_creation_input_tokens + (m.cacheCreationInputTokens ?? 0),
              }),
              {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            );
            turnState.lastResult = { subtype: "aborted", totalCostUsd: turnState.costUsd, usage };
          }
          // Act on the LAST "result" message — real or, absent one, the
          // synthesized fallback above (see the "result" case for why only
          // the last one is ever used) — the usage.ndjson entry and the
          // "done" broadcast both fire at most
          // once per POST.
          if (turnState.lastResult) {
            if (capturedSession) {
              logUsage({
                ts: Date.now(),
                account: profile.name,
                model,
                sessionId: capturedSession,
                inputTokens: turnState.lastResult.usage?.input_tokens ?? 0,
                outputTokens: turnState.lastResult.usage?.output_tokens ?? 0,
                cacheReadTokens: turnState.lastResult.usage?.cache_read_input_tokens ?? 0,
                cacheCreateTokens: turnState.lastResult.usage?.cache_creation_input_tokens ?? 0,
                costUsd: turnState.lastResult.totalCostUsd,
              });
            }
            send("done", {
              subtype: turnState.lastResult.subtype,
              // The SESSION'S TOTAL so far, projected over usage.ndjson — not
              // this turn's delta (AD-18: every spend readout is a projection
              // over the one ledger, never an independent counter). The line
              // for this turn is appended immediately above, so the fold
              // already includes it. Because this is a TOTAL and not a delta,
              // the client must SET it rather than add it — adding would
              // compound the total against itself, so the second turn of a
              // session would render turn 1 twice. Falls back to the turn's
              // own figure only if no session was ever captured, in which case
              // nothing was logged or persisted either.
              costUsd: capturedSession
                ? sessionSpendUsd(capturedSession)
                : turnState.lastResult.totalCostUsd,
              turns: turnState.lastResult.turns,
              usage: turnState.lastResult.usage,
              // Real context-window occupancy (final call), not the step sum.
              context: contextUsage?.totalTokens ?? contextOf(turnState.lastMainUsage),
              contextUsage,
            });
          }
          // A COMPACT-ONLY REQUEST APPENDS NO TURN (issue #25). The Codex
          // branch has always been this way by construction — it leaves
          // `capturedSession`/`lastResult` unset precisely so "the harness
          // reorganized its own history" never manufactures a transcript entry
          // — but Claude's `/compact` runs a REAL query(), so it reaches this
          // block on the same path an ordinary turn does. REASONED, NOT TRACED:
          // whatever that query() leaves in `parts` (empty, on the reading that
          // a compaction produces no assistant output), a compaction is not a
          // turn and must not persist one — the rule holds without depending on
          // what was in the bubble. That is the same landmine session-view.tsx
          // guards against live ("a compaction must not become an empty
          // assistant bubble"), arriving by the persistence door; it also keeps
          // appendTurn's `delete chat.settledAt` off a path no human drove.
          // The compaction is still recorded — as a compaction, below —
          // and its tokens are still in usage.ndjson, which every spend readout
          // projects over (AD-18), so nothing is lost but the phantom turn.
          let turnPersisted = false;
          if (capturedSession && !compact) {
            // Hand this turn's attachments to the chat that now exists. Until
            // this runs they are unowned uploads, which the orphan sweep in
            // lib/attachments.ts collects after a day — and after it, they are
            // covered by the chat's lifetime, so archiving destroys them.
            // Bound HERE rather than at upload time because a fresh composer
            // has no session id until this turn's first `session` event.
            if (turnAttachments.length) {
              bindAttachments(turnAttachments.map((a) => a.id), capturedSession);
            }
            // Bounded wait for the title job fired at POST-body-validation
            // time (parallel with the whole main turn above, so it's usually
            // already settled by now) — never let it delay persistence
            // beyond TITLE_RACE_MS. Resolves to null (not the string "null")
            // on timeout, abort, or any generation failure; appendTurn's own
            // message-prefix fallback covers all of those.
            let title: string | undefined;
            if (titlePromise) {
              const raced = await Promise.race([
                titlePromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), TITLE_RACE_MS)),
              ]);
              title = raced ?? undefined;
            }
            if (title) send("title", { title });
            appendTurn({
              id: capturedSession,
              model,
              effort,
              account: profile.name,
              project,
              runtimeMode,
              fastMode,
              serviceTier,
              // Session<->Loom link (docs/loom-model.md §5): undefined
              // means "no change" (appendTurn only ever narrows a link in,
              // see its own comment) — loomLink stays untouched for a plain
              // turn that never called a loom tool.
              loomId: loomLink.loomId,
              role: loomLink.role,
              // The attachment part rides AFTER the text, matching the order the
              // composer stages them in and the order the live turn rendered.
              // Metadata only — see the `attachments` variant in lib/store.ts.
              userMessage: {
                role: "user",
                parts: [
                  { type: "text", text: displayText },
                  ...(turnAttachments.length
                    ? [
                        {
                          type: "attachments" as const,
                          files: turnAttachments.map((a) => ({
                            id: a.id,
                            name: a.name,
                            mediaType: a.mediaType,
                            size: a.size,
                          })),
                        },
                      ]
                    : []),
                ],
              },
              // Bug-B fix: the escalation kickoff's "user" turn is the
              // server-authored instruction, not something the human said —
              // never persist it into the visible transcript (userMessage
              // above is only a fallback-title source for a would-be fresh
              // chat; appendTurn skips pushing it when this is set). Story 4.1's
              // Ultra wake trigger is the same kind of machinery and shares the
              // flag: `hidden: true` on the client suppresses only the LOCAL
              // bubble, so without this the trigger would reappear after a
              // reload as something the human appeared to type.
              hideUserMessage: hiddenTurn,
              assistantMessage: { role: "assistant", parts },
              costUsd: turnState.costUsd,
              title,
              usage: turnState.lastResult?.usage
                ? {
                    inputTokens: turnState.lastResult.usage.input_tokens ?? 0,
                    outputTokens: turnState.lastResult.usage.output_tokens ?? 0,
                    cacheReadTokens: turnState.lastResult.usage.cache_read_input_tokens ?? 0,
                    cacheCreateTokens: turnState.lastResult.usage.cache_creation_input_tokens ?? 0,
                  }
                : undefined,
              // Final-call context (not the step sum) — persisted so CTX is
              // right on resume, independent of the cumulative usage above.
              contextTokens: contextUsage?.totalTokens ?? contextOf(turnState.lastMainUsage),
              contextUsage,
            });
            turnPersisted = true;
            send("saved", { chatId: capturedSession });
          }
          // ISSUE #25 — the compaction boundary itself, written LAST so its
          // anchor is the transcript as it stands after this turn landed: a
          // compaction that happened mid-turn reloads BELOW that turn, which is
          // where the reader watched the divider appear. `resumeTarget` is the
          // fallback for the Codex compact-only branch, which never captures a
          // session because it never runs a turn (recordCompactions is a no-op
          // for an id with no chat record, so an untrusted one writes nothing).
          if (compactionFold.entries.length) {
            const compactionTarget = capturedSession ?? resumeTarget;
            if (compactionTarget) {
              const recorded = recordCompactions(
                compactionTarget,
                compactionFold.entries.map(compactionFacts),
                // Did the number this stream just persisted post-date the
                // compaction? Only then may the reloaded wheel trust it (see
                // seedCompactedContext): a mid-turn auto-compaction is followed
                // by more of the same turn, which measures again, while a
                // compact-only request persists nothing at all and leaves the
                // pre-compaction figure on disk.
                turnPersisted && contextRemeasured,
              );
              // A COMPACTION SPENDS TOKENS AND SAVES NO TURN. "saved" is the
              // only event that makes an open surface re-project the ledger
              // (AD-18 — the client's handler refreshes chats + usage), and the
              // branch above skipped it for this path, so a manual Compact
              // wrote to usage.ndjson while every spend readout kept its old
              // total until something unrelated happened. Sent only once the
              // store has confirmed the chat exists, which is also the only
              // thing "saved" claims: `chatPersisted`. Compaction is blocked
              // while a turn is in flight, so this never races the branch above.
              if (recorded && compact) {
                send("saved", { chatId: compactionTarget });
              }
            }
          }
        } catch {
          // persistence failure must never mask the stream teardown
        }
        // Never let title generation outlive this response. `titleAbort` is
        // the title's OWN controller (#28 persistent runtime: the turn's
        // `abort` now kills the whole session runtime, so it must never fire
        // as routine teardown). This is a no-op if generateTitle already
        // finished (its own finally aborted its internal controller) and a
        // no-op for a resumed session (titlePromise is null) — otherwise it
        // force-ends the orphaned subprocess right now: it lost the
        // TITLE_RACE_MS race above, or the main query never reached
        // system:init so the persistence block — the only awaiter — never ran.
        if (titlePromise) titleAbort.abort();
        // Terminal marker the live-tail subscriber closes on. Written BEFORE
        // endChatRun so a still-connected subscriber reads "closed" while the
        // run is technically still registered as live (Phase 1b).
        if (capturedSession) appendSessionEvent(capturedSession, "closed", {});
        // Turn over — drop the current-turn delta ring (contract §2). The
        // "closed" marker above lives in the file; the ring's in-flight tokens
        // are all superseded by now, so a late reconnect reads the file only.
        if (capturedSession) endSessionDeltas(capturedSession);
        endChatRun(runId);
        // The server, not a mounted renderer, owns advancing durable intent.
        // Release the active run first, then let the one session dispatcher
        // claim the next FIFO item if the queue is not paused.
        if (capturedSession) void kickSessionQueue(capturedSession);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
