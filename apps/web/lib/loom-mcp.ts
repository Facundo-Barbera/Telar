// The "loom" in-process MCP server (docs/loom-model.md §5, §M.6) — the
// moat-safe toolset a planning session gets: draft/refine a Spec Bundle,
// propose its falsifiable Verification Contract, inspect looms, and —
// gated entirely outside this module, see route.ts's allowedTools/PreToolUse
// wiring — commit a draft into a running loom. Modeled on engine.ts's
// `agent()` (createSdkMcpServer + tool() + zod), but long-lived for a whole
// chat turn rather than scoped to one agent() call.
//
// No tool here sets a loom's state/verdict/acceptance. `start_loom` is the
// only mutation that dispatches a loom, and the `by` identity it stamps as
// provenance is always server-derived (the chat's own account), NEVER read
// from tool input — the model cannot name who approved its own commit.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  addWatch,
  answerBlocked,
  cancelLoom,
  ContractAssertion,
  createDraftLoom,
  getLoom,
  isListableLoom,
  listAccounts,
  listBundleFiles,
  listLooms,
  loadPolicy,
  readContract,
  rejectLoom,
  resumeLoom,
  saveLoom,
  startLoomFromBundle,
  steerLoom,
  updateDraftObjectiveFromBundle,
  WorkUnitState,
  writeBundleFile,
  writeContract,
} from "@telar/core";

// The read/draft tools AND the lifecycle-drive tools (steer/reject/resume/
// cancel) — safe to auto-run (route.ts adds these, and only these, to
// `allowedTools`). The user DRIVES a running loom through the agent, so these
// mustn't spam permission cards. NB `start_loom` (the commit) is deliberately
// absent, and there is no accept tool — accept-to-done stays a human click
// (docs/loom-model.md §M.6, the moat). Named here so the allow-list and the
// server definition below can never drift apart.
export const LOOM_AUTO_TOOLS = [
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
  // Registering a background watch is inert (it spends nothing and returns
  // immediately — docs/watchers-design.md §5), so it must never spam a card.
  "mcp__loom__watch_loom",
] as const;

// The commit tool — deliberately NEVER added to `allowedTools` and hard-routed
// back to an interactive approval by route.ts's PreToolUse guardrail hook
// regardless of permissionMode (§M.6 — the human's Approve click IS the
// provenance stamp). See route.ts's preToolUseGuardrail and canUseTool.
export const LOOM_START_TOOL = "mcp__loom__start_loom";

// M11.3 — the conversational-escalation WRITE tool. Like start_loom (§M.6) it
// commits a real, viability-making decision (the persisted verification recipe
// that resumes a `blocked` loop), so it is human-gated by the EXACT same moat:
// NEVER in LOOM_AUTO_TOOLS, and hard-routed to an interactive approval card by
// route.ts's PreToolUse guardrail in every permission mode — the human's Approve
// click IS the provenance stamp answerBlocked's `by` records (which is always
// the chat's server-resolved account, never tool input). Distinct from the
// auto-run `answer_loom`: that one resumes with an AGENT-picked devCommand
// un-gated and can't carry a verifyCommand; this one carries the strategy answer
// and only lands after the human approves. See route.ts's three mirror sites.
export const LOOM_ANSWER_BLOCKED_TOOL = "mcp__loom__answer_blocked";

// M11.3 — the escalation session's AUTO-RUN toolset (route.ts's `allowedTools`
// when isEscalationSession). READ-ONLY only: the loom-inspection reads plus the
// project-root snapshot tools, so the discussing agent can explain the parked
// verification method and inspect the repo, but has NO state-changing tool that
// auto-runs. answer_blocked is deliberately ABSENT here (it is the one write and
// stays human-gated, exactly like start_loom is absent from LOOM_AUTO_TOOLS).
// The state-changing loom tools are additionally HARD-BLOCKED via
// LOOM_ESCALATION_DISALLOWED_TOOLS below (SDK disallow always wins), so they can
// never run in an escalation session even interactively — the read-only judge/
// discuss wall is enforced by the toolset, not by isolation.
export const LOOM_ESCALATION_READONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "mcp__loom__read_bundle",
  "mcp__loom__get_loom",
  "mcp__loom__list_looms",
] as const;

// M11.3 — the state-changing loom tools an escalation session must NEVER run.
// Passed into route.ts's `disallowedTools` for isEscalationSession: the SDK
// guarantees a disallow beats any allow (repo-settings or otherwise), so even
// though the loom MCP server registers these for planner/steerer sessions, they
// are truly uncallable here. Deliberately EXCLUDES answer_blocked (which must
// remain callable-but-gated — the ONLY escalation write path) and the read
// tools in LOOM_ESCALATION_READONLY_TOOLS above.
export const LOOM_ESCALATION_DISALLOWED_TOOLS = [
  "mcp__loom__draft_bundle_file",
  "mcp__loom__propose_contract",
  "mcp__loom__start_loom",
  "mcp__loom__steer_loom",
  "mcp__loom__reject_loom",
  "mcp__loom__answer_loom",
  "mcp__loom__resume_loom",
  "mcp__loom__cancel_loom",
  "mcp__loom__watch_loom",
] as const;

// M11.3 — the escalation session's per-turn seed context (parallel to route.ts's
// buildSteererContext). PURE string assembly over already-fetched values so it's
// hermetically testable and carries no @telar/core coupling: route.ts gathers the
// loom/contract/deliverable-signal and hands the primitives here. Seeds the
// agent with WHY the loop parked (blockedReason/blockedQuestion), WHAT the
// contract asks (assertion type+description summary), and the machine evidence of
// what verification substrates were checked (the deliverable signal's reason).
export function formatEscalationContext(args: {
  loomId: string;
  state?: string;
  blockedReason?: string;
  blockedQuestion?: string;
  assertions?: { type: string; description: string }[];
  signalReason?: string;
}): string {
  const assertionLines =
    args.assertions && args.assertions.length
      ? args.assertions.map((a) => `  • [${a.type}] ${a.description}`).join("\n")
      : null;
  return [
    `\n\n--- BLOCKED LOOM CONTEXT (id ${args.loomId}, state: ${args.state ?? "unknown"}) ---`,
    args.blockedQuestion && `# The question the loop parked on\n${args.blockedQuestion}`,
    args.blockedReason && `# What it already tried (why the lane is unviable)\n${args.blockedReason}`,
    assertionLines && `# Verification Contract (what must be proven)\n${assertionLines}`,
    args.signalReason &&
      `# Deliverable-signal evidence (verification substrates checked)\n${args.signalReason}`,
    `# Project snapshot\nYour working directory IS this loom's project root — use Read/Grep/Glob to inspect it (package.json, test setup, entry points) so your guidance is grounded in the real repo.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Mutated in place by draft_bundle_file (first-use lazy create) and read back
// by route.ts after the turn ends to persist onto the chat record via the
// same appendTurn(loomId, role) path used for every other captured session
// state — see store.ts's Chat.loomId/role.
export type LoomSessionLink = { loomId?: string; role?: "planner" | "steerer" };

export type LoomMcpOpts = {
  project: string;
  // The turn's raw user message — used only to seed a lazily-created draft
  // loom's title/objective on first use; never re-read after that.
  objectiveSeed: string;
  // Server-derived human/account identity for this chat — the ONLY source
  // start_loom's `by`/provenance ever draws from.
  account: string;
  link: LoomSessionLink;
  // Tool calls always run after the SDK's system:init message, so by the
  // time any handler below fires, route.ts's capturedSession is already set
  // — read lazily rather than captured at server-construction time.
  getSessionId: () => string | null;
};

const errResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
const okResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function createLoomMcpServer(opts: LoomMcpOpts): McpServerConfig {
  // Shared by every tool below except draft_bundle_file (which lazily
  // creates the draft loom instead of erroring).
  const requireLoomId = (): string | null => opts.link.loomId ?? null;

  // The lifecycle-drive tools (steer/reject/resume/cancel) target a loom by
  // OPTIONAL id, defaulting to the session's linked loom — so any session can
  // drive any loom by id, or its own linked one by default.
  const resolveLoomId = (loomId?: string): string | null =>
    loomId?.trim() || opts.link.loomId || null;

  // The same DispatcherDeps start_loom builds — needed by steer/reject/resume
  // (cancel takes none).
  const buildDeps = () => ({
    accounts: Object.fromEntries(listAccounts().map((a) => [a.name, a])),
    policy: loadPolicy(),
  });

  return createSdkMcpServer({
    name: "loom",
    version: "1.0.0",
    tools: [
      tool(
        "draft_bundle_file",
        "Write (or overwrite) one file into this session's draft Spec Bundle — the working directory the loom will weave from. Creates the draft loom on first use. Path is relative to the bundle root (e.g. 'objective.md', 'contract.json').",
        { path: z.string(), contents: z.string() },
        async ({ path, contents }) => {
          if (!opts.link.loomId) {
            const title = opts.objectiveSeed.trim().slice(0, 60) || "Untitled loom";
            const draft = createDraftLoom({
              project: opts.project,
              title,
              objective: opts.objectiveSeed,
              account: opts.account,
            });
            opts.link.loomId = draft.id;
            opts.link.role = "planner";
          }
          try {
            writeBundleFile(opts.link.loomId, path, contents);
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
          // objective.md is the single source of truth for the draft's
          // objective — keep the loom's prompt/title tracking it LIVE, so the
          // god-view never diverges from the bundle (docs/loom-model.md §5).
          if (path === "objective.md") updateDraftObjectiveFromBundle(opts.link.loomId);
          return okResult(`Wrote "${path}" to the draft bundle (loom ${opts.link.loomId}).`);
        },
      ),
      tool(
        "propose_contract",
        "Write this draft loom's Verification Contract (spec/contract.json) — the required, falsifiable proof spec. Each assertion must be falsifiable by construction (a concrete `expected`/`expectedFile`, or an `observable` for live-critic entries); a prose-only/non-falsifiable contract is REJECTED — the tool result will report exactly why so you can fix it. For command/gate assertions the runnable command / gate-name goes in `expected` (its exit code is the proof) — it must be a REAL shell command, not a prose description of the outcome; `observable` is live-critic-only and is REJECTED on command/gate.",
        { assertions: z.array(ContractAssertion) },
        async ({ assertions }) => {
          const loomId = requireLoomId();
          if (!loomId) {
            return errResult("No draft loom yet — call draft_bundle_file first to start one.");
          }
          try {
            writeContract(loomId, { version: 1, assertions });
          } catch (e) {
            // writeContract THROWS on an unfalsifiable contract (§M.1) — the
            // thrown message IS the tool result, so the model sees exactly
            // what to fix rather than a silently swallowed failure.
            return errResult(e instanceof Error ? e.message : String(e));
          }
          return okResult(`Verification Contract written with ${assertions.length} assertion(s).`);
        },
      ),
      tool(
        "read_bundle",
        "List this draft loom's bundle files and its current Verification Contract (if any), so you can review what's been drafted so far.",
        {},
        async () => {
          const loomId = requireLoomId();
          if (!loomId) {
            return okResult("No draft loom yet — nothing has been drafted.");
          }
          const files = listBundleFiles(loomId);
          const { contract, errors } = readContract(loomId);
          return okResult(JSON.stringify({ loomId, files, contract, contractErrors: errors }, null, 2));
        },
      ),
      tool(
        "list_looms",
        "List started, top-level looms (drafts-in-progress and child/thread looms are excluded).",
        {},
        async () => {
          const looms = listLooms()
            .filter(isListableLoom)
            .map((l) => ({ id: l.id, title: l.title, project: l.project, state: l.state, updatedAt: l.updatedAt }));
          return okResult(JSON.stringify(looms, null, 2));
        },
      ),
      tool(
        "get_loom",
        "Get the full status of one loom by id (works for a draft, in the current session, too).",
        { id: z.string() },
        async ({ id }) => {
          const loom = getLoom(id);
          if (!loom) return errResult(`No loom found with id "${id}".`);
          return okResult(JSON.stringify(loom, null, 2));
        },
      ),
      tool(
        "start_loom",
        "COMMIT this draft Spec Bundle and start the loom running — the moment automation begins spending. This tool ALWAYS requires the human's explicit interactive approval in Telar's UI, in every permission mode; it can never auto-run. Only call it once you and the human are confident the bundle (objective + falsifiable Verification Contract) is ready.",
        { title: z.string().optional() },
        async ({ title }) => {
          const loomId = requireLoomId();
          if (!loomId) {
            return errResult("No draft loom yet — call draft_bundle_file first to start one.");
          }
          try {
            // `by` is opts.account — the chat's own server-resolved identity,
            // never a value read from tool input (§M.6).
            const started = await startLoomFromBundle(
              loomId,
              opts.account,
              { accounts: Object.fromEntries(listAccounts().map((a) => [a.name, a])), policy: loadPolicy() },
              { sessionId: opts.getSessionId() ?? undefined },
            );
            // Apply an explicit title override AFTER start: startLoomFromBundle
            // reconciles title from objective.md, so setting it before would be
            // clobbered. The human's chosen title is the last word.
            if (title?.trim()) {
              started.title = title.trim();
              saveLoom(started);
            }
            return okResult(JSON.stringify({ loomId: started.id, url: `/looms/${started.id}` }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      // The lifecycle-drive tools (docs/loom-model.md §A) — auto-run so the
      // human can DRIVE a running loom through the agent. Each re-enters the
      // SAME verified loop and can only land back at `ready`, never `done`
      // (the accept-to-done moat stays a human click). `loomId` is optional and
      // defaults to the session's linked loom; `by` is ALWAYS opts.account, the
      // chat's own server-resolved identity, never read from tool input (§M.6).
      tool(
        "steer_loom",
        "Steer a RUNNING loom: record a directive and re-dispatch so it continues and RE-VERIFIES against its contract. Valid from 'ready' or 'needs-review'. Defaults to this session's linked loom when loomId is omitted.",
        { loomId: z.string().optional(), directive: z.string() },
        async ({ loomId, directive }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to steer a specific loom.");
          try {
            const loom = await steerLoom(id, directive, opts.account, buildDeps());
            return okResult(JSON.stringify({ loomId: loom.id, state: loom.state }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "reject_loom",
        "Reject a loom's work and send it back with feedback so it re-enters the verified loop. Valid from 'ready', 'blocked', 'needs-review', or 'failed'. Defaults to this session's linked loom when loomId is omitted.",
        { loomId: z.string().optional(), feedback: z.string() },
        async ({ loomId, feedback }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to reject a specific loom.");
          try {
            const loom = await rejectLoom(id, feedback, opts.account, buildDeps());
            return okResult(JSON.stringify({ loomId: loom.id, state: loom.state }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "answer_loom",
        "Answer a loom parked in 'blocked' (the orchestrator asked how to verify this work) and re-dispatch it. Provide a devCommand (e.g. 'bun run dev') and/or a runbook narrative (how to drive the app to reach the feature). Persists the recipe so it never asks again, then re-verifies (lands 'ready' at most, never 'done'). Defaults to this session's linked loom when loomId is omitted.",
        {
          loomId: z.string().optional(),
          devCommand: z.string().optional(),
          runbook: z.string().optional(),
        },
        async ({ loomId, devCommand, runbook }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to answer a specific loom.");
          try {
            // `by` is ALWAYS opts.account — the human-by moat; never read from
            // tool input.
            const ok = await answerBlocked(id, opts.account, { devCommand, runbook }, buildDeps());
            if (!ok) {
              return errResult("Loom is not blocked, or the answer was empty (provide a devCommand or runbook).");
            }
            const loom = getLoom(id);
            return okResult(JSON.stringify({ loomId: id, state: loom?.state }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      // M11.3 — the conversational-escalation WRITE. Human-gated exactly like
      // start_loom: NEVER in LOOM_AUTO_TOOLS, hard-routed to an interactive
      // approval card by route.ts's PreToolUse guardrail in every permission
      // mode (see LOOM_ANSWER_BLOCKED_TOOL). Distinct from answer_loom above:
      // this carries the M11 strategy answer (verifyCommand) and only lands
      // after the human's Approve click. `by` is ALWAYS opts.account — the
      // chat's server-resolved human identity, NEVER read from tool input
      // (§M.6), consistent with the /block/answer route's server-bound `by`.
      tool(
        "answer_blocked",
        "Answer a loom parked in 'blocked' with the human-approved verification recipe and resume it. Provide a verifyCommand (a test/eval command whose exit code proves a library/CLI/eval deliverable — persisted as telar.yaml verifyCommand, NEVER auto-spun as a dev server), and/or a devCommand (how to bring a runnable app up), and/or a runbook (optional free-text narrative for how to drive the app to reach the feature; a runbook alone can NOT resume the loom). This tool ALWAYS requires the human's explicit interactive approval in Telar's UI, in every permission mode; it can never auto-run — only call it once the human has converged on the answer. Persists the recipe (so it never asks again) then re-verifies (lands 'ready' at most, never 'done'). Defaults to this session's linked loom when loomId is omitted.",
        {
          loomId: z.string().optional(),
          devCommand: z.string().optional(),
          verifyCommand: z.string().optional(),
          runbook: z.string().optional(),
        },
        async ({ loomId, devCommand, verifyCommand, runbook }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to answer a specific loom.");
          try {
            // `by` is ALWAYS opts.account — the human-by moat; never read from
            // tool input. The accept-guard inside answerBlocked (viability-
            // making devCommand/verifyCommand/servers only; runbook alone
            // never resumes) stays in lock-step with executor's isLaneViable.
            const ok = await answerBlocked(
              id,
              opts.account,
              { devCommand, verifyCommand, runbook },
              buildDeps(),
            );
            if (!ok) {
              return errResult(
                "Loom is not blocked, or the answer wasn't viability-making (provide a verifyCommand or devCommand — a runbook alone can't resume the loom).",
              );
            }
            const loom = getLoom(id);
            return okResult(JSON.stringify({ loomId: id, state: loom?.state }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "resume_loom",
        "Resume a stuck loom as-is (no new directive) — re-run it through the SAME verified loop. Valid from 'failed', 'needs-review', or 'blocked'. Defaults to this session's linked loom when loomId is omitted.",
        { loomId: z.string().optional() },
        async ({ loomId }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to resume a specific loom.");
          try {
            const loom = resumeLoom(id, buildDeps());
            return okResult(JSON.stringify({ loomId: loom.id, state: loom.state }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      tool(
        "cancel_loom",
        "Cancel (stop) a loom — abort a live executor, or halt a paused loom directly. Returns whether a loom was actually stopped. Defaults to this session's linked loom when loomId is omitted.",
        { loomId: z.string().optional() },
        async ({ loomId }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to cancel a specific loom.");
          try {
            const cancelled = cancelLoom(id);
            return okResult(JSON.stringify({ loomId: id, cancelled }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
      // Register a BACKGROUND watch (docs/watchers-design.md §5). Inert and
      // non-blocking: it persists a Watch record and returns AT ONCE — the
      // reaction arrives later as a new turn, it never awaits a loom event.
      // `sessionId` is server-derived via opts.getSessionId(), NEVER from input.
      tool(
        "watch_loom",
        "Register a background watch on a loom: when it transitions into a trigger state (needs-review / blocked / failed / done / ready by default), this session is alerted and reacts in-conversation. Returns IMMEDIATELY — it does NOT block the turn on any loom event. Defaults to this session's linked loom when loomId is omitted.",
        { loomId: z.string().optional(), triggerStates: z.array(WorkUnitState).optional() },
        async ({ loomId, triggerStates }) => {
          const id = resolveLoomId(loomId);
          if (!id) return errResult("No loom is linked to this session — pass a loomId to watch a specific loom.");
          // sessionId is server-derived; a not-yet-persisted session has no id
          // to own the watch, so bail rather than write an orphaned record.
          const sessionId = opts.getSessionId();
          if (!sessionId) {
            return errResult(
              "This session isn't persisted yet — send a message so it gets an id, then register the watch.",
            );
          }
          try {
            const watch = addWatch({
              loomId: id,
              sessionId,
              triggerStates,
            });
            return okResult(
              JSON.stringify(
                { watchId: watch.id, loomId: watch.loomId, triggerStates: watch.triggerStates },
                null,
                2,
              ),
            );
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
}
