// Ultra executor core (doc §3 / §7-U1/U2/U3/U4). Compiles a script
// (sandbox.ts), builds the frozen injected surface, and runs the default
// export as an in-process detached task. Owns the runaway brakes: a run-local
// concurrency semaphore (cap 3, SEPARATE from the process-wide admission gate
// — admission.ts, TELAR_MAX_AGENTS, default 4 — which every schema'd agent()
// call joins by way of the real runner delegating to engine.agent(), see
// runner.ts's header), a
// 1000-agent lifetime backstop, and one AbortController shared into every
// agent() call. Journal + ordinal resume (cut U2): every LIVE agent() call
// appends a journal record keyed by its issue-time ordinal; a re-run of the
// same runId (resumeUltra) replays the matching (prompt,opts) prefix from
// that journal with zero live calls, and runs live from the first ordinal
// whose hash misses (or whose ordinal simply isn't journaled yet) — the
// standard Stop → edit → resume surgery (doc §3). Cut U3: the
// validate-and-retry loop over agent()'s schema (K=2, then null, never a
// control signal) and a real pipeline() (per-item, no inter-stage barrier; a
// throwing stage drops that item to null). Cut U4: the DI default is the REAL
// runner (runner.ts — schema'd calls delegate to engine.agent() itself,
// schema-less calls keep their own SDK query() loop, see runner.ts's header)
// and every settled call's cost/turns are surfaced both into the journal
// record (a resume-time readout, doc §5) and as a new "agent" UltraEvent on
// the run's own event stream (doc §5's events.ndjson taxonomy:
// phase/log/agent/result — "result" is this file's existing "state" event).
import crypto from "node:crypto";
import { z } from "zod";
import type { EngineEvent } from "../engine";
import type { AccountProfile } from "../schemas";
import { compileScript, type ScriptMeta } from "./sandbox";
import type { UltraAgentOpts, UltraSurface, UltraTokens } from "./surface";
import { MissingModel, LifetimeExceeded, BadPrompt, isAbortError, isControlSignal } from "./signals";
import { appendJournal, readJournal, hashCall, type JournalRecord } from "./journal";
import { runUltraAgent, type EngineAgentFn, type UltraRunnerOpts } from "./runner";

// Per-run in-flight cap: no single run holds more than 3 agent() calls at once,
// so a burst of 100 parallel thunks can never starve sibling runs / looms
// (doc §3). A run-local fan-out limit STACKED ON TOP of the process-wide
// admission ceiling (admission.ts), not a competitor to it and never to be
// folded into it: this one bounds one run's share of the fleet, that one bounds
// the whole process.
export const RUN_CONCURRENCY = 3;
// Lifetime backstop: an unbounded loop can't spawn forever (doc §3).
export const LIFETIME_BACKSTOP = 1000;
// Validate-and-retry cap for schema'd agent() calls (doc §3/§7-U3): K TOTAL
// attempts (the first try plus one retry) before an unparseable/never-emitted
// result settles to `null` — an ordinary dead agent, never a control signal.
// One loop for both providers: engine.agent()'s own contract is already "no
// emit = null" (engine.ts's `agent`); this adds the shape check on top so a
// wrong-shaped emit is treated identically to a never-emitted one.
export const VALIDATE_RETRY_K = 2;

// A passthrough schema for the schema-less agent() case. This predates cut
// U4's runner (which now genuinely supports "no schema -> final text", doc
// §3): kept as-is so every already-tested script call site here still gets a
// STRUCTURED { text } result via the forced emit_result path (recon
// reality-check #6, from when this executor only had engine.agent() — which
// always forces a typed emit — to bind to). Not a limitation of the runner
// itself (runner.ts's schema-less branch is real and directly tested there);
// changing this executor-level default is out of scope for U4.
const PASSTHROUGH_SCHEMA = z.object({ text: z.string() });

// The stringification artifacts a prompt can never legitimately need (see the
// guard in agentFn and signals.ts's BadPrompt). Both are what a template
// literal renders for a value the author forgot to unwrap — an agent() result
// object, or the promise of one.
const STRINGIFIED_ARTIFACTS = ["[object Object]", "[object Promise]"] as const;

// A minimal counting semaphore — the acquire/waiters idiom engine.ts used to
// carry inline, kept run-local here so it never touches the process-wide gate.
// (engine.ts no longer holds one at all: its ceiling moved to admission.ts.)
class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.inFlight >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }
  release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }
}

export type UltraState = "running" | "done" | "failed" | "stopped";

// Narrator + lifecycle events for the run stream — doc §5's events.ndjson
// taxonomy is "phase/log/agent/result"; this union's "state" IS that doc's
// "result" (the run's own terminal-lifecycle event, named "state" since cut
// U3 and left as-is here — a naming, not a behavior, gap). "agent" is new in
// cut U4: emitted once per ORDINAL as it settles (cache-hit replay on a
// resume re-emits it too, same as phase/log re-emitting from the cheap
// re-run, doc §3) — the storage layer (U4-B) taps this to roll up
// manifest.json's live `spend` without re-reading every agent transcript.
export type UltraEvent =
  | { type: "phase"; title: string }
  | { type: "log"; msg: string }
  | { type: "state"; state: UltraState }
  // AN ORDINAL HAS BEGUN — new in story 4.2, and the ONLY reason the engine was
  // opened for a UI story. Before it, an agent emitted NOTHING until it settled,
  // so a running agent was invisible on `events.ndjson` and the frozen session-UI
  // contract's per-agent live row had no data source at all. The alternatives
  // were both forbidden: fabricate the row (hard rule 3, "no placebo") or drop a
  // clause of a frozen contract.
  //
  // EMITTED ONCE PER ORDINAL, IMMEDIATELY BEFORE ITS FIRST LIVE ATTEMPT, AND
  // NEVER ON THE CACHED-REPLAY PATH — that path returns early, above, having
  // spent nothing and started nothing. So on a resume a replayed ordinal carries
  // only its `agent` event, and a projection keyed on `ordinal` sees one row
  // either way.
  //
  // IT CARRIES NO `settleId` AND MUST NOT. A settleId names A BILLING, minted at
  // the moment the money is spent; nothing has been spent when this fires, and
  // an id minted here would name a slot (see the `settleId` doc below, which is
  // the record of a money bug repaired three times). Nothing folds, dedupes or
  // bills off this event — it is narration.
  | {
      type: "agent-start";
      ordinal: number;
      label?: string;
      model: string;
      // Display metadata, journaled nowhere else. `UltraAgentOpts` accepts it
      // and the engine deliberately never sees it (see `engineOpts` below and
      // ultra-executor.test.ts's `expect("effort" in seen[0]!).toBe(false)`),
      // so before story 4.2 it was accepted and then dropped on the floor. The
      // rail's `model·effort` chip is the first reader it has ever had.
      effort?: string;
    }
  | {
      type: "agent";
      ordinal: number;
      label?: string;
      model: string;
      // Same field, same reason, on the settle event — so a reader that joined
      // the stream after an ordinal started (the anchor's SSE tail opens
      // mid-run) still gets the chip. Still NOT passed to the engine.
      effort?: string;
      ok: boolean; // result !== null — a dead agent (exhausted retries) is ok:false, never a run failure
      costUsd?: number;
      turns?: number;
      // What this settle actually consumed, as the provider reported it.
      // ABSENT means "not reported" and must never be rendered as a confident
      // zero — see the capture site's note.
      tokens?: UltraTokens;
      // THE BILLING IDENTITY OF THIS SETTLE — a unique id MINTED AT THE MOMENT
      // THE MONEY IS SPENT (`crypto.randomUUID()`, the live-settle path below),
      // written onto that settle's journal record, and re-presented VERBATIM by
      // every later replay of that record. The ledger key storage.ts builds out
      // of it therefore names this one billing and nothing else.
      //
      // WHY IT EXISTS — A KEY MUST NAME A BILLABLE EVENT, NOT A SLOT. The
      // ledger key was (runId, ordinal), and an ordinal is a SLOT: a per-run
      // counter reset to 0 on every re-run (`ctl.issued` below), so one name
      // covered every call that ever occupied that position. A resume genuinely
      // re-runs — and the provider genuinely re-bills — both the call a human
      // rewrote AND, because `cacheValid` is a one-way latch, every later
      // ordinal after the first miss. Keyed on the slot, the fold consumed the
      // FIRST of those billings and dropped every later one. The ledger's write
      // path suppresses nothing, so those rows ARE on disk — but a row that
      // repeats a key is exactly what an honest re-presentation of one settle
      // looks like, so no projection over the file (manifest.spend, a charter's
      // budget-left) counts it, and nothing anywhere reports a loss.
      //
      // WHY MINTED AND NOT COUNTED — the obvious repair, numbering the settles
      // 1,2,3… off the journal, is the same bug one level down. That number is
      // a TALLY OF EXISTING RECORDS, and a tally is not an identity: it
      // REGRESSES when one journal line is lost to mid-file corruption
      // (journal.ts skips a malformed line BY DESIGN, "so one corrupt record
      // doesn't blind resume to every record after it"), and it COLLIDES when
      // two processes resume one runId, because both scan before either
      // appends. Either way a later live settle re-mints a key the ledger
      // already holds and its cost is dropped — silently, and strictly worse
      // than never deduping at all. A minted id cannot regress, cannot collide,
      // and needs no coordination between writers.
      //
      // WHY NOT `hash`: hashCall is over the SCRIPT-FACING (prompt, opts), so
      // it discriminates an EDIT and nothing else. The plain
      // retry-after-failure resume — the latch re-running a later ordinal whose
      // prompt/opts never changed — hashes IDENTICALLY to the billing that
      // already folded, so a hash-keyed row would still drop that money.
      //
      // A REPLAY NEVER MINTS: it reads the id back out of the record it is
      // serving. That is what stops a resume from re-billing an ordinal that
      // already has its row, and equally what lets a replay REPAIR a settle
      // whose live ledger write failed.
      settleId: string;
      // True when this event is a RESUME REPLAY served from the journal — the
      // call was not re-made and was not re-billed by the provider; `costUsd`
      // here is the ORIGINAL live call's journaled cost, replayed verbatim.
      // Absent on a live settle.
      //
      // It is NOT a "skip the ledger" flag. The keyed ledger row IS re-written
      // on every replay, deliberately: storage.ts's launch() onEvent is the
      // sole writer, and it logs the entryKey
      // `ultra:<runId>:<ordinal>:<settleId>` for a live settle and for a cache
      // replay alike, while usage-ledger.ts's
      // fold consumes a non-empty entryKey AT MOST ONCE over the FILE. A
      // re-record therefore folds to nothing, while REPAIRING an ordinal whose
      // live write failed — appendJournal below runs strictly BEFORE
      // opts.onEvent, so a live settle can end up journaled-with-cost yet
      // ledger-less, and the replay is the only chance to close that gap.
      // Additive optional field on an append-only narration stream; nothing
      // gates on it — it is the durable record that this settle was a replay.
      cached?: true;
    };

export type UltraRunResult = {
  runId: string;
  state: Exclude<UltraState, "running">;
  meta: ScriptMeta;
  result?: unknown;
  error?: string;
};

export type UltraRun = {
  runId: string;
  meta: ScriptMeta;
  state: () => UltraState;
  stop: () => void;
  finished: Promise<UltraRunResult>;
};

export type StartUltraOpts = {
  runId?: string;
  args?: unknown;
  // DI seam — defaults to the REAL runner (runner.ts's runUltraAgent, cut
  // U4); tests pass a canned fn instead (no live SDK).
  agent?: EngineAgentFn;
  // The project root every child agent() call runs in (doc §3: writes
  // confined to the project root, or the opts.isolation worktree — the
  // latter not yet wired, surface.ts). Falls back to the runner's own
  // process.cwd() default when omitted (tests / a script with no real
  // project).
  project?: string;
  // Routes every child agent() call's env exactly like a loom's agent()
  // (doc §2 — Ultra inherits accountEnv dispatch "for free"). Absent = the
  // provider's base login (engine.ts's accountEnv semantics).
  account?: AccountProfile;
  // Narrator/lifecycle sink (phase/log/state/agent).
  onEvent?: (e: UltraEvent) => void;
  // Per-ordinal transcript tap — the engine EngineEvent stream for agent
  // `ordinal`, tagged with `attempt` (1-based, doc §3/§7-U3 validate-and-retry)
  // so a retried call's events never blur into one ambiguous stream: each
  // event carries the attempt that produced it, and the highest `attempt`
  // seen is the terminal one for that ordinal (its `result` event is the one
  // that decided the ordinal's outcome). Wired to agents/<ordinal>.ndjson in
  // cut U4.
  onAgentEvent?: (ordinal: number, e: EngineEvent, attempt: number) => void;
};

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
// Exported (cut U4) so storage.ts's launchUltra can mint a runId BEFORE
// calling startUltra — it needs the id up front to build the manifest/event
// persistence closures that startUltra's own onEvent/onAgentEvent callbacks
// close over, so the id can't be discovered only after the fact.
export const newUltraRunId = () => `u-${crypto.randomBytes(6).toString("hex")}`;

const errText = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

// Per-run mutable control state.
type RunControl = {
  readonly runId: string;
  readonly abort: AbortController;
  readonly sem: Semaphore;
  issued: number; // monotonic ordinal + lifetime counter (issued at call time)
  // Resume cache (doc §3): records already on disk for this runId, keyed by
  // ordinal. `cacheValid` is a one-way latch — true until the first ordinal
  // whose hash misses (script edited there, or this ordinal was never
  // journaled), after which EVERY later ordinal runs live even if its old
  // record would still hash-match by coincidence. This is what makes resume a
  // PREFIX replay, not an independent per-call cache.
  readonly journal: Map<number, JournalRecord>;
  // PRE-settleId RECORDS ONLY: how many journal records each ordinal has ON
  // DISK, out of the same scan that built `journal` above. A record written
  // before `settleId` existed carries no billing identity, so a replay of it
  // falls back to the key its live settle actually wrote at the time —
  // `ultra:<runId>:<ordinal>:<count>`, which that older code derived from
  // exactly this tally — and so still dedupes against the row already on the
  // ledger. NOTHING LIVE READS IT: every live settle mints its own id, so the
  // tally's failure modes (a skipped corrupt line makes it regress; two
  // concurrent processes make it collide) can no longer drop a billing. At
  // worst they mis-key a REPLAY, whose money is already on the ledger or was
  // already lost by the write this replay was trying to repair.
  readonly legacyCounts: Map<number, number>;
  cacheValid: boolean;
};

// Build the frozen surface for one run. The agent()/parallel() wrappers are
// closures over the run control so the caps, the backstop, and the shared
// AbortController all apply uniformly.
function buildSurface(ctl: RunControl, opts: StartUltraOpts): UltraSurface {
  const agentFn = async (prompt: string, uOpts: UltraAgentOpts): Promise<unknown> => {
    // model is REQUIRED — a control signal, never coerced to the engine default.
    if (!uOpts || typeof uOpts.model !== "string" || uOpts.model === "") {
      throw new MissingModel(uOpts?.label);
    }
    // THE PROMPT MUST BE A USABLE STRING, and this is the ONLY position that
    // makes "fails before any ordinal is issued and before any spend" literally
    // true rather than approximately true: it is before `ctl.issued++` (so no
    // ordinal is burned), before `hashCall` (so no journal/resume-cache key is
    // minted), before the cache lookup, and before the live path entirely. It
    // is ALSO before `const schema = uOpts.schema ?? PASSTHROUGH_SCHEMA` below,
    // which is what makes it cover the schema and schema-less paths by
    // construction rather than by two copies of the same check.
    //
    // "[object Promise]" is here for the same authoring bug one step earlier — a
    // missing `await` on an agent() call interpolated into a template literal —
    // and it is equally unrecoverable and equally invisible today.
    //
    // NO empty/whitespace rule: `${undefined}` renders "undefined", not "", so an
    // empty prompt is a different (and un-complained-about) thing.
    if (!uOpts.allowStringifiedObject) {
      if (typeof prompt !== "string") {
        throw new BadPrompt(`a ${typeof prompt} prompt — agent() takes a string`, uOpts.label);
      }
      const artifact = STRINGIFIED_ARTIFACTS.find((a) => prompt.includes(a));
      if (artifact) {
        throw new BadPrompt(
          `a prompt containing "${artifact}" — an agent() result is an OBJECT (the default ` +
            `schema is z.object({ text }), so even a schema-less call resolves to { text }), and ` +
            `interpolating one into a template literal stringifies it away. Read the field you ` +
            `want (e.g. result.text) before interpolating. If the artifact is genuinely part of ` +
            `text you meant to send — an upstream agent quoting a log line, say — pass ` +
            `{ allowStringifiedObject: true } on this call`,
          uOpts.label,
        );
      }
    }
    // Lifetime backstop, checked at ISSUE time (deterministic ordinal order).
    if (ctl.issued >= LIFETIME_BACKSTOP) throw new LifetimeExceeded(LIFETIME_BACKSTOP);
    const ordinal = ctl.issued++;
    // The cache-validity check (doc §3) — hashed over the SCRIPT-FACING
    // (prompt, opts) only, before engine-internal fields (abort, onEvent) are
    // added below, so it is stable across re-runs with a fresh AbortController.
    const hash = hashCall(prompt, uOpts);

    if (ctl.cacheValid) {
      const cached = ctl.journal.get(ordinal);
      if (cached && cached.hash === hash) {
        // Cache-hit replay still narrates (doc §3: "phase/log re-emit from
        // the cheap re-run") — the rail's agent roster must look the same on
        // a resume as it did live, cost/turns included.
        opts.onEvent?.({
          type: "agent",
          ordinal,
          ...(uOpts.label ? { label: uOpts.label } : {}),
          model: uOpts.model,
          // Read off THIS run's opts, not off the journal record — a resume
          // re-runs the script, so the call that hash-matched supplied it again.
          // The journal has never carried it and this story does not add it
          // there: `effort` is display metadata, not part of a settle's identity.
          ...(uOpts.effort ? { effort: uOpts.effort } : {}),
          ok: cached.result !== null,
          ...(cached.costUsd !== undefined ? { costUsd: cached.costUsd } : {}),
          ...(cached.turns !== undefined ? { turns: cached.turns } : {}),
          // The id this settle WAS BILLED UNDER, read back out of the record —
          // never re-minted. A replay spends nothing, so it must re-present the
          // key its own live settle already wrote (or would have written, had
          // that write not failed — that is the repair). A record from before
          // `settleId` existed has none, and only such a record takes the
          // count-derived key the older code used for it (RunControl's
          // `legacyCounts`). The `?? 0` is unreachable — the same scan that
          // produced `cached` counted it — and "0" is the safe way to be wrong
          // anyway: it collides with no minted id and with no legacy count
          // (those start at 1), so a stray replay would append a visible extra
          // row rather than silently fold real money away.
          settleId: cached.settleId ?? String(ctl.legacyCounts.get(ordinal) ?? 0),
          // Re-presented from the record, exactly as costUsd/turns are. A
          // replay that dropped this would make a resumed run's rows report
          // "not reported" for work whose usage was measured the first time.
          ...(cached.tokens !== undefined ? { tokens: cached.tokens } : {}),
          // Replayed: not re-made, not re-billed by the provider. This does
          // NOT suppress the ledger write — storage.ts re-records this
          // settle's keyed row (`ultra:<runId>:<ordinal>:<settleId>`) on every
          // replay so a settle whose LIVE write failed self-heals; the fold's
          // at-most-once entryKey dedupe is what stops the double-count. See
          // the field's doc on UltraEvent above.
          cached: true,
        });
        return cached.result; // served from the journal — no spawn (doc §3)
      }
      ctl.cacheValid = false; // first miss invalidates this AND every later ordinal
    }

    // THIS ORDINAL IS ABOUT TO RUN LIVE (story 4.2). Every early return above is
    // a cache replay that spends nothing and starts nothing, so this is the
    // first statement on the live path and therefore the honest place to say
    // "begun". It precedes `engineOpts`, `runOnce` and the retry loop
    // deliberately: the rail's row must exist for the whole time the agent is
    // working, not from the moment the first engine event happens to arrive.
    //
    // `effort` rides the EVENT and still never reaches `engineOpts` below — that
    // asymmetry is the child posture NFR-UW-4 fixes and
    // `ultra-executor.test.ts`'s `expect("effort" in seen[0]!).toBe(false)` pins
    // it. Emitting it here does not change what the child is told; it changes
    // what the human is shown.
    opts.onEvent?.({
      type: "agent-start",
      ordinal,
      ...(uOpts.label ? { label: uOpts.label } : {}),
      model: uOpts.model,
      ...(uOpts.effort ? { effort: uOpts.effort } : {}),
    });

    // Only the doc's allowed opts reach the engine. `phase` stays journaled
    // display metadata; isolation → worktree in a later cut.
    //
    // `effort` NOW REACHES THE MODEL, and until this change it did not. The
    // original note here read "effort/phase are journaled display metadata (no
    // SDK field)" — true of the SDK it was written against, and false since:
    // the chat route hands `effort` to the same `query()` options for every
    // session turn. An Ultra script could therefore ask for an effort, see it
    // rendered on the agent's chip, and get a model that was never told —
    // a control that displayed and did nothing.
    const schema = uOpts.schema ?? PASSTHROUGH_SCHEMA;
    // Mutable — set at the top of each retry-loop iteration below, before
    // `runOnce` fires the engine call, so the SAME `engineOpts.onEvent` closure
    // (reused verbatim across every attempt) can still tag each forwarded
    // event with the attempt that produced it. Without this, attempt 1's and
    // attempt 2's full event streams — including each one's own `result`
    // event — land in the same ordinal bucket with no marker of where one
    // attempt ends and the next begins.
    let attempt = 1;
    // The LAST attempt's settled cost/turns (doc §3 "cost visibility" / §5
    // journal record) — a retry's earlier attempts are discarded work, so
    // only the surviving attempt's spend is what actually happened from the
    // run's point of view; overwritten every time a "result" event lands.
    let lastCostUsd: number | undefined;
    let lastTurns: number | undefined;
    // The provider's usage split for this attempt, captured from the same
    // one-shot `result` event `costUsd` comes from. ONE FIELD, not four loose
    // ones: it travels together onto the journal record and the settle event,
    // and a partial object is how a reader ends up printing an input count with
    // no output count beside it.
    let lastTokens: UltraTokens | undefined;
    const engineOpts: UltraRunnerOpts = {
      schema,
      model: uOpts.model,
      // THE LINE THAT MAKES `effort` REAL — see the note above `schema`.
      ...(uOpts.effort ? { effort: uOpts.effort } : {}),
      ...(uOpts.label ? { label: uOpts.label } : {}),
      ...(opts.project ? { cwd: opts.project } : {}),
      ...(opts.account ? { account: opts.account } : {}),
      abort: ctl.abort,
      onEvent: (e: EngineEvent) => {
        if (e.type === "result") {
          lastCostUsd = e.costUsd;
          lastTurns = e.turns;
          // ABSENT STAYS ABSENT. A provider that reported no usage at all leaves
          // this undefined rather than becoming four zeroes, so a reader can
          // tell "spent nothing" apart from "never told us" — the same
          // distinction `costUsd` already keeps by being optional.
          lastTokens =
            e.inputTokens === undefined &&
            e.outputTokens === undefined &&
            e.cacheReadTokens === undefined &&
            e.cacheCreateTokens === undefined
              ? undefined
              : {
                  input: e.inputTokens ?? 0,
                  output: e.outputTokens ?? 0,
                  cacheRead: e.cacheReadTokens ?? 0,
                  cacheCreate: e.cacheCreateTokens ?? 0,
                };
        }
        opts.onAgentEvent?.(ordinal, e, attempt);
      },
    };

    // One live engine call. The semaphore is acquired/released PER ATTEMPT (not
    // held across a retry) so a retry contends for a fresh slot like any other
    // call — a schema'd call (the only kind this executor ever issues, via
    // PASSTHROUGH_SCHEMA above) is routed by the real runner (runner.ts)
    // through engine.agent() itself, which self-acquires the shared admission
    // slot (admission.ts, class "ultra") on top of this run-local cap.
    const runOnce = async (p: string): Promise<unknown> => {
      await ctl.sem.acquire();
      try {
        return await (opts.agent ?? runUltraAgent)(p, engineOpts);
      } finally {
        ctl.sem.release();
      }
    };

    // Validate-and-retry (doc §3/§7-U3): a call that never emits (engine
    // contract: null) and a call that emits the WRONG SHAPE are the same
    // failure from Ultra's view — both retry, appending the validation error to
    // the ORIGINAL prompt (never chained, so a K=2 run never grows the prompt
    // more than once) up to VALIDATE_RETRY_K total attempts, then settle to
    // `null` — an ordinary dead agent, never a control signal (never ends the
    // run).
    let result: unknown = null;
    let attemptPrompt = prompt;
    for (attempt = 1; attempt <= VALIDATE_RETRY_K; attempt++) {
      result = await runOnce(attemptPrompt);
      const parsed = schema.safeParse(result);
      if (parsed.success) break;
      if (attempt < VALIDATE_RETRY_K) {
        const detail =
          result === null
            ? "no structured result was ever emitted (emit_result was not called)"
            : parsed.error.message;
        attemptPrompt = `${prompt}\n\n[Ultra retry ${attempt}/${VALIDATE_RETRY_K}] Your previous attempt failed schema validation: ${detail}. Call emit_result again with a result matching the required schema.`;
      } else {
        result = null; // exhausted — dead agent, per the engine's own null contract
      }
    }
    // This live call IS a new billable event even when an earlier run already
    // billed this same ordinal: `cacheValid` latched false above, so the
    // provider really re-ran it and really re-billed it. So MINT ITS IDENTITY
    // HERE, at the moment the money is spent — not from the ordinal, not from
    // the attempt, not from a tally of anything on disk (see
    // UltraEvent.settleId) — and carry it on the record so every later replay
    // of THIS settle re-presents THIS id.
    const settleId = crypto.randomUUID();
    // Only a LIVE call ever appends — a cache hit above already returned. A
    // thrown call (ordinary failure, abort, control signal) never reaches here,
    // so it is simply never cached and re-runs live on the next resume.
    appendJournal(ctl.runId, {
      ordinal,
      hash,
      result,
      settleId,
      ...(lastCostUsd !== undefined ? { costUsd: lastCostUsd } : {}),
      ...(lastTurns !== undefined ? { turns: lastTurns } : {}),
      // Journaled beside the cost so a RESUME re-presents the same token figure
      // it re-presents the same cost — a cached replay that dropped tokens would
      // make a resumed run's rows read as "never reported" for work that was
      // measured the first time round.
      ...(lastTokens !== undefined ? { tokens: lastTokens } : {}),
    });
    opts.onEvent?.({
      type: "agent",
      ordinal,
      ...(uOpts.label ? { label: uOpts.label } : {}),
      model: uOpts.model,
      ...(uOpts.effort ? { effort: uOpts.effort } : {}),
      ok: result !== null,
      ...(lastCostUsd !== undefined ? { costUsd: lastCostUsd } : {}),
      ...(lastTurns !== undefined ? { turns: lastTurns } : {}),
      ...(lastTokens !== undefined ? { tokens: lastTokens } : {}),
      settleId,
    });
    return result;
  };

  // Our OWN parallel — engine.ts's `parallel` swallows AbortError /
  // MissingModel to null; here the control-signal carve-out re-throws them so a
  // Stop / model-contract breach / backstop terminates the run past the barrier.
  const parallelFn = <T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> =>
    Promise.all(
      thunks.map((t) =>
        t().catch((e) => {
          if (isControlSignal(e)) throw e;
          return null; // ordinary agent failure → dead-agent null
        }),
      ),
    );

  // Per-item pipeline (doc §3/§7-U3): each item flows ALL stages independently
  // — no inter-stage barrier, so item A can be in stage 3 while item B is still
  // in stage 1. A stage callback gets (prev, originalItem, index). A throwing
  // stage drops that item to `null` and skips its remaining stages (same
  // control-signal carve-out as parallelFn above — Stop/MissingModel/lifetime
  // backstop propagate past a stage, never coerced to null). Every stage's own
  // agent() calls flow through agentFn above, so they get the same per-run
  // concurrency cap, journal/resume, and validate-and-retry as any other call.
  const pipelineFn = (items: unknown[], ...stages: unknown[]): Promise<unknown> =>
    Promise.all(
      items.map(async (originalItem, index) => {
        let prev: unknown = originalItem;
        for (const stage of stages) {
          try {
            prev = await (stage as (p: unknown, item: unknown, i: number) => unknown)(prev, originalItem, index);
          } catch (e) {
            if (isControlSignal(e)) throw e;
            return null; // a throwing stage drops the item to null, skips remaining stages
          }
        }
        return prev;
      }),
    );

  return Object.freeze({
    agent: agentFn,
    parallel: parallelFn,
    pipeline: pipelineFn,
    phase: (title: string) => opts.onEvent?.({ type: "phase", title }),
    log: (msg: string) => opts.onEvent?.({ type: "log", msg }),
    args: opts.args,
  });
}

// A run that is already terminal (compile reject) with a resolved promise.
function terminalRun(runId: string, meta: ScriptMeta, result: UltraRunResult): UltraRun {
  return { runId, meta, state: () => result.state, stop: () => {}, finished: Promise.resolve(result) };
}

// Compile + start a detached run. Returns immediately (non-blocking, doc §4);
// callers await `finished` for the terminal result. A compile reject returns a
// run already `failed` — the validation-error return path (fleshed out in U5).
export function startUltra(code: string, opts: StartUltraOpts = {}): UltraRun {
  const runId = opts.runId ?? newUltraRunId();
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid ultra runId: ${JSON.stringify(runId)}`);

  const compiled = compileScript(code);
  if (!compiled.ok) {
    return terminalRun(runId, {}, { runId, state: "failed", meta: {}, error: compiled.error });
  }

  // ONE scan of the journal builds BOTH maps, so they can never disagree about
  // which record is an ordinal's last one: `journal` keeps that last record
  // (readJournalMap's own rule, restated here rather than called, because the
  // count below has to come out of the SAME pass), and `legacyCounts` counts
  // how many records that ordinal has — read ONLY when the record being
  // replayed predates `settleId` (RunControl). An ordinal legitimately has more
  // than one record: every run that re-runs it LIVE appends another. Both maps
  // are empty on a genuinely fresh runId — the cache-check then misses on
  // ordinal 0 and every call simply runs live, appending as it goes. A runId
  // that already has a journal on disk (this IS what resume means, §3) preloads
  // it here — start and resume are the same code path.
  const journal = new Map<number, JournalRecord>();
  const legacyCounts = new Map<number, number>();
  for (const rec of readJournal(runId)) {
    journal.set(rec.ordinal, rec);
    legacyCounts.set(rec.ordinal, (legacyCounts.get(rec.ordinal) ?? 0) + 1);
  }

  const ctl: RunControl = {
    runId,
    abort: new AbortController(),
    sem: new Semaphore(RUN_CONCURRENCY),
    issued: 0,
    journal,
    legacyCounts,
    cacheValid: true,
  };
  const surface = buildSurface(ctl, opts);

  let state: UltraState = "running";
  const settle = (next: Exclude<UltraState, "running">, extra?: Partial<UltraRunResult>): UltraRunResult => {
    state = next;
    opts.onEvent?.({ type: "state", state: next });
    return { runId, state: next, meta: compiled.meta, ...extra };
  };

  const finished = (async (): Promise<UltraRunResult> => {
    try {
      const result = await Promise.resolve(compiled.run(surface));
      return settle("done", { result });
    } catch (e) {
      // Stop → stopped (journal prefix kept). MissingModel / LifetimeExceeded /
      // any other throw → failed (never swallowed to a null result).
      if (isAbortError(e)) return settle("stopped");
      return settle("failed", { error: errText(e) });
    }
  })();

  return { runId, meta: compiled.meta, state: () => state, stop: () => ctl.abort.abort(), finished };
}

// Resume: re-run a (possibly edited) script under a runId that already has a
// journal on disk. Ordinal `i` is served from the journal instantly iff its
// stored hash still matches call `i` of THIS re-executed script; the first
// mismatch (or an ordinal simply missing from the journal — e.g. a crash
// mid-append) invalidates it and every later ordinal, which then run live
// (doc §3). Concretely the same code path as startUltra with a pinned runId —
// "resume" IS "start again with the same id" once a journal exists; the
// separate name matches the doc's `resume(runId)` verb and the future
// `/api/ultra/[id]/resume` route (U4, which will also persist+recall the
// script text itself so a bare id round-trips without the caller re-supplying
// `code`).
export function resumeUltra(runId: string, code: string, opts: Omit<StartUltraOpts, "runId"> = {}): UltraRun {
  return startUltra(code, { ...opts, runId });
}
