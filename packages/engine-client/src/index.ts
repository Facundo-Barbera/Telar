import type { EngineTransport } from "./platform/transport";
import { runBase } from "./terminal/client";
import { domainClients, type EngineDomainMethods } from "./platform/domains";
import type { InboxPolicy, SidebarLayout } from "./settings/schema";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineDiscovery,
  type TurnAttachment,
  type TaskOutputPage,
  type TurnModelSelection,
  type EngineErrorBody,
  type EngineErrorCode,
  type EngineEvent,
  type EngineHealth,
  type EventPage,
  type Item,
  type ModelSelection,
  type Project,
  type ProviderDriverKind,
  type LiveSessionRow,
  type Session,
  type SessionOrigin,
  type Subscription,
  type Cohort,
  type SubscribedCohort,
  type Task,
  type EngineRequest,
  type RequestDecision,
  type RequestDefault,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type RuntimeMode,
  type Turn,
  type TurnObservation,
  type TurnSubmissionResult,
  type UsageSnapshot,
  type WakeKind,
  type WorkerClaim,
  type ProviderTurnOpenInput,
  type AgentTurnInput,
  type WorkerStatus,
  type WorkerTurnFailure,
  type SessionAssignment,
} from "./protocol";

export * from "./protocol";
export * from "./notes/schema";
export * from "./plugins/schema";
export * from "./plugins/toolchains";
export * from "./projects/workspace";
export * from "./prompts/schema";
export * from "./providers/compaction";
export * from "./providers/schema";
export * from "./schedules/schema";
export * from "./settings/schema";
export * from "./storage/schema";
export * from "./terminal/schema";
export type { RunTargetInput } from "./terminal/client";
export * from "./usage/schema";
export * from "./worktrees/schema";
export * from "./agent-tools/schema";
export * from "./computer-use/schema";
export * from "./appearance/schema";
export * from "./dictation/schema";
export * from "./files/schema";
export * from "./hosts/schema";
export * from "./push/schema";
export * from "./updates/schema";
export * from "./git/schema";
export * from "./github/query";
export * from "./github/schema";
export * from "./icons";

/** `?turns=N[&before=runId]`, or nothing — spelled once for every caller. */
export function snapshotQuery(window?: SnapshotWindow): string {
  if (!window) return "";
  const params = new URLSearchParams({ turns: String(window.turns) });
  if (window.before !== undefined) params.set("before", window.before);
  return `?${params.toString()}`;
}

function query(params: URLSearchParams): string {
  const written = params.toString();
  return written ? `?${written}` : "";
}

export function sanitizeTransportCause(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  let name: string | undefined;
  // The interesting code is usually one or two links down the `cause` chain
  // (TypeError → Error → SystemError), so walk it — bounded, and cycle-safe.
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === undefined && typeof record.name === "string" && /^[A-Za-z]{1,40}$/.test(record.name)) name = record.name;
    // Errno-shaped only: an arbitrary string here could be anything.
    if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(record.code)) return name ? `${name}:${record.code}` : record.code;
    current = record.cause;
  }
  return name;
}

export class EngineClientError extends Error {
  readonly code: EngineErrorCode;
  readonly status?: number;
  readonly operation?: string;
  /** The sanitized transport cause; absent on an HTTP error, which has a status. */
  readonly transport?: string;

  constructor(code: EngineErrorCode, message: string, status?: number, details?: { operation?: string; transport?: string }) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
    this.status = status;
    if (details?.operation !== undefined) this.operation = details.operation;
    if (details?.transport !== undefined) this.transport = details.transport;
  }
}

export type FetchLike = typeof fetch;

export type SessionSettleEnded = { terminals: number; backgroundTasks: number };

export type SnapshotPage = {
  /** Oldest settled turn on this page — the `before` for the next page up. */
  before: string | null;
  /** Are there settled turns above this page? */
  more: boolean;
  total?: number;
};

/** How much of a session to read. Omit for the whole thing. */
export type SnapshotWindow = {
  /** Newest N settled turns (unsettled ones always ride along). */
  turns: number;
  /** Page cursor from a previous read's `page.before`. */
  before?: string;
};

/** What `GET /v2/sessions/:id` answers with — the snapshot a client opens on
 *  so it does not have to replay the journal from zero. */
export type SessionSnapshot = {
  cursor?: number;
  page?: SnapshotPage;
  session: Session;
  turns: Turn[];
  items: Item[];
  requests: EngineRequest[];
  assignments?: SessionAssignment[];
  tasks: Task[];
};

/** What `GET /v2/sessions/:id/held-reports` answers with: peer notifications waiting for the next turn. */
export type HeldReports = { held: number };

/** One hit from `GET /v2/sessions/find`, quoting the line that matched. */
export type SessionSearchHit = {
  id: string;
  title?: string;
  projectId?: string;
  activity: string;
  updatedAt: number;
  runId?: string;
  /** The matching line, clamped — so a chooser is not taking the engine's word
   *  for the match. */
  why: string;
};

export type SessionSearchAnswer = {
  sessions: SessionSearchHit[];
  /** Which index answered — FTS5 where this engine's sqlite has it, a bounded
   *  `LIKE` scan where it does not. Reported so a caller comparing two engines'
   *  results is never guessing. */
  index: "fts5" | "like";
  more: boolean;
};

/** One turn as an outline page draws it — `turn-summary.ts`'s `OutlineRow`. */
export type SessionOutlineRow = {
  runId: string;
  sequence: number;
  origin?: Turn["origin"];
  state: Turn["state"];
  input: string;
  items: number;
  /** The first line of the answer, clamped. */
  answer: string;
  answerChars: number;
  endedAt?: number;
  failure?: string;
};

export type SessionOutlineAnswer = {
  turns: SessionOutlineRow[];
  total: number;
  more: boolean;
  next?: number;
};

/** One step of one run, as the list shows it. `bytes` is what lets a caller
 *  choose which step it can afford before it fetches one. */
export type RunItemRow = {
  index: number;
  id: string;
  title: string;
  status: Item["status"];
  bytes: number;
};

export type RunItemsAnswer = { items: RunItemRow[] };

export type RunItemRead = {
  index: number;
  id: string;
  title: string;
  status: Item["status"];
  startedAt: number;
  completedAt?: number;
  taskId?: string;
  text: string;
  totalChars: number;
  more: boolean;
};

export type TurnAnswerRead = {
  runId: string;
  sequence: number;
  text: string;
  from: number;
  totalChars: number;
  more: boolean;
  next?: number;
};

/** One place a phrase appears in a session's journal, with the line around it. */
export type SessionGrepMatch = {
  /** The journal event's id — also the `before` cursor for the next page. */
  id: number;
  at: number;
  type: string;
  runId?: string;
  context: string;
};

export type SessionGrepAnswer = { matches: SessionGrepMatch[]; more: boolean; next?: number };

export type SessionBootstrap = SessionSnapshot & {
  /**
   * The journal from `cursor`. Empty on a quiet session, which is the ordinary
   * case and the point: nobody pays a round trip to be told nothing happened.
   * A client's own cursor after applying this is `max(cursor, last event id)`.
   */
  events: EngineEvent[];
  /** Who this conversation has asked to be woken by — the same list
   *  `GET /v2/sessions/:id/subscriptions` answers with. */
  subscriptions: Subscription[];
};

export type LiveSessionsAnswer = {
  sessions: LiveSessionRow[];
  projects: Project[];
  assignments?: Record<string, SessionAssignment[]>;
  layout?: SidebarLayout;
  daemonId?: string;
  inbox?: InboxPolicy;
  revision?: number;
  settledCount?: number;
  terminals?: Record<string, number>;
  /** The discriminant, present only so `unchanged` narrows this union in a
   *  caller rather than needing a cast. Never sent on the wire. */
  unchanged?: false;
};

export type LiveSessionsUnchanged = { unchanged: true; revision: number; daemonId?: string };

export { diffBaseQuery, filePatchQuery, parseDiffBaseQuery, parseFilePatchQuery, type DiffBaseOption, type FilePatchOptions } from "./git/diff-query";
export { mountRootsFor, volumeSupportOn, type VolumeSupport } from "./mounts";

export interface EngineClient extends EngineDomainMethods {}

export class EngineClient implements EngineTransport {
  constructor(
    readonly discovery: EngineDiscovery,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal, operation?: string): Promise<T> {
    const named = operation === undefined ? {} : { operation };
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.discovery.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      // An abort is the caller hanging up, not the engine being away — rethrow
      // it as itself so a forwarding route can end quietly.
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, {
        ...named,
        ...(sanitizeTransportCause(cause) ? { transport: sanitizeTransportCause(cause)! } : {}),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status, { ...named, transport: "malformed_response" });
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      const code: EngineErrorCode = error?.code ?? "engine_unavailable";
      throw new EngineClientError(code, error?.message ?? "engine request failed", response.status, named);
    }
    return payload as T;
  }

  private async requestConditional<T>(
    pathname: string,
    etag: string | undefined,
  ): Promise<{ unchanged: true; etag?: string } | { unchanged: false; payload: T; etag?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.discovery.token}`,
          ...(etag ? { "if-none-match": etag } : {}),
        },
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, sanitizeTransportCause(cause) ? { transport: sanitizeTransportCause(cause)! } : {});
    }
    const tag = response.headers.get("etag") ?? undefined;
    if (response.status === 304) return { unchanged: true, ...(tag ? { etag: tag } : {}) };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status, { transport: "malformed_response" });
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status);
    }
    return { unchanged: false, payload: payload as T, ...(tag ? { etag: tag } : {}) };
  }

  /** The same envelope as `request`, for a body that is not JSON. Kept separate
   *  rather than generalised: exactly one route takes bytes, and folding the
   *  two would put a `content-type` branch on every call in this class. */
  private async requestBytes<T>(method: string, pathname: string, bytes: Uint8Array, headers: Record<string, string>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${this.discovery.token}`, ...headers },
        // A fresh copy: `BodyInit` will not take a `Uint8Array` view whose
        // buffer may be shared, and the caller's array often is one.
        body: new Uint8Array(bytes) as unknown as BodyInit,
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "engine is unreachable");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status);
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status);
    }
    return payload as T;
  }

  health(): Promise<EngineHealth> {
    return this.request("GET", "/v2/health");
  }

  sessionsStream(): { url: string; headers: Record<string, string> } {
    return {
      url: `http://${this.discovery.host}:${this.discovery.port}/v2/sessions/stream`,
      headers: { authorization: `Bearer ${this.discovery.token}` },
    };
  }

  completeStructured(
    input: { prompt: string; schema: Record<string, unknown>; model?: string; effort?: "low" | "medium" | "high" },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ result: Record<string, unknown> }> {
    return this.request("POST", "/v2/textgen/complete", input, options.signal);
  }

  listSessions(projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  liveSessions(options: { all?: boolean } = {}): Promise<LiveSessionsAnswer> {
    return this.request("GET", options.all ? "/v2/sessions/live?all=1" : "/v2/sessions/live");
  }

  liveSessionsSince(since: number): Promise<(LiveSessionsAnswer & { unchanged?: false }) | LiveSessionsUnchanged> {
    return this.request("GET", `/v2/sessions/live?since=${encodeURIComponent(String(since))}`);
  }

  async liveSessionsMatching(
    options: { etag?: string; all?: boolean } = {},
  ): Promise<{ notModified: true; etag: string } | (LiveSessionsAnswer & { notModified?: false; etag?: string })> {
    const pathname = options.all ? "/v2/sessions/live?all=1" : "/v2/sessions/live";
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.discovery.token}`,
          ...(options.etag === undefined ? {} : { "if-none-match": options.etag }),
        },
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, {
        operation: "liveSessionsMatching",
        ...(sanitizeTransportCause(cause) ? { transport: sanitizeTransportCause(cause)! } : {}),
      });
    }
    const etag = response.headers.get("etag") ?? undefined;
    if (response.status === 304) {
      return { notModified: true, etag: etag ?? options.etag ?? "" };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status, { operation: "liveSessionsMatching", transport: "malformed_response" });
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status, { operation: "liveSessionsMatching" });
    }
    return { ...(payload as LiveSessionsAnswer), ...(etag === undefined ? {} : { etag }) };
  }

  createSession(input: {
    draft?: boolean;
    id?: string;
    projectId: string;
    title?: string;
    detached?: boolean;
    envMode?: "local" | "worktree";
    /** Which provider runs this session's turns. Defaults to Claude. */
    driver?: ProviderDriverKind;
    /** Proposed branch for a worktree session, e.g. `loom/<loom>/<thread>`.
     *  Must live under `loom/` or `telar/`; the engine refuses anything else. */
    branchSlug?: string;
    baseRef?: string;
    branchName?: string;
    origin?: SessionOrigin;
    ceilingFrom?: string;
  }): Promise<{ session: Session }> {
    return this.request("POST", "/v2/sessions", input);
  }

  /**
   * Where the outward `sessions` MCP socket listens, and its dedicated secret.
   * Behind the normal bearer, because reading it mints and reveals a
   * credential.
   */
  sessionsMcpInfo(): Promise<{ mcp: { url: string; secret: string; addCommand: string } }> {
    return this.request("GET", "/v2/sessions/mcp-info");
  }

  markSessionRead(sessionId: string, runId: string): Promise<{ session: Session }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/read`, { runId });
  }

  updateSession(
    sessionId: string,
    patch: {
      title?: string;
      runtimeMode?: RuntimeMode;
      detached?: boolean;
      model?: ModelSelection | null;
      /** Shelve or pin this session in the list. `null` hands it back to the
       *  inactivity rule — see `Session.settledOverride`. */
      settledOverride?: "settled" | "active" | null;
      /** Hide it until this instant. `null` cancels. */
      snoozedUntil?: number | null;
      /** Sit out a usage limit and carry on. `null` returns the session to the
       *  driver's default — see `Session.resumeAfterRateLimit`. */
      resumeAfterRateLimit?: boolean | null;
    },
  ): Promise<{ session: Session; ended?: SessionSettleEnded }> {
    return this.request("PATCH", `/v2/sessions/${encodeURIComponent(sessionId)}`, patch);
  }

  settleSession(sessionId: string, settled: boolean): Promise<{ session: Session; ended?: SessionSettleEnded }> {
    return this.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" });
  }

  /** How many peer notifications are waiting for this session's next turn. */
  sessionHeldReports(sessionId: string): Promise<HeldReports> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/held-reports`);
  }

  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}${snapshotQuery(window)}`);
  }

  sessionBootstrap(sessionId: string, window?: SnapshotWindow): Promise<SessionBootstrap> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/bootstrap${snapshotQuery(window)}`);
  }

  events(sessionId: string, after = 0, limit?: number): Promise<EventPage> {
    const bound = limit === undefined ? "" : `&limit=${limit}`;
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/events?after=${after}${bound}`);
  }

  eventsIfChanged(
    sessionId: string,
    after = 0,
    limit?: number,
    etag?: string,
  ): Promise<{ unchanged: true; etag?: string } | { unchanged: false; payload: EventPage; etag?: string }> {
    const bound = limit === undefined ? "" : `&limit=${limit}`;
    return this.requestConditional<EventPage>(`/v2/sessions/${encodeURIComponent(sessionId)}/events?after=${after}${bound}`, etag);
  }

  findSessions(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit?: number }): Promise<SessionSearchAnswer> {
    const search = new URLSearchParams({ q: query.q });
    if (query.projectId !== undefined) search.set("projectId", query.projectId);
    if (query.settled !== undefined) search.set("settled", query.settled ? "1" : "0");
    if (query.since !== undefined) search.set("since", String(query.since));
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    return this.request("GET", `/v2/sessions/find?${search.toString()}`);
  }

  /** Scroll a conversation: one row per turn, newest first. */
  sessionOutline(sessionId: string, options: { limit?: number; before?: number } = {}): Promise<SessionOutlineAnswer> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.before !== undefined) search.set("before", String(options.before));
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/outline${query(search)}`);
  }

  /** What one run did, as a list to choose from — `bytes` per step. */
  runItems(sessionId: string, runId: string): Promise<RunItemsAnswer> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/items`);
  }

  runItem(sessionId: string, runId: string, step: number | string, options: { maxChars?: number } = {}): Promise<RunItemRead> {
    const search = new URLSearchParams();
    if (options.maxChars !== undefined) search.set("maxChars", String(options.maxChars));
    return this.request(
      "GET",
      `/v2/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(String(step))}${query(search)}`,
    );
  }

  /** What one turn concluded — the answer alone, sliced, with its true length. */
  turnAnswer(sessionId: string, options: { runId?: string; from?: number; limit?: number } = {}): Promise<TurnAnswerRead> {
    const search = new URLSearchParams();
    if (options.runId !== undefined) search.set("runId", options.runId);
    if (options.from !== undefined) search.set("from", String(options.from));
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/answer${query(search)}`);
  }

  /** Where a phrase appears in one session's journal, newest first. Substring,
   *  not a regular expression — see `grepEvents`. */
  grepSession(sessionId: string, pattern: string, options: { limit?: number; before?: number } = {}): Promise<SessionGrepAnswer> {
    const search = new URLSearchParams({ pattern });
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.before !== undefined) search.set("before", String(options.before));
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/grep?${search.toString()}`);
  }

  async drainEvents(sessionId: string, after = 0, options?: { limit?: number; pages?: number }): Promise<EventPage> {
    const pages = options?.pages ?? 100;
    let cursor = after;
    let events: EngineEvent[] = [];
    for (let page = 0; page < pages; page += 1) {
      const read = await this.events(sessionId, cursor, options?.limit);
      events = events.length ? [...events, ...read.events] : read.events;
      cursor = Math.max(cursor, read.cursor);
      if (!read.more) return { events, cursor, more: false };
    }
    return { events, cursor, more: true, next: cursor };
  }

  submitTurn(
    sessionId: string,
    input: { runId: string; input: string; kind?: "message" | "compact"; model?: TurnModelSelection; attachments?: string[] },
  ): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns`, input);
  }

  submitAgentTurn(sessionId: string, input: AgentTurnInput): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/agent`, input);
  }

  ds<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/ds/${method}`, body ?? {});
  }

  latex<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/latex/${method}`, body ?? {});
  }

  plugin<T>(sessionId: string, pluginId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/plugins/${pluginId}/${method}`, body ?? {});
  }

  runStream(sessionId: string): { url: string; headers: Record<string, string> } {
    return {
      url: `http://${this.discovery.host}:${this.discovery.port}${runBase(sessionId)}/stream`,
      headers: { authorization: `Bearer ${this.discovery.token}` },
    };
  }

  /** A window of rows from a CSV, TSV or Parquet file in the session's tree. */
  sessionTable(
    sessionId: string,
    path: string,
    options: { offset: number; limit: number; sort?: string; desc?: boolean },
  ): Promise<{ path: string; columns: string[]; dtypes?: string[]; total: number; offset: number; rows: unknown[][]; truncated?: boolean }> {
    const query = new URLSearchParams({ path, offset: String(options.offset), limit: String(options.limit), ...(options.sort ? { sort: options.sort } : {}), ...(options.desc ? { desc: "1" } : {}) });
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/data/table?${query.toString()}`);
  }

  /** The session's attachment index, optionally by tag (`plot`). Newest first. */
  attachments(sessionId: string, options: { tag?: string } = {}): Promise<{ attachments: TurnAttachment[] }> {
    const suffix = options.tag ? `?tag=${encodeURIComponent(options.tag)}` : "";
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/attachments${suffix}`);
  }

  /** Replace an attachment's tags — how a plot is pinned. */
  tagAttachment(sessionId: string, attachmentId: string, tags: string[]): Promise<{ attachment: TurnAttachment }> {
    return this.request("PATCH", `/v2/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { tags });
  }

  /** The bytes behind an attachment. Immutable: the id is minted per write. */
  attachmentBytes(sessionId: string, attachmentId: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`/v2/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  async readBytes(pathAndQuery: string): Promise<{ data: Uint8Array; contentType: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathAndQuery}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.discovery.token}` },
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "engine is unreachable");
    }
    if (!response.ok) {
      const error = ((await response.json().catch(() => null)) as EngineErrorBody | null)?.error;
      throw new EngineClientError(error?.code ?? "engine_unavailable", error?.message ?? "engine request failed", response.status);
    }
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  async uploadAttachment(
    sessionId: string,
    file: { name: string; mediaType: string; data: ArrayBuffer | Uint8Array },
  ): Promise<{ attachment: TurnAttachment }> {
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    return this.requestBytes("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/attachments`, bytes, {
      "content-type": file.mediaType || "application/octet-stream",
      // Encoded, because a filename may hold anything a filesystem allows and a
      // header may not — a raw newline here would end the header block.
      "x-telar-attachment-name": encodeURIComponent(file.name),
    });
  }

  stopTurn(sessionId: string, runId?: string): Promise<{ turn?: Turn; stopped: boolean }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop`, { runId });
  }

  stopSession(sessionId: string, by: "user" | "agent" = "user", commandId?: string): Promise<{ stopped: Turn[]; live?: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop`, { scope: "session", by, commandId });
  }

  stopBackgroundTasks(sessionId: string): Promise<{ stopped: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop-background`, {});
  }

  /** A page of a background task's log from byte `after`; without it, the
   *  tail. The Processes tab's row polls this while the task runs. */
  taskOutput(sessionId: string, taskId: string, after?: number): Promise<TaskOutputPage> {
    const params = new URLSearchParams();
    if (after !== undefined) params.set("after", String(after));
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output${query(params)}`);
  }

  /** Deprecated compatibility alias for session Stop; never creates a latch. */
  pauseSession(sessionId: string, by: "human" | "session" = "human"): Promise<{ session: Session; stopped?: Turn; held: number; already: boolean }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/pause`, { by });
  }

  /** A human resumes: the pause comes off and its held backlog runs in order. */
  resumeSession(sessionId: string): Promise<{ session: Session; released: number; already: boolean }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/resume`, {});
  }

  /** End a session and free its worktree. The branch survives — it is the
   *  session's output, and destroying it is a separate human decision. */
  archiveSession(sessionId: string): Promise<{ session: Session }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/archive`, {});
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Explicit human resolution for a turn whose provider effects are uncertain. */
  /** Let a message recovery held run after a human has re-read it. */
  releaseHeldTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/release`, {});
  }

  resumeRateLimitedTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/resume`, {});
  }

  discardAmbiguousTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {});
  }

  promoteTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/promote`, {});
  }

  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(steerRunId)}/steer-ack`, {
      claimToken,
    });
  }

  registerWorker(workerId: string): Promise<{ worker: { workerId: string }; heartbeatIntervalMs?: number }> {
    return this.request("POST", "/v2/workers/register", { workerId }, undefined, "registerWorker");
  }

  /** Idempotent control: reports state and drains already-decided deliveries,
   *  so re-polling on the next tick cannot duplicate work. `signal` lets the
   *  caller bound it — a heartbeat that never resolves must not pin its loop. */
  workerHeartbeat(workerId: string, signal?: AbortSignal, acknowledgedTaskStops?: string[]): Promise<WorkerStatus> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/heartbeat`, { acknowledgedTaskStops }, signal, "workerHeartbeat");
  }

  claimTurn(workerId: string, claimSeq: number, signal?: AbortSignal): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/claim`, { claimSeq }, signal, "claimTurn");
  }

  openProviderTurn(sessionId: string, input: ProviderTurnOpenInput): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/provider`, input);
  }

  /** Task reports that arrive between turns; no claim, worker-authenticated. */
  reportSessionTasks(sessionId: string, workerId: string, observations: TurnObservation[]): Promise<{ accepted: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/tasks`, { workerId, observations });
  }

  markTurnRunning(sessionId: string, runId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/running`, { claimToken });
  }

  /** Batched: one round trip per delta would dominate the cost of streaming. */
  reportObservations(
    sessionId: string,
    runId: string,
    claimToken: string,
    observations: TurnObservation[],
  ): Promise<{ accepted: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/observe`, {
      claimToken,
      observations,
    });
  }

  /**
   * Ask whether a tool call may proceed. The engine applies the session's
   * runtime mode and either answers immediately or parks the request; a parked
   * answer arrives later on the heartbeat.
   */
  openRequest(
    sessionId: string,
    runId: string,
    claimToken: string,
    input: {
      requestId: string;
      kind: RequestKind;
      detail: RequestDetail;
      itemId?: string;
      deadlineMs?: number;
      default?: RequestDefault;
    },
  ): Promise<RequestOpenResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/request`, {
      claimToken,
      ...input,
    });
  }

  /**
   * A human answering a parked request — or, with `resolvedBy: "session"`,
   * another session doing so through the `sessions` toolkit. That is the only
   * resolver a caller may name; anything else is recorded as a human's.
   */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown>; resolvedBy?: "session" },
  ): Promise<{ request: EngineRequest }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input);
  }

  subscribe(
    sessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Promise<{ subscription: Subscription }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/subscriptions`, input);
  }

  subscriptions(sessionId: string): Promise<{ subscriptions: Subscription[] }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/subscriptions`);
  }

  subscribeCohort(
    sessionId: string,
    input: { sessionIds: string[]; timeoutMinutes?: number; completionWake?: Cohort["completionWake"] },
  ): Promise<{ cohort: SubscribedCohort }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/cohorts`, input);
  }

  cohorts(sessionId: string): Promise<{ cohorts: Cohort[] }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/cohorts`);
  }

  /** `subscriberSessionId` narrows the delete to that session's own
   *  subscription — a session may not remove another's. */
  unsubscribe(subscriptionId: string, input: { subscriberSessionId?: string } = {}): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v2/subscriptions/${encodeURIComponent(subscriptionId)}`, input);
  }

  /** `signal` bounds the settle: a terminal write that hangs must not park a
   *  worker's turn indefinitely. Idempotent by claim token, so a bounded
   *  attempt whose response is lost is safe to repeat. */
  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    result: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
    signal?: AbortSignal,
  ): Promise<{ turn: Turn }> {
    return this.request(
      "POST",
      `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/complete`,
      { claimToken, ...result },
      signal,
      "completeTurn",
    );
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: WorkerTurnFailure,
    signal?: AbortSignal,
  ): Promise<{ turn: Turn }> {
    return this.request(
      "POST",
      `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/fail`,
      { claimToken, ...failure },
      signal,
      "failTurn",
    );
  }
}

Object.assign(EngineClient.prototype, ...domainClients);

export { domainMethods, type EngineDomainMethods } from "./platform/domains";
export type { EngineTransport };

export { ENGINE_PROTOCOL_VERSION };
