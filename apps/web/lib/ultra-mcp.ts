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
  listUltraAgentOrdinals,
  readJournal,
  readUltraAgentTranscript,
  resumeUltraRun,
  readUltraEvents,
  stopUltraRun,
  watchUltraRun,
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
  "mcp__ultra__ultra_inspect",
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

// WHAT A TOOL DESCRIPTION IS FOR, and where the rest of it went (story 4.2).
//
// This used to carry a condensed authoring reference: the script format, a
// walk-through of the injected surface, the explicit-model rule, the determinism
// bans, the quality patterns and one worked example. Story 4.2 built the fuller
// version doc §4 always intended — `@/lib/ultra-authoring`'s
// ULTRA_AUTHORING_REFERENCE — and injects it into every Claude session's
// system-prompt appendix (`@/lib/session-prompts`'s `ultraAuthoring`).
//
// TWO FULL TEXTS WOULD BE A SECOND SOURCE OF TRUTH, which is the failure mode
// `session-prompts.ts`'s own header says that module exists to prevent. So the
// split is by JOB rather than by length:
//
//   THIS STRING KEEPS what decides whether the CALL IS LEGAL — the opt-in rule,
//   the non-blocking contract, the script format, the model requirement (a
//   pre-run rejection), and the determinism bans.
//
//   `@/lib/ultra-authoring` OWNS what decides whether the SCRIPT IS GOOD — the
//   surface API walk-through, the quality patterns and the worked example. Those
//   now arrive in the appendix on every Claude session, so carrying them on the
//   tool schema every turn as well would be paying twice.
//
// EXPORTED (story 4.2) so `ultra-mcp.test.ts` can pin the two sentences the
// composer chip's client half depends on BY IDENTIFIER. The only other way to
// reach the string is `server.instance._registeredTools[…].description` — the
// SDK's private registry, which breaks on an SDK upgrade for no reason.
//
// WHY THE WAITING PROTOCOL IS IN THE DESCRIPTION (story 4.1's AC3 proved this
// file untouched; owner ruling 1 is what authorises the edit). The sentence this
// replaces was "Poll ultra_status(runId) for progress", and it was the textual
// root of a real, observed habit: a guiding agent reads it, finds no
// non-blocking protocol offered, and falls back to sleeping in a background
// shell and re-polling — with tools that are not in BASE_ALLOWED_TOOLS at all,
// so each call can hit a permission gate. The completion wake (story 4.1) has
// been durable and unconditional since it shipped; nothing told the model it
// existed. The anti-pattern is NAMED because a model that is not told what not
// to do invents it.
export const ULTRA_TOOL_DESCRIPTION = `Launch an ULTRA run: a deterministic fan-out script that spawns real subagents (agent()), fans them out in parallel (parallel()) or per-item (pipeline()), and narrates progress (phase()/log()). Validates synchronously, then returns {runId} IMMEDIATELY — the run detaches and keeps going in the background while you and the user keep talking. Several runs may be live at once.

HOW TO WAIT FOR A RUN: you don't. Its outcome is delivered to you AUTOMATICALLY on a later turn, as a COMPLETED ULTRA RUNS block in your context — you do not have to be listening for it, and it survives a server restart. So the correct way to wait for a run is TO END YOUR TURN. Do not sleep in a background shell, do not busy-poll, do not hold the turn open: nothing makes the result arrive sooner, and a turn spent waiting is a turn the user cannot use. Call ultra_status(runId) if the USER asks what a run is doing right now; call ultra_stop(runId) to abort.

ONLY call this when the user explicitly asked for a large orchestrated/parallel run — they said "ultra", or their message is Ultra-annotated (the composer's Ultra chip, noted in your system context for this turn). Never infer it yourself from an ordinary request.

Script format (plain JS — no TypeScript, no imports):
  export const meta = { name, description, phases };  // a PURE object literal, no function calls
  export default async function ({ agent, parallel, pipeline, phase, log, args }) { ... }

opts.model is REQUIRED on EVERY agent() call — a script with even one model-less agent() call is REJECTED before anything runs, naming the offending call site. Your system context for this session carries the full authoring reference: the injected surface API, the quality patterns, and a worked example. Read it there rather than guessing the surface.

Banned inside the script body (throws or is rejected before running): require, import, process, Date / Date.now() / new Date(), Math.random() — no wall-clock, no entropy, no host access; a re-run must be byte-identical. Every child agent() runs NON-INTERACTIVELY under the same fixed tool surface this session has — an action needing approval simply fails that agent() call, it never pauses the run.

RESUMING A RUN. Pass \`resume\` with a runId INSTEAD of \`script\` to continue a run that stopped, failed, or was aborted. Every agent() call that already settled replays from the journal instantly and costs nothing; the run goes live again from the first ordinal that never settled. This is how you recover a partially-completed run — DO NOT re-author the whole script and relaunch, which pays a second time for work that already succeeded.

An agent that DIED is deliberately not journaled, so a resume re-runs exactly the calls that failed and no others. Resume inherits the original run's args and session; it re-resolves the project's guardrails as they are TODAY, not as they were at launch. It refuses a run that is still live — stop it first.

Pass \`resume\` AND \`script\` together for the stop → edit → resume surgery: the longest unchanged prefix of agent() calls still replays, and the first call whose (prompt, opts) changed — plus everything after it — runs live. Same runId, same journal.

Before resuming a run that returned something unexpected, read its journal at TELAR_HOME/ultra/<runId>/journal.jsonl (what each agent actually returned) and its per-agent transcripts at TELAR_HOME/ultra/<runId>/agents/<ordinal>.ndjson (every tool call, and the result subtype that says WHY an agent stopped — error_max_turns means it hit its turn ceiling, and re-running it at the same maxTurns will hit the same wall).`;

const ULTRA_STATUS_DESCRIPTION = `A one-shot SNAPSHOT of an Ultra run, returned immediately: state (running / done / stopped / failed), agents in flight / started / settled, the current phase, the last event's timestamp, and a rollup of phases and narration so far. Once state is "done" it also carries the script's returned result — in full, uncapped.

Reach for it in exactly four cases: the USER asked what a run is doing right now; you need the full text of an outcome the completion wake had to truncate; you are deciding whether to stop it; or you want to register interest in this ONE run (pass watch: true). Calling it in a loop tells you nothing the completion wake will not tell you anyway — the run's outcome reaches you automatically on a later turn.

watch: true records — durably, surviving a server restart — that THIS run is the one you are waiting on, and returns immediately with the same snapshot. It starts nothing, blocks nothing, subscribes to nothing, and it does NOT switch delivery on: every run this session launched is delivered to you anyway. What it changes is that the run you asked about is marked as yours in the COMPLETED ULTRA RUNS block, so you can wait on one named run instead of re-reading the whole session's mailbox. Set it once, then END YOUR TURN.`;

// WHAT THE SNAPSHOT CAN AND CANNOT SEE, stated in the payload rather than left
// for a reader to infer from a zero. Exported so a test can pin it.
export const ULTRA_STATUS_NOTE =
  "This snapshot carries NO cost figure, deliberately: spend is a human-facing readout and there is nothing you can do with it. `updatedAt` moves only at agent settles and at the terminal, because that is when a run's durable record is rewritten. `inFlight`, `started`, `phase` and `lastEventAt` come from the run's own event stream and ARE live. There is no total-agents denominator because the script decides how many agents to spawn as it runs; do not infer progress from a ratio.";

// WHY THIS TOOL EXISTS, and it is a debt being paid rather than a feature.
//
// A run writes journal.jsonl (what each agent RETURNED), agents/<n>.ndjson
// (every tool call it made, and the result subtype saying WHY it stopped),
// manifest.json and script.js. All of it, on disk, for every run. None of it
// was reachable: the only readouts were ultra_status's counts and a narration
// window, so "why did that agent produce nothing" could not be answered at all.
//
// On 2026-08-05 three agents in one run were diagnosed for hours as "hung".
// They had each ended `error_max_turns` — 41, 61 and 61 turns — and said so, in
// these exact files, the whole time. The counts could not show it, and nothing
// could read the files. This tool is that hour back.
const ULTRA_INSPECT_DESCRIPTION = `Read what a run and its agents ACTUALLY did — the durable record, not the live counters.

Call it with runId alone for the ROSTER: every agent ordinal the run has spawned, whether each one settled, what it returned (truncated), what it cost, and why any dead one died. An ordinal that appears here with settled:false either is still working or DIED WITHOUT SETTLING — the roster says which.

Call it with runId AND ordinal for ONE agent: its journal record plus the tail of its transcript — the tools it called, their results, and the harness's own result subtype. That subtype is usually the answer: "error_max_turns" means it ran out of agent turns rather than failing, so RAISING maxTurns is the fix and re-running it unchanged will hit the same wall.

REACH FOR THIS BEFORE GUESSING, and specifically before re-running or re-authoring anything. A run that "returned nothing useful", an agent that came back null, a parallel() stage that produced fewer results than it had thunks — all of those are answered here in one call. Guessing from counts is how an afternoon gets spent on agents that were never stuck.

Reads only this session's own runs.`;

const ULTRA_STOP_DESCRIPTION = `Abort a live Ultra run: its shared AbortController fires, every in-flight child agent() interrupts, and the run ends state "stopped" with its journal prefix intact (a later resume replays that prefix instantly and runs only what's left live). A no-op (stopped:false) if the run isn't currently live in this process — e.g. already terminal, or the server restarted since it launched.`;

// THE TOOLS, EXPORTED — this array is the harness-neutral definition.
//
// `tool()` returns a plain {name, description, inputSchema, handler} record,
// which is structurally the core port's HarnessToolDescriptor, so exporting the
// array is the entire cost of making these reachable from a second harness:
// the Claude path wraps them in createSdkMcpServer exactly as before, and the
// Codex path turns the same records into `dynamicTools` (see harness-tools.ts).
// No handler is defined twice, and there is no second implementation to drift.
export function ultraTools(opts: UltraMcpOpts) {
  return [
      tool(
        "ultra",
        ULTRA_TOOL_DESCRIPTION,
        {
          script: z.string().min(1).optional(),
          args: z.unknown().optional(),
          // RESUME, previously unreachable. `resumeUltraRun` has existed and
          // been guarded since the storage cut — it serves the journal prefix
          // by ordinal, refuses a run that is already live, re-resolves the
          // original project/account off the manifest, and re-applies today's
          // guardrails rather than the ones in force when the run started. None
          // of that was reachable from a session, so the only remedy for a run
          // that died halfway was to author the whole thing again and pay for
          // the work that had already succeeded.
          //
          // That is not hypothetical: a run stopped on 2026-08-05 had two
          // implementation groups committed and its design phase done, and the
          // pickup was hand-written from scratch because there was no way to
          // say "continue that one".
          resume: z.string().optional(),
        },
        async ({ script, args, resume }) => {
          if (!script && !resume) {
            return errResult(
              "Pass `script` to launch a new run, or `resume` with a runId to continue an existing one.",
            );
          }
          // PRE-RUN static reject (doc §4): compileScript is a pure,
          // side-effect-free parse — this runs BEFORE any spend and before
          // launchUltra ever touches disk, and returns the doc's structured
          // {error,kind,detail,line} shape straight back to the AUTHORING
          // AGENT (never the user) so it can re-author on the spot.
          //
          // A bare resume compiles nothing here: the script it will run is the
          // one already persisted for that runId, which compiled at launch.
          // Only an EDITED script arrives with a resume, and that one is
          // rejected on the same terms as a fresh launch.
          const compiled = script ? compileScript(script) : { ok: true as const };
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
          // The project's guardrails travel with its root, from the SAME lookup.
          // THIS is the path a session actually takes (the `ultra` tool), so a
          // miss here would leave the common case unguarded while the HTTP
          // route was covered. Enforced per child by the Ultra PreToolUse hook
          // (packages/core/src/ultra/child-guard.ts).
          let guardrails: { disallowedTools: string[]; protectedPaths: string[] };
          try {
            const manifest = getProject(opts.project).manifest;
            root = manifest.root;
            // DEFENSIVE READ, and the `catch` below is why: it reports "unknown
            // project", so anything that throws inside this block claims the
            // project does not exist. A manifest without a guardrails field is a
            // manifest with nothing to enforce, not a missing project.
            guardrails = {
              disallowedTools: [...(manifest.guardrails?.disallowedTools ?? [])],
              protectedPaths: [...(manifest.guardrails?.protectedPaths ?? [])],
            };
          } catch {
            return errResult(`Unknown project "${opts.project}".`);
          }

          // A RESUME IS GUARDED LIKE A LAUNCH — same root, same guardrails,
          // resolved fresh from the project's CURRENT manifest rather than
          // recovered from the run. `args`, `sessionId` and `messageId` are
          // deliberately not passed: resumeUltraRun reads them off the original
          // manifest, and re-supplying them here would let a resume quietly
          // re-parent a run onto a different session or feed it different args
          // than the journal prefix it is about to replay.
          // A RESUME MAY ONLY REACH THIS SESSION'S OWN RUNS. `resume` is the
          // first tool input that names an EXISTING run, and a runId is just a
          // string — without this, a model could name any run on the machine
          // and replay its journal and its persisted script. The rest of this
          // file's inputs cannot do that by construction (doc §3: scripts
          // narrow work, never grant capability; project and account are read
          // from the server's own opts and never from tool input), and adding
          // the first input that CAN reach outside had to come with the check.
          //
          // Ownership is the manifest's `sessionId`, the same field a resume
          // already inherits. A run with no recorded session is not adoptable
          // either: unowned is not the same as ours.
          if (resume) {
            const manifest = getUltraManifest(resume);
            if (!manifest) return errResult(`Ultra run "${resume}" not found.`);
            const mine = opts.getSessionId();
            if (!mine || manifest.sessionId !== mine) {
              return errResult(
                `Ultra run "${resume}" belongs to a different session and cannot be resumed from here.`,
              );
            }
          }
          const result = resume
            ? await resumeUltraRun(resume, {
                // Undefined means "run the script already persisted for this
                // id" — the ordinary case. A supplied script is the Stop →
                // edit → resume surgery, and re-persists.
                ...(script ? { script } : {}),
                project: root,
                guardrails: { root, guardrails },
                account: opts.account,
              })
            : await launchUltra({
                script: script!,
                args,
                project: root,
                guardrails: { root, guardrails },
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
                // THE STRING THE MODEL READS AT THE MOMENT IT DECIDES WHAT TO DO
                // NEXT, so it carries the same protocol the tool description
                // does — a note that still said "poll progress" here would drive
                // the very next tool call regardless of what the description says.
                note: "Launched — non-blocking. The run continues in the background and its outcome will be delivered to you AUTOMATICALLY on a later turn (a COMPLETED ULTRA RUNS block in your context). The right way to wait is to END YOUR TURN — do not sleep in a background shell and do not busy-poll. To wait on THIS run in particular, call ultra_status(runId, watch: true) once — it returns immediately and marks this run as the one you are waiting on — then end your turn. Call ultra_status(runId) if the user asks what it is doing right now, or ultra_stop(runId) to abort.",
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
        // `watch` is OPTIONAL and defaults to absent rather than to false, so a
        // caller that predates it — or a model that never reads that far — sends
        // the exact same input object it always sent.
        { runId: z.string().min(1), watch: z.boolean().optional() },
        async ({ runId, watch }) => {
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
          // AGENTS IN FLIGHT, from the stream this tool ALREADY reads. The data
          // was here all along — `agent-start` is appended to events.ndjson
          // unconditionally (storage.ts's onEvent), only the MANIFEST write is
          // gated on the settle — and it was being dropped on the floor, so a
          // parallel fan-out that had started and not settled reported an
          // unchanged zero for its whole survey phase.
          const started = new Set<number>();
          const settled = new Set<number>();
          let phase: string | undefined;
          let lastEventAt: number | undefined;
          for (const e of events) {
            if (typeof e.ts === "number") lastEventAt = e.ts;
            if (e.type === "agent") {
              settled.add(e.ordinal);
              if (e.ok) agentsDone++;
              else agentsDead++;
            } else if (e.type === "agent-start") {
              started.add(e.ordinal);
            } else if (e.type === "phase") {
              if (phases[phases.length - 1] !== e.title) phases.push(e.title);
              phase = e.title;
            } else if (e.type === "log") {
              recentLog.push(e.msg);
            }
          }
          // A SET DIFFERENCE, NEVER A SUBTRACTION OF COUNTS, and this is the one
          // thing here that is easy to get wrong and impossible to see
          // afterwards. `agent-start` is NEVER emitted on the cached-replay path
          // (executor.ts returns early before it) while that ordinal's settle IS
          // re-emitted — so on a RESUME `startedCount - settledCount` goes
          // negative, and clamped at zero it would report "nothing in flight"
          // while agents are genuinely burning money. The difference over
          // ORDINALS is exact on both paths.
          let inFlight = 0;
          for (const ordinal of started) if (!settled.has(ordinal)) inFlight++;

          // REGISTER INTEREST IN ONE RUN — the agent-facing half of core's
          // `watchUltraRun`, on the tool the model is already holding.
          //
          // WHY IT IS A FLAG HERE AND NOT A FOURTH TOOL, because the shape is a
          // deviation and a later reader deserves the reason rather than a
          // guess. Owner ruling 1 named a separate `watch_loom`-shaped tool as
          // the PREFERRED shape, and it still is. But a fourth ultra tool NAME
          // cannot be registered without the same commit also editing four
          // count-pinned files that no lane owns — invariants.test.ts's
          // MCP_INVENTORY (compared as an ORDERED list, so registering without
          // the pin reports GAINED and pinning without registering reports
          // LOST), core's ULTRA_AUTO_TOOL_NAMES (without which the tool is
          // silently filtered out of allowedTools at runtime), and the two
          // BASE_ALLOWED_TOOLS counts. There is no ordering of those edits that
          // does not open a red window. A flag on the tool that ALREADY takes
          // exactly this one runId costs none of it: the registered tool-name
          // set is unchanged, so every one of those pins stays green untouched.
          //
          // The capability is identical either way. `watchUltraRun` stamps one
          // timestamp into the run's OWN wake.json and returns: it awaits
          // nothing, registers no callback, declares no bus event, and GATES
          // NOTHING — `pendingUltraWakes` is unconditional per session, so this
          // changes what the appendix SAYS about a run, never whether it is
          // delivered. It also refuses, and writes nothing, for a run belonging
          // to another session.
          const watching = watch === true ? watchUltraRun(opts.getSessionId() ?? "", runId) : undefined;

          return okResult(
            JSON.stringify(
              {
                runId: manifest.runId,
                state: manifest.state,
                meta: manifest.meta,
                // NO `spend` (owner ruling). A guiding agent cannot act on the
                // dollar figure — it does not choose to spend less, and telling
                // it what a run cost only invited it to narrate money at the
                // user, which the transcript screenshots showed it doing. Cost
                // belongs to the surfaces a HUMAN reads: the run pane and the
                // session's own breakdown, both of which project the same
                // ledger this field used to copy. Removed from the payload, not
                // from the manifest — nothing about accounting changed.
                startedAt: manifest.startedAt,
                updatedAt: manifest.updatedAt,
                // UNCHANGED, deliberately: `total` is the SETTLED count
                // (done+dead) and stays that. The new figures ride BESIDE this
                // object rather than inside it, so every existing reader — and
                // every existing assertion — sees exactly what it saw before.
                agents: { done: agentsDone, dead: agentsDead, total: agentsDone + agentsDead },
                // …and the new, live ones. No `expected`/`total-planned`
                // denominator anywhere: a script decides how many agents to
                // spawn as it runs, so a total would be fabricated, which story
                // 4.2's AC11 forbids.
                inFlight,
                started: started.size,
                ...(phase ? { phase } : {}),
                ...(lastEventAt !== undefined ? { lastEventAt } : {}),
                // CONDITIONAL SPREAD, like the two above it: a call that did not
                // ask to watch gets a payload byte-identical to the one it got
                // before this field existed.
                ...(watching ? { watching } : {}),
                note: ULTRA_STATUS_NOTE,
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
      tool(
        "ultra_inspect",
        ULTRA_INSPECT_DESCRIPTION,
        { runId: z.string().min(1), ordinal: z.number().int().min(0).optional() },
        async ({ runId, ordinal }) => {
          const manifest = getUltraManifest(runId);
          if (!manifest) return errResult(`Ultra run "${runId}" not found.`);
          // Same ownership rule as resume, for the same reason: a runId is just
          // a string, and a transcript can contain anything the agent read.
          const mine = opts.getSessionId();
          if (!mine || manifest.sessionId !== mine) {
            return errResult(`Ultra run "${runId}" belongs to a different session.`);
          }

          const journal = readJournal(runId);
          const settled = new Map(journal.map((r) => [r.ordinal, r]));

          if (ordinal === undefined) {
            // THE ROSTER. Joined from two independent sources on purpose: the
            // agents/ directory says who was SPAWNED (a file exists from the
            // first streamed event, so a live agent is visible), the journal
            // says who SETTLED. The difference between those two sets is the
            // question worth asking, and neither file answers it alone.
            const ordinals = listUltraAgentOrdinals(runId);
            const agents = ordinals.map((n) => {
              const rec = settled.get(n);
              return {
                ordinal: n,
                settled: rec !== undefined,
                ...(rec?.deadReason ? { deadReason: rec.deadReason } : {}),
                ...(rec?.costUsd !== undefined ? { costUsd: rec.costUsd } : {}),
                ...(rec?.turns !== undefined ? { turns: rec.turns } : {}),
                ...(rec !== undefined ? { result: preview(rec.result) } : {}),
              };
            });
            const unsettled = agents.filter((a) => !a.settled).map((a) => a.ordinal);
            return okResult(
              JSON.stringify(
                {
                  runId,
                  state: manifest.state,
                  spawned: ordinals.length,
                  settled: journal.length,
                  unsettled,
                  agents,
                  // Said rather than left to be inferred from two numbers, because
                  // inferring it wrongly is exactly what cost a day.
                  note:
                    unsettled.length === 0
                      ? "Every spawned agent settled."
                      : `Ordinals ${unsettled.join(", ")} spawned but never settled — still working, or died without settling. Inspect one with ordinal to see its result subtype.`,
                },
                null,
                2,
              ),
            );
          }

          const transcript = readUltraAgentTranscript(runId, ordinal);
          if (transcript.length === 0 && !settled.has(ordinal)) {
            return errResult(`Ultra run "${runId}" has no agent at ordinal ${ordinal}.`);
          }
          // The LAST result event is the one that says how the agent ended. It
          // is pulled out rather than left for the caller to find in the tail,
          // because it is the single most useful field here and a tail long
          // enough to be useful is long enough to bury it.
          const lastResult = [...transcript].reverse().find((e) => e.type === "result");
          const rec = settled.get(ordinal);
          return okResult(
            JSON.stringify(
              {
                runId,
                ordinal,
                settled: rec !== undefined,
                ...(rec?.deadReason ? { deadReason: rec.deadReason } : {}),
                ...(rec !== undefined ? { result: rec.result } : {}),
                endedWith: lastResult ?? null,
                events: transcript.length,
                // Tail, not head: how it ENDED is the question. Capped because
                // a transcript is unbounded and this goes into a context window.
                tail: transcript.slice(-TRANSCRIPT_TAIL),
              },
              null,
              2,
            ),
          );
        },
      ),
  ];
}

// How many trailing transcript events one inspect returns. Enough to see the
// last few tool calls and the result event that ends them; small enough that
// inspecting three agents does not fill a context window.
const TRANSCRIPT_TAIL = 12;

// A result is arbitrary script data and can be enormous. The roster shows
// enough to recognise which agent is which; `ordinal` gives the full record.
function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export const ULTRA_MCP_VERSION = "1.0.0";

export function createUltraMcpServer(opts: UltraMcpOpts): McpServerConfig {
  return createSdkMcpServer({
    name: "ultra",
    version: ULTRA_MCP_VERSION,
    tools: ultraTools(opts),
  });
}
