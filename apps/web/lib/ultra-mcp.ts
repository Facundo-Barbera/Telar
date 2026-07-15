// The "ultra" in-process MCP server (docs/plans/ultra-harness.md §4) — the
// side-quest toolset a chat session's main agent reaches for to author and
// run a deterministic fan-out script. Modeled directly on loom-mcp.ts's
// createLoomMcpServer (createSdkMcpServer + tool() + zod), but far simpler:
// Ultra has no draft/commit lifecycle and no human-gated write — every tool
// here is a read or a non-blocking launch/stop, so (unlike
// mcp__loom__start_loom) NONE of them need the interactive canUseTool
// approval card (doc §2/§4: opt-in is a REQUEST enforced by the tool
// description + the composer-annotation system-prompt note, never a
// per-call human click — see ULTRA_AUTO_TOOLS below and its comment).
//
// Cut U5 scope: the three tools (ultra/ultra_status/ultra_stop) + the
// server-side half of the composer annotation (route.ts's `ultra` wire flag
// -> a system-prompt note the agent reads, doc §4's "message annotation the
// tool reads"). The transcript ANCHOR (doc §6.2) needs no new event type of
// its own here: launching a run already surfaces as an ordinary
// mcp__ultra__ultra tool-call/tool-result pair on the session's existing SSE
// stream (id/name/input/output, exactly like every other tool call route.ts
// already relays) — a future UI reads `output.runId` off that same event to
// open `/api/ultra/[runId]/events`. The authoring-reference skill file (doc
// §4's "single source file in core... injected as a skill") and the
// session-cost usage rollup (doc §4's "folds into the session's per-turn
// usage display") are both OUT of this cut's scope; the tool description
// below carries a condensed version of the authoring guidance instead.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  compileScript,
  getProject,
  getUltraManifest,
  launchUltra,
  readUltraEvents,
  stopUltraRun,
  type AccountProfile,
} from "@telar/core";

// Every ultra tool auto-runs (route.ts adds these, and only these, to
// `allowedTools` for a non-escalation session — see route.ts's mirror of
// LOOM_AUTO_TOOLS). Unlike mcp__loom__start_loom there is no human-gated
// write here to exclude: launching a run is stoppable at any time (Stop /
// ultra_stop), never writes loom state, never reaches `done` on its own, and
// the doc's own opt-in language ("the description forbids reaching for it
// unless the user asked... never infer it") is explicitly a PROMPT-level
// constraint, the same soft gate LOOM_AUTO_TOOLS' draft/propose/read tools
// already rely on — never a "the human's Approve click IS the provenance
// stamp" moat like start_loom/answer_blocked (doc has no such language for
// `ultra`). So: auto-run, gated by the tool description + the composer
// annotation's system-prompt note (route.ts), not an approval card.
export const ULTRA_AUTO_TOOLS = [
  "mcp__ultra__ultra",
  "mcp__ultra__ultra_status",
  "mcp__ultra__ultra_stop",
] as const;

export type UltraMcpOpts = {
  // The project SLUG (route.ts's own `project` request field) — resolved to
  // its manifest root lazily inside the `ultra` handler below, the exact same
  // resolution apps/web/app/api/ultra/route.ts's POST does. Never read from
  // tool input (doc §3: scripts narrow work, never grant capability — the
  // project a script's children run in is always THIS session's own
  // project, not something the model can redirect).
  project: string;
  // The chat's own resolved account profile — Ultra inherits accountEnv
  // dispatch "for free" through the same runner every loom uses (doc §2).
  // Never read from tool input.
  account: AccountProfile;
  // Tool calls always run after the SDK's system:init message, so read this
  // lazily rather than capture it at server-construction time — identical
  // reasoning to loom-mcp.ts's own getSessionId.
  getSessionId: () => string | null;
  // The id of the chat TURN that launches a run — doc §5's
  // UltraManifest.messageId ("sessionId+messageId link the owning chat
  // message"). This app has no id finer-grained than a turn (route.ts's own
  // client-generated per-turn `runId`), so that value is what callers should
  // thread in here.
  getMessageId?: () => string | null;
};

const errResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
const okResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

// Condensed authoring reference (doc §4's fuller "single source file"
// belongs to a later cut — see the file header) — the script format, the
// injected surface, the explicit-model rule, the determinism bans, and one
// worked example, so the agent can write a good script on the first try.
const ULTRA_TOOL_DESCRIPTION = `Launch an ULTRA run: a deterministic fan-out script that spawns real subagents (agent()), fans them out in parallel (parallel()) or per-item (pipeline()), and narrates progress (phase()/log()). Validates synchronously, then returns {runId} IMMEDIATELY — the run detaches and keeps going in the background while you and the user keep talking. Several runs may be live at once. Poll ultra_status(runId) for progress; call ultra_stop(runId) to abort.

ONLY call this when the user explicitly asked for a large orchestrated/parallel run — they said "ultra", or their message is Ultra-annotated (the composer's Ultra chip, noted in your system context for this turn). Never infer it yourself from an ordinary request.

Script format (plain JS — no TypeScript, no imports):
  export const meta = { name, description, phases };  // a PURE object literal, no function calls
  export default async function ({ agent, parallel, pipeline, phase, log, args }) { ... }

The injected surface is the ONLY thing the script can touch:
- agent(prompt, opts) spawns ONE subagent and returns its result, or null if it died (never throws for an ordinary failure). opts.model is REQUIRED on EVERY call — a script with even one model-less agent() call is REJECTED before anything runs, naming the offending call site. Optional opts: label (a short display name), effort (display only), schema (a zod object — forces a validated structured result off emit_result; omit it to get the model's final text instead), isolation (a fresh worktree for a parallel mutator).
- parallel(thunks) runs an array of () => agent(...) thunks concurrently with a barrier; a failed thunk resolves to null in its slot, never rejects the whole run.
- pipeline(items, ...stages) flows each item through every stage independently (no inter-stage barrier); a stage callback gets (prev, item, index) and a throw drops just that item to null.
- phase(title) groups progress into a named section; log(msg) narrates a line. args is whatever JSON value you pass at launch.

Banned inside the script body (throws or is rejected before running): require, import, process, Date / Date.now() / new Date(), Math.random() — no wall-clock, no entropy, no host access; a re-run must be byte-identical. Every child agent() runs NON-INTERACTIVELY under the same fixed tool surface this session has — an action needing approval simply fails that agent() call, it never pauses the run. There is no budget/spend ceiling — bound an open-ended search with loop-until-dry (iterate a queue until it's empty) rather than a count; use an adversarial-verify pattern (a critic agent() checks a builder agent()'s output) for anything you want double-checked.

Worked example:
  export const meta = { name: "rank-files", description: "summarize then rank a set of files", phases: ["summarize", "rank"] };
  export default async function ({ agent, parallel, phase, log, args }) {
    phase("summarize");
    const summaries = await parallel(
      args.files.map((f) => () => agent(\`Summarize \${f} in two sentences.\`, { model: "sonnet", label: f })),
    );
    const ok = summaries.filter(Boolean);
    log(\`\${ok.length}/\${args.files.length} files summarized\`);
    phase("rank");
    return agent(\`Rank these summaries best-to-worst: \${JSON.stringify(ok)}\`, { model: "opus", label: "rank" });
  }`;

const ULTRA_STATUS_DESCRIPTION = `Check an Ultra run's live progress: state (running / done / stopped / failed), cost-visibility spend, and a rollup of settled agents/phases/narration so far — call this to poll a run you launched with \`ultra\` instead of blocking on it. Once state is "done" the response also carries the script's returned result.`;

const ULTRA_STOP_DESCRIPTION = `Abort a live Ultra run: its shared AbortController fires, every in-flight child agent() interrupts, and the run ends state "stopped" with its journal prefix intact (a later resume replays that prefix instantly and runs only what's left live). A no-op (stopped:false) if the run isn't currently live in this process — e.g. already terminal, or the server restarted since it launched.`;

export function createUltraMcpServer(opts: UltraMcpOpts): McpServerConfig {
  return createSdkMcpServer({
    name: "ultra",
    version: "1.0.0",
    tools: [
      tool(
        "ultra",
        ULTRA_TOOL_DESCRIPTION,
        { script: z.string().min(1), args: z.unknown().optional() },
        async ({ script, args }) => {
          // PRE-RUN static reject (doc §4): compileScript is a pure,
          // side-effect-free parse — this runs BEFORE any spend and before
          // launchUltra ever touches disk, and returns the doc's structured
          // {error,kind,detail,line} shape straight back to the AUTHORING
          // AGENT (never the user) so it can re-author on the spot.
          const compiled = compileScript(script);
          if (!compiled.ok) {
            return errResult(
              JSON.stringify(
                { error: compiled.error, kind: compiled.kind, detail: compiled.detail, line: compiled.line },
                null,
                2,
              ),
            );
          }

          let root: string;
          try {
            root = getProject(opts.project).manifest.root;
          } catch {
            return errResult(`Unknown project "${opts.project}".`);
          }

          const result = await launchUltra({
            script,
            args,
            project: root,
            account: opts.account,
            sessionId: opts.getSessionId() ?? undefined,
            messageId: opts.getMessageId?.() ?? undefined,
          });
          // Defense-in-depth: launchUltra's only failure mode today is the
          // SAME compile reject already handled above, but this handler
          // never assumes that stays true forever.
          if (!result.ok) return errResult(result.error);

          return okResult(
            JSON.stringify(
              {
                runId: result.runId,
                meta: result.meta,
                note: "Launched — non-blocking. The run continues in the background; call ultra_status(runId) to poll progress or ultra_stop(runId) to abort.",
              },
              null,
              2,
            ),
          );
        },
      ),
      tool(
        "ultra_status",
        ULTRA_STATUS_DESCRIPTION,
        { runId: z.string().min(1) },
        async ({ runId }) => {
          const manifest = getUltraManifest(runId);
          if (!manifest) return errResult(`No Ultra run found with id "${runId}".`);

          // "journal summary" (doc's own phrase) — a rollup of the run's
          // narrator/progress stream (events.ndjson), which carries the
          // per-agent label/model/ok/cost the raw journal.jsonl itself
          // doesn't (journal.jsonl is a resume cache key, not a progress
          // feed — see journal.ts's header).
          const { events } = readUltraEvents(runId, 0);
          let agentsDone = 0;
          let agentsDead = 0;
          const phases: string[] = [];
          const recentLog: string[] = [];
          for (const e of events) {
            if (e.type === "agent") {
              if (e.ok) agentsDone++;
              else agentsDead++;
            } else if (e.type === "phase") {
              if (phases[phases.length - 1] !== e.title) phases.push(e.title);
            } else if (e.type === "log") {
              recentLog.push(e.msg);
            }
          }

          return okResult(
            JSON.stringify(
              {
                runId: manifest.runId,
                state: manifest.state,
                meta: manifest.meta,
                spend: manifest.spend,
                startedAt: manifest.startedAt,
                updatedAt: manifest.updatedAt,
                agents: { done: agentsDone, dead: agentsDead, total: agentsDone + agentsDead },
                phases,
                recentLog: recentLog.slice(-20),
                ...(manifest.error ? { error: manifest.error } : {}),
                ...(manifest.state === "done" ? { result: manifest.result } : {}),
              },
              null,
              2,
            ),
          );
        },
      ),
      tool(
        "ultra_stop",
        ULTRA_STOP_DESCRIPTION,
        { runId: z.string().min(1) },
        async ({ runId }) => {
          const stopped = stopUltraRun(runId);
          const manifest = getUltraManifest(runId);
          return okResult(JSON.stringify({ runId, stopped, state: manifest?.state ?? "unknown" }, null, 2));
        },
      ),
    ],
  });
}
