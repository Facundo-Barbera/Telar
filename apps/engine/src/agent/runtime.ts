/**
 * THE AGENT'S LOOP — a hand-built StateGraph, one thread per machine (#531).
 *
 * ── WHY A `StateGraph` AND NOT `createReactAgent` ───────────────────────────
 * The installed package deprecates its own prebuilt: `@langchain/langgraph`
 * 1.4.15 ships `createReactAgent` with `@deprecated CreateReactAgentParams has
 * been moved to the langchain package`. The replacement, `createAgent` from
 * `langchain`, is a third package and an agent abstraction with its own
 * middleware system — adopting it would mean taking somebody's opinions about
 * approvals, context and subagents on top of the ones Telar already has. A
 * graph over the two packages #531 names is the non-deprecated API and is what
 * the lab measured.
 *
 * ── THE TWO PROPERTIES THAT ARE NOT DECORATION ──────────────────────────────
 * 1. APPROVAL IS A FIRST PASS. `interrupt()` propagates by throwing, so a node
 *    that ran one tool and THEN interrupted would lose that tool's state write
 *    and re-run it on resume — the effect landing twice. Every gated call in a
 *    batch is therefore interrupted before any effect in the same node runs.
 * 2. EFFECTS ARE LEDGERED IN GRAPH STATE, so the record of an effect is
 *    checkpointed in the same write as the messages that produced it. The
 *    ledger is read BEFORE the approval check, so a deduplicated retry neither
 *    asks the person again nor reaches the wall. This is "checkpoint before
 *    effect" done the only way a checkpointer can give it: the effect and its
 *    record commit together, and a crash between them replays the node.
 *
 * Neither closes the case the lab found in scenario 5C — a cancel landing
 * BETWEEN the HTTP call and the checkpoint write. No graph framework can: an
 * HTTP call and a local write are not atomic. That one is closed at the wall,
 * by `sessions_send` deriving its run id from the tool call id.
 *
 * ── ONE TURN AT A TIME, AND A QUEUE BEHIND IT ───────────────────────────────
 * A thread is a conversation and a conversation has one live turn. A second
 * human message while a turn runs is QUEUED rather than steered: LangGraph's
 * unit of execution is a graph invocation on a thread, and injecting into one
 * mid-flight would mean writing to `messages` from outside the graph, behind
 * the checkpointer's back. Wakes queue on the same line, so a person's message
 * and a session's completion cannot interleave into one prompt.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, Command, END, MessagesAnnotation, START, StateGraph, interrupt } from "@langchain/langgraph";
import crypto from "node:crypto";
import type { SocketTool } from "../mcp-socket";
import { toolInputSchema } from "../mcp-socket";
import { approvalRequest, DECLINED_ANSWER, needsApproval, type AgentApprovalDecision, type AgentApprovalRequest } from "./approval";
import { AGENT_BRIEFING } from "./briefing";
import { openAgentCheckpointer, type OpenedCheckpointer } from "./checkpointer";
import { AgentThreadLog, THREAD_PAGE_DEFAULT, type AgentRow } from "./thread-log";
import { agentPaths, patchAgentSettings, readAgentSettings, type AgentPaths } from "./store";
import { trimAgentMessages } from "./trim";

/**
 * HOW MANY TIMES ONE TURN MAY GO BACK TO THE MODEL — `MAX_ROUNDS`' own number
 * and its own argument. A model that keeps calling tools keeps costing money
 * and nobody is watching a coordinator at 3am. Generous for the work this loop
 * does (read the rail, read a session, send a task, report) and small enough
 * that a loop costs a few calls rather than a night.
 *
 * LangGraph counts SUPERSTEPS, and one lap is two of them (model, tools), so
 * the graph's ceiling is twice the laps plus one.
 */
const MAX_LAPS = 12;

/** The ledger's key for one effect. A hash rather than the arguments because a
 *  key is compared and never read, and a `sessions_send` argument is a whole
 *  message. */
function effectKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${crypto.createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16)}`;
}

/** Which calls must not happen twice — the two that LAND something on another
 *  session. A read replayed costs a page; a send replayed costs somebody a
 *  second turn they did not ask for. */
function ledgerKey(name: string, args: Record<string, unknown>): string | undefined {
  return name === "sessions_send" || name === "sessions_create" ? effectKey(name, args) : undefined;
}

const AgentGraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** key → the answer that effect already produced. */
  effects: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
});
type AgentGraphStateType = typeof AgentGraphState.State;

/* ------------------------------------------------------------------ *
 * What the runtime tells the world.
 * ------------------------------------------------------------------ */

export type AgentTurnOrigin = "human" | "wake";

export type AgentPendingRequest = AgentApprovalRequest & { id: string; runId: string; openedAt: number };

export type AgentStateAnswer = {
  enabled: boolean;
  threadId?: string;
  model?: string;
  generation?: number;
  /** A turn is executing right now. False while one is parked for a person —
   *  which is why `request` is reported beside it rather than inside it. */
  running: boolean;
  /** The run this is all about, whether it is executing or parked. */
  runId?: string;
  /** How many turns are waiting behind the live one. */
  queued: number;
  request?: AgentPendingRequest;
};

/** What a watcher is pushed. A row is durable and pageable; a delta is neither,
 *  and is folded into the assistant row when the message completes. */
export type AgentStreamEvent =
  | { type: "row"; row: AgentRow }
  | { type: "delta"; runId: string; itemId: string; text: string };

export type AgentRuntimeOptions = {
  engineRoot: string;
  /** Rebuilt per turn, because a wall closes over store state that a long-lived
   *  object would pin. */
  tools: () => SocketTool[];
  /** The model, per turn, for the key ladder's reason: a person who pastes a
   *  key gets the new answer on their next message, not their next restart. */
  model: (input: { threadId: string; model?: string }) => BaseChatModel;
  now?: () => number;
  /** Appended after the briefing, exactly as a session's orientation is. */
  orientation?: () => string | undefined;
  maxLaps?: number;
  budgetChars?: number;
};

type QueuedTurn = {
  runId: string;
  input: string;
  origin: AgentTurnOrigin;
  wakeReason?: Record<string, unknown>;
  /**
   * THIS TURN CONTINUES ONE THE CHECKPOINT ALREADY HOLDS — see `restore`.
   *
   * Present only for a turn resumed after a RESTART: the conversation is in the
   * checkpoint, the parked interrupt is in it too, and what this carries is the
   * person's answer rather than anything new to say. It writes no
   * `user_message` and no `turn_started`, because neither happened twice.
   */
  resume?: AgentApprovalDecision;
};

/* ------------------------------------------------------------------ *
 * The runtime.
 * ------------------------------------------------------------------ */

export class AgentRuntime {
  readonly paths: AgentPaths;
  private readonly now: () => number;
  private opened?: OpenedCheckpointer;
  private log?: AgentThreadLog;
  private queue: QueuedTurn[] = [];
  private live?: { turn: QueuedTurn; controller: AbortController };
  private pending?: AgentPendingRequest;
  /** Resolves when the person answers. The parked turn awaits it. */
  private answer?: (decision: AgentApprovalDecision) => void;
  private watchers = new Set<(event: AgentStreamEvent) => void>();
  /** The turn currently pumping, so `submit` does not start a second pump. */
  private pumping = false;
  /** Which conversation the live turn belongs to — see `row`. */
  private turnThreadId?: string;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.paths = agentPaths(options.engineRoot);
    this.now = options.now ?? Date.now;
  }

  /* -------------------------------------------------------------- *
   * Lifecycle.
   * -------------------------------------------------------------- */

  /**
   * The thread's file, opened lazily and kept open.
   *
   * LAZY BECAUSE AN ENGINE WHOSE AGENT IS OFF SHOULD NOT GROW A DATABASE. The
   * first turn, the first thread read or the first stream opens it; a machine
   * that never switches the Agent on never has one.
   */
  private open(): { opened: OpenedCheckpointer; log: AgentThreadLog } {
    if (!this.opened || !this.log) {
      const opened = openAgentCheckpointer(this.paths.threads);
      this.opened = opened;
      this.log = new AgentThreadLog(opened.db);
    }
    return { opened: this.opened, log: this.log };
  }

  /**
   * AN APPROVAL PARKED BY A PREVIOUS PROCESS, FOUND AGAIN (#531).
   *
   * THIS IS THE WHOLE POINT OF A DURABLE CHECKPOINTER, and it is the property
   * the lab measured: `interrupt()` writes the parked call INTO the checkpoint,
   * payload and all, so a process that has never seen the thread can read what
   * the person was being asked and carry on from it. `MemorySaver` survives
   * nothing across a process boundary, which is exactly what a restart is.
   *
   * THE REQUEST'S OWN ID COMES FROM THE TRANSCRIPT, not from the checkpoint.
   * LangGraph stores the payload our node passed to `interrupt()`; the id and
   * the run it belongs to are Telar's, and they were written as a
   * `request_opened` row in the same breath. Recovering them from there is what
   * lets a cockpit that was holding the old id still answer it.
   *
   * AWAITED BY THE DAEMON AT STARTUP rather than fired off inside the first
   * read. It is one bounded sqlite read, it happens once, and doing it eagerly
   * is what makes "the request is there the moment the route can answer" true
   * instead of nearly true.
   *
   * SILENT WHEN THERE IS NOTHING TO RESTORE, which is every ordinary start.
   */
  async restore(): Promise<void> {
    const settings = readAgentSettings(this.paths);
    if (!settings.enabled || !settings.threadId || this.pending || this.live) return;
    try {
      const graph = this.buildGraph({ tools: [], model: undefined, runId: "" });
      const snapshot = await graph.getState({ configurable: { thread_id: settings.threadId } });
      const parked = firstInterrupt(snapshot);
      if (!parked) return;
      const opened = this.lastUnresolvedRequest(settings.threadId);
      if (!opened) return;
      this.pending = { ...parked, id: opened.id, runId: opened.runId, openedAt: opened.openedAt };
      // NO `answer` RESOLVER: the promise that held the parked turn died with
      // the process that made it. `resolveRequest` sees that and queues a
      // RESUME turn instead of settling a promise nobody is waiting on.
    } catch {
      // A thread whose checkpoint cannot be read is not a reason a daemon fails
      // to start. The conversation is still on disk for a later build.
    }
  }

  /** The newest `request_opened` on this thread with no `request_resolved`
   *  after it. Bounded: an approval nobody answered is the newest thing that
   *  happened, so the tail is where it is. */
  private lastUnresolvedRequest(threadId: string): { id: string; runId: string; openedAt: number } | undefined {
    const log = this.log;
    if (!log) return undefined;
    const end = log.cursor(threadId);
    const page = log.page(threadId, Math.max(0, end - 50), 50);
    let found: { id: string; runId: string; openedAt: number } | undefined;
    for (const row of page.rows) {
      if (row.kind === "request_opened" && typeof row.detail.id === "string") {
        found = { id: row.detail.id, runId: row.runId, openedAt: typeof row.detail.openedAt === "number" ? row.detail.openedAt : row.at };
      }
      if (row.kind === "request_resolved") found = undefined;
    }
    return found;
  }

  /** Close the thread file. The reset path's precondition, and the daemon's
   *  shutdown. Safe to call when nothing is open. */
  close(): void {
    this.opened?.close();
    this.opened = undefined;
    this.log = undefined;
  }

  /**
   * ENABLE, DISABLE, MODEL, RESET — the settings verb, with the one side effect
   * the store cannot perform on its own.
   *
   * THE CLOSE IS WIRED HERE because this object owns the handle. `patchAgentSettings`
   * refuses to move a database until its `beforeArchive` hook has run, and this
   * is what that hook is for.
   */
  patch(patch: { enabled?: unknown; model?: unknown; reset?: unknown }): AgentStateAnswer {
    const result = patchAgentSettings(this.paths, patch, { now: this.now, beforeArchive: () => this.close() });
    if (patch.reset === true) {
      // The conversation is gone; anything waiting to be said to it is too.
      this.queue = [];
      this.live?.controller.abort();
      this.pending = undefined;
      this.answer = undefined;
    }
    if (result.settings.enabled === false) this.queue = [];
    return this.state();
  }

  state(): AgentStateAnswer {
    const settings = readAgentSettings(this.paths);
    return {
      enabled: settings.enabled,
      ...(settings.threadId ? { threadId: settings.threadId } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.generation === undefined ? {} : { generation: settings.generation }),
      running: this.live !== undefined && this.pending === undefined,
      ...(this.live ? { runId: this.live.turn.runId } : {}),
      queued: this.queue.length,
      ...(this.pending ? { request: this.pending } : {}),
    };
  }

  /* -------------------------------------------------------------- *
   * Reading.
   * -------------------------------------------------------------- */

  thread(options: { after?: number; limit?: number } = {}): { rows: AgentRow[]; cursor: number; more: boolean; threadId?: string } {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return { rows: [], cursor: 0, more: false };
    const { log } = this.open();
    return { ...log.page(threadId, Math.max(0, options.after ?? 0), options.limit ?? THREAD_PAGE_DEFAULT), threadId };
  }

  /** The end of the transcript, so a watcher can start from the tail without
   *  paging a whole conversation to reach it. */
  cursor(): number {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return 0;
    return this.open().log.cursor(threadId);
  }

  /** Push events to a watcher until it unsubscribes. The caller is responsible
   *  for the rows BEFORE its cursor — it pages those, then watches. */
  watch(listener: (event: AgentStreamEvent) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  private push(event: AgentStreamEvent): void {
    for (const watcher of [...this.watchers]) {
      try {
        watcher(event);
      } catch {
        // A watcher whose socket has gone must not take down the turn that was
        // talking to it. It will be dropped when its own route notices.
      }
    }
  }

  /**
   * ONE ROW, ON THE THREAD IT IS ABOUT — or nowhere.
   *
   * THE THREAD CHECK IS NOT PARANOIA, it is a reset. Resetting aborts the live
   * turn, and that turn unwinds a moment LATER, in the pump's own catch — by
   * which time `agent.json` names a different conversation. Without this, a
   * brand-new thread's first row would be the ending of a turn from the
   * conversation that was just archived, carrying a run id that appears
   * nowhere else in it.
   */
  private row(kind: AgentRow["kind"], runId: string, detail: Record<string, unknown>): AgentRow | undefined {
    const threadId = readAgentSettings(this.paths).threadId;
    if (!threadId) return undefined;
    if (this.turnThreadId !== undefined && this.turnThreadId !== threadId) return undefined;
    const row = this.open().log.append({ threadId, runId, at: this.now(), kind, detail });
    this.push({ type: "row", row });
    return row;
  }

  /* -------------------------------------------------------------- *
   * Turns.
   * -------------------------------------------------------------- */

  /**
   * QUEUE A TURN, AND ANSWER ITS RUN ID AT ONCE.
   *
   * The id is minted here rather than by the caller so two clients pressing
   * send cannot collide, and it is returned before the turn runs because the
   * composer needs something to follow — the same contract `submitTurn` has for
   * a session.
   */
  submit(input: { text: string; origin?: AgentTurnOrigin; wakeReason?: Record<string, unknown> }): { runId: string; queued: number } {
    const settings = readAgentSettings(this.paths);
    if (!settings.enabled || !settings.threadId) throw new Error("Telar's Agent is switched off.");
    const text = input.text.trim();
    if (!text) throw new Error("a turn needs something to say");
    const turn: QueuedTurn = {
      runId: `run_${crypto.randomUUID().replaceAll("-", "")}`,
      input: text,
      origin: input.origin ?? "human",
      ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
    };
    this.queue.push(turn);
    void this.pump();
    return { runId: turn.runId, queued: this.queue.length };
  }

  /**
   * A SESSION'S COMPLETION OR PARKED REQUEST, AS A TURN.
   *
   * The notice is the input, exactly as it is for a session: what a wake hands
   * a model is the engine's own sentence about what happened, not the peer's
   * text — which the Agent can read with `sessions_read` if it wants it.
   * Marked `origin: "wake"` so the transcript can draw it as something that
   * arrived rather than something the person said.
   *
   * SILENT WHEN THE AGENT IS OFF. A subscription outliving the switch is a real
   * state — the store keeps subscription rows — and a wake it produces has
   * nowhere to go. Throwing would fail the turn whose ending caused it.
   */
  wake(input: { notice: string; wakeReason?: Record<string, unknown> }): void {
    try {
      this.submit({ text: input.notice, origin: "wake", ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}) });
    } catch {
      // Switched off, or reset out from under the subscription.
    }
  }

  /**
   * STOP THE LIVE TURN WHERE IT STANDS.
   *
   * WHAT IT DOES NOT DO is undo anything: a `sessions_send` that already
   * reached the store has landed, and the person who pressed Stop is told that
   * rather than promised otherwise. Resuming is a new turn, from the last
   * checkpoint — which is what makes the replay safe, since the effect ledger
   * came back with it.
   */
  cancel(runId?: string): boolean {
    const before = this.queue.length;
    if (runId) this.queue = this.queue.filter((turn) => turn.runId !== runId);
    if (this.live && (runId === undefined || this.live.turn.runId === runId)) {
      this.live.controller.abort();
      // A turn parked for a person is not awaiting the model, so aborting the
      // signal alone would leave it waiting for an answer that will never come.
      this.answer?.("decline");
      return true;
    }
    return this.queue.length !== before;
  }

  /**
   * ANSWER THE PARKED APPROVAL.
   *
   * BY ID, so a stale client cannot answer a question that has already been
   * answered and accidentally approve the next one. The id is the request's
   * own, minted when it parked.
   */
  resolveRequest(requestId: string, decision: AgentApprovalDecision): boolean {
    if (!this.pending || this.pending.id !== requestId) return false;
    const pending = this.pending;
    this.row("request_resolved", pending.runId, { requestId, decision, tool: pending.tool });
    this.pending = undefined;
    if (this.answer) {
      // The turn is still in this process, waiting on the promise below.
      const answer = this.answer;
      this.answer = undefined;
      answer(decision);
      return true;
    }
    /**
     * NOBODY IS WAITING — this approval was parked by a PROCESS THAT IS GONE,
     * and `restore` found it in the checkpoint. The answer therefore starts a
     * turn rather than settling a promise: same run id, same thread, and the
     * graph picks up inside the node it was interrupted in.
     */
    this.queue.push({ runId: pending.runId, input: "", origin: "human", resume: decision });
    void this.pump();
    return true;
  }

  /* -------------------------------------------------------------- *
   * The pump.
   * -------------------------------------------------------------- */

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (!next) return;
        const controller = new AbortController();
        this.live = { turn: next, controller };
        try {
          await this.runTurn(next, controller.signal);
        } catch (error) {
          this.row("turn_done", next.runId, {
            status: controller.signal.aborted ? "stopped" : "failed",
            ...(controller.signal.aborted ? {} : { message: error instanceof Error ? error.message : String(error) }),
          });
        } finally {
          this.live = undefined;
          this.pending = undefined;
          this.answer = undefined;
          this.turnThreadId = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTurn(turn: QueuedTurn, signal: AbortSignal): Promise<void> {
    const settings = readAgentSettings(this.paths);
    const threadId = settings.threadId;
    if (!threadId) return;
    this.turnThreadId = threadId;
    this.open();

    // A RESUMED TURN SAYS NOTHING NEW. The person's words and the turn's start
    // were written by the process that parked the approval; writing them again
    // would put the same question in the transcript twice.
    if (!turn.resume) {
      this.row("user_message", turn.runId, {
        text: turn.input,
        origin: turn.origin,
        ...(turn.wakeReason ? { wakeReason: turn.wakeReason } : {}),
      });
      this.row("turn_started", turn.runId, { origin: turn.origin });
    }

    const tools = this.options.tools();
    const graph = this.buildGraph({ tools, model: this.options.model({ threadId, ...(settings.model ? { model: settings.model } : {}) }), runId: turn.runId });
    const config: RunnableConfig = {
      configurable: { thread_id: threadId },
      // One lap is two supersteps, plus the final model call that answers.
      recursionLimit: (this.options.maxLaps ?? MAX_LAPS) * 2 + 1,
      signal,
    };

    /** The first pass carries the person's words; every pass after an approval
     *  carries the decision instead, which is how LangGraph resumes a parked
     *  interrupt rather than restarting the node with new input. Typed off the
     *  compiled graph so the node names in `Command`'s own generics stay right
     *  when a node is added. */
    let input: Parameters<typeof graph.stream>[0] = turn.resume
      ? new Command({ resume: turn.resume })
      : { messages: [new HumanMessage(turn.input)] };
    for (;;) {
      /**
       * `streamMode: "messages"` IS WHERE THE TOKENS COME FROM. Tool rows are
       * emitted by the tools node itself instead: the node knows a call is
       * about to run, and a row derived from the stream could only ever say
       * that one already had.
       */
      for await (const part of await graph.stream(input, { ...config, streamMode: "messages" })) {
        if (signal.aborted) break;
        const [chunk] = part as [unknown, unknown];
        const message = chunk as { content?: unknown; id?: string; getType?: () => string };
        if (message?.getType?.() !== "ai") continue;
        const text = typeof message.content === "string" ? message.content : "";
        if (text) this.push({ type: "delta", runId: turn.runId, itemId: message.id ?? turn.runId, text });
      }
      signal.throwIfAborted();

      const snapshot = await graph.getState(config);
      const parked = firstInterrupt(snapshot);
      if (!parked) break;

      const decision = await this.park(parked, turn.runId, signal);
      input = new Command({ resume: decision });
    }

    const snapshot = await graph.getState(config);
    const text = lastAssistantText(snapshot.values?.messages ?? []);
    this.row("turn_done", turn.runId, { status: "completed", ...(text ? { text } : {}) });
  }

  /**
   * PARK, AND WAIT FOR A PERSON.
   *
   * The promise is what holds the turn: the graph has already written its
   * checkpoint (the interrupt is IN it), so a restart here loses nothing — the
   * request is re-read from the checkpoint and the conversation resumes. What
   * does not survive is this process's promise, which is why an abort settles
   * it as a decline rather than leaving it hanging.
   */
  private park(request: AgentApprovalRequest, runId: string, signal: AbortSignal): Promise<AgentApprovalDecision> {
    const pending: AgentPendingRequest = { ...request, id: `req_${crypto.randomUUID().replaceAll("-", "")}`, runId, openedAt: this.now() };
    this.pending = pending;
    this.row("request_opened", runId, { ...pending });
    return new Promise<AgentApprovalDecision>((resolve) => {
      this.answer = resolve;
      if (signal.aborted) {
        this.answer = undefined;
        this.pending = undefined;
        resolve("decline");
        return;
      }
      signal.addEventListener("abort", () => resolve("decline"), { once: true });
    });
  }

  /* -------------------------------------------------------------- *
   * The graph.
   * -------------------------------------------------------------- */

  private buildGraph(context: { tools: SocketTool[]; model: BaseChatModel | undefined; runId: string }) {
    const byName = new Map(context.tools.map((tool) => [tool.name, tool]));
    /**
     * BOUND AS FUNCTION DEFINITIONS, NOT AS LANGCHAIN TOOL OBJECTS.
     *
     * The wall already produces a JSON Schema for its own MCP socket
     * (`toolInputSchema`), and the model only ever needs the schema — execution
     * goes through `SocketTool.run` below, which is what carries the tool call
     * id the idempotency key is derived from. Wrapping each wall tool in a
     * LangChain `tool()` would add a second zod bridge and put the framework
     * between us and the call id, for nothing.
     */
    const specs = context.tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool.shape) },
    }));
    const system = new SystemMessage([AGENT_BRIEFING, this.options.orientation?.()].filter(Boolean).join("\n\n"));
    const budget = this.options.budgetChars;

    const callModel = async (state: AgentGraphStateType, config?: RunnableConfig): Promise<Partial<AgentGraphStateType>> => {
      // `restore` compiles this graph with no model at all — it only ever reads
      // state — so a node that somehow ran without one says so rather than
      // dereferencing undefined.
      if (!context.model) throw new Error("the Agent has no model for this turn");
      const bound = context.model.bindTools?.(specs as never) ?? context.model;
      // THE TRIM IS THE PRE-MODEL STEP — see `./trim.ts`. It shapes what the
      // MODEL sees and never what the transcript holds.
      const history = trimAgentMessages(state.messages, {
        ...(budget === undefined ? {} : { budgetChars: budget }),
        reservedChars: String(system.content).length,
      });
      // CONFIG IS PASSED THROUGH so the turn's abort signal reaches the
      // provider call. A cancel that unwound the graph and left the request in
      // flight would not be a cancel.
      const answer = (await bound.invoke([system, ...history], config)) as AIMessage;
      /**
       * ONE ROW PER THING THE ASSISTANT SAYS, AS IT SAYS IT.
       *
       * THE BUG THIS FIXES: a turn that says something and THEN calls a tool
       * lost the said text entirely. Only `turn_done.detail.text` reached a
       * row, and that carries the LAST assistant message of the turn — so
       * "I'll check the rail" followed by `sessions_list` left a transcript in
       * which the Agent narrated nothing and simply acted.
       *
       * EMITTED FROM THE NODE rather than derived from the stream, for the
       * reason the tool rows already are: the node holds the finished message,
       * where a row derived from deltas would have to decide for itself when a
       * message had ended.
       *
       * `itemId` IS THE MESSAGE'S OWN ID, which is also what the deltas carry,
       * so a client that has been painting a live bubble can reconcile it with
       * the row that lands rather than drawing the same sentence twice.
       *
       * A ROUND THAT ONLY CALLS TOOLS SAYS NOTHING, and writes no row — the
       * same rule `main-session/driver.ts` had for its text item: an empty
       * speech bubble in the transcript is worse than none.
       *
       * `turn_done.detail.text` IS UNCHANGED, deliberately. It is the turn's
       * ANSWER — what a list view renders without replaying the thread — and
       * the final assistant row is the same words in the conversation. Two
       * readers, two shapes, one of them keyed by run.
       */
      const said = typeof answer.content === "string" ? answer.content : "";
      if (said.trim()) this.row("assistant_message", context.runId, { text: said, itemId: answer.id ?? context.runId });
      return { messages: [answer] };
    };

    const callTools = async (state: AgentGraphStateType, config?: RunnableConfig): Promise<Partial<AgentGraphStateType>> => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      const calls = last?.tool_calls ?? [];
      if (calls.length === 0) return {};

      // PASS 1 — every approval, before any effect. See the header.
      const decisions = new Map<string, AgentApprovalDecision>();
      for (const call of calls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        if (!needsApproval({ name: call.name, args })) continue;
        // AN EFFECT ALREADY ON THE LEDGER IS NOT ASKED ABOUT AGAIN: the person
        // approved this exact call once, nothing new will happen, and waking
        // them for it would teach them that approvals are noise.
        const key = ledgerKey(call.name, args);
        if (key && state.effects[key] !== undefined) continue;
        decisions.set(call.id ?? "", interrupt<AgentApprovalRequest, AgentApprovalDecision>(approvalRequest({ name: call.name, args }, call.id ?? "")));
      }

      // PASS 2 — the effects, each recorded in the same state write as its
      // answer.
      const messages: ToolMessage[] = [];
      const effects: Record<string, string> = {};
      for (const call of calls) {
        const id = call.id ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const key = ledgerKey(call.name, args);
        const already = key ? state.effects[key] : undefined;
        if (already !== undefined) {
          messages.push(new ToolMessage({ tool_call_id: id, name: call.name, content: `${already}\n\n[this exact call was already made on this thread; the recorded answer is above and nothing was sent again]` }));
          continue;
        }
        if (needsApproval({ name: call.name, args }) && decisions.get(id) !== "accept") {
          this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: DECLINED_ANSWER, status: "declined" });
          messages.push(new ToolMessage({ tool_call_id: id, name: call.name, content: DECLINED_ANSWER }));
          continue;
        }
        const tool = byName.get(call.name);
        if (!tool) {
          const message = `There is no tool called ${call.name} in this conversation. Use one of the tools you were given.`;
          this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: message, status: "failed" });
          messages.push(new ToolMessage({ tool_call_id: id, name: call.name, content: message }));
          continue;
        }
        let text: string;
        let failed = false;
        try {
          // THE CALL ID GOES THROUGH, which is what makes `sessions_send`
          // idempotent across a replay of this node.
          const answer = await tool.run(args, { toolCallId: id });
          text = textOf(answer.content);
          failed = answer.isError === true;
        } catch (error) {
          // EVERY OUTCOME IS A TOOL RESULT, never a thrown turn. A refusal, a
          // bad argument and a handler that threw are all things the model can
          // respond to; failing the turn would throw away a conversation over
          // one bad call.
          text = error instanceof Error ? error.message : String(error);
          failed = true;
        }
        if (key) effects[key] = text;
        this.row("tool_call", context.runId, { name: call.name, toolCallId: id, input: args, output: text, status: failed ? "failed" : "completed" });
        messages.push(new ToolMessage({ tool_call_id: id, name: call.name, content: text }));
      }
      config?.signal?.throwIfAborted();
      return { messages, effects };
    };

    const shouldContinue = (state: AgentGraphStateType): typeof END | "tools" => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      return (last?.tool_calls?.length ?? 0) > 0 ? "tools" : END;
    };

    return new StateGraph(AgentGraphState)
      .addNode("model", callModel)
      .addNode("tools", callTools)
      .addEdge(START, "model")
      .addConditionalEdges("model", shouldContinue, ["tools", END])
      .addEdge("tools", "model")
      .compile({ checkpointer: this.open().opened.saver });
  }
}

/* ------------------------------------------------------------------ *
 * Reading a graph snapshot.
 * ------------------------------------------------------------------ */

/** The one interrupt a parked graph is waiting on, with the payload our own
 *  node put in it. Several gated calls in one batch park one at a time: the
 *  node replays on resume and the next `interrupt()` throws again. */
function firstInterrupt(snapshot: { tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ value?: unknown }> }> }): AgentApprovalRequest | undefined {
  for (const task of snapshot.tasks ?? []) {
    for (const parked of task.interrupts ?? []) {
      const value = parked.value as AgentApprovalRequest | undefined;
      if (value && value.type === "approval") return value;
    }
  }
  return undefined;
}

/** The assistant's last words, for the row that closes the turn. */
function lastAssistantText(messages: readonly BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.getType() !== "ai") continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    if (content.trim()) return content;
  }
  return "";
}

/** An MCP content list as the one string a `tool` message carries. */
function textOf(content: unknown[]): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string") {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.join("\n");
}
