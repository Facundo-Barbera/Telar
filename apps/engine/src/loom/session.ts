/**
 * THE REAL `LoomSessionPort` — how the loom reaches Telar sessions, replacing
 * the refusal `daemon.ts` shipped in its place.
 *
 * ── TWO KINDS OF SESSION, AND THE DIFFERENCE IS THE DESIGN (§16) ────────────
 * `start` makes a WORKER: headless, disposable, scoped to one item, cut into its
 * own checkout so its diff is attributable to that item and nothing else. It is
 * given the brief as its first and only turn and then nobody talks to it again.
 *
 * `create` makes the ORCHESTRATOR CONVERSATION: a normal Telar session pinned to
 * the project's OWN ROOT, with a transcript, which is the human's counterpart
 * for setup, dry runs and correcting the Program. It reads and proposes; it
 * never implements. Pinning it to a worktree would have it describing a private,
 * hours-stale copy of the project it is supposed to be talking about.
 *
 * The two are separate verbs rather than one with a flag because every property
 * above differs between them, and a flag would make "which one is this" a thing
 * you work out from a call site.
 *
 * ── `status` IS THE WHOLE OF DONE-DETECTION (§4) ────────────────────────────
 * The orchestrator dies every tick. Nothing survives it but files, so tick N+1
 * re-derives what tick N dispatched — and the ONE question it has to answer
 * about a `working` loom is whether that worker is still alive. Get it wrong in
 * one direction and a finished worker is waited on forever; wrong in the other
 * and a live worker is gated mid-edit and its item dispatched again.
 *
 * DERIVED FROM THE SESSION STORE AND NOTHING ELSE. §4 decided against a
 * heartbeat file for the reason `dispatch.ts` states: the store already knows,
 * and a second source of truth exists only to disagree with the first at 4am.
 * So the answer is read from the queue the worker itself transitions, with the
 * journal as corroboration — two views of one file set, which cannot diverge.
 *
 * ── WHY THIS BYPASSES `worker_unavailable`, AND WHY THAT IS FINE ────────────
 * `daemon.ts:2005-2006` answers `POST /turns` with a 503 `worker_unavailable`
 * when no worker has registered — a courtesy to a human typing into a cockpit
 * with nothing to run their message. THAT CHECK IS ON THE HTTP PATH ONLY. This
 * port is in-process and calls `store.submitTurn` directly, so it walks past it,
 * and that is deliberate: a loom dispatched at 3am must queue its brief whether
 * or not a worker happens to be registered in that instant. The turn sits
 * `queued` and the first worker to appear claims it. Surprising enough to be
 * worth stating; the alternative is a night's work refused because a worker was
 * mid-restart.
 *
 * WHAT THAT COST, AND WHERE IT IS PAID. Queueing into a void is only defensible
 * if the void is REPORTABLE, and for a while it was not: `status` answered
 * `running` for a turn nothing had claimed, so with no worker process alive a
 * dispatched loom sat `working` indefinitely and every surface drew the project
 * as healthy. The queueing stays; the misreport does not. `status` now answers
 * `unclaimed` for that exact state and `dispatch.ts` bounds how long it may
 * last. A human must always be able to tell "nothing to do" from "nothing can
 * be done".
 *
 * ── ONE CHECKOUT PER LOOM, AND THE SESSION ADOPTS IT ────────────────────────
 * This used to be the file's one open seam, and the failure it produced was
 * quiet in four directions: `createSession({ envMode: "worktree" })` cut its OWN
 * checkout on `telar/<sessionId>` off project HEAD, so the worker never saw the
 * worktree `provisionLoom` had prepared. The Program's `setup` ran where nobody
 * worked; the branch `publish` pushes never received a commit; the gate counted
 * commits in the loom's worktree, found none, and reported a finished worker as
 * one that did nothing — `stuck` at rung 1, forever; and each loom cost two
 * checkouts against a RAM ceiling derived from one.
 *
 * IT IS CLOSED BY ADOPTION RATHER THAN BY MOVING THE CUT. `provisionLoom` still
 * owns the worktree — it is the only place that knows the Program's branch name,
 * its base, and that `setup` must run before a worker touches the tree — and
 * `createSession` now takes that prepared workspace, validates it, records it,
 * and marks it as NOT the session's to reap. The store cutting it instead would
 * have had to learn the Program, and the loom would have had to run `setup`
 * after the brief was already queued.
 *
 * `store.archiveSession` therefore leaves the checkout alone for a worker: the
 * gate reads commits out of it after the worker has ended. Whoever cut it owns
 * it. That is what `SessionWorkspace.adopted` records.
 */
import path from "node:path";
import crypto from "node:crypto";
import type { Session, TurnState } from "@telar/engine-client";
import { EngineStateError, type EngineStore } from "../state";
import type { LoomSessionPort } from "./dispatch";

/**
 * A TURN THAT HAS NOT SETTLED — the liveness signal.
 *
 * `queued` COUNTS AS ALIVE and that is the load-bearing entry: a brief waiting
 * for a worker to claim it has not failed, it has not finished, and reporting it
 * as done would gate an empty worktree and stick the loom seconds after
 * dispatching it.
 */
const IN_FLIGHT = new Set<TurnState>(["queued", "claimed", "running"]);

/**
 * A TURN THAT ENDED — the completion signal, and the same set the web app treats
 * as the end of a turn (`apps/web/lib/engine/session-sync.ts:16`). Enumerated
 * from that list rather than inferred, so a new terminal state has exactly one
 * place to be added on both sides.
 */
const TURN_ENDED = new Set<string>(["turn.completed", "turn.failed", "turn.stopped", "turn.ambiguous", "turn.discarded"]);

export type LoomSessionPortDeps = {
  store: EngineStore;
  /** The turn's idempotency key. Injected so a test can name it instead of
   *  matching a uuid, and so a retry could be made replayable later. */
  runId?: () => string;
};

export function createLoomSessionPort(deps: LoomSessionPortDeps): LoomSessionPort {
  const { store } = deps;
  const newRunId = deps.runId ?? (() => `run_${crypto.randomUUID().replaceAll("-", "")}`);

  const submit = (sessionId: string, prompt: string, what: string): void => {
    try {
      store.submitTurn(sessionId, { runId: newRunId(), input: prompt });
    } catch (error) {
      /**
       * A SESSION WITH NO TURN IS A WORKER THAT WILL NEVER START, and it would
       * sit in the deck as `working` until something reaped it. Archiving ends
       * the session and LEAVES THE CHECKOUT — it is the loom's, not this
       * session's, and `provisionLoom`'s next attempt reuses it. Best-effort,
       * because failing to clean up must not replace the sentence that says
       * what actually went wrong.
       */
      try {
        store.archiveSession(sessionId);
      } catch {
        // Already gone, or holding something. The message below is the point.
      }
      throw new Error(
        `${what} was created but its first turn could not be queued, so nothing would ever have run in it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /**
   * IS SOMETHING STILL WORKING IN THIS CHECKOUT — the guard `start` needs.
   *
   * `active`/`archived` is not the question: `stop` settles a session's turns
   * and deliberately leaves the session alive, because the branch is the loom's
   * output and archiving is a separate human decision. So liveness is asked of
   * the TURNS, which is the same signal `status` reads.
   */
  const liveSessionOn = (projectId: string, worktree: string): Session | undefined => {
    let sessions: Session[];
    try {
      sessions = store.listSessions(projectId);
    } catch {
      // A project with no sessions yet, or a store that cannot list them. There
      // is nothing to collide with that we can prove, and refusing on a read we
      // could not make would strand every dispatch behind an unrelated fault.
      return undefined;
    }
    const target = path.resolve(worktree);
    for (const session of sessions) {
      if (session.state === "archived") continue;
      if (path.resolve(session.workspace.path) !== target) continue;
      try {
        if (store.turns(session.id).some((turn) => IN_FLIGHT.has(turn.state))) return session;
      } catch {
        // Gone between the listing and the read; it cannot be live.
      }
    }
    return undefined;
  };

  return {
    async start(input) {
      /**
       * ONE LIVE SESSION PER CHECKOUT, REFUSED HERE.
       *
       * Every ladder rung and every human answer re-provisions the loom against
       * the SAME worktree. `provisionLoom` now stops the previous session first,
       * so the ordinary path never reaches this — which is exactly why the check
       * belongs here too: it is the invariant, and the caller's cooperation is
       * not a way to hold one. Two live agents editing one tree produce a diff
       * attributable to neither and a gate that measures whichever instant it
       * arrived in, and neither symptom names its cause.
       *
       * REFUSING, NOT STOPPING. Killing somebody else's running worker from
       * inside a constructor-shaped call is a bigger decision than this function
       * is allowed to make; `stick` turns this sentence into a loom a human can
       * read and act on.
       */
      const live = liveSessionOn(input.projectId, input.worktree);
      if (live) {
        throw new Error(
          `session ${live.id} is still working in ${input.worktree} and a second worker in one checkout would produce a diff attributable to neither. Stop or cancel that session first — the loom that owns it can be cancelled from the deck.`,
        );
      }
      /**
       * `envMode: "worktree"` IS THE WHOLE REASON A LOOM CAN RUN MORE THAN ONE
       * ITEM AT ONCE. Two workers in one checkout produce a diff nobody can
       * attribute and a `git status` belonging to neither — see `worktree.ts`.
       * The checkout is the one the loom already prepared; see the header.
       */
      const session = store.createSession({
        projectId: input.projectId,
        title: input.title.trim() || "Loom worker",
        envMode: "worktree",
        // ADOPTED, NOT CUT. See the header. The store validates the path before
        // it records it, and marks it as not the session's to reap.
        workspace: {
          path: input.worktree,
          branch: input.branch,
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        },
      });
      // EXACTLY ONE TURN. The brief is complete by construction — the Program,
      // the item's detail, the boundaries — and a worker nobody talks to again
      // is what makes its cost bounded and its output reviewable as one diff.
      submit(session.id, input.prompt, `the worker session for ${input.title}`);
      return { sessionId: session.id };
    },

    async create(input) {
      /**
       * `envMode: "local"` PINS IT TO THE PROJECT'S OWN ROOT — that is what
       * "local" means in the store, and it is exactly §16's requirement for the
       * conversational surface.
       */
      const session = store.createSession({
        projectId: input.projectId,
        title: input.title.trim() || "Loom",
        envMode: "local",
      });
      /**
       * VERIFIED, NOT ASSUMED. The caller's `cwd` and the store's project root
       * both come from the registry today, so this cannot fire — which is
       * exactly why it is cheap to check and worth checking: the day they stop
       * agreeing, the symptom would otherwise be an orchestrator quietly reading
       * a different directory than the one it is describing.
       */
      if (path.resolve(session.workspace.path) !== path.resolve(input.cwd)) {
        try {
          store.archiveSession(session.id);
        } catch {
          // Nothing more to do; the refusal below is what matters.
        }
        throw new Error(
          `the orchestrator session for ${input.projectId} would have opened in ${session.workspace.path}, but the runtime asked for ${input.cwd}. The project's recorded root and the path the loom composes have diverged; re-open the project in Telar to fix its root.`,
        );
      }
      // SEEDED ONLY WHEN ASKED — `ensureLoomSession` passes the setup brief on
      // creation and nothing afterwards, so a conversation that has moved on is
      // never re-briefed mid-thread.
      if (input.prompt?.trim()) submit(session.id, input.prompt, `the orchestrator session for ${input.projectId}`);
      return { sessionId: session.id };
    },

    async status(sessionId) {
      let session: Session;
      try {
        session = store.getSession(sessionId);
      } catch (error) {
        // THE ONLY `gone` THAT MATTERS: no session document at all. A store that
        // is unreadable for some other reason must NOT read as "the worker
        // vanished" — that would gate a worktree a live worker is still writing.
        if (error instanceof EngineStateError && error.code === "not_found") return "gone";
        throw error;
      }
      /**
       * ARCHIVED IS `gone`, NOT `done`. An archived session was cleaned up
       * rather than merely finished, and nobody can ask it anything afterwards.
       * `dispatch.ts` says "disappeared" rather than "ended" for this, and that
       * is the true sentence for a human reading the ledger. The loom's
       * WORKTREE survives it — it was adopted, not cut — so the gate can still
       * count commits and say something better than "nothing ran".
       */
      if (session.state === "archived") return "gone";

      const turns = store.turns(sessionId);
      const unsettled = turns.filter((turn) => IN_FLIGHT.has(turn.state));
      // Includes the case of no turns at all — an orchestrator session nobody
      // has typed into is idle and reusable, which is what `done` means here.
      if (unsettled.length === 0) return "done";

      /**
       * QUEUED AND NOBODY HAS TOUCHED IT — reported as `unclaimed`, not as
       * `running`, and this is the fix for the largest silent stall in the
       * system.
       *
       * See this file's header: queueing past `worker_unavailable` is
       * deliberate and stays. But its consequence was that with NO worker
       * process alive, a dispatched loom sat `working` on a `queued` turn
       * FOREVER — `status` said `running`, which was true of the session and
       * false about the world, so the ledger stayed silent and the deck drew a
       * project that could never move as one that was busy. "Nothing to do" and
       * "nothing can be done" rendered identically, which is the one
       * distinction an unattended system has to keep.
       *
       * NOT A TIMEOUT, AND NOT A SECOND SOURCE OF TRUTH. It reads the same
       * queue `status` already reads and reports what is written there: a turn
       * in `claimed` or `running` means a worker took it, and this never fires
       * again for that session no matter how long the work takes. Only the
       * absence of any claim produces `unclaimed`, and `dispatch.ts` — not this
       * port — decides how long that is allowed to last.
       */
      if (unsettled.every((turn) => turn.state === "queued")) return "unclaimed";

      /**
       * THE JOURNAL AS CORROBORATION, not as a second opinion.
       *
       * The store writes the queue BEFORE appending the event, so the journal
       * can only ever lag the queue — never lead it. Which makes this exactly
       * one thing: a queue that still calls a turn in-flight while the journal
       * already carries its ending is a torn write, and the append-only file is
       * the one to believe. Reading both is also what keeps this honest to §4 —
       * the answer comes from the session store, and from nothing else.
       */
      const ended = new Set(
        store
          .readEvents(sessionId)
          .filter((event) => TURN_ENDED.has(event.type) && event.runId !== undefined)
          .map((event) => event.runId as string),
      );
      return unsettled.every((turn) => ended.has(turn.runId)) ? "done" : "running";
    },

    async stop(sessionId) {
      /**
       * EVERY RUNNABLE TURN, not just the first. `stopTurn` settles one, and a
       * cancelled loom must not leave a queued brief behind that a worker picks
       * up ten seconds later. Bounded by the queue's length so a store that
       * refuses to settle costs a loop of reads rather than the daemon.
       *
       * THE SESSION IS NOT ARCHIVED. `cancelLoom` keeps the worktree and the
       * branch on purpose — they are the loom's output, and destroying commits
       * is a separate human decision from stopping a run.
       */
      let remaining: number;
      try {
        remaining = store.turns(sessionId).length;
      } catch (error) {
        // Already gone is exactly what the caller wanted; `cancelLoom` calls
        // this best-effort for that reason.
        if (error instanceof EngineStateError && error.code === "not_found") return;
        throw error;
      }
      for (let attempt = 0; attempt < remaining; attempt += 1) {
        if (!store.stopTurn(sessionId).stopped) return;
      }
    },
  };
}
