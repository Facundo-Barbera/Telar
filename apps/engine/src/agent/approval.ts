/**
 * WHICH OF THE AGENT'S CALLS A PERSON HAS TO SEE FIRST (#531).
 *
 * ── ARGUMENT-AWARE, AND IN OUR CODE RATHER THAN THE FRAMEWORK'S ─────────────
 * LangGraph offers a static gate (`interruptBefore: ["tools"]`) that stops
 * before the whole tools node and carries NO payload about which call triggered
 * it. That is not enough for a surface that has to say "the Agent wants to send
 * this task to that session" — it would have to re-derive the call from the
 * last message. So the gate is a function of the CALL, evaluated here, and the
 * dynamic `interrupt()` carries the tool name and its arguments across the
 * checkpoint to whoever answers.
 *
 * ── WHAT IS GATED, AND THE ONE RULE BEHIND THE LIST ─────────────────────────
 * Anything that LANDS something on another session, or DESTROYS something.
 * Reads are never gated: a gate on `sessions_list` teaches a person to click
 * through gates, and then the one that mattered is clicked through too.
 *
 *   · `sessions_send` with `intent: task` or `blocker` — the calls that put
 *     another agent to work or demand a human's attention. `report` and
 *     `result` are passive and are not gated: they are the Agent saying
 *     something, which is what it is for.
 *   · `sessions_create` — a new session, a new checkout, a new row in somebody's
 *     rail.
 *   · `sessions_stop` — ends work in flight; what it already wrote stays written
 *     and a command it had started may have finished.
 *   · `sessions_resolve_request` — answering a question on the person's behalf.
 *     The wall's own prose says to answer only what you actually know; this is
 *     the gate that makes that a promise rather than a request.
 *   · `notes_delete` — the only verb on either wall that removes something.
 *
 * NOT `sessions_settle`, NOT `sessions_subscribe`, NOT `notes_write`. Settling
 * is shelving and is reversible; a subscription costs the Agent's own turns and
 * nobody else's; a note is additive and the notebook is a scratchpad. Gating
 * them would be the click-through problem with no safety bought.
 */

/** One call, as the gate sees it. Deliberately not LangChain's `ToolCall`: the
 *  policy is a fact about Telar's walls and should be testable without the
 *  framework. */
export type GatedCall = { name: string; args: Record<string, unknown> };

/**
 * WHICH OF THE AGENT'S TOOLS ONLY LOOK — the table the within-turn memo asks
 * (#592).
 *
 * ── WHY IT LIVES HERE AND NOT BESIDE THE MEMO ───────────────────────────────
 * This file already owns the one sentence the classification is about: "anything
 * that LANDS something on another session, or DESTROYS something". The gate
 * below is a STRICT SUBSET of that — `sessions_settle`, `sessions_subscribe`,
 * `sessions_unsubscribe`, `notes_write`, `remember` and a `report`-intent
 * `sessions_send` all land something and are deliberately NOT gated, for the
 * click-through reason the header argues. So the memo could not be derived from
 * `needsApproval`: it would have read five landers and a send as reads. The
 * table is the shared fact both now answer from, in the module that already
 * held half of it.
 *
 * ── IT FAILS TOWARDS NOT MEMOISING ──────────────────────────────────────────
 * A name this table has never heard of answers "lands". That direction is the
 * whole safety of it: a new READ that nobody classified costs a duplicate page
 * and is visible in the transcript, while a new WRITE that nobody classified
 * would be silently swallowed the second time the model asked for it — which is
 * exactly the correctness bug the memo must not be able to introduce.
 * `agent-approval.test.ts` pins that every tool the Agent is actually given has
 * an entry, so the safe direction is a backstop rather than the normal case.
 */
const TOOL_EFFECT: Readonly<Record<string, "reads" | "lands">> = {
  // The sessions wall.
  sessions_list: "reads",
  sessions_read: "reads",
  sessions_status: "reads",
  sessions_diff: "reads",
  sessions_requests: "reads",
  sessions_subscriptions: "reads",
  sessions_create: "lands",
  sessions_send: "lands",
  sessions_stop: "lands",
  sessions_settle: "lands",
  sessions_subscribe: "lands",
  sessions_unsubscribe: "lands",
  sessions_resolve_request: "lands",
  // NO `sessions_report_window` AND NO `sessions_schedule`, and their absence is
  // the table working rather than an omission: this table is held against the
  // tools the AGENT is given, and neither is one of them — the Agent is a
  // thread, not a session, so it has no mailbox to hold reports in and no
  // session id a schedule row could fire into. See `NOT_ON_THE_AGENTS_WALL`.
  // #516's six queries and the fleet read. Every one of them is a READ by
  // construction rather than by classification: the query capability has no
  // verb that writes, so there is nothing here for a future tool on it to be
  // misfiled as.
  sessions_find: "reads",
  sessions_outline: "reads",
  sessions_answer: "reads",
  sessions_steps: "reads",
  sessions_step: "reads",
  sessions_grep: "reads",
  fleet_status: "reads",
  // The notebook.
  notes_projects: "reads",
  notes_list: "reads",
  notes_read: "reads",
  notes_write: "lands",
  notes_delete: "lands",
  // Outside Telar, and the Agent's own two.
  github_status: "reads",
  remember: "lands",
  recall: "reads",
};

/**
 * Does this call only LOOK at something?
 *
 * The one question the memo asks, and the only safe basis for it: a read
 * repeated inside one turn cannot have changed in a way the Agent could act on,
 * while a write repeated inside one turn is a second thing the person may well
 * have asked for.
 */
export function readsOnly(name: string): boolean {
  return TOOL_EFFECT[name] === "reads";
}

/** Every tool this table has been taught, so a test can hold it against the
 *  list the Agent is actually given rather than against itself. */
export function classifiedTools(): string[] {
  return Object.keys(TOOL_EFFECT);
}

/** What an interrupt hands over — enough for a surface to render the ask
 *  without re-deriving which call it is about. */
export type AgentApprovalRequest = {
  type: "approval";
  tool: string;
  args: Record<string, unknown>;
  toolCallId: string;
  /** One sentence, in the words a person reads. Specific to the call, because
   *  "the Agent wants to run a tool" is an ask nobody can answer. */
  reason: string;
};

export type AgentApprovalDecision = "accept" | "decline";

/** The intents of `sessions_send` that put somebody to work. */
const GATED_INTENTS = new Set(["task", "blocker"]);

const REASONS: Record<string, string> = {
  /**
   * THE CARD NAMES THE ACCESS MODE — issue #541 G1.
   *
   * The gate was never bypassed; what it SAID was the problem. A person
   * approved "create a session" and what they got was a session in `auto`:
   * file changes and commands inside its checkout accepted without asking
   * again. Nothing on this card said so, so the approval was for a smaller
   * thing than the one it authorised.
   *
   * IT NAMES `auto` OUTRIGHT rather than deferring to the ceiling, and that is
   * deliberate: the ceiling caps a session's children at the CREATOR's mode,
   * and the Agent is a thread rather than a session — it has no runtime mode,
   * so its creates land on the detached default and this sentence is exactly
   * true for every card a person will see here.
   */
  sessions_create:
    "This creates a new session — a new row in your rail, and a checkout if it asked for one. It starts in `auto`: it will make file changes and run commands inside its own checkout without asking you again. You can narrow that from the session once it exists.",
  sessions_stop: "This stops another session's work where it stands. Nothing it already wrote is undone.",
  sessions_resolve_request: "This answers another session's open request on your behalf.",
  notes_delete: "This deletes a note from a project's notebook.",
};

const SEND_REASONS: Record<string, string> = {
  task: "This assigns work to another session. A person approves that, not the model.",
  blocker: "This asks another session to intervene, which will interrupt whoever is watching it.",
};

/**
 * Does this call need a person first?
 *
 * ARGUMENT-AWARE FOR EXACTLY ONE TOOL, and that is the point of the seam rather
 * than a special case: `sessions_send` is four different acts depending on its
 * `intent`, and a gate on the tool NAME would either stop every report the
 * Agent writes or let every task through.
 */
export function needsApproval(call: GatedCall): boolean {
  if (call.name === "sessions_send") return GATED_INTENTS.has(String(call.args?.intent ?? "report"));
  return call.name in REASONS;
}

/** The ask, for a call `needsApproval` said yes to. */
export function approvalRequest(call: GatedCall, toolCallId: string): AgentApprovalRequest {
  const reason =
    call.name === "sessions_send"
      ? (SEND_REASONS[String(call.args?.intent ?? "")] ?? "This sends a message to another session.")
      : (REASONS[call.name] ?? "This changes something outside this conversation.");
  return { type: "approval", tool: call.name, args: call.args ?? {}, toolCallId, reason };
}

/**
 * WHAT A DECLINED CALL TELLS THE MODEL.
 *
 * A SENTENCE, NOT AN ERROR. A decline is a person's decision and the model's
 * job is to say so and ask what they want instead — a thrown failure would end
 * the turn and the person would never hear that their decline landed.
 *
 * AND IT SAYS NOT TO RETRY, because a model that reads "declined" as "that
 * attempt failed" tries the same call again, and the second ask teaches the
 * person that approvals are noise.
 */
export const DECLINED_ANSWER =
  "The person declined this call. Do not retry it — tell them it was declined and ask what they would like instead.";
