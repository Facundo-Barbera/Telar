import type { AgentModelChoice, ModelSelection, ProviderDriverKind, RuntimeMode, TurnAttachment } from "../protocol/common";
import type { Cohort, Session, SessionOrigin, SubscribedCohort, Subscription, Turn, WakeKind } from "../protocol/entities";
import type { AgentTurnInput } from "../protocol/observations";
import type { TaskOutputPage } from "../protocol/tasks";
import type { EngineTransport } from "../platform/transport";
import {
  snapshotQuery,
  type HeldReports,
  type LiveSessionsAnswer,
  type LiveSessionsUnchanged,
  type SessionBootstrap,
  type SessionCapabilities,
  type SessionGrepAnswer,
  type SessionOutlineAnswer,
  type SessionSearchAnswer,
  type SessionSettleEnded,
  type SessionSnapshot,
  type SnapshotWindow,
} from "./schema";

type SessionPatch = {
  title?: string;
  runtimeMode?: RuntimeMode;
  detached?: boolean;
  model?: ModelSelection | null;
  /** `null` hands the session back to the inactivity rule. */
  settledOverride?: "settled" | "active" | null;
  /** `null` cancels the snooze. */
  snoozedUntil?: number | null;
  /** `null` returns to the driver's default. */
  resumeAfterRateLimit?: boolean | null;
};

type Settled = Promise<{ session: Session; ended?: SessionSettleEnded }>;

export const sessionPath = (sessionId: string) => `/v2/sessions/${encodeURIComponent(sessionId)}`;

/** `?a=1&b=2` from the defined entries, or nothing. */
export function queryOf(fields: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, String(value));
  return params.size > 0 ? `?${params.toString()}` : "";
}

export const sessionsClient = {
  listSessions(this: EngineTransport, projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions${queryOf({ projectId })}`);
  },

  liveSessions(this: EngineTransport, options: { all?: boolean } = {}): Promise<LiveSessionsAnswer> {
    return this.request("GET", options.all ? "/v2/sessions/live?all=1" : "/v2/sessions/live");
  },

  liveSessionsSince(this: EngineTransport, since: number): Promise<(LiveSessionsAnswer & { unchanged?: false }) | LiveSessionsUnchanged> {
    return this.request("GET", `/v2/sessions/live${queryOf({ since })}`);
  },

  createSession(
    this: EngineTransport,
    input: {
      draft?: boolean;
      id?: string;
      projectId: string;
      title?: string;
      detached?: boolean;
      envMode?: "local" | "worktree";
      driver?: ProviderDriverKind;
      /** Must live under `loom/` or `telar/`; the engine refuses anything else. */
      branchSlug?: string;
      baseRef?: string;
      branchName?: string;
      origin?: SessionOrigin;
      ceilingFrom?: string;
      model?: AgentModelChoice;
      proof?: AgentTurnInput["proof"];
    },
  ): Promise<{ session: Session }> {
    return this.request("POST", "/v2/sessions", input);
  },

  sessionCapabilities(this: EngineTransport, caller?: string): Promise<SessionCapabilities> {
    return this.request("GET", `/v2/sessions/capabilities${queryOf({ caller })}`);
  },

  /** Reading it mints and reveals the `sessions` MCP socket's secret. */
  sessionsMcpInfo(this: EngineTransport): Promise<{ mcp: { url: string; secret: string; addCommand: string } }> {
    return this.request("GET", "/v2/sessions/mcp-info");
  },

  markSessionRead(this: EngineTransport, sessionId: string, runId: string): Promise<{ session: Session }> {
    return this.request("POST", `${sessionPath(sessionId)}/read`, { runId });
  },

  updateSession(this: EngineTransport, sessionId: string, patch: SessionPatch): Settled {
    return this.request("PATCH", sessionPath(sessionId), patch);
  },

  regenerateSessionTitle(this: EngineTransport, sessionId: string): Promise<{ session: Session; changed: boolean }> {
    return this.request("POST", `${sessionPath(sessionId)}/regenerate-title`, {});
  },

  settleSession(this: EngineTransport, sessionId: string, settled: boolean): Settled {
    return this.request("PATCH", sessionPath(sessionId), { settledOverride: settled ? "settled" : "active" });
  },

  /** Peer notifications waiting for this session's next turn. */
  sessionHeldReports(this: EngineTransport, sessionId: string): Promise<HeldReports> {
    return this.request("GET", `${sessionPath(sessionId)}/held-reports`);
  },

  session(this: EngineTransport, sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot> {
    return this.request("GET", `${sessionPath(sessionId)}${snapshotQuery(window)}`);
  },

  sessionBootstrap(this: EngineTransport, sessionId: string, window?: SnapshotWindow): Promise<SessionBootstrap> {
    return this.request("GET", `${sessionPath(sessionId)}/bootstrap${snapshotQuery(window)}`);
  },

  findSessions(this: EngineTransport, query: { q: string; projectId?: string; settled?: boolean; since?: number; limit?: number }): Promise<SessionSearchAnswer> {
    const settled = query.settled === undefined ? undefined : query.settled ? "1" : "0";
    return this.request("GET", `/v2/sessions/find${queryOf({ ...query, settled })}`);
  },

  /** One row per turn, newest first. */
  sessionOutline(this: EngineTransport, sessionId: string, options: { limit?: number; before?: number } = {}): Promise<SessionOutlineAnswer> {
    return this.request("GET", `${sessionPath(sessionId)}/outline${queryOf(options)}`);
  },

  /** Substring, not a regular expression; newest first. */
  grepSession(this: EngineTransport, sessionId: string, pattern: string, options: { limit?: number; before?: number } = {}): Promise<SessionGrepAnswer> {
    return this.request("GET", `${sessionPath(sessionId)}/grep${queryOf({ pattern, ...options })}`);
  },

  stopSession(this: EngineTransport, sessionId: string, by: "user" | "agent" = "user", commandId?: string): Promise<{ stopped: Turn[]; live?: Turn }> {
    return this.request("POST", `${sessionPath(sessionId)}/stop`, { scope: "session", by, commandId });
  },

  stopBackgroundTasks(this: EngineTransport, sessionId: string): Promise<{ stopped: number }> {
    return this.request("POST", `${sessionPath(sessionId)}/stop-background`, {});
  },

  /** From byte `after`, or the tail without it. */
  taskOutput(this: EngineTransport, sessionId: string, taskId: string, after?: number): Promise<TaskOutputPage> {
    return this.request("GET", `${sessionPath(sessionId)}/tasks/${encodeURIComponent(taskId)}/output${queryOf({ after })}`);
  },

  /** Stops the session; never creates a latch. */
  pauseSession(this: EngineTransport, sessionId: string, by: "human" | "session" = "human"): Promise<{ session: Session; stopped?: Turn; held: number; already: boolean }> {
    return this.request("POST", `${sessionPath(sessionId)}/pause`, { by });
  },

  /** The held backlog runs in order. */
  resumeSession(this: EngineTransport, sessionId: string): Promise<{ session: Session; released: number; already: boolean }> {
    return this.request("POST", `${sessionPath(sessionId)}/resume`, {});
  },

  /** Frees the worktree and keeps the branch. */
  archiveSession(this: EngineTransport, sessionId: string): Promise<{ session: Session }> {
    return this.request("POST", `${sessionPath(sessionId)}/archive`, {});
  },

  deleteSession(this: EngineTransport, sessionId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", sessionPath(sessionId));
  },

  sessionTable(
    this: EngineTransport,
    sessionId: string,
    path: string,
    options: { offset: number; limit: number; sort?: string; desc?: boolean },
  ): Promise<{ path: string; columns: string[]; dtypes?: string[]; total: number; offset: number; rows: unknown[][]; truncated?: boolean }> {
    return this.request("GET", `${sessionPath(sessionId)}/data/table${queryOf({ path, offset: options.offset, limit: options.limit, sort: options.sort || undefined, desc: options.desc ? "1" : undefined })}`);
  },

  /** Newest first, optionally by tag (`plot`). */
  attachments(this: EngineTransport, sessionId: string, options: { tag?: string } = {}): Promise<{ attachments: TurnAttachment[] }> {
    return this.request("GET", `${sessionPath(sessionId)}/attachments${queryOf({ tag: options.tag || undefined })}`);
  },

  /** Replaces the tags; how a plot is pinned. */
  tagAttachment(this: EngineTransport, sessionId: string, attachmentId: string, tags: string[]): Promise<{ attachment: TurnAttachment }> {
    return this.request("PATCH", `${sessionPath(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { tags });
  },

  /** Immutable: the id is minted per write. */
  attachmentBytes(this: EngineTransport, sessionId: string, attachmentId: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`${sessionPath(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`);
  },

  subscribe(
    this: EngineTransport,
    sessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Promise<{ subscription: Subscription }> {
    return this.request("POST", `${sessionPath(sessionId)}/subscriptions`, input);
  },

  subscriptions(this: EngineTransport, sessionId: string): Promise<{ subscriptions: Subscription[] }> {
    return this.request("GET", `${sessionPath(sessionId)}/subscriptions`);
  },

  subscribeCohort(
    this: EngineTransport,
    sessionId: string,
    input: { sessionIds: string[]; timeoutMinutes?: number; completionWake?: Cohort["completionWake"] },
  ): Promise<{ cohort: SubscribedCohort }> {
    return this.request("POST", `${sessionPath(sessionId)}/cohorts`, input);
  },

  cohorts(this: EngineTransport, sessionId: string): Promise<{ cohorts: Cohort[] }> {
    return this.request("GET", `${sessionPath(sessionId)}/cohorts`);
  },

  /** `subscriberSessionId` limits the delete to that session's own subscription. */
  unsubscribe(this: EngineTransport, subscriptionId: string, input: { subscriberSessionId?: string } = {}): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`, input);
  },
};
