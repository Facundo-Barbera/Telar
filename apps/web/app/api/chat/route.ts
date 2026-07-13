import {
  query,
  type EffortLevel,
  type HookInput,
  type HookJSONOutput,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  accountEnv,
  deriveDeliverableSignal,
  getAccount,
  getDefaultAccountName,
  getLoom,
  getProject,
  readBundleFile,
  readContract,
  resolveProjectMcpServers,
  STEERING_FILE,
  type ProjectManifest,
} from "@telar/core";
import {
  CODEX_EFFORT_OPTIONS,
  CODEX_SANDBOX_PRESETS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  type CodexReasoningEffort,
  type CodexSandbox,
} from "@/lib/models";
import { runCodexTurn } from "@/lib/codex-app-server";
import { resolveEscalationMessage } from "@/lib/escalation-kickoff";
import { generateTitle } from "@/lib/titles";
import { endChatRun, registerChatRun, setChatRunSession } from "@/lib/chat-runs";
import { appendSessionEvent, startSessionLog } from "@/lib/session-log";
import {
  createLoomMcpServer,
  formatEscalationContext,
  LOOM_ANSWER_BLOCKED_TOOL,
  LOOM_AUTO_TOOLS,
  LOOM_ESCALATION_DISALLOWED_TOOLS,
  LOOM_ESCALATION_READONLY_TOOLS,
  LOOM_START_TOOL,
  type LoomSessionLink,
} from "@/lib/loom-mcp";
import {
  createPending,
  resolvePending,
  readRules,
  addRule,
  ruleFor,
  ruleMatches,
  ruleOptionsFor,
  makeGuardrailDecision,
  isValidPermissionMode,
  type ClientPermissionMode,
  type PermissionDecision,
} from "@/lib/permissions";
import {
  appendTurn,
  getChat,
  logUsage,
  savePlanUsage,
  type Part,
  type PlanSnapshot,
} from "@/lib/store";
import {
  agentMetaFromInput,
  AGENT_SPAWN_TOOL_CANDIDATES,
  capToolInput,
  capToolOutput,
  extractToolResultText,
  ParentFlattener,
} from "@/lib/transcript";

const toIso = (epoch?: number) =>
  epoch ? new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString() : null;

// Hard ceiling on how many tool calls a single turn persists with full
// input/output detail. capToolInput/capToolOutput bound each part's own
// size, but nothing bounds the COUNT — a pathological (e.g. repo-wide
// refactor) turn can carry hundreds of tool calls across maxTurns rounds,
// and store.ts rewrites the entire chats.json synchronously on every
// appendTurn. Beyond this ceiling, later tool parts degrade to name-only
// (the shape this diff's tool parts had before) so one outlier turn can't
// blow up chats.json or the blocking write it forces on every other chat.
const MAX_DETAILED_TOOL_PARTS = 200;

// The SDK's full EffortLevel set, single-sourced from lib/models.ts (also
// what the composer's Select renders) so the API's validation and the UI's
// offered choices can never drift apart. Typed as Set<string> (not the
// inferred Set<EffortLevel>) so the `.has(effort)` check below — where
// `effort` is narrowed to plain `string` by the `typeof effort === "string"`
// guard, not to the literal union — type-checks; the runtime membership test
// is identical either way.
const EFFORT_LEVELS: Set<string> = new Set(EFFORT_OPTIONS.map((o) => o.id));

// Same idea as EFFORT_LEVELS but for Codex's distinct reasoning-effort union
// ("minimal" instead of Claude's "max") and its static sandbox choice —
// both single-sourced from lib/models.ts so this route's validation can't
// drift from what the composer offers.
const CODEX_EFFORT_LEVELS: Set<string> = new Set(CODEX_EFFORT_OPTIONS.map((o) => o.id));
const CODEX_SANDBOXES: Set<string> = new Set(CODEX_SANDBOX_PRESETS.map((p) => p.sandbox));

// Title generation must never delay teardown beyond this — see the `finally`
// block's Promise.race. Deliberately short: a title that isn't ready by then
// just falls back to appendTurn's own message-prefix default.
const TITLE_RACE_MS = 2_000;

// Appended (never replacing) the "claude_code" preset system prompt for a
// Loom Session (docs/loom-model.md §5's "planner" role) — see
// `isPlannerSession` below. Guidance only: it does not grant any tool the
// session doesn't already have (LOOM_AUTO_TOOLS/LOOM_START_TOOL + the
// PreToolUse guardrail are the actual moat) and a non-planner session's
// systemPrompt is completely unaffected.
const PLANNER_SYSTEM_PROMPT = `You are helping the user plan a LOOM in Telar — an autonomous unit of work Telar will build and then independently verify. Your ONLY job in this session is planning, not coding. Workflow:
1. Understand what the user wants to build (ask brief, focused questions).
2. Draft a Spec Bundle with your loom tools: use draft_bundle_file to write the objective and any useful context (spec files, examples, constraints), and propose_contract to define a FALSIFIABLE Verification Contract — concrete, checkable assertions (golden-diff / value-equality / schema-match / contains / live-critic), never vague prose. propose_contract will reject an unfalsifiable contract.
3. Show the user the plan (read_bundle) and refine until they're happy.
4. When the spec is solid AND the user confirms, call start_loom. This ASKS THE USER TO APPROVE — you cannot start a loom yourself; that human approval is required by design. After it starts, tell the user the loom is building and verifying autonomously and that they can watch it in the god-view.
Do NOT write the feature's code yourself — the loom's builder does that. Keep your messages concise and guide the user through the plan.
When you need to clarify something, ask it as a plain chat message and wait for the user's reply — never use a structured question/interactive tool; the chat has no UI to answer those.

OBJECTIVE — the most important thing you write. objective.md is the single source of truth for what the loom builds; write it (via draft_bundle_file, path "objective.md") BEFORE calling start_loom. It must:
- Describe the CONCRETE CHANGE to make in the project — the actual feature/fix/refactor and its acceptance shape — distilled from the WHOLE conversation.
- NEVER be the meta-request to create/draft/start the loom, a restatement like "let's work on #109", or a raw fragment of the user's chat message. "Create the loom" is not a task.
If the user's ask is vague or is only a pointer (an issue number, "the thing we discussed"), ask focused questions and read the referenced material until you can state the real objective — do not draft a placeholder objective.`;

// Appended (never replacing) the "claude_code" preset for a STEERER Loop
// Session (docs/loom-model.md §5) — the loom Chat tab. Like PLANNER above this
// is guidance only: it grants ZERO tools (the moat lives in this text plus the
// unchanged LOOM_AUTO_TOOLS/LOOM_START_TOOL gating + PreToolUse guardrail). The
// hard rule below forbids any accept/promote/mark-done attempt — acceptance is
// a human click made OUTSIDE this chat, and there is no accept_loom tool.
const STEERER_SYSTEM_PROMPT = `You are embedded in the cockpit of a RUNNING loom as its steering session. Your
job is to answer "what's going on?" and to redirect the loom on the owner's behalf.

You can OBSERVE and STEER this loom with the mcp__loom__ tools, all of which
default to THIS loom:
  • get_loom / read_bundle — inspect state, verdict, objective, contract.
  • steer_loom {directive} — fold a course correction in and re-run the verified loop.
  • reject_loom {feedback} — send it back with feedback.
  • resume_loom — retry without new feedback.
  • cancel_loom — halt it.
  • watch_loom — get woken as a chat turn on any state transition.

On your FIRST turn, call watch_loom for this loom so state changes reach you.

HARD RULE (the product's core invariant): you can steer/reject/resume/cancel, but
you can NEVER accept, promote, approve, or mark this loom "done". There is no tool
for that and there never will be — acceptance is a human click made outside this
chat. Do not claim you accepted it; do not imply the work is done. If the owner
asks you to accept it, tell them acceptance is theirs to make in the cockpit.`;

// Keep the per-turn steerer append small: truncate a section to its last
// `max` bytes, prefixing an elision marker so the model knows it's a tail.
function tail(s: string, max: number): string {
  return s.length <= max ? s : `…(truncated)…\n${s.slice(-max)}`;
}

// Guarded bundle read: a loom mid-flight may lack a file (objective/contract/
// steering) — a missing section is simply omitted, never an error.
function safeRead(fn: () => string | null | undefined): string | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

// Dynamic per-turn context for a steerer session: recomputed every turn so the
// state + latest steering decisions are always fresh. Bounds each section so
// the append stays reasonable. Server-only (value core imports are fine here).
function buildSteererContext(loomId: string): string {
  const loom = getLoom(loomId);
  const objective = safeRead(() => readBundleFile(loomId, "objective.md"));
  const contract = safeRead(() =>
    JSON.stringify(readContract(loomId).contract, null, 2),
  );
  const steering = safeRead(() => readBundleFile(loomId, STEERING_FILE));
  return [
    `\n\n--- LIVE LOOM CONTEXT (id ${loomId}, state: ${loom?.state ?? "unknown"}) ---`,
    objective && `# Objective\n${tail(objective, 4000)}`,
    contract && `# Verification Contract\n${contract}`,
    steering && `# Live steering decisions (append-only)\n${tail(steering, 4000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Appended (never replacing) the "claude_code" preset for an ESCALATION session
// (docs/adaptive-verification.md §8's conversational-escalation surface) — the
// "Discuss with the orchestrator" chat on a `blocked` loom. Guidance only: the
// actual moat is the toolset (LOOM_ESCALATION_READONLY_TOOLS auto-run +
// LOOM_ESCALATION_DISALLOWED_TOOLS hard-blocked + answer_blocked human-gated via
// the PreToolUse guardrail). Reuses the steerer moat language: the agent can
// NEVER accept/promote/mark-done. Its ONE write is answer_blocked, which only
// lands after the human's explicit Approve click.
const ESCALATION_SYSTEM_PROMPT = `You are embedded in a PARKED loom's escalation chat. The loop stopped BEFORE spending on the build because it could not stand up a way to VERIFY this work, and it refuses to guess. Your job is to talk it through with the human and distill the verification recipe.

You can OBSERVE this loom and inspect its project with read-only tools:
  • get_loom / read_bundle / list_looms — inspect state, objective, contract.
  • Read / Grep / Glob — inspect the project root (your working directory) to ground your advice in the real repo (package.json, test setup, entry points).

DISCUSS the verification method with the human. Explain the options plainly and help them choose the one that fits the deliverable:
  • a TEST/EVAL command — a command whose exit code proves the work (e.g. \`bun test\`), for a library/CLI/eval deliverable. Saved as the telar.yaml verifyCommand; a test suite is NEVER auto-spun as a dev server.
  • a DEV command — how to bring a runnable app up (e.g. \`bun run dev\`), for a web/app deliverable.
  • a RUNBOOK — optional free-text narrative for how to drive the app to reach the feature (accompanies a command; it can NOT resume the loom on its own).
  • a SERVERS recipe — a background-process setup, when the app needs services up first.

ONLY when the human has converged on a concrete answer, DISTILL it and call answer_blocked with the fields they settled on. That tool ASKS THE HUMAN TO APPROVE — you cannot resume a loom yourself; that human approval is required by design and IS the provenance stamp. After it resumes, tell them the loop is re-verifying and they can watch it in the cockpit.

HARD RULE (the product's core invariant): you can DISCUSS and, with the human's approval, answer the block — but you can NEVER accept, promote, approve, or mark this loom "done". There is no tool for that and there never will be — acceptance is a human click made outside this chat. Do not claim you accepted it; do not imply the work is done.
When you need to clarify something, ask it as a plain chat message and wait for the human's reply — never use a structured question/interactive tool; the chat has no UI to answer those.`;

// Dynamic per-turn context for an escalation session (parallel to
// buildSteererContext): recomputed every turn so blockedReason/blockedQuestion,
// the contract, and the deliverable-signal evidence are always fresh. Delegates
// the string assembly to loom-mcp's PURE formatEscalationContext (hermetically
// tested there) — this function only gathers the core-backed values. Guarded:
// each read fails safe to omission, never an error.
function buildEscalationContext(loomId: string, root: string): string {
  const loom = getLoom(loomId);
  const assertions = safeRead(() => {
    const c = readContract(loomId).contract;
    return c ? JSON.stringify(c.assertions.map((a) => ({ type: a.type, description: a.description }))) : null;
  });
  // deriveDeliverableSignal is a bounded synchronous fs read (no LLM, no spawn)
  // — the same signal the pre-flight parked on, so the agent sees exactly which
  // verification substrates were checked and why none applied.
  const signalReason = (() => {
    try {
      return deriveDeliverableSignal(root, loom?.charter).reason;
    } catch {
      return undefined;
    }
  })();
  return formatEscalationContext({
    loomId,
    state: loom?.state,
    blockedReason: loom?.blockedReason,
    blockedQuestion: loom?.blockedQuestion,
    assertions: assertions ? (JSON.parse(assertions) as { type: string; description: string }[]) : undefined,
    signalReason,
  });
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
    account,
    effort,
    permissionMode: rawPermissionMode = "default",
    sandbox: rawSandbox,
    approvalPolicy: rawApprovalPolicy,
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
  } = await req.json();
  const role: "planner" | "steerer" | "escalation" | undefined =
    rawRole === "planner"
      ? "planner"
      : rawRole === "steerer"
        ? "steerer"
        : rawRole === "escalation"
          ? "escalation"
          : undefined;
  const runId: string =
    typeof rawRunId === "string" && rawRunId ? rawRunId : crypto.randomUUID();

  // M11 finding-1: the escalation surface auto-fires a HIDDEN first turn whose
  // wire message is the kickoff sentinel (see @/lib/escalation-kickoff). On a
  // fresh escalation session we swap it for the server-authored kickoff prompt
  // so the model opens from ESCALATION_SYSTEM_PROMPT + buildEscalationContext
  // with a genuine verification proposal. Byte-identical passthrough for every
  // other turn (planner/steerer/plain/real escalation replies), so nothing else
  // changes. Substituted HERE, before generateTitle/query/log all read it.
  const message: string = resolveEscalationMessage(role, sessionId, rawMessage);

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
  // chat.account, passed explicitly here), then the project's manifest
  // default, then "personal". See AGENTS notes on the account-lock: a
  // session's resume transcript lives under the account's config dir, so
  // this route trusts whatever the client sends — the picker being
  // choosable only pre-first-turn is a client-side rule, not enforced here.
  // Resolved ahead of the effort/sandbox checks below because both are
  // provider-shaped (Claude's EffortLevel vs Codex's ModelReasoningEffort;
  // sandbox is Codex-only).
  const profile =
    (account ? getAccount(account) : undefined) ??
    getAccount(manifest.account) ??
    getAccount(getDefaultAccountName()) ?? { name: manifest.account };
  const provider = profile.provider ?? "claude";

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

  // Codex-only: the sandbox is a static, up-front choice paired with the
  // approvalPolicy validated just below (see CODEX_APPROVAL_PRESETS in
  // lib/models.ts, which the composer's preset picker sources both from —
  // this route validates each independently rather than trusting a
  // preset id, since the client sends the resolved sandbox/approvalPolicy
  // pair, not the preset id itself). Ignored for Claude, where the
  // interactive canUseTool/permissionMode flow below governs access instead.
  let sandbox: CodexSandbox = DEFAULT_CODEX_SANDBOX;
  if (provider === "codex" && rawSandbox != null) {
    if (typeof rawSandbox !== "string" || !CODEX_SANDBOXES.has(rawSandbox)) {
      return Response.json(
        { error: `Invalid sandbox "${rawSandbox}".` },
        { status: 400 },
      );
    }
    sandbox = rawSandbox as CodexSandbox;
  }

  // Codex-only: mirrors the app-server's AskForApproval union. Deliberately
  // an INLINE set here, not imported from lib/models.ts's CODEX_APPROVAL_
  // PRESETS — that file also feeds the client bundle (composer UI), and this
  // route's own validation is meant to stand alone rather than trust
  // whatever the client-side preset list happens to contain. Defaults to
  // "on-request" (CODEX_APPROVAL_PRESETS' "auto" preset's policy) when
  // omitted, matching the composer's own default preset.
  const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
  let approvalPolicy: "untrusted" | "on-request" | "never" = "on-request";
  if (provider === "codex" && rawApprovalPolicy != null) {
    if (typeof rawApprovalPolicy !== "string" || !CODEX_APPROVAL_POLICIES.has(rawApprovalPolicy)) {
      return Response.json(
        { error: `Invalid approvalPolicy "${rawApprovalPolicy}".` },
        { status: 400 },
      );
    }
    approvalPolicy = rawApprovalPolicy as "untrusted" | "on-request" | "never";
  }

  // Only "default"/"auto"/"acceptEdits" are ever accepted from a client —
  // never "bypassPermissions" (skips canUseTool entirely), "dontAsk", or
  // "plan", regardless of what the request body claims. See
  // isValidPermissionMode. Codex turns don't consult this — approvalPolicy
  // (validated above) is Codex's own analogous knob — but it's still
  // validated uniformly for both providers.
  if (!isValidPermissionMode(rawPermissionMode)) {
    return Response.json(
      { error: `Invalid permissionMode "${rawPermissionMode}".` },
      { status: 400 },
    );
  }
  const permissionMode: ClientPermissionMode = rawPermissionMode;

  const model: string = rawModel ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);
  const workspace = manifest.root;

  // Background turn (docs/runtime-architecture.md §A.4): the run is deliberately
  // NOT bound to the request. A client disconnect (navigation, closed tab,
  // hot-reload) must NOT abort it — the turn keeps working and persists on its
  // own, like a loom. Only an explicit Stop (POST /api/chat/stop) or natural
  // completion aborts it. Registered so Stop can find it by runId / session id.
  const abort = new AbortController();
  registerChatRun(runId, abort);

  // Fire title generation the instant the body is validated, in parallel
  // with the main turn below — only for a brand-new session (no resume
  // target: appendTurn only ever consults a supplied title when it's
  // CREATING the chat, so generating one for an existing session's turn
  // would just be wasted inference). Forwarding `abort.signal` means a
  // client disconnect/Stop click cancels this subprocess too, same as the
  // main turn's.
  const titlePromise: Promise<string | null> | null = sessionId
    ? null
    : generateTitle(message, profile, abort.signal);

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
        // Mirror every event (except the token-level firehose) into the
        // session's live log so a reconnecting client can tail the in-flight
        // turn (Phase 1b). capturedSession is only truthy after system:init,
        // which is exactly when startSessionLog has opened the file.
        if (capturedSession && event !== "delta" && event !== "thinking_delta") {
          appendSessionEvent(capturedSession, event, data);
        }
      };

      const parts: Part[] = [];
      // parts[i]'s originating SDKMessage uuid, index-aligned with `parts` —
      // scratch bookkeeping so a later refusal-fallback `supersedes` list can
      // evict the exact entries it retracts (see the "assistant" handler).
      const partOrigin: (string | undefined)[] = [];
      // Text accumulated from deltas for the current content block, keyed by
      // resolved parent id (null = main conversation). A Map, not a single
      // string, because with forwardSubagentText the main turn and any
      // number of concurrently-streaming subagents interleave their
      // stream_event deltas on this one loop — a shared scalar would let
      // them clobber each other's in-progress text.
      const streamingText = new Map<string | null, string>();
      // Flattens subagent-of-a-subagent nesting to the top-level spawn's
      // tool_use id — see lib/transcript.ts's ParentFlattener for why a
      // raw parent_tool_use_id isn't already enough.
      const parentFlatten = new ParentFlattener();
      // The resume target is the client-supplied id, but it's untrusted until
      // the SDK actually confirms it via a system:init message below.
      // capturedSession must only ever hold an SDK-confirmed id — the finally
      // block persists a turn whenever it's truthy, and a resume that fails
      // before init (e.g. session doesn't exist under this account's config
      // dir) must not persist a phantom empty turn under the client's guess.
      const resumeTarget = sessionId ?? null;
      // Session<->Loom link (docs/loom-model.md §5): seeded from the resumed
      // chat's own persisted loomId/role (a brand-new chat starts with
      // neither). Mutated in place by the loom MCP server's tools as this
      // turn runs — draft_bundle_file lazily sets it on first use — then
      // threaded back through appendTurn below, the same per-turn
      // persistence path store.ts already exposes for every other captured
      // session field.
      const existingChat = resumeTarget ? getChat(resumeTarget) : undefined;
      // Turn-1 wire seed for an embedded steerer session (mirrors the planner
      // path, but steerer also binds a loomId). Validated: the loom must exist
      // AND belong to the anchoring project — a bad/foreign id fails safe to a
      // normal session, never binds to someone else's loom. Only ever consulted
      // for a brand-new chat (existingChat's own persisted link wins otherwise).
      // Both a STEERER (loom Chat tab) and an ESCALATION (blocked-loom "Discuss
      // with the orchestrator") turn-1 seed bind a loomId the same way, validated
      // identically — the loom must exist AND belong to the anchoring project.
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
        // Only steerer is PERSISTED as a link role (store.ts's Chat.role union is
        // planner|steerer). An escalation session is deliberately EPHEMERAL — it
        // must never auto-reattach (the surface is behind an explicit click), so
        // it persists no role: isEscalationSession is derived from the wire `role`
        // (sent every turn) below, not from a stored link.
        role: existingChat?.role ?? (wireLoomId && role === "steerer" ? "steerer" : undefined),
      };
      // Whether this turn is part of a Loom Session (docs/loom-model.md §5's
      // "planner" role) — the body's own `role` (authoritative for turn 1,
      // before any Chat record exists) OR'd with the resumed chat's own
      // already-persisted role (belt-and-suspenders for any later turn whose
      // client omits it). Drives ONLY the appended system-prompt guidance
      // below — never loom tool access/gating, which stays exactly as wired
      // via LOOM_AUTO_TOOLS/LOOM_START_TOOL and the PreToolUse guardrail.
      const isPlannerSession = role === "planner" || existingChat?.role === "planner";
      // A session is planner XOR steerer XOR neither — the steerer branch drives
      // ONLY the appended system-prompt guidance + live-context block below,
      // never loom tool access/gating (which stays exactly as wired).
      const isSteererSession = loomLink.role === "steerer";
      // M11.3 escalation session (the blocked-loom "Discuss with the
      // orchestrator" chat). Derived from the WIRE `role` (sent every turn — the
      // link is never persisted as escalation, above) AND a resolved loomId; a
      // bad/foreign loomId fails safe to a plain session (loomLink.loomId stayed
      // undefined), exactly like the steerer seed does. Drives the read-only
      // escalation toolset + the answer_blocked-only write path + its system
      // prompt/context below — mutually exclusive with planner/steerer (role is
      // "escalation", and loomLink.role is never "steerer" for it).
      const isEscalationSession = role === "escalation" && !!loomLink.loomId;
      let capturedSession: string | null = null;
      let costUsd = 0;
      let usagePromise: Promise<any> | null = null;
      // The last "result" message seen this POST — captured, not acted on
      // immediately. A backgrounded subagent (forwardSubagentText) can wake
      // an SDK auto-continuation that runs a second full turn (and hence a
      // second "result") inside this same stream; those messages report
      // running totals for the whole query() invocation, not per-turn
      // deltas, so logging/broadcasting each one as it arrives would
      // double-count cost/usage. Only the LAST one — read once in the
      // `finally` block below — is ever acted on.
      let lastResult: {
        subtype: string;
        totalCostUsd: number;
        turns?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      } | null = null;
      // The final main-thread assistant call's usage — the basis for CTX (see
      // the assistant branch). Distinct from lastResult.usage (a step sum).
      let lastMainUsage: Record<string, number> | null = null;
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
        { signal }: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
      ): Promise<PermissionResult> => {
        // disallowedTools / protectedPaths — shared with the PreToolUse hook
        // below (options.hooks) so the same checks apply whether or not this
        // particular call ever reaches canUseTool at all (auto/acceptEdits
        // mode can approve without invoking it — see the hook's own comment).
        const guardrail = makeGuardrailDecision(manifest, workspace, toolName, input);
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
          return { behavior: "allow", updatedInput: safeInput };
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
        const { id, promise } = createPending(project, toolName, input, rule, undefined, ruleOptions);
        myPending.add(id);
        // Respect the SDK's per-call signal: resolve the pending (deny) the
        // moment this tool call is aborted, rather than hanging to timeout.
        const onAbort = () => resolvePending(id, { behavior: "deny", reason: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        send("permission", { id, toolName, input, rule, ruleOptions });

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
        // Distinguish a real user refusal from a timeout/abort so the model
        // doesn't treat silence as a deliberate "no" and abandon the tool.
        const message =
          decision.reason === "timeout"
            ? "No response from the user in time; treat as not yet decided."
            : decision.reason === "aborted"
              ? "The request was cancelled before the user responded."
              : "Denied by the user in telar.";
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
      const preToolUseGuardrail = async (input: HookInput): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return { continue: true };
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        const decision = makeGuardrailDecision(manifest, workspace, input.tool_name, toolInput);
        if (decision.behavior === "deny") {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message,
            },
          };
        }
        // §M.6 / §6 moat guard: mcp__loom__start_loom dispatches a real loom
        // — the one action in this whole toolset that spends money
        // autonomously — and "no human starts a Loom alone" must hold in
        // EVERY permission mode, not just "default". It's deliberately never
        // in `allowedTools` (see the query() options below), but that alone
        // only stops the SDK's pre-approval fast path; permissionMode
        // "auto"/"acceptEdits" can still have the SDK's own classifier or
        // accept-edits shortcut approve it WITHOUT ever invoking canUseTool
        // (the same gap the guardrail re-check above exists to close).
        // Hooks fire before that decision is finalized, so returning `ask`
        // here — regardless of mode — force-routes it back through the
        // interactive canUseTool permission card every single time; the
        // human clicking Approve on that card IS the §M.6 human-approved
        // provenance stamp startLoomFromBundle's `by` records.
        // The SAME §M.6 hard-route covers answer_blocked (M11.3): the
        // conversational-escalation write commits a viability-making
        // verification recipe that resumes a parked loop, so — like start_loom
        // — it must force the interactive canUseTool card in EVERY permission
        // mode; the human's Approve click IS the provenance stamp answerBlocked's
        // `by` records. It is never in the escalation session's allowedTools, but
        // that alone only stops the SDK's pre-approval fast path.
        if (input.tool_name === LOOM_START_TOOL || input.tool_name === LOOM_ANSWER_BLOCKED_TOOL) {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason:
                input.tool_name === LOOM_START_TOOL
                  ? "Starting a loom always requires the human's explicit approval (docs/loom-model.md §M.6)."
                  : "Answering a blocked loom always requires the human's explicit approval (docs/loom-model.md §M.6).",
            },
          };
        }
        // Mirror canUseTool's own AGENT_SPAWN_TOOL_CANDIDATES stripping (see
        // its comment above): this hook fires even for a Task/Agent spawn
        // that auto/acceptEdits mode approved WITHOUT ever calling canUseTool
        // — the only place left that can strip a model-supplied `mode`
        // ("bypassPermissions" skips the subagent's own permission checks
        // entirely) or `isolation` ("remote" moves it off-box) before either
        // reaches the SDK. `updatedInput` on a PreToolUse hook's output
        // replaces the tool's input the same way canUseTool's own does.
        if (
          (AGENT_SPAWN_TOOL_CANDIDATES as readonly string[]).includes(input.tool_name) &&
          ("mode" in toolInput || "isolation" in toolInput)
        ) {
          const { mode: _mode, isolation: _isolation, ...safeInput } = toolInput;
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: safeInput },
          };
        }
        return { continue: true };
      };

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
            const rule = ruleFor("Bash", input);
            const ruleOptions = ruleOptionsFor("Bash", input);
            const { id, promise } = createPending(project, "Bash", input, rule, undefined, ruleOptions);
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
          for await (const nev of runCodexTurn({
            prompt: message,
            cwd: workspace,
            env: accountEnv(profile),
            model,
            ...(effort ? { reasoningEffort: effort as CodexReasoningEffort } : {}),
            sandbox,
            resume: resumeTarget,
            signal: abort.signal,
            approvalPolicy,
            onApproval: onCodexApproval,
          })) {
            switch (nev.type) {
              case "session": {
                capturedSession = nev.sessionId;
                setChatRunSession(runId, capturedSession);
                // Open the live log (truncate + write the `user` header) BEFORE
                // the first send() so the session event is the log's second line
                // and a reconnecting client can tail this turn (Phase 1b).
                startSessionLog(capturedSession, message);
                send("session", {
                  sessionId: capturedSession,
                  slashCommands: [],
                  skills: [],
                  agents: [],
                });
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
                send("delta", { text: nev.text, ...(parent ? { parent } : {}) });
                break;
              }
              case "text": {
                const parent = resolveCodexParent(nev.threadId);
                parts.push({ type: "text", text: nev.text, ...(parent ? { parentId: parent } : {}) });
                send("text", { text: nev.text, ...(parent ? { parent } : {}) });
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
                send("tool_result", { id: nev.childThreadId, output, isError: nev.isError });
                break;
              }
              case "usage": {
                lastMainUsage = {
                  input_tokens: nev.usage.input_tokens,
                  cache_read_input_tokens: nev.usage.cache_read_input_tokens,
                  cache_creation_input_tokens: nev.usage.cache_creation_input_tokens,
                };
                // Codex has no per-token billing (ChatGPT subscription — see
                // lib/models.ts's zeroed Codex pricing), so totalCostUsd is
                // always 0 here rather than derived from usage.
                lastResult = {
                  subtype: "success",
                  totalCostUsd: 0,
                  usage: nev.usage,
                };
                break;
              }
              case "rate_limits": {
                // Same account-scoped snapshot idiom as the Claude branch's
                // "rate_limit_event" handling below (savePlanUsage + send
                // "plan", generic client refresh() on that event) — primary
                // is the 5-hour window, secondary the weekly one (see
                // lib/codex-app-server.ts's account/rateLimits/updated case).
                const toWindow = (
                  w: { usedPercent: number; resetsAt: number | null } | null,
                ) =>
                  w
                    ? {
                        utilization: Math.round(w.usedPercent),
                        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
                      }
                    : null;
                const snapshot: Partial<PlanSnapshot> = {
                  subscriptionType: nev.planType,
                  fiveHour: toWindow(nev.primary),
                  sevenDay: toWindow(nev.secondary),
                };
                savePlanUsage(profile.name, snapshot);
                send("plan", { account: profile.name, ...snapshot });
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
        const loomMcpServer = createLoomMcpServer({
          project,
          objectiveSeed: message,
          account: profile.name,
          link: loomLink,
          getSessionId: () => capturedSession,
        });
        const q = query({
          prompt: message,
          options: {
            cwd: workspace,
            ...(resumeTarget ? { resume: resumeTarget } : {}),
            model,
            ...(effort ? { effort: effort as EffortLevel } : {}),
            env: accountEnv(profile),
            // Planner guidance (docs/loom-model.md §5) is ADDITIVE via the
            // preset's own `append` — a normal session's systemPrompt is
            // byte-for-byte unchanged; only isPlannerSession turns get the
            // extra paragraph tacked on after Claude Code's default prompt.
            systemPrompt: isEscalationSession
              ? {
                  type: "preset",
                  preset: "claude_code",
                  // Static moat text + a per-turn seed (blockedReason/question +
                  // contract + deliverable-signal evidence). loomLink.loomId is
                  // non-null whenever isEscalationSession (guarded above).
                  append:
                    ESCALATION_SYSTEM_PROMPT + buildEscalationContext(loomLink.loomId!, workspace),
                }
              : isSteererSession
              ? {
                  type: "preset",
                  preset: "claude_code",
                  // Static moat text + a per-turn live-context block (state +
                  // latest steering recomputed every turn). loomLink.loomId is
                  // non-null whenever isSteererSession (role === "steerer" is
                  // only set alongside a resolved loomId, above).
                  append: STEERER_SYSTEM_PROMPT + buildSteererContext(loomLink.loomId!),
                }
              : isPlannerSession
              ? { type: "preset", preset: "claude_code", append: PLANNER_SYSTEM_PROMPT }
              : { type: "preset", preset: "claude_code" },
            permissionMode,
            // Load the repo's own .claude: CLAUDE.md, skills, slash commands,
            // settings, hooks, and MCP servers. User-level settings stay out
            // on purpose (keeps the developer's personal config/tokens out of
            // the subprocess). This is a deliberate trust decision, not an
            // oversight: a repo's settings.local.json can itself grant
            // `permissions.allow`/`defaultMode: bypassPermissions`, which the
            // SDK honors BEFORE canUseTool is ever invoked — our guardrails
            // and the interactive prompt below are both bypassed for
            // whatever the repo pre-allows. Hooks/apiKeyHelper/MCP servers
            // from the repo's settings also run as ordinary subprocess code,
            // outside canUseTool entirely. `disallowedTools` is passed
            // explicitly below because the SDK guarantees a disallow always
            // wins over any allow rule (repo-settings or otherwise), which is
            // the one lever we have against a repo widening its own access.
            settingSources: ["project", "local"],
            // The agent-spawn tool ("Agent"/"Task") is deliberately NOT
            // listed here even though it's auto-allowed in effect: an
            // `allowedTools` entry is approved by the SDK before canUseTool
            // is ever invoked, which would let a model-supplied AgentInput
            // `mode` override reach the subagent unexamined (see canUseTool's
            // own dedicated branch above, which allows it AND strips that
            // field). Read/Grep/Glob plus the web tools are auto-allowed here:
            // all are individually-safe read-only tools that never touch the
            // filesystem. Auto-allowing the web tools is also what makes them
            // usable inside a SUBAGENT — a subagent's canUseTool requests can't
            // reach the interactive approval channel (they fail closed with
            // "Stream closed"), so anything a research subagent needs (web
            // search/fetch, the MCP tool-search) must be pre-allowed, not
            // gated. The PreToolUse guardrail hook still runs for these.
            allowedTools: isEscalationSession
              ? // M11.3 escalation session: READ-ONLY auto-run tools only (loom
                // inspection + project-root snapshot). NO state-changing loom
                // tool auto-runs; answer_blocked is NOT here (it is human-gated
                // via the PreToolUse guardrail below, exactly like start_loom).
                [...LOOM_ESCALATION_READONLY_TOOLS]
              : [
                  "Read",
                  "Grep",
                  "Glob",
                  "WebSearch",
                  "WebFetch",
                  "ToolSearch",
                  // The loom moat's read/draft tools ONLY (docs/loom-model.md
                  // §5/§M.6) — auto-run so a planning session isn't spamming
                  // permission cards to write bundle files or propose a
                  // contract. mcp__loom__start_loom is deliberately excluded:
                  // it is the one tool in this server that dispatches a real
                  // loom, and must always go through the interactive
                  // canUseTool prompt (see preToolUseGuardrail's `ask`
                  // hard-route above and canUseTool's own always-allow-rule
                  // exclusion for it).
                  ...LOOM_AUTO_TOOLS,
                ],
            // AskUserQuestion (and any sibling structured-question tool the
            // SDK exposes) is hard-disallowed here: the chat UI has no
            // widget to answer a structured question, so the model must ask
            // clarifying questions as plain chat messages instead (see
            // PLANNER_SYSTEM_PROMPT above). For an escalation session, ADD the
            // state-changing loom tools (steer/reject/answer_loom/resume/cancel/
            // watch/draft/propose/start) to the disallow set: the SDK guarantees
            // a disallow beats any allow, so those tools — registered on the loom
            // MCP server for other sessions — are truly uncallable here, even
            // interactively. answer_blocked is deliberately NOT disallowed (it
            // stays callable-but-human-gated — the ONLY escalation write path).
            disallowedTools: [
              ...manifest.guardrails.disallowedTools,
              "AskUserQuestion",
              ...(isEscalationSession ? LOOM_ESCALATION_DISALLOWED_TOOLS : []),
            ],
            // The loom MCP server (see loomMcpServer above) — its tools
            // surface as mcp__loom__*, gated the same way every other tool
            // is: allowedTools for the safe read/draft ones, canUseTool +
            // the PreToolUse hook for start_loom.
            // Per-project MCP servers (docs/runtime-architecture.md §B) with
            // their OWN token-injected env/headers — resolved decoupled from
            // accountEnv above, so account-switching can't rotate MCP auth.
            mcpServers: { loom: loomMcpServer, ...(project ? resolveProjectMcpServers(project) : {}) },
            // Telar OWNS the MCP surface: use ONLY the servers above (loom +
            // the project's telar.yaml servers). settingSources ["project",
            // "local"] would otherwise pull in the repo's .mcp.json / the
            // user's local Claude MCP config — leaking in confusing duplicate,
            // unauthenticated servers (e.g. a second Supabase). Ignore them.
            strictMcpConfig: true,
            canUseTool,
            hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] },
            maxTurns: 25,
            includePartialMessages: true,
            // Relay full subagent conversation text (not just its tool
            // calls/results) on this same stream, each message tagged with
            // parent_tool_use_id — the basis for the client's per-subagent
            // tabs (contract: see route.ts's per-message `parent`/`parentId`
            // attribution below).
            forwardSubagentText: true,
            abortController: abort,
          },
        });
        for await (const msg of q) {
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
            // Open the live log (truncate + write the `user` header) BEFORE the
            // first send() so the session event is the log's second line and a
            // reconnecting client can tail this turn (Phase 1b).
            startSessionLog(capturedSession, message);
            send("session", {
              sessionId: capturedSession,
              slashCommands: init.slash_commands ?? [],
              skills: init.skills ?? [],
              agents: init.agents ?? [],
            });
            // Fire the plan-usage control call now — the subprocess must still
            // be alive when it resolves; awaiting it at result-time is too late.
            const usageFn = (q as unknown as Record<string, () => Promise<any>>)
              .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
            usagePromise = usageFn ? usageFn.call(q).catch(() => null) : null;
          } else if (msg.type === "stream_event") {
            const parent = parentFlatten.resolve(
              (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
            );
            const ev = (msg as { event: Record<string, any> }).event;
            if (ev?.type === "content_block_start") {
              if (ev.content_block?.type === "thinking") {
                send("thinking", parent ? { parent } : {});
              }
              streamingText.set(parent, "");
            } else if (
              ev?.type === "content_block_delta" &&
              ev.delta?.type === "text_delta"
            ) {
              streamingText.set(parent, (streamingText.get(parent) ?? "") + ev.delta.text);
              send("delta", { text: ev.delta.text, ...(parent ? { parent } : {}) });
            } else if (
              ev?.type === "content_block_delta" &&
              ev.delta?.type === "thinking_delta"
            ) {
              // Interleaved narration text, not persisted (see StorePart —
              // there's no "thinking" variant there): live-only, same
              // treatment as permission cards. `thinking` above already told
              // the client a block started; this streams its growing text.
              send("thinking_delta", {
                text: ev.delta.thinking ?? "",
                ...(parent ? { parent } : {}),
              });
            }
          } else if (msg.type === "assistant") {
            // A non-null parent_tool_use_id means this message came from a
            // subagent's own internal conversation (spawned via the detected
            // agent-spawn tool), relayed on this same top-level stream
            // because forwardSubagentText is on. It's still appended to the
            // same flat `parts` array — attributed via parentId, flattening
            // arbitrarily deep subagent-of-a-subagent nesting to the
            // top-level spawn's tool_use id — rather than skipped, so the
            // client can render it as its own tab.
            const parent = parentFlatten.resolve(
              (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
            );
            const msgUuid = (msg as { uuid?: string }).uuid;
            // Context-window occupancy = the FINAL main-thread model call's
            // prompt (input + cache-read + cache-create). Each assistant
            // message in a multi-step turn carries its own single-call usage;
            // the result message's usage is the SUM across every step, which
            // is far larger than the actual window (13 tool steps → ~13× the
            // real context). Capture the last main-thread (non-subagent) call
            // so the "CTX" the UI shows is the real thing, not a step total.
            if (!parent) {
              const mu = (msg as unknown as { message?: { usage?: Record<string, number> } })
                .message?.usage;
              if (mu) lastMainUsage = mu;
            }
            const content =
              (msg as { message?: { content?: Array<Record<string, any>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type === "text") {
                parts.push({
                  type: "text",
                  text: block.text as string,
                  ...(parent ? { parentId: parent } : {}),
                });
                partOrigin.push(msgUuid);
                send("text", { text: block.text, ...(parent ? { parent } : {}) }); // finalize the streamed block
                streamingText.set(parent, "");
              }
              if (block.type === "tool_use") {
                const id = block.id as string;
                const name = block.name as string;
                const rawInput = (block.input ?? {}) as Record<string, unknown>;
                const input = capToolInput(rawInput);
                const part: Extract<Part, { type: "tool" }> = {
                  type: "tool",
                  id,
                  name,
                  input,
                  ...(parent ? { parentId: parent } : {}),
                };
                // This tool_use IS a spawn step: enrich its part with agent
                // meta (contract 3) and record it in parentFlatten so any
                // messages the spawned subagent forwards under this exact
                // id resolve straight to it — including a subagent that
                // itself spawns a sub-subagent, which noteSpawn flattens to
                // this same top-level id via `parent` above.
                //
                // Matched directly against the candidate list, NOT against a
                // single name detected once from the init message's `tools`
                // array: live testing showed init.tools advertises the spawn
                // tool under its legacy registered name ("Task") while the
                // actual tool_use blocks on the wire carry the SDK's current
                // canonical name ("Agent") — the two disagree within the same
                // session, so a single detected name silently never matches.
                if ((AGENT_SPAWN_TOOL_CANDIDATES as readonly string[]).includes(name)) {
                  part.agent = agentMetaFromInput(rawInput);
                  parentFlatten.noteSpawn(id, parent);
                }
                parts.push(part);
                partOrigin.push(msgUuid);
                send("tool", {
                  id,
                  name,
                  input,
                  ...(part.agent ? { agent: part.agent } : {}),
                  ...(parent ? { parent } : {}),
                });
              }
            }
            // Refusal-fallback retry: the SDK retried on a fallback model and
            // this message's `supersedes` names the wire uuids of previously
            // -delivered message frames it replaces (including tombstoned
            // tool_result frames from the refused leg). Evict whatever this
            // turn already queued from those frames so a retracted tool call
            // never gets persisted as if the model's final output included it.
            const supersedes = (msg as { supersedes?: string[] }).supersedes;
            if (supersedes?.length) {
              const dead = new Set(supersedes);
              for (let i = parts.length - 1; i >= 0; i--) {
                const origin = partOrigin[i];
                if (origin && dead.has(origin)) {
                  parts.splice(i, 1);
                  partOrigin.splice(i, 1);
                }
              }
            }
          } else if (msg.type === "user") {
            // Tool results: the SDK relays the model's `user` turn carrying
            // tool_result blocks — both this turn's own and, with
            // forwardSubagentText on, any forwarded subagent's. Attach
            // output/isError onto the matching "tool" part (by tool_use_id,
            // globally unique regardless of nesting depth) so persistence
            // includes results, and mirror the same data over SSE. A
            // tool_result whose id matches no part pushed above is stray
            // side-channel noise — skip it rather than crash or emit a
            // dangling event.
            const parent = parentFlatten.resolve(
              (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
            );
            const content =
              (msg as { message?: { content?: Array<Record<string, any>> } })
                .message?.content ?? [];
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              const id = block.tool_use_id as string;
              const part = parts.find(
                (p): p is Extract<Part, { type: "tool" }> =>
                  p.type === "tool" && p.id === id,
              );
              if (!part) continue;
              // A duplicate/retried delivery for the same tool_use_id: first
              // write wins rather than silently overwriting an already
              // -resolved result with a second (possibly stale) one.
              if (part.output !== undefined) continue;
              const output = capToolOutput(extractToolResultText(block.content));
              const isError = !!block.is_error;
              part.output = output;
              part.isError = isError;
              send("tool_result", { id, output, isError, ...(parent ? { parent } : {}) });
            }
          } else if (msg.type === "system" && msg.subtype === "task_notification") {
            // Authoritative completion signal for a backgrounded subagent.
            // Subagents spawned via Agent/Task run in the background by
            // default: the spawn tool_use's own tool_result ("Async agent
            // launched successfully…") lands almost immediately and is NOT
            // the subagent's real completion — this system message, keyed by
            // the spawn's own tool_use id (not parent_tool_use_id — it's a
            // control-plane notification ABOUT a tool_use, not a forwarded
            // message FROM one), is. Recorded on the matching tool part so
            // the client's agentStatus() can tell "still actually running"
            // from "the launch ack merely already arrived" (see
            // session-view.tsx).
            const tn = msg as {
              tool_use_id?: string;
              status?: "completed" | "failed" | "stopped";
            };
            if (tn.tool_use_id && tn.status) {
              const part = parts.find(
                (p): p is Extract<Part, { type: "tool" }> =>
                  p.type === "tool" && p.id === tn.tool_use_id,
              );
              if (part) {
                part.taskStatus = tn.status;
                send("task_status", { id: tn.tool_use_id, status: tn.status });
              }
            }
          } else if (msg.type === "system" && msg.subtype === "permission_denied") {
            // Auto-denied without an interactive prompt — the model's normal
            // tool_use/tool_result exchange still happens (already handled
            // by the "assistant"/"user" cases above), so in the common case
            // this just adds WHY onto the tool part they already created.
            // The fallback branch below covers the rare ordering where this
            // message is seen before that tool_use block ever is.
            const pd = msg as unknown as {
              tool_name: string;
              tool_use_id: string;
              message: string;
              decision_reason_type?: string;
            };
            send("permission_denied", {
              toolName: pd.tool_name,
              toolUseId: pd.tool_use_id,
              message: pd.message,
              reason: pd.decision_reason_type,
            });
            const existing = parts.find(
              (p): p is Extract<Part, { type: "tool" }> =>
                p.type === "tool" && p.id === pd.tool_use_id,
            );
            if (existing) {
              existing.autoDenied = true;
              existing.isError = true;
              if (existing.output === undefined) existing.output = pd.message;
            } else {
              parts.push({
                type: "tool",
                id: pd.tool_use_id,
                name: pd.tool_name,
                isError: true,
                autoDenied: true,
                output: pd.message,
              });
              partOrigin.push(undefined);
            }
          } else if (msg.type === "rate_limit_event") {
            // Streamed mid-turn — single-window update, merge into the snapshot
            const info = (msg as { rate_limit_info?: Record<string, any> }).rate_limit_info;
            if (info?.rateLimitType && info.utilization != null) {
              const window = { utilization: info.utilization, resets_at: toIso(info.resetsAt) };
              const key =
                info.rateLimitType === "five_hour"
                  ? "fiveHour"
                  : info.rateLimitType === "seven_day"
                    ? "sevenDay"
                    : info.rateLimitType === "seven_day_opus"
                      ? "sevenDayOpus"
                      : info.rateLimitType === "seven_day_sonnet"
                        ? "sevenDaySonnet"
                        : null;
              if (key) {
                savePlanUsage(profile.name, { [key]: window });
                send("plan", { account: profile.name, [key]: window });
              }
            }
          } else if (msg.type === "result") {
            // Capture only — do NOT log usage / save plan snapshot / send
            // "done" here. A backgrounded subagent can wake an SDK
            // auto-continuation that produces a second "result" later in
            // this same stream, and these fields are running totals for the
            // whole query() invocation, not per-message deltas; acting on
            // every "result" would double-count cost/usage for one turn.
            // `lastResult` is read exactly once, after the loop ends (see
            // the `finally` block), so only the final (most complete) totals
            // are ever persisted or broadcast.
            const r = msg as unknown as {
              subtype: string;
              total_cost_usd?: number;
              num_turns?: number;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
            costUsd = r.total_cost_usd ?? 0;
            lastResult = {
              subtype: r.subtype,
              totalCostUsd: costUsd,
              turns: r.num_turns,
              usage: r.usage,
            };
          }
        }
        }

      } catch (e) {
        if (!abort.signal.aborted) send("error", { message: String(e) });
      } finally {
        // Fail-closed teardown: deny any permission requests still open on this
        // stream so their canUseTool promises unblock and no pending is leaked.
        for (const id of myPending) resolvePending(id, { behavior: "deny", reason: "aborted" });
        myPending.clear();
        // Persist in teardown, not in the happy path: a client disconnect
        // (navigation, closed tab) aborts the SDK loop with a throw, and the
        // turn must survive it — the SDK session already exists server-side.
        try {
          // Flush every parent's in-progress (never text-block-finalized)
          // streamed text — the main turn's (key null) and any forwarded
          // subagent's alike — so an abort/crash mid-stream doesn't drop
          // whatever was already visible to the user.
          for (const [parent, text] of streamingText) {
            if (text) parts.push({ type: "text", text, ...(parent ? { parentId: parent } : {}) });
          }
          // A tool part still missing output at this point never got a
          // matching tool_result — the turn was aborted or crashed mid-flight
          // (a graceful "result" message only arrives once every tool call
          // belonging to it has resolved, denials included). Flag it so the
          // client can render "interrupted" instead of rendering identically
          // to a genuinely empty successful result.
          let anyInterrupted = false;
          for (const part of parts) {
            if (part.type === "tool" && part.output === undefined) {
              part.interrupted = true;
              anyInterrupted = true;
            }
          }
          // The mutation above is local-only (about to be persisted below) —
          // without this, a live client watching this same stream never
          // learns a tool call got flagged interrupted (no SSE event carried
          // that fact before now), so its copy keeps reading `output:
          // undefined, interrupted: undefined` and a subagent tab's status
          // dot shimmers as "running" forever even after the turn is over.
          // Payload-free: the client already knows which message is its own
          // in-flight one and applies the exact same "tool part still
          // missing output" rule locally (see markToolsInterrupted).
          if (anyInterrupted) send("interrupted", {});
          // Bound how many tool parts keep full input/output detail — but
          // ration that budget PER PARENT (main thread = undefined, each
          // subagent spawn = its own tool_use id), not with one shared
          // counter. forwardSubagentText means a single chatty subagent's
          // tool calls now share this same flat array with the main thread's
          // own; a single shared counter would let that subagent's noise
          // consume the whole budget and strip detail from the main thread's
          // own tool calls, which is what a user actually asked for most.
          const detailedByParent = new Map<string | undefined, number>();
          for (const part of parts) {
            if (part.type !== "tool") continue;
            const count = (detailedByParent.get(part.parentId) ?? 0) + 1;
            detailedByParent.set(part.parentId, count);
            if (count > MAX_DETAILED_TOOL_PARTS) {
              delete part.input;
              delete part.output;
            }
          }
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
              // experimental API — degrade silently, rate_limit_events still cover us
            }
          }
          if (u?.rate_limits_available && u.rate_limits) {
            const rl = u.rate_limits;
            const snapshot: Partial<PlanSnapshot> = {
              subscriptionType: u.subscription_type ?? null,
              fiveHour: rl.five_hour ?? null,
              sevenDay: rl.seven_day ?? null,
              sevenDayOpus: rl.seven_day_opus ?? null,
              sevenDaySonnet: rl.seven_day_sonnet ?? null,
              modelScoped: rl.model_scoped ?? [],
            };
            savePlanUsage(profile.name, snapshot);
            send("plan", { account: profile.name, ...snapshot });
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
          if (!lastResult && u?.session) {
            const modelUsages = Object.values(u.session.model_usage ?? {}) as Array<{
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }>;
            costUsd = u.session.total_cost_usd ?? 0;
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
            lastResult = { subtype: "aborted", totalCostUsd: costUsd, usage };
          }
          // Act on the LAST "result" message — real or, absent one, the
          // synthesized fallback above (see the "result" case for why only
          // the last one is ever used) — plan-usage snapshot, the
          // usage.ndjson entry, and the "done" broadcast all fire at most
          // once per POST.
          if (lastResult) {
            if (capturedSession) {
              logUsage({
                ts: Date.now(),
                account: profile.name,
                model,
                sessionId: capturedSession,
                inputTokens: lastResult.usage?.input_tokens ?? 0,
                outputTokens: lastResult.usage?.output_tokens ?? 0,
                cacheReadTokens: lastResult.usage?.cache_read_input_tokens ?? 0,
                cacheCreateTokens: lastResult.usage?.cache_creation_input_tokens ?? 0,
                costUsd: lastResult.totalCostUsd,
              });
            }
            send("done", {
              subtype: lastResult.subtype,
              costUsd: lastResult.totalCostUsd,
              turns: lastResult.turns,
              usage: lastResult.usage,
              // Real context-window occupancy (final call), not the step sum.
              context: contextOf(lastMainUsage),
            });
          }
          if (capturedSession) {
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
              permissionMode,
              // Session<->Loom link (docs/loom-model.md §5): undefined
              // means "no change" (appendTurn only ever narrows a link in,
              // see its own comment) — loomLink stays untouched for a plain
              // turn that never called a loom tool.
              loomId: loomLink.loomId,
              role: loomLink.role,
              userMessage: { role: "user", parts: [{ type: "text", text: message }] },
              assistantMessage: { role: "assistant", parts },
              costUsd,
              title,
              usage: lastResult?.usage
                ? {
                    inputTokens: lastResult.usage.input_tokens ?? 0,
                    outputTokens: lastResult.usage.output_tokens ?? 0,
                    cacheReadTokens: lastResult.usage.cache_read_input_tokens ?? 0,
                    cacheCreateTokens: lastResult.usage.cache_creation_input_tokens ?? 0,
                  }
                : undefined,
              // Final-call context (not the step sum) — persisted so CTX is
              // right on resume, independent of the cumulative usage above.
              contextTokens: contextOf(lastMainUsage),
            });
            send("saved", { chatId: capturedSession });
          }
        } catch {
          // persistence failure must never mask the stream teardown
        }
        // Never let title generation outlive this response. `abort` is only
        // ever triggered above by req.signal's 'abort' listener (client
        // disconnect) — a turn that completes/errors/aborts normally never
        // signals it otherwise, so titlePromise's underlying subprocess would
        // otherwise keep running unobserved: (1) it lost the TITLE_RACE_MS
        // race above (still running past the bounded wait), or (2) the main
        // query() never reached system:init at all (capturedSession stayed
        // null, so the whole persistence block — the only place that awaits
        // titlePromise — never ran). Aborting here is a no-op if
        // generateTitle already finished on its own (its own `finally`
        // already called abort.abort(); idempotent) and a no-op for a
        // resumed session (titlePromise is null there, nothing was ever
        // fired) — otherwise it force-ends the orphaned subprocess right now
        // instead of leaving it to whatever natural conclusion it reaches on
        // its own after the HTTP response has already closed.
        if (titlePromise) abort.abort();
        // Terminal marker the live-tail subscriber closes on. Written BEFORE
        // endChatRun so a still-connected subscriber reads "closed" while the
        // run is technically still registered as live (Phase 1b).
        if (capturedSession) appendSessionEvent(capturedSession, "closed", {});
        endChatRun(runId);
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
