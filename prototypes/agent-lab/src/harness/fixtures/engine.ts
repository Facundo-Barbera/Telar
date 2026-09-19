/**
 * THE FIXTURE ENGINE — an in-memory Telar, and a fake project worker.
 *
 * Every side effect in this lab lands here and nowhere else: no daemon, no
 * store, no filesystem, no network. The real tool walls
 * (`apps/engine/src/sessions-tools/tools.ts`, `notes-tools/tools.ts`) are
 * imported UNCHANGED and driven over this, which is the whole point of the
 * capability port they were written against.
 *
 * ── THE FAKE WORKER ─────────────────────────────────────────────────────────
 * A session created here is inert until something sends it a turn. A turn with
 * `intent: task` starts the worker: after `workerDelayMs` it appends the
 * journal events a real run would, completes the turn, and wakes every session
 * subscribed to it. `failOnce` makes the FIRST such run fail instead — which is
 * scenario 6's whole premise, and the reason a retry path has anything to be
 * idempotent about.
 *
 * ── NOTHING OUTLIVES THE TEST ───────────────────────────────────────────────
 * Every timer is tracked and `close()` clears it; `settle()` awaits the work
 * already scheduled. A scenario that forgets either would leave a timer holding
 * the process open, which is exactly what this lab is not allowed to do.
 */
import type {
  EngineEvent,
  EngineRequest,
  EnvMode,
  ProjectNote,
  ProviderDriverKind,
  Session,
  SessionDiff,
  Subscription,
  Turn,
  WakeKind,
} from "@telar/engine-client";
import { idFactory } from "../ids";

/** A wake the fixture delivered — recorded rather than dispatched, because
 *  there is no second agent here to receive one. */
export type RecordedWake = {
  subscriptionId: string;
  subscriberSessionId: string;
  targetSessionId: string;
  kind: WakeKind;
  runId: string;
  at: number;
};

export type FixtureEngineOptions = {
  /** How long the fake worker takes to answer a task. Small, but not zero —
   *  a delegation that resolves synchronously proves nothing about waiting. */
  workerDelayMs?: number;
  /** The first worker run fails; every later one succeeds. Scenario 6. */
  failOnce?: boolean;
  /** Wall clock, injected so a transcript is stable across runs. */
  now?: () => number;
};

const PROJECT = { id: "prj_lab", name: "Agent Lab" };

export class FixtureEngine {
  readonly projects = [PROJECT];
  private readonly sessions = new Map<string, Session>();
  private readonly journals = new Map<string, EngineEvent[]>();
  private readonly turnsBySession = new Map<string, Turn[]>();
  private readonly requestsBySession = new Map<string, EngineRequest[]>();
  private readonly notesByProject = new Map<string, ProjectNote[]>();
  private readonly subs: Subscription[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly id = idFactory();
  private eventSeq = 0;
  private clock: number;

  /** What the scenarios assert on. `sendCalls` counts every `send` that
   *  reached this engine; `sendsAccepted` drops the idempotent replays. */
  readonly counts = { create: 0, sendCalls: 0, sendsAccepted: 0, workerRuns: 0, workerFailures: 0 };
  readonly wakes: RecordedWake[] = [];

  private readonly workerDelayMs: number;
  private failOnce: boolean;

  constructor(options: FixtureEngineOptions = {}) {
    this.workerDelayMs = options.workerDelayMs ?? 25;
    this.failOnce = options.failOnce ?? false;
    this.clock = options.now?.() ?? 1_700_000_000_000;
  }

  private tick(by = 1): number {
    this.clock += by;
    return this.clock;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(input: { projectId: string; title?: string; envMode: EnvMode; driver?: ProviderDriverKind }): Session {
    if (input.projectId !== PROJECT.id) throw new Error(`No project goes by "${input.projectId}".`);
    this.counts.create += 1;
    const id = this.id("ses");
    const at = this.tick();
    const session: Session = {
      id,
      projectId: input.projectId,
      environmentId: "local",
      title: input.title ?? "Untitled",
      state: "active",
      createdAt: at,
      updatedAt: at,
      providerInstanceId: "pi_lab",
      driver: input.driver ?? "claude",
      origin: "session",
      workspace:
        input.envMode === "worktree"
          ? { mode: "worktree", path: `/fixture/worktrees/${id}`, branch: `lab/${id}` }
          : { mode: "local", path: "/fixture/project" },
      envMode: input.envMode,
      runtimeMode: "approval-required",
      interactionMode: "default",
      detached: false,
      activity: "idle",
    };
    this.sessions.set(id, session);
    this.journals.set(id, []);
    this.turnsBySession.set(id, []);
    this.append(id, { type: "session.created", session });
    return session;
  }

  session(id: string): Session {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`No session goes by "${id}".`);
    return found;
  }

  liveSessions(): Session[] {
    return [...this.sessions.values()].filter((session) => session.state === "active");
  }

  settle(id: string, settled: boolean): Session {
    const session = this.session(id);
    const next: Session = { ...session, settledOverride: settled ? "settled" : "active", settledAt: this.tick(), updatedAt: this.tick() };
    this.sessions.set(id, next);
    return next;
  }

  turns(id: string): Turn[] {
    this.session(id);
    return this.turnsBySession.get(id) ?? [];
  }

  journal(id: string): EngineEvent[] {
    this.session(id);
    return this.journals.get(id) ?? [];
  }

  diff(id: string): SessionDiff {
    const session = this.session(id);
    return {
      repository: true,
      workspacePath: "path" in session.workspace ? session.workspace.path : "/fixture/project",
      branch: session.workspace.mode === "worktree" ? session.workspace.branch : "main",
      files: [{ path: "src/answer.ts", status: "modified", linesAdded: 4, linesRemoved: 1 }],
      commits: [],
      linesAdded: 4,
      linesRemoved: 1,
      truncated: false,
    } as SessionDiff;
  }

  // ── turns and the fake worker ─────────────────────────────────────────────

  send(sessionId: string, input: { runId: string; input: string; intent?: Turn["agentIntent"] }): { turn: Turn; replayed: boolean } {
    this.counts.sendCalls += 1;
    const session = this.session(sessionId);
    const turns = this.turnsBySession.get(sessionId) ?? [];
    const already = turns.find((turn) => turn.runId === input.runId);
    if (already) return { turn: already, replayed: true };

    this.counts.sendsAccepted += 1;
    const intent = input.intent ?? "report";
    const delivery: Turn["agentDelivery"] = intent === "report" ? "passive" : "wake";
    const at = this.tick();
    const turn: Turn = {
      runId: input.runId,
      sessionId,
      sequence: turns.length + 1,
      state: "queued",
      input: input.input,
      acceptedAt: at,
      updatedAt: at,
      origin: "session",
      agentIntent: intent,
      agentDelivery: delivery,
      agentNotice:
        delivery === "wake"
          ? `[agent message · ${intent}] a peer session ASSIGNED this session work (run ${input.runId}, ${input.input.length} chars).`
          : `[agent message · ${intent}] a peer session reported to this session (run ${input.runId}, ${input.input.length} chars).`,
    };
    turns.push(turn);
    this.turnsBySession.set(sessionId, turns);
    this.append(sessionId, { type: "turn.accepted", turn, replayed: false }, input.runId);
    this.sessions.set(sessionId, { ...session, updatedAt: at, activity: delivery === "wake" ? "queued" : session.activity });

    if (delivery === "wake") this.startWorker(sessionId, turn);
    return { turn, replayed: false };
  }

  /** The fake project worker: a delay, a journal, and an ending. */
  private startWorker(sessionId: string, turn: Turn): void {
    const shouldFail = this.failOnce;
    if (shouldFail) this.failOnce = false;
    const work = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        try {
          this.runWorker(sessionId, turn, shouldFail);
        } finally {
          resolve();
        }
      }, this.workerDelayMs);
      this.timers.add(timer);
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private runWorker(sessionId: string, turn: Turn, fail: boolean): void {
    this.counts.workerRuns += 1;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.append(sessionId, { type: "turn.started" }, turn.runId);

    if (fail) {
      this.counts.workerFailures += 1;
      const failure = { code: "driver_failed", message: "the fixture worker was told to fail once" } as const;
      this.append(sessionId, { type: "turn.failed", ...failure }, turn.runId);
      this.patchTurn(sessionId, turn.runId, { state: "failed", completedAt: this.tick(), failure });
      this.sessions.set(sessionId, { ...session, activity: "idle", lastTurnFailed: true, updatedAt: this.tick() });
      this.fire(sessionId, "turn_failed", turn.runId);
      return;
    }

    const resultText = `Done. Worked on: ${turn.input.slice(0, 80)}`;
    this.append(sessionId, { type: "turn.completed", resultText }, turn.runId);
    this.patchTurn(sessionId, turn.runId, { state: "completed", completedAt: this.tick(), resultText });
    this.sessions.set(sessionId, { ...session, activity: "idle", lastTurnFailed: false, updatedAt: this.tick() });
    this.fire(sessionId, "turn_completed", turn.runId);
  }

  private patchTurn(sessionId: string, runId: string, patch: Partial<Turn>): void {
    const turns = this.turnsBySession.get(sessionId) ?? [];
    const index = turns.findIndex((turn) => turn.runId === runId);
    if (index >= 0) turns[index] = { ...turns[index], ...patch, updatedAt: this.tick() } as Turn;
  }

  /** Deliver a wake to every subscription that asked for this kind. Recorded,
   *  not dispatched: there is no second agent in this process to wake. */
  private fire(targetSessionId: string, kind: WakeKind, runId: string): void {
    for (const sub of [...this.subs]) {
      if (sub.targetSessionId !== targetSessionId) continue;
      if (!sub.events.includes(kind)) continue;
      this.wakes.push({
        subscriptionId: sub.id,
        subscriberSessionId: sub.subscriberSessionId,
        targetSessionId,
        kind,
        runId,
        at: this.tick(),
      });
      if (sub.once) this.subs.splice(this.subs.indexOf(sub), 1);
    }
  }

  private append(sessionId: string, body: Record<string, unknown>, runId?: string): void {
    const journal = this.journals.get(sessionId) ?? [];
    this.eventSeq += 1;
    journal.push({ id: this.eventSeq, at: this.tick(), sessionId, ...(runId ? { runId } : {}), ...body } as EngineEvent);
    this.journals.set(sessionId, journal);
  }

  // ── subscriptions ─────────────────────────────────────────────────────────

  subscribe(subscriberSessionId: string, input: { targetSessionId: string; events?: WakeKind[]; once?: boolean }): Subscription {
    this.session(input.targetSessionId);
    const sub: Subscription = {
      id: this.id("sub"),
      subscriberSessionId,
      targetSessionId: input.targetSessionId,
      events: input.events?.length ? input.events : (["turn_completed", "turn_failed", "turn_stopped", "request_opened"] as WakeKind[]),
      ...(input.once === false ? {} : { once: true }),
      createdAt: this.tick(),
    };
    this.subs.push(sub);
    return sub;
  }

  unsubscribe(subscriptionId: string, subscriberSessionId: string): boolean {
    const index = this.subs.findIndex((sub) => sub.id === subscriptionId && sub.subscriberSessionId === subscriberSessionId);
    if (index < 0) return false;
    this.subs.splice(index, 1);
    return true;
  }

  subscriptions(subscriberSessionId: string): Subscription[] {
    return this.subs.filter((sub) => sub.subscriberSessionId === subscriberSessionId);
  }

  // ── requests ──────────────────────────────────────────────────────────────

  requests(sessionId: string): EngineRequest[] {
    return this.requestsBySession.get(sessionId) ?? [];
  }

  openRequest(sessionId: string, detail: EngineRequest["detail"], runId = "run_fixture"): EngineRequest {
    const request: EngineRequest = {
      id: this.id("req"),
      runId,
      sessionId,
      state: "open",
      detail,
      openedAt: this.tick(),
    };
    const list = this.requestsBySession.get(sessionId) ?? [];
    list.push(request);
    this.requestsBySession.set(sessionId, list);
    this.append(sessionId, { type: "request.opened", request }, runId);
    this.fire(sessionId, "request_opened", runId);
    return request;
  }

  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "acceptForSession" | "decline"; reason?: string; answers?: Record<string, string> },
  ): EngineRequest {
    const list = this.requestsBySession.get(sessionId) ?? [];
    const index = list.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error(`No request goes by "${requestId}" on "${sessionId}".`);
    const resolved: EngineRequest = {
      ...list[index],
      state: "resolved",
      decision: input.decision,
      resolvedBy: "session",
      resolvedAt: this.tick(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.answers ? { answers: input.answers } : {}),
    };
    list[index] = resolved;
    return resolved;
  }

  stop(sessionId: string): { stopped: Turn[]; live?: Turn } {
    const turns = this.turnsBySession.get(sessionId) ?? [];
    const live = turns.filter((turn) => turn.state === "queued" || turn.state === "claimed" || turn.state === "running");
    for (const turn of live) this.patchTurn(sessionId, turn.runId, { state: "stopped", stopReason: "agent", completedAt: this.tick() });
    const stopped = (this.turnsBySession.get(sessionId) ?? []).filter((turn) => live.some((one) => one.runId === turn.runId));
    return { stopped, ...(stopped[0] ? { live: stopped[0] } : {}) };
  }

  // ── notes ─────────────────────────────────────────────────────────────────

  notes(projectId: string): ProjectNote[] {
    return this.notesByProject.get(projectId) ?? [];
  }

  seedNote(projectId: string, input: { title: string; body: string; pinned?: boolean; author?: ProjectNote["author"] }): ProjectNote {
    return this.writeNote(projectId, { ...input, author: input.author ?? "you" });
  }

  writeNote(projectId: string, input: { title: string; body: string; pinned?: boolean; author?: ProjectNote["author"] }): ProjectNote {
    const at = this.tick();
    const note: ProjectNote = {
      id: this.id("note"),
      projectId,
      title: input.title,
      body: input.body,
      ...(input.pinned ? { pinned: true } : {}),
      created: { label: "created", at },
      updated: { label: "updated", at },
      author: input.author ?? "session",
      schemaVersion: 1,
    };
    const list = this.notesByProject.get(projectId) ?? [];
    list.push(note);
    this.notesByProject.set(projectId, list);
    return note;
  }

  updateNote(projectId: string, noteId: string, patch: { title?: string; body?: string; pinned?: boolean }): ProjectNote | null {
    const list = this.notesByProject.get(projectId) ?? [];
    const index = list.findIndex((note) => note.id === noteId);
    if (index < 0) return null;
    const next: ProjectNote = {
      ...list[index],
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updated: { label: "updated", at: this.tick() },
    };
    list[index] = next;
    return next;
  }

  removeNote(projectId: string, noteId: string): boolean {
    const list = this.notesByProject.get(projectId) ?? [];
    const index = list.findIndex((note) => note.id === noteId);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  findNote(noteId: string): { note: ProjectNote; projectId: string } | null {
    for (const [projectId, list] of this.notesByProject) {
      const note = list.find((one) => one.id === noteId);
      if (note) return { note, projectId };
    }
    return null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Await every worker run already scheduled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Drop every timer. Nothing this fixture started may outlive the test. */
  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
