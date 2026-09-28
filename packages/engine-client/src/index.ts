import { appearanceClient } from "./appearance/client";
import { dictationClient } from "./dictation/client";
import { notesClient } from "./notes/client";
import type { EngineTransport } from "./platform/transport";
import type { InboxPolicy, SidebarLayout } from "./settings/schema";
import { promptsClient } from "./prompts/client";
import { schedulesClient } from "./schedules/client";
import { settingsClient } from "./settings/client";
import { storageClient } from "./storage/client";
import { usageClient } from "./usage/client";
import { worktreesClient } from "./worktrees/client";
import { diffBaseQuery, filePatchQuery } from "./protocol/diff-query";
import type { DiffBaseOption, FilePatchOptions } from "./protocol/diff-query";
import {
  ENGINE_PROTOCOL_VERSION,
  EngineDiscovery,
  type BrowserSnapshot,
  type EnvMode,
  type GitCommitEntry,
  forgeQuery,
  type GitHubCheckLog,
  type GitHubFacets,
  type GitHubIssueFilter,
  type GitHubIssueRead,
  type GitHubMergeMethod,
  type GitHubMergeResult,
  type GitHubReactionContent,
  type GitHubReactionResult,
  type GitHubThreadReplyResult,
  type GitHubThreadResolveResult,
  type GitHubLineCommentInput,
  type GitHubLineCommentResult,
  type GitHubPullAnchor,
  type GitHubPullCreateResult,
  type GitHubPullFilter,
  type GitHubPullRead,
  type GitPushResult,
  type GitHubSnapshot,
  type GitignoreRemoval,
  type GitignoreResult,
  type ComputerUseGrant,
  type ComputerUseStatus,
  type RememberedLogin,
  type WorkspaceConfig,
  type ProjectWorkspaceOverrides,
  type ProjectWorkspaceView,
  type ModelCatalogue,
  type ModelOverlay,
  type CustomProviderModel,
  type SessionDiff,
  type McpOAuthStatus,
  type McpServer,
  type McpServerSpec,
  type TurnAttachment,
  type TaskOutputPage,
  type TurnModelSelection,
  type DataScienceBootstrap,
  type DataScienceConfig,
  type DataScienceCreateEnvironment,
  type DataScienceEnvironments,
  type DataScienceJob,
  type DataScienceInstallCommand,
  type DataScienceManager,
  type DataSciencePackage,
  type DataSciencePreflight,
  type DataScienceRequirementsSource,
  type DataScienceToolchain,
  type LatexBootstrap,
  type LatexConfig,
  type LatexDistributions,
  type LatexJob,
  type LatexPackagesAnswer,
  type LatexToolchain,
  type ManagedTectonic,
  type EngineErrorBody,
  type EngineErrorCode,
  type EngineEvent,
  type EngineHealth,
  type EventPage,
  type Item,
  type GitFilePatch,
  type GitOverview,
  type ModelSelection,
  type Project,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
  type AutoCompact,
  type ProviderProbe,
  type ProviderUpdateRun,
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
  type ProviderSkills,
  type ClaudeConversation,
  type ConversationImportDetail,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkerTurnFailure,
  type WorkspaceWriteResult,
  type RunConfigurationDraft,
  type RunView,
  type RunConfigurationView,
  type RunConfigurationsAnswer,
  type RunOutputAnswer,
  type RunOutputFilter,
  type RunWaitAnswer,
  type RunStopSignal,
  type RunClosedBy,
  type RunBytesAnswer,
  type RunWriteAnswer,
  type RunResizeAnswer,
  type RunStartInput,
  type RunOpenInput,
  type RunStatusAnswer,
  type SessionAssignment,
  type PluginInstallInput,
  type PluginStatus,
  type ProjectPlugins,
} from "./protocol";

export * from "./protocol";
export * from "./notes/schema";
export * from "./prompts/schema";
export * from "./schedules/schema";
export * from "./settings/schema";
export * from "./storage/schema";
export * from "./usage/schema";
export * from "./worktrees/schema";

export * from "./appearance/schema";
export * from "./dictation/schema";

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
  /** The sanitized transport cause — see `sanitizeTransportCause`. Absent for
   *  an ordinary HTTP error response, which has a status instead. */
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

/** The run surface hangs off the session that is asking — see `runStatus` for
 *  why a project-scoped answer lives under a session-scoped path. */
function runBase(sessionId: string): string {
  return `/v2/sessions/${encodeURIComponent(sessionId)}/run`;
}

export type RunTargetInput = { terminalId?: string; runId?: string };

/** The wire's spelling of a target: `terminalId`, whichever name it came in. */
function runTarget(input: RunTargetInput): { terminalId?: string } {
  const terminalId = input.terminalId ?? input.runId;
  return terminalId === undefined ? {} : { terminalId };
}

/** The same, for a JSON body: the target spelled once, the rest untouched. */
function runBody<T extends RunTargetInput>(input: T): Omit<T, "runId" | "terminalId"> & { terminalId?: string } {
  const { runId: _runId, terminalId: _terminalId, ...rest } = input;
  return { ...rest, ...runTarget(input) };
}

/** `?terminalId=&after=` for the two windows that share a cursor contract,
 *  written once so the line view and the byte view cannot drift apart in their
 *  spelling of it. */
function runCursor(input: RunTargetInput & { after?: number } & RunOutputFilter): string {
  const query = new URLSearchParams();
  const { terminalId } = runTarget(input);
  if (terminalId !== undefined) query.set("terminalId", terminalId);
  if (input.after !== undefined) query.set("after", String(input.after));
  if (input.tail !== undefined) query.set("tail", String(input.tail));
  if (input.grep !== undefined) query.set("grep", input.grep);
  if (input.stream !== undefined) query.set("stream", input.stream);
  return query.size === 0 ? "" : `?${query.toString()}`;
}

export { diffBaseQuery, filePatchQuery, parseDiffBaseQuery, parseFilePatchQuery } from "./protocol/diff-query";
export { mountRootsFor, volumeSupportOn, type VolumeSupport } from "./mounts";
export type { DirectoryEntry, DirectoryListing } from "./files/schema";
export { LOCAL_HOST_ID, type PublicHost } from "./hosts/schema";
export type { DiffBaseOption, FilePatchOptions } from "./protocol/diff-query";

export interface EngineClient
  extends Methods<typeof appearanceClient>,
    Methods<typeof dictationClient>,
    Methods<typeof notesClient>,
    Methods<typeof promptsClient>,
    Methods<typeof schedulesClient>,
    Methods<typeof settingsClient>,
    Methods<typeof storageClient>,
    Methods<typeof usageClient>,
    Methods<typeof worktreesClient> {}

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
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, {
        ...(sanitizeTransportCause(cause) ? { transport: sanitizeTransportCause(cause)! } : {}),
      });
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

  projectIcon(projectId: string, options: { format?: "png" } = {}): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`/v2/projects/${encodeURIComponent(projectId)}/icon${options.format ? `?format=${options.format}` : ""}`);
  }

  listProjects(options: { includeRemoved?: boolean } = {}): Promise<{ projects: Project[] }> {
    return this.request("GET", options.includeRemoved ? "/v2/projects?includeRemoved=1" : "/v2/projects");
  }

  registerProject(input: { id?: string; name: string; root: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects", input);
  }

  cloneProject(input: { url: string; parent: string; name?: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects/clone", input);
  }

  unregisterProject(projectId: string): Promise<{ project: Project; sessions: number }> {
    return this.request("DELETE", `/v2/projects/${encodeURIComponent(projectId)}`);
  }

  /** Put a removed project back: same id, same settings, same sessions. */
  restoreProject(projectId: string): Promise<{ project: Project }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/restore`, {});
  }

  updateProject(
    projectId: string,
    patch: {
      name?: string;
      /** One id from `TELAR_ICONS` — see `Project.iconName`. */
      iconName?: string | null;
      iconEmoji?: string | null;
      defaultModel?: ModelSelection | null;
      envMode?: EnvMode | null;
      /**
       * @deprecated An input alias for `plugins["data-science"]`, accepted for
       * one more release so a released cockpit keeps working. The engine writes
       * it into the map; nothing stores or returns this key.
       */
      dataScience?: DataScienceConfig | null;
      /** @deprecated An input alias for `plugins.latex`, as `dataScience` above. */
      latex?: LatexConfig | null;
      plugins?: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>;
    },
  ): Promise<{ project: Project }> {
    return this.request("PATCH", `/v2/projects/${encodeURIComponent(projectId)}`, patch);
  }

  /** Every environment a project could run on, each probed, with the toolchain
   *  and the checkout's dependency manifests. Spawns interpreters; call it from
   *  a page, never from a poll. */
  dataScienceEnvironments(projectId: string): Promise<DataScienceEnvironments> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/data-science/environments`);
  }

  /** Start making an environment. Returns a job to poll with `dataScienceJob`;
   *  its `result` is a `DataScienceCreatedEnvironment`. */
  dataScienceCreateEnvironment(projectId: string, request: DataScienceCreateEnvironment): Promise<{ jobId: string }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/data-science/environments`, request);
  }

  /** What is installed in the project's configured environment. */
  dataSciencePackages(projectId: string): Promise<{ packages: DataSciencePackage[]; environment: { manager: DataScienceManager; root: string; python: string; command: DataScienceInstallCommand } }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/data-science/packages`);
  }

  /** Install into / remove from the project's environment, as a job. */
  dataScienceInstall(projectId: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }): Promise<{ jobId: string }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/data-science/packages`, input);
  }

  /** Install uv, a Python version, or Miniforge — machine-wide, as a job. */
  dataScienceBootstrap(request: DataScienceBootstrap): Promise<{ jobId: string }> {
    return this.request("POST", "/v2/data-science/bootstrap", request);
  }

  dataScienceToolchain(fresh = false): Promise<{ toolchain: DataScienceToolchain }> {
    return this.request("GET", `/v2/data-science/toolchain${fresh ? "?fresh=1" : ""}`);
  }

  /** A job's status and the log lines after `after`. */
  dataScienceJob(jobId: string, after = 0): Promise<{ job: DataScienceJob }> {
    return this.request("GET", `/v2/data-science/jobs/${encodeURIComponent(jobId)}?after=${after}`);
  }

  dataScienceCancelJob(jobId: string): Promise<Record<string, never>> {
    return this.request("DELETE", `/v2/data-science/jobs/${encodeURIComponent(jobId)}`);
  }

  /** Probe one interpreter, venv or conda env directory a person named. */
  dataScienceProbe(projectId: string, path: string): Promise<{ probe: DataSciencePreflight & { relativePath?: string; root?: string; manager?: DataScienceManager } }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/data-science/probe`, { path });
  }

  /** Every TeX distribution the machine carries plus the checkout's main-file
   *  candidates. Spawns `--version` probes; call it from a page, never a poll. */
  latexDistributions(projectId: string): Promise<LatexDistributions> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/latex/distributions`);
  }

  /** Installed TeX packages — or the sentence that this manager self-serves. */
  latexPackages(projectId: string): Promise<LatexPackagesAnswer> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/latex/packages`);
  }

  /** `tlmgr install`/`remove`, as a job. Refused for tectonic projects. */
  latexInstall(projectId: string, input: { add?: string[]; remove?: string[] }): Promise<{ jobId: string }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/latex/packages`, input);
  }

  /** Install Tectonic or TinyTeX — machine-wide, as a job. */
  latexBootstrap(request: LatexBootstrap): Promise<{ jobId: string }> {
    return this.request("POST", "/v2/latex/bootstrap", request);
  }

  latexToolchain(fresh = false): Promise<{ toolchain: LatexToolchain }> {
    return this.request("GET", `/v2/latex/toolchain${fresh ? "?fresh=1" : ""}`);
  }

  /** Telar's own Tectonic: whether it is here, and whether one is downloading. */
  managedTectonic(): Promise<{ managed: ManagedTectonic }> {
    return this.request("GET", "/v2/latex/managed");
  }

  installManagedTectonic(): Promise<{ managed: ManagedTectonic }> {
    return this.request("POST", "/v2/latex/managed", {});
  }

  /** A latex job's status and the log lines after `after`. */
  latexJob(jobId: string, after = 0): Promise<{ job: LatexJob }> {
    return this.request("GET", `/v2/latex/jobs/${encodeURIComponent(jobId)}?after=${after}`);
  }

  latexCancelJob(jobId: string): Promise<Record<string, never>> {
    return this.request("DELETE", `/v2/latex/jobs/${encodeURIComponent(jobId)}`);
  }

  /** The inbox's standing rule — see `InboxPolicy`. Environment-wide, so every
   *  client that reads this engine bands its list the same way. */
  /** This Mac's workspace defaults — see `protocol/workspace.ts`. */
  machineWorkspace(): Promise<{ machine: WorkspaceConfig }> {
    return this.request("GET", "/v2/workspace");
  }

  /** Replaces the whole machine layer; the engine validates and answers with what it kept. */
  setMachineWorkspace(machine: WorkspaceConfig): Promise<{ machine: WorkspaceConfig }> {
    return this.request("PUT", "/v2/workspace", { machine });
  }

  /** One project's overrides, the repo's proposal, and what they resolve to. */
  projectWorkspace(projectId: string): Promise<{ workspace: ProjectWorkspaceView }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/workspace`);
  }

  /** Replaces the project's overrides: absent inherits, `null` turns a field off. */
  setProjectWorkspace(projectId: string, overrides: ProjectWorkspaceOverrides): Promise<{ workspace: ProjectWorkspaceView }> {
    return this.request("PUT", `/v2/projects/${encodeURIComponent(projectId)}/workspace`, { overrides });
  }

  sessionsStream(): { url: string; headers: Record<string, string> } {
    return {
      url: `http://${this.discovery.host}:${this.discovery.port}/v2/sessions/stream`,
      headers: { authorization: `Bearer ${this.discovery.token}` },
    };
  }

  computerUseStatus(): Promise<{ computerUse: ComputerUseStatus }> {
    return this.request("GET", "/v2/computer-use");
  }

  /** Ask macOS for Accessibility + Screen Recording — through Telar's bundled
   *  helper when there is one (the prompts name it), else cua's own flow — and
   *  open the Settings pane the person finishes in. Answers what happened. */
  grantComputerUseAccess(): Promise<ComputerUseGrant> {
    return this.request("POST", "/v2/computer-use/grant", {});
  }

  /** Reveal the bundled helper in Finder, to drag into a Settings list that
   *  does not show it yet. `revealed: false` without a bundled helper. */
  revealComputerUseHelper(): Promise<{ revealed: boolean }> {
    return this.request("POST", "/v2/computer-use/reveal", {});
  }

  /** Reset the bundled helper's two macOS grants (`tccutil reset`, its bundle
   *  id only). `reset: false` when there is no bundled helper. */
  resetComputerUseAccess(): Promise<{ reset: boolean; message?: string }> {
    return this.request("POST", "/v2/computer-use/reset", {});
  }

  /**
   * The logins a person allowed agents to fill without being asked again —
   * metadata only (profile, origin, item title, field kinds), never a value.
   */
  browserLogins(): Promise<{ logins: RememberedLogin[] }> {
    return this.request("GET", "/v2/browser/logins");
  }

  /** Take one back. The next fill of that item asks again. */
  revokeBrowserLogin(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/v2/browser/logins/${encodeURIComponent(id)}`);
  }

  completeStructured(
    input: { prompt: string; schema: Record<string, unknown>; model?: string; effort?: "low" | "medium" | "high" },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ result: Record<string, unknown> }> {
    return this.request("POST", "/v2/textgen/complete", input, options.signal);
  }

  /** A project's git state — branch, dirty count, divergence, worktrees.
   *  Read fresh on every call: it describes a working tree that changes
   *  underneath the engine, and a stale branch name is worse than a slow one. */
  projectGit(projectId: string): Promise<{ git: GitOverview }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/git`);
  }

  /**
   * A project's issues and pull requests, through the `gh` CLI the user
   * authenticated on this machine. Cached for thirty seconds in the engine;
   * `refresh` is what a human pressing the button sends.
   */
  projectGitHub(
    projectId: string,
    options: { refresh?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {},
  ): Promise<{ github: GitHubSnapshot }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github${forgeQuery(options)}`);
  }

  projectForgeFacets(projectId: string, options: { refresh?: boolean } = {}): Promise<{ facets: GitHubFacets }> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/facets${suffix}`);
  }

  projectCheckLog(projectId: string, jobId: string): Promise<{ log: GitHubCheckLog }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/checks/${encodeURIComponent(jobId)}/log`);
  }

  projectGitignore(projectId: string): Promise<{ gitignore: GitignoreResult }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/gitignore`, {});
  }

  undoProjectGitignore(projectId: string): Promise<{ gitignore: GitignoreRemoval }> {
    return this.request("DELETE", `/v2/projects/${encodeURIComponent(projectId)}/gitignore`);
  }

  projectIssue(projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubIssueRead> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/issues/${number}${suffix}`);
  }

  projectPull(projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubPullRead> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}${suffix}`);
  }

  mergeProjectPull(
    projectId: string,
    number: number,
    input: { method: GitHubMergeMethod; expectedHeadOid: string },
  ): Promise<GitHubMergeResult> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/merge`, input);
  }

  reactOnProjectForge(
    projectId: string,
    kind: "issue" | "pull",
    number: number,
    input: { subjectId: string; content: GitHubReactionContent; react: boolean },
  ): Promise<GitHubReactionResult> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/github/${kind === "issue" ? "issues" : "pulls"}/${number}/reactions`, input);
  }

  replyToProjectThread(projectId: string, number: number, threadId: string, body: string): Promise<GitHubThreadReplyResult> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/threads/${encodeURIComponent(threadId)}/replies`, { body });
  }

  resolveProjectThread(projectId: string, number: number, threadId: string, resolved: boolean): Promise<GitHubThreadResolveResult> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/threads/${encodeURIComponent(threadId)}/resolve`, { resolved });
  }

  projectDiff(projectId: string): Promise<{ diff: SessionDiff }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/diff`);
  }

  projectFilePatch(projectId: string, path: string, options: FilePatchOptions = {}): Promise<{ file: GitFilePatch }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/diff?${filePatchQuery(path, options)}`);
  }

  projectFiles(projectId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/files`);
  }

  sessionFiles(sessionId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files`);
  }

  sessionSkills(sessionId: string): Promise<ProviderSkills> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/skills`);
  }

  claudeConversations(options: { instanceId?: string; cwd?: string } = {}): Promise<{ conversations: ClaudeConversation[] }> {
    const query = new URLSearchParams();
    if (options.instanceId) query.set("instanceId", options.instanceId);
    if (options.cwd) query.set("cwd", options.cwd);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request("GET", `/v2/claude/conversations${suffix}`);
  }

  adoptClaudeConversation(
    sessionId: string,
    input: { sourceSessionId: string; cut?: "whole" | "since_compact_boundary"; sourceCwd?: string },
  ): Promise<{ session: Session; turn: Turn; provenance: ConversationImportDetail }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/adopt`, input);
  }

  projectSkills(projectId: string, driver?: ProviderDriverKind): Promise<ProviderSkills> {
    const query = driver ? `?${new URLSearchParams({ driver }).toString()}` : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/skills${query}`);
  }

  /** One file's text, as it is on disk. Fenced inside the checkout by the
   *  engine — see `readFenced` there for why the check is not at the route. */
  projectFile(projectId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`);
  }

  sessionFile(sessionId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`);
  }

  projectFileBytes(projectId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`/v2/projects/${encodeURIComponent(projectId)}/files/raw?${new URLSearchParams({ path }).toString()}`);
  }

  sessionFileBytes(sessionId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.readBytes(`/v2/sessions/${encodeURIComponent(sessionId)}/files/raw?${new URLSearchParams({ path }).toString()}`);
  }

  writeProjectFile(projectId: string, path: string, text: string, expectedSha256: string): Promise<WorkspaceWriteResult> {
    return this.request(
      "PUT",
      `/v2/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`,
      { text, expectedSha256 },
    );
  }

  writeSessionFile(sessionId: string, path: string, text: string, expectedSha256: string): Promise<WorkspaceWriteResult> {
    return this.request(
      "PUT",
      `/v2/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
      { text, expectedSha256 },
    );
  }

  modelCatalogue(
    driver: ProviderDriverKind,
    options: { refresh?: boolean; instanceId?: string } = {},
  ): Promise<{ catalogue: ModelCatalogue }> {
    const query = new URLSearchParams({ driver });
    if (options.refresh) query.set("refresh", "1");
    if (options.instanceId) query.set("instanceId", options.instanceId);
    return this.request("GET", `/v2/models?${query.toString()}`);
  }

  /** What this login's reader did to that provider's model list. An untouched
   *  overlay is a real answer, not a 404. */
  modelOverlay(instanceId: string): Promise<{ overlay: ModelOverlay }> {
    return this.request("GET", `/v2/provider-instances/${encodeURIComponent(instanceId)}/models`);
  }

  /** Presence is the patch, and a submitted array replaces that list whole — so
   *  `{ hidden: [] }` clears the hides and omitting `hidden` leaves them. */
  setModelOverlay(
    instanceId: string,
    patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
  ): Promise<{ overlay: ModelOverlay }> {
    return this.request("PATCH", `/v2/provider-instances/${encodeURIComponent(instanceId)}/models`, patch);
  }

  listSessions(projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  machinePlugins(): Promise<{ plugins: PluginStatus[]; machine: ProjectPlugins }> {
    return this.request("GET", "/v2/plugins");
  }

  /** Install a plugin from a folder. Refused with the manifest's problem when it would not load. */
  installPlugin(input: PluginInstallInput): Promise<{ plugin: PluginStatus }> {
    return this.request("POST", "/v2/plugins/installed", input);
  }

  /** Stop an installed plugin and remove its folder (a linked one is only unlinked). */
  uninstallPlugin(id: string): Promise<{ removed: true }> {
    return this.request("DELETE", `/v2/plugins/installed/${encodeURIComponent(id)}`);
  }

  /** Turn a plugin on or off for this Mac, or change its machine settings. */
  updateMachinePlugins(
    plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>,
  ): Promise<{ machine: ProjectPlugins }> {
    return this.request("PATCH", "/v2/plugins", { plugins });
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

  projectActivity(): Promise<{ projects: Array<{ projectId: string; updatedAt: number }> }> {
    return this.request("GET", "/v2/sessions/activity");
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

  runConfigurations(sessionId: string): Promise<RunConfigurationsAnswer> {
    return this.request("GET", `${runBase(sessionId)}/configs`);
  }

  createRunConfiguration(sessionId: string, draft: RunConfigurationDraft): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs`, draft);
  }

  updateRunConfiguration(sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`, patch);
  }

  removeRunConfiguration(sessionId: string, configId: string): Promise<{ removed: string }> {
    return this.request("DELETE", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`);
  }

  /** The calling session's terminals, newest first. */
  runStatus(sessionId: string): Promise<RunStatusAnswer> {
    return this.request("GET", `${runBase(sessionId)}/status`);
  }

  startRun(sessionId: string, input: RunStartInput): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/start`, input);
  }

  openTerminal(sessionId: string, input: RunOpenInput): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/open`, input);
  }

  stopRun(sessionId: string, terminalId?: string, signal?: RunStopSignal, options: { closedBy?: RunClosedBy } = {}): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/stop`, {
      ...(terminalId === undefined ? {} : { terminalId }),
      ...(signal === undefined ? {} : { signal }),
      ...(options.closedBy === undefined ? {} : { closedBy: options.closedBy }),
    });
  }

  restartRun(sessionId: string, terminalId?: string, options: { closedBy?: RunClosedBy } = {}): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/restart`, {
      ...(terminalId === undefined ? {} : { terminalId }),
      ...(options.closedBy === undefined ? {} : { closedBy: options.closedBy }),
    });
  }

  runOutput(sessionId: string, input: RunTargetInput & { after?: number } & RunOutputFilter = {}): Promise<RunOutputAnswer> {
    return this.request("GET", `${runBase(sessionId)}/output${runCursor(input)}`);
  }

  runWait(sessionId: string, input: RunTargetInput & { pattern?: string; ready?: boolean; exit?: boolean; timeoutMs: number }): Promise<RunWaitAnswer> {
    return this.request("POST", `${runBase(sessionId)}/wait`, runBody(input));
  }

  runBytes(sessionId: string, input: RunTargetInput & { after?: number } = {}): Promise<RunBytesAnswer> {
    return this.request("GET", `${runBase(sessionId)}/bytes${runCursor(input)}`);
  }

  runStream(sessionId: string): { url: string; headers: Record<string, string> } {
    return {
      url: `http://${this.discovery.host}:${this.discovery.port}${runBase(sessionId)}/stream`,
      headers: { authorization: `Bearer ${this.discovery.token}` },
    };
  }

  writeRun(sessionId: string, input: RunTargetInput & { data: string }): Promise<RunWriteAnswer> {
    return this.request("POST", `${runBase(sessionId)}/write`, runBody(input));
  }

  resizeRun(sessionId: string, input: RunTargetInput & { cols: number; rows: number }): Promise<RunResizeAnswer> {
    return this.request("POST", `${runBase(sessionId)}/resize`, runBody(input));
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

  sessionDiff(sessionId: string, options: DiffBaseOption = {}): Promise<{ diff: SessionDiff }> {
    const query = diffBaseQuery(options);
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/diff${query ? `?${query}` : ""}`);
  }

  /** One file's patch. Separate from the review for the same reason a screenshot
   *  is separate from the browser's tab list: size, and nobody reads all of it. */
  sessionFilePatch(sessionId: string, path: string, options: FilePatchOptions = {}): Promise<{ file: GitFilePatch }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/diff?${filePatchQuery(path, options)}`);
  }

  /** Snapshot the session's work as one commit. The engine's only git mutation —
   *  additive, reversible, and never automatic. */
  commitSessionWork(sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/git/commit`, { message });
  }

  pushSessionBranch(sessionId: string): Promise<GitPushResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/git/push`, {});
  }

  openSessionPullRequest(sessionId: string, input: { title: string; body?: string; base?: string }): Promise<GitHubPullCreateResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/github/pull`, input);
  }

  sessionPullAnchor(sessionId: string): Promise<GitHubPullAnchor> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/github/pull/anchor`);
  }

  commentOnSessionPullLine(sessionId: string, input: GitHubLineCommentInput): Promise<GitHubLineCommentResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/github/pull/comments`, input);
  }

  browserState(sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}): Promise<{ browser: BrowserSnapshot }> {
    const query = new URLSearchParams();
    if (options.screenshot) query.set("screenshot", "1");
    if (options.start) query.set("start", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/browser${suffix}`);
  }

  /** Open an http(s) page as a new tab in the session's browser, as the human
   *  would — for clients without a desktop shell of their own. Journals the
   *  tab set like a hand-started browser does. */
  browserOpen(sessionId: string, url: string): Promise<{ browser: BrowserSnapshot }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/browser/open`, { url });
  }

  listMcpServers(): Promise<{ mcpServers: McpServer[] }> {
    return this.request("GET", "/v2/mcp-servers");
  }

  /** This project's servers, plus `effective` — the merge its sessions actually
   *  run with, computed by the engine so the surface that explains the
   *  shadowing cannot disagree with the one that performs it. */
  listProjectMcpServers(projectId: string): Promise<{ mcpServers: McpServer[]; effective: McpServer[] }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/mcp-servers`);
  }

  saveMcpServer(input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: McpServerSpec }): Promise<{ mcpServer: McpServer }> {
    const { projectId, id, ...rest } = input;
    const path = projectId
      ? `/v2/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(id)}`
      : `/v2/mcp-servers/${encodeURIComponent(id)}`;
    return this.request("PUT", path, { id, ...rest });
  }

  removeMcpServer(id: string, projectId?: string): Promise<{ removed: boolean }> {
    const path = projectId
      ? `/v2/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(id)}`
      : `/v2/mcp-servers/${encodeURIComponent(id)}`;
    return this.request("DELETE", path);
  }

  mcpOAuthStatus(projectId?: string): Promise<{ statuses: McpOAuthStatus[] }> {
    return this.request("GET", projectId ? `/v2/mcp-oauth?projectId=${encodeURIComponent(projectId)}` : "/v2/mcp-oauth");
  }

  connectMcpOAuth(input: { serverId: string; projectId?: string; redirectOrigin: string }): Promise<{ authorizationUrl: string }> {
    return this.request("POST", "/v2/mcp-oauth/connect", input);
  }

  mcpOAuthCallback(query: string): Promise<{ redirect: string }> {
    return this.request("GET", `/v2/mcp-oauth/callback?${query}`);
  }

  /** Forget a stored grant. Idempotent; `removed` says whether one existed. */
  disconnectMcpOAuth(input: { serverId: string; projectId?: string }): Promise<{ removed: boolean }> {
    return this.request("POST", "/v2/mcp-oauth/disconnect", input);
  }

  listProviderInstances(options: { refresh?: boolean } = {}): Promise<{ providerInstances: ProviderInstance[]; probes: ProviderProbe[] }> {
    return this.request("GET", `/v2/provider-instances${options.refresh ? "?refresh=1" : ""}`);
  }

  updateProviderCli(instanceId: string): Promise<{
    result: ProviderUpdateRun;
    providerInstances: ProviderInstance[];
    probes: ProviderProbe[];
  }> {
    return this.request("POST", `/v2/provider-updates/${encodeURIComponent(instanceId)}`, {});
  }

  saveProviderInstance(input: {
    id: string;
    driver?: ProviderDriverKind;
    displayName?: string | null;
    accentColor?: string | null;
    /** A whole percentage of the model's window; `null` returns this login to
     *  the cockpit's default. */
    contextNoticePercent?: number | null;
    /** When this login's sessions compact; `null` returns it to the provider's
     *  default. */
    autoCompact?: AutoCompact | null;
    configDir?: string | null;
    binaryPath?: string | null;
    enabled?: boolean;
    env?: ProviderInstanceEnvVar[];
    carryOverInherited?: string[];
  }): Promise<{ providerInstance: ProviderInstance; stoppedInheriting?: string[] }> {
    const { id, ...patch } = input;
    return this.request("PUT", `/v2/provider-instances/${encodeURIComponent(id)}`, patch);
  }

  /** The built-in slot for a driver refuses: a session on that driver would
   *  have nothing left to route to. */
  removeProviderInstance(id: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v2/provider-instances/${encodeURIComponent(id)}`);
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

  sessionTerminals(sessionId: string): Promise<{ open: number }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/terminals`);
  }

  closeSessionTerminals(sessionId: string): Promise<{ closed: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/terminals/close`, {});
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

type Methods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };

Object.assign(
  EngineClient.prototype,
  appearanceClient,
  dictationClient,
  notesClient,
  promptsClient,
  schedulesClient,
  settingsClient,
  storageClient,
  usageClient,
  worktreesClient,
);

export { ENGINE_PROTOCOL_VERSION };
