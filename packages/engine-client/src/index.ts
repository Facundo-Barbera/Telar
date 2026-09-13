/**
 * engine client — protocol v2.
 *
 * PROTOCOL v1 IS GONE, not deprecated. Its eleven flat `turn.*` events were not
 * a subset of v2 and there is no dual-emit path; an engine speaking v2 answers
 * on `/v2/**` and a v1 client gets a 404 rather than a confusing parse failure
 * three layers in. The routes moved with the version deliberately, so the break
 * is visible at the URL.
 */
import { parsePublishedAppearance, type PublishedAppearance } from "./look";
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
  type GitHubPullFilter,
  type GitHubPullRead,
  type GitHubSnapshot,
  type GitignoreRemoval,
  type GitignoreResult,
  type ComputerUseBackend,
  type ComputerUseStatus,
  type AgentOrientation,
  type InboxPolicy,
  type RememberedLogin,
  type SessionDefaults,
  type SidebarLayout,
  type TextGenPolicy,
  type UsageReport,
  type UsageResolution,
  type UsageLimits,
  type UsageLimitSource,
  type UsageLimitSourceKind,
  type SpoolAperture,
  type SpoolApertureView,
  type SpoolArea,
  type SpoolBrief,
  type SpoolBriefing,
  type SpoolLobby,
  type SpoolCanvasState,
  type SpoolDeadline,
  type SpoolPin,
  type SpoolExpertOutcome,
  type SpoolItem,
  type SpoolItemDetail,
  type SpoolLook,
  type SpoolLookOutcome,
  type SpoolMcpInfo,
  type SpoolNote,
  type ProjectNote,
  type ProjectNoteAuthor,
  type NotesMcpInfo,
  type SpoolSearchHit,
  type SpoolMemoryFact,
  type SpoolTerrain,
  type SpoolNight,
  type SpoolSubject,
  type SpoolSubjectColor,
  type SpoolSubjectPermits,
  type SpoolFocusDay,
  type SpoolFocusEnd,
  type SpoolFocusEntry,
  type SpoolMap,
  type SpoolPickup,
  type SpoolSubjectThreads,
  type SpoolTagUsage,
  type SpoolThread,
  type SpoolWork,
  type SpoolLane,
  type SpoolSnapshot,
  type ModelCatalogue,
  type ModelOverlay,
  type CustomProviderModel,
  type SessionDiff,
  type McpOAuthStatus,
  type McpServer,
  type McpServerSpec,
  type TurnAttachment,
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
  type Item,
  type GitOverview,
  type ModelSelection,
  type Project,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderInstanceEnvVar,
  type ProviderProbe,
  type ProviderUpdate,
  type ProviderUpdateRun,
  type Session,
  type SessionOrigin,
  type Subscription,
  type Task,
  type EngineRequest,
  type RequestDecision,
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
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkerTurnFailure,
  type WorkspaceWriteResult,
  type RunConfigurationDraft,
  type RunView,
  type RunConfigurationView,
  type RunConfigurationsAnswer,
  type RunOutputAnswer,
  type RunStartInput,
  type RunStatusAnswer,
  type SessionAssignment,
  type PluginStatus,
  type ProjectPlugins,
} from "./protocol";

export * from "./protocol";

/**
 * THE LOOK FORMAT — the appearance vocabulary the cockpit publishes and every
 * other client reads. Kept out of `protocol/` because it is not part of the
 * engine's own model: the engine stores this blob without understanding a word
 * of it (see `/v2/appearance`), and the shape belongs to the clients that both
 * write and wear it. Pure data and total parsers; no DOM, no framework.
 */
export * from "./look";

/**
 * THE IDENTITY VOCABULARY — the closed sets of icons and colours anything a
 * person names may wear (a browser profile, a project). Like the look format,
 * it is not part of the engine's model: the clients that draw an identity are
 * what needs the two lists to agree.
 */
export * from "./icons";

/** `?turns=N[&before=runId]`, or nothing — spelled once for every caller. */
export function snapshotQuery(window?: SnapshotWindow): string {
  if (!window) return "";
  const params = new URLSearchParams({ turns: String(window.turns) });
  if (window.before !== undefined) params.set("before", window.before);
  return `?${params.toString()}`;
}

/**
 * A TRANSPORT FAILURE, REDUCED TO SOMETHING SAFE TO KEEP.
 *
 * `fetch` rejects with a `TypeError` whose message and `cause` chain routinely
 * carry the request URL — and this client's URLs are loopback addresses whose
 * headers hold the engine's bearer token. So the error is NOT propagated: only
 * the constructor name and an errno-shaped code survive, which is exactly the
 * pair that distinguishes ECONNRESET from ECONNREFUSED from a timeout.
 *
 * Everything else is dropped. `undefined` when there is nothing errno-shaped to
 * say, which stays honestly distinguishable from "the cause was known".
 */
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
  /**
   * Which client call failed, as a stable identifier (`workerHeartbeat`,
   * `submitTurn`). Present so a supervisor can tell an idempotent control poll
   * from a mutating submission WITHOUT re-deriving it from a URL.
   */
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

/** Engine discovery (`discoverEngine`/`connectEngine`) lives in `./node`, a
 *  separate entry point, because it reads the filesystem and this root export
 *  is bundled into browser client components — a top-level `node:fs/promises`
 *  import here is a hard Turbopack error. */
export type FetchLike = typeof fetch;

/** Where a windowed snapshot stands in the session's history. */
export type SnapshotPage = {
  /** Oldest settled turn on this page — the `before` for the next page up. */
  before: string | null;
  /** Are there settled turns above this page? */
  more: boolean;
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
  /**
   * The journal position this snapshot reflects — the id of the last event
   * the engine had written when it was read. A client tails from here;
   * replaying the journal from zero to learn what the snapshot already
   * says was the whole cost of opening a long session. Absent from an
   * engine older than this field, in which case a client has to ask.
   */
  cursor?: number;
  /**
   * Present when the read was windowed (`session(id, { turns })`): the page
   * above this one is `session(id, { turns, before })`, and `null` once the
   * window reaches the session's first turn. Every unsettled turn is on the
   * first page whatever the limit.
   */
  page?: SnapshotPage;
  session: Session;
  turns: Turn[];
  items: Item[];
  /**
   * The requests filed under the turns in this window, plus EVERY open one
   * wherever its turn sits — an unanswered question on a paged-out turn is
   * still the session's own state and still has to reach a composer. Settled
   * requests outside the window are not here: they render nothing, and on a
   * long session they were the largest thing in the snapshot after `items`.
   */
  requests: EngineRequest[];
  /**
   * Who this session is working on behalf of, and what it has finished for
   * them. Folded by the ENGINE over the whole queue, never windowed — a client
   * paging its transcript cannot tell a finished carrier from an absent one,
   * so it must not have to try. Absent from an older engine.
   */
  assignments?: SessionAssignment[];
  /** Sub-agents and background work. A background task OUTLIVES the turn that
   *  started it, so this is the only thing that can tell a client opening a
   *  cold session that it is still working. */
  tasks: Task[];
};

/** The run surface hangs off the session that is asking — see `runStatus` for
 *  why a project-scoped answer lives under a session-scoped path. */
function runBase(sessionId: string): string {
  return `/v2/sessions/${encodeURIComponent(sessionId)}/run`;
}

export class EngineClient {
  constructor(
    readonly discovery: EngineDiscovery,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * `operation` is the CALLER'S OWN NAME for what it was doing, threaded
   * through rather than derived from the URL.
   *
   * A supervisor deciding whether a failure may be tolerated has to know
   * whether the call that failed was an idempotent control poll or a mutating
   * submission, and reconstructing that from a path is exactly the kind of
   * re-derivation that drifts. Absent from older call sites, which then get the
   * previous behaviour — an unnamed failure is never treated as retryable.
   */
  private async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal, operation?: string): Promise<T> {
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
      /**
       * THE CAUSE IS KEPT, SANITIZED. It used to be caught and dropped on the
       * floor, which is why a Telar that lost one loopback request could not
       * afterwards say whether the engine had died, the socket had reset, or
       * the process had run out of descriptors — see #208. The raw error is
       * still not propagated: its message and cause chain carry the request
       * URL, and these URLs are authenticated.
       */
      throw new EngineClientError("engine_unavailable", "engine is unreachable", undefined, {
        ...named,
        ...(sanitizeTransportCause(cause) ? { transport: sanitizeTransportCause(cause)! } : {}),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A reply that arrived but did not parse is a DIFFERENT failure from one
      // that never arrived: the status is the evidence, and it is kept.
      throw new EngineClientError("engine_unavailable", "engine returned an invalid response", response.status, { ...named, transport: "malformed_response" });
    }
    if (!response.ok) {
      const error = (payload as EngineErrorBody | null)?.error;
      const code: EngineErrorCode = error?.code ?? "engine_unavailable";
      throw new EngineClientError(code, error?.message ?? "engine request failed", response.status, named);
    }
    return payload as T;
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

  /**
   * The project's icon, as bytes — the image behind `Project.icon`.
   *
   * The one binary GET on this client. Not folded into `request` because that
   * envelope parses JSON, and generalising it for one route would put a
   * content-type branch on every call in the class.
   */
  async projectIcon(projectId: string): Promise<{ data: Uint8Array; contentType: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}/v2/projects/${encodeURIComponent(projectId)}/icon`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.discovery.token}` },
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "engine is unreachable");
    }
    if (!response.ok) {
      let code: EngineErrorCode = "engine_unavailable";
      let message = "engine request failed";
      try {
        const error = ((await response.json()) as EngineErrorBody | null)?.error;
        if (error) ({ code, message } = error);
      } catch {
        // A non-JSON failure body keeps the defaults.
      }
      throw new EngineClientError(code, message, response.status);
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** The registered projects. `includeRemoved` also returns the put-away ones,
   *  which carry `removedAt`; without it they are absent entirely. */
  listProjects(options: { includeRemoved?: boolean } = {}): Promise<{ projects: Project[] }> {
    return this.request("GET", options.includeRemoved ? "/v2/projects?includeRemoved=1" : "/v2/projects");
  }

  registerProject(input: { id?: string; name: string; root: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects", input);
  }

  /**
   * Clone a repository into `parent` and register what landed, in one call.
   *
   * ONE CALL BECAUSE THE CALLER CANNOT NAME THE PATH IN BETWEEN. `git clone`
   * chooses the folder from the URL, so a client doing this in two steps would be
   * registering a path it never picked. `name` is optional and defaults to that
   * folder's own name.
   *
   * NOT STREAMED. The answer is the registered project, or a 400/409 whose message
   * is the sentence to show: a URL that is not one, a parent that is not a
   * directory, a target that already exists, or git's own stderr.
   */
  cloneProject(input: { url: string; parent: string; name?: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects/clone", input);
  }

  /**
   * Remove a project from Telar. NOT A DELETE OF THE PROJECT, and REVERSIBLE:
   * the checkout, its git metadata, its worktrees, the journals of every
   * session that ran on it and those sessions' browser profiles are all left
   * alone, and so is the registration record — it is marked `removedAt` and
   * dropped from `listProjects`. `restoreProject`, or `registerProject` on the
   * same root, brings it back with the SAME id and settings.
   *
   * 409 when a session on that project has work in flight — the engine will
   * not quietly put a registration away under a running turn. `sessions`
   * counts the session records that now belong to a put-away project.
   */
  unregisterProject(projectId: string): Promise<{ project: Project; sessions: number }> {
    return this.request("DELETE", `/v2/projects/${encodeURIComponent(projectId)}`);
  }

  /** Put a removed project back: same id, same settings, same sessions. */
  restoreProject(projectId: string): Promise<{ project: Project }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/restore`, {});
  }

  /**
   * Move a project's identity and its opt-in switches. `dataScience: null` /
   * `latex: null` turn a feature off.
   *
   * `iconName`, `iconEmoji`, `defaultModel` and `envMode` take `null` for the
   * same reason and with the same meaning as the two above: REMOVE the stored
   * answer, which is not the same as storing a neutral one. A project with no
   * `envMode` follows this Mac's `SessionDefaults`; a project that stored
   * `"local"` insists on the checkout however the Mac's answer moves later. A
   * project with neither icon field goes back to the one its checkout carries.
   *
   * `name` HAS NO `null`. Every project has a name — clearing it would leave a
   * row with nothing to render — so it takes a new one or is left alone.
   */
  updateProject(
    projectId: string,
    patch: {
      name?: string;
      /** One id from `TELAR_ICONS` — see `Project.iconName`. */
      iconName?: string | null;
      /** Legacy; nothing writes a value now. `null` clears a stored mark. */
      iconEmoji?: string | null;
      defaultModel?: ModelSelection | null;
      envMode?: EnvMode | null;
      dataScience?: DataScienceConfig | null;
      latex?: LatexConfig | null;
      /**
       * THE GENERIC ARM. One entry per plugin, `null` to turn it off. The two
       * legacy keys above still work and are mirrored into this map by the
       * engine, so an old cockpit and a new one write the same truth.
       */
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

  /**
   * Fetch it. IDEMPOTENT — an install already running is joined rather than
   * duplicated, and one already finished returns immediately — so a pane may
   * call this on every press without guarding.
   */
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
  inboxPolicy(): Promise<{ inbox: InboxPolicy }> {
    return this.request("GET", "/v2/inbox");
  }

  setInboxPolicy(patch: {
    autoSettleAfterHours?: number | null;
    /** The delegation grace — see `InboxPolicy`. `null` turns it off. */
    settleDelegatedAfterHours?: number | null;
  }): Promise<{ inbox: InboxPolicy }> {
    return this.request("PATCH", "/v2/inbox", patch);
  }

  /**
   * Whether Telar may tell an agent where it is — see `AgentOrientation`.
   * Environment-wide, like the inbox rule above: it decides what EVERY session
   * on this machine is told.
   *
   * `text` IS THE ENGINE'S OWN COPY OF THE PARAGRAPH, and it rides the answer
   * so that "show me exactly what you inject" is a read rather than a second
   * copy of the words in the cockpit. A paired Mac may be running a different
   * release; the disclosure then shows what THAT engine says, which is the only
   * honest thing it could show.
   */
  orientation(): Promise<{ orientation: AgentOrientation; text: string }> {
    return this.request("GET", "/v2/orientation");
  }

  /** Either switch, by presence — an absent field is left alone, so turning the
   *  skill off cannot silently re-enable the preamble. */
  setOrientation(patch: { preamble?: boolean; skill?: boolean }): Promise<{ orientation: AgentOrientation; text: string }> {
    return this.request("PATCH", "/v2/orientation", patch);
  }

  /** What a session is created with when the caller didn't say — see
   *  `SessionDefaults`. Environment-wide, like the inbox rule above. */
  sessionDefaults(): Promise<{ sessionDefaults: SessionDefaults }> {
    return this.request("GET", "/v2/session-defaults");
  }

  setSessionDefaults(patch: { envMode?: EnvMode }): Promise<{ sessionDefaults: SessionDefaults }> {
    return this.request("PATCH", "/v2/session-defaults", patch);
  }

  /** Where each project group sits in the rail — see `SidebarLayout`.
   *  Environment-wide, like the inbox rule above. */
  sidebarLayout(): Promise<{ layout: SidebarLayout }> {
    return this.request("GET", "/v2/sidebar-layout");
  }

  /** One arrangement per call: an absent field is left alone, so a drop in the
   *  pinned band cannot overwrite the groups the same rail just arranged. */
  setSidebarLayout(patch: {
    projectOrder?: string[];
    sessionOrder?: Record<string, string[]>;
    pinnedOrder?: string[];
  }): Promise<{ layout: SidebarLayout }> {
    return this.request("PATCH", "/v2/sidebar-layout", patch);
  }

  /**
   * Computer use, MEASURED: the Codex plugin's presence, its Sky host app, and
   * the macOS Automation grant — the last one answered by a real read-only
   * call, which is also what makes macOS raise its granting prompt when the
   * decision is still open. Slow by design (one subprocess round trip).
   */
  computerUseStatus(): Promise<{ computerUse: ComputerUseStatus }> {
    return this.request("GET", "/v2/computer-use");
  }

  /** Wake the Sky host app in the background. Idempotent. */
  wakeComputerUseHost(): Promise<{ ok: boolean }> {
    return this.request("POST", "/v2/computer-use/host", {});
  }

  /** Run cua's native granting flow (CuaDriver.app requests Accessibility +
   *  Screen Recording, attributed to itself). A no-op for the Sky backend. */
  grantComputerUseAccess(): Promise<{ started: boolean; backend?: ComputerUseBackend }> {
    return this.request("POST", "/v2/computer-use/grant", {});
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

  /** Spend over time, folded from the engine's journals — see `UsageReport`. */
  usageReport(input: { sinceMs: number; untilMs: number; resolution?: UsageResolution; timeZone?: string }): Promise<{ usage: UsageReport }> {
    const query = new URLSearchParams({ since: String(input.sinceMs), until: String(input.untilMs) });
    if (input.resolution) query.set("resolution", input.resolution);
    if (input.timeZone) query.set("tz", input.timeZone);
    return this.request("GET", `/v2/usage?${query.toString()}`);
  }

  /**
   * The CLIProxyAPI hubs quota is read from — configuration, not quota.
   *
   * MANAGEMENT KEYS NEVER COME BACK: every row reads `managementKey: ""`, with
   * `keyRedacted: true` when one is stored. See `UsageLimitSource`.
   */
  usageLimitSources(): Promise<{ sources: UsageLimitSource[] }> {
    return this.request("GET", "/v2/usage/sources");
  }

  /** Create or replace one hub. An EMPTY `managementKey` keeps the stored one,
   *  which is what makes saving a row you read back redacted safe. */
  saveUsageLimitSource(input: {
    id: string;
    kind?: UsageLimitSourceKind;
    /** `null` clears it; absent leaves it alone. */
    label?: string | null;
    url?: string;
    managementKey?: string;
    enabled?: boolean;
  }): Promise<{ source: UsageLimitSource }> {
    const { id, ...patch } = input;
    return this.request("PUT", `/v2/usage/sources/${encodeURIComponent(id)}`, patch);
  }

  /** Forget a hub and its stored key together. */
  removeUsageLimitSource(id: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v2/usage/sources/${encodeURIComponent(id)}`);
  }

  /**
   * What the hubs currently report — pooled account quota, per source.
   *
   * SERVED FROM A SHORT-LIVED CACHE. `refresh` waits for a fresh read of every
   * configured hub; without it a stale snapshot comes back immediately and
   * refreshes behind the answer.
   */
  usageLimits(options: { refresh?: boolean } = {}): Promise<{ limits: UsageLimits }> {
    return this.request("GET", `/v2/usage/limits${options.refresh ? "?refresh=1" : ""}`);
  }

  /** Who writes generated titles and branch names — see `TextGenPolicy`. */
  textGenPolicy(): Promise<{ textGen: TextGenPolicy }> {
    return this.request("GET", "/v2/textgen");
  }

  setTextGenPolicy(patch: {
    titles?: boolean;
    renameBranches?: boolean;
    driver?: ProviderDriverKind;
    /** `null` returns to the driver's default model; absent leaves it alone. */
    model?: string | null;
  }): Promise<{ textGen: TextGenPolicy }> {
    return this.request("PATCH", "/v2/textgen", patch);
  }

  /**
   * One structured completion from the policy's harness — the title job's
   * subprocess, generalised for callers that bring their own JSON schema.
   *
   * SLOW AND FALLIBLE BY NATURE: a cold harness start plus a completion, and a
   * harness that refuses or times out comes back as a `textgen_failed` 502
   * rather than an empty answer. Treat it as a request that may take a minute
   * and may not succeed.
   */
  completeStructured(
    input: { prompt: string; schema: Record<string, unknown>; model?: string; effort?: "low" | "medium" | "high" },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ result: Record<string, unknown> }> {
    return this.request("POST", "/v2/textgen/complete", input, options.signal);
  }

  /**
   * The host cockpit's published look — the whole `Look` (both theme halves,
   * the backdrop with its pixels, accent, type, strength) plus the few facts
   * about the publishing WINDOW a Look deliberately does not carry.
   *
   * PARSED HERE, NOT HANDED THROUGH RAW. The engine stores this blob without
   * understanding a word of it, and any paired device may have written it — so
   * the shared total parser runs on the way out, colour gates included. A
   * `null` appearance means "nothing published, or nothing readable"; both are
   * the same instruction to a reader: wear your own defaults.
   */
  async appearance(): Promise<{ appearance: PublishedAppearance | null; updatedAt: number | null }> {
    const raw = await this.request<{ appearance?: unknown; updatedAt?: unknown }>("GET", "/v2/appearance");
    return {
      appearance: parsePublishedAppearance(raw.appearance) ?? null,
      updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    };
  }

  /**
   * THE APPEARANCE HOME — the files, not the mailbox.
   *
   * Returned RAW rather than parsed into Looks and Themes. The home is a
   * directory two authors edit by hand, so "what is on disk" and "what this
   * build can wear" are different questions: the caller parses with the
   * vocabulary it paints with, and decides for itself what to do with an entry
   * it does not understand. `skipped` names the files that were not even JSON.
   */
  async appearanceHome(): Promise<{
    settings: Record<string, unknown> | null;
    themes: Record<string, unknown>[];
    looks: Record<string, unknown>[];
    images: string[];
    skipped: { file: string; reason: string }[];
  }> {
    const raw = await this.request<Record<string, unknown>>("GET", "/v2/appearance/home");
    const list = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
    return {
      settings: typeof raw["settings"] === "object" && raw["settings"] !== null && !Array.isArray(raw["settings"]) ? (raw["settings"] as Record<string, unknown>) : null,
      themes: list(raw["themes"]),
      looks: list(raw["looks"]),
      images: Array.isArray(raw["images"]) ? raw["images"].filter((name): name is string => typeof name === "string") : [],
      skipped: list(raw["skipped"]).map((entry) => ({ file: String(entry["file"] ?? ""), reason: String(entry["reason"] ?? "") })),
    };
  }

  async putAppearanceEntry(kind: "themes" | "looks", id: string, value: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/v2/appearance/home/${kind}/${encodeURIComponent(id)}`, value);
  }

  async deleteAppearanceEntry(kind: "themes" | "looks", id: string): Promise<void> {
    await this.request("DELETE", `/v2/appearance/home/${kind}/${encodeURIComponent(id)}`);
  }

  /**
   * A stored picture's bytes. Shaped exactly like `projectIcon` because it is
   * the same job — the engine holds a file, the cockpit streams it — and a
   * second idiom for "fetch binary from the engine" is how two of them drift
   * on error handling.
   */
  async appearanceImage(name: string): Promise<{ data: Uint8Array; contentType: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}/v2/appearance/home/images/${encodeURIComponent(name)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.discovery.token}` },
      });
    } catch {
      throw new EngineClientError("engine_unavailable", "engine is unreachable");
    }
    if (!response.ok) throw new EngineClientError(response.status === 404 ? "not_found" : "engine_unavailable", "no such image");
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  async putAppearanceSettings(settings: Record<string, unknown>): Promise<void> {
    await this.request("PUT", "/v2/appearance/home/settings", settings);
  }

  /** Replaces the published look wholesale — a snapshot, never a patch, because
   *  two publishers' merged halves would describe a look neither of them wears.
   *  `updatedAt` and `etag` come back so a publisher can tell its own write
   *  apart from somebody else's. */
  setAppearance(blob: PublishedAppearance): Promise<{ ok: boolean; updatedAt: number; etag: string }> {
    return this.request("PUT", "/v2/appearance", blob);
  }

  /** Forget the published look. Idempotent: clearing an empty mailbox is a
   *  200, because "there is no published look" is the state either way. */
  clearAppearance(): Promise<{ ok: boolean }> {
    return this.request("DELETE", "/v2/appearance");
  }

  // ── Spool ─────────────────────────────────────────────────────────────────
  //
  // NOT PROJECT-SCOPED, and that is the module's premise rather than a routing
  // convenience: an item's project is optional, and absent means floating — a
  // valid resting state. A project-scoped view is a filter over `rows`.

  /** Everything the queue renders, in one read — lanes, rows, desk, the
   *  diagnostic channel, and the two live numbers the footer states. */
  spool(): Promise<SpoolSnapshot> {
    return this.request("GET", "/v2/spool");
  }

  /** One item, with the lane and rank the STACKS give it — never the packet's
   *  own recovery hint. Both absent means unfiled, which is a resting state. */
  spoolItem(id: string): Promise<SpoolItemDetail> {
    return this.request("GET", `/v2/spool/items/${encodeURIComponent(id)}`);
  }

  createSpoolItem(input: {
    title: string;
    project?: string;
    lane?: string;
    raw?: string;
    rawSource?: string;
    creationNote?: string;
    /** A QUOTE, never a computation — §3.2's quoting law, restated where the
     *  tool surface hands one in. */
    deadline?: SpoolDeadline;
    /** The user's own day for it, strict `YYYY-MM-DD` — the engine refuses
     *  anything else with a sentence. Human-owned; see `SpoolPin`. */
    pinned?: SpoolPin;
    /** Whose hand is filing. ABSENT MEANS THE HUMAN'S ("you") — this is the
     *  human API, and a bare create must not count into "agents added N".
     *  Only the engine's own tool wall declares "session"; a surface never
     *  passes this field for a form the user submitted. */
    source?: "you" | "session";
    /** Free-text labels in the user's own words — identity across lanes and
     *  subjects, never a state or an urgency. */
    tags?: string[];
  }): Promise<{ item: SpoolItem }> {
    return this.request("POST", "/v2/spool/items", input);
  }

  /** Record the answer to one of an item's open questions. The engine refuses
   *  an empty answer and a question the item does not hold. */
  answerSpoolQuestion(id: string, question: string, answer: string): Promise<{ item: SpoolItem }> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/answer`, { question, answer });
  }

  /**
   * Patch an item. The permitted keys are the engine's to police, not this
   * client's: naming a forbidden one — `raw`, `promotedFrom`, `tracking` — is
   * refused there with a sentence saying which and why, and a client-side filter
   * would turn that refusal into a silent no-op.
   */
  updateSpoolItem(
    id: string,
    patch: {
      title?: string;
      lane?: string;
      project?: string;
      desk?: boolean;
      unplaced?: boolean;
      mirrored?: string;
      deadline?: SpoolDeadline;
      /** Set with `{day}`, clear with an EXPLICIT `null` — clearing removes the
       *  pin, never the item. Absent leaves the pin exactly as it is. */
      pinned?: SpoolPin | null;
      /** The whole tag list, replaced. `[]` clears; absent leaves it alone. */
      tags?: string[];
    },
  ): Promise<{ item: SpoolItem }> {
    return this.request("PATCH", `/v2/spool/items/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Tick the checkbox — the human's own close (`docs/spool-loops.md` §9). A
   * DEDICATED verb, never the generic patch: `closed` is refused there so no
   * tool-reachable path can spell it. The engine cascades: every open thread
   * holding this capture settles with the answer "the user closed the task",
   * and a thread that refused the settle comes back in `refused` rather than
   * undoing the close. Idempotent — closing a closed item returns the honest
   * note and changes nothing.
   */
  closeSpoolItem(id: string): Promise<{
    item: SpoolItem;
    settledThreads: SpoolThread[];
    refused: Array<{ threadId: string; reason: string }>;
    note?: string;
  }> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/close`);
  }

  /** Untick it — equally the hand's. Removes `closed` and nothing else:
   *  cascade-settled threads stay settled (open a new question instead), and
   *  the close/reopen pair stays on the item's timeline as the record. */
  reopenSpoolItem(id: string): Promise<{ item: SpoolItem; note?: string }> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/reopen`);
  }

  /**
   * Tick MANY checkboxes — the selection model's close, HUMAN API ONLY like
   * the single verb it is made of. Each id gets the same cascade and the same
   * per-item shape as a single close; an id nothing goes by comes back with
   * `error` beside the ones that landed, never as a thrown-away batch.
   */
  closeSpoolItems(ids: string[]): Promise<{
    results: Array<{
      id: string;
      item?: SpoolItem;
      settledThreads?: SpoolThread[];
      refused?: Array<{ threadId: string; reason: string }>;
      note?: string;
      error?: string;
    }>;
  }> {
    return this.request("POST", "/v2/spool/items/close-many", { ids });
  }

  addSpoolSubtask(id: string, title: string): Promise<{ item: SpoolItem }> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/subtasks`, { title });
  }

  setSpoolSubtaskDone(id: string, subtaskId: string, done: boolean): Promise<{ item: SpoolItem }> {
    return this.request(
      "PATCH",
      `/v2/spool/items/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { done },
    );
  }

  /** THE ONLY PROMOTION PATH. No tool surface reaches it — a human click does. */
  promoteSpoolSubtask(id: string, subtaskId: string): Promise<{ parent: SpoolItem; promoted: SpoolItem }> {
    return this.request(
      "POST",
      `/v2/spool/items/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtaskId)}/promote`,
    );
  }

  /**
   * Ask the item's own project expert to read it — the interpreter.
   *
   * SLOW BY NATURE: this awaits a model turn, so it is seconds to minutes where
   * every other method here is milliseconds. A caller needs a busy state, and
   * one that races two consultations on one item will append two passes' worth
   * of timeline events, because a pass is deliberately not idempotent — the
   * packet is the audit trail.
   *
   * NEVER REJECTS FOR A REFUSAL. A floating item or an unreachable expert comes
   * back as `{ok: false, reason}` with the sentence intact; only transport and
   * genuine engine faults throw.
   */
  consultSpoolExpert(id: string): Promise<SpoolExpertOutcome> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/expert`);
  }

  /**
   * The same pass, started and answered at once with its work record.
   *
   * WHAT EVERY SURFACE SHOULD CALL. A consultation is fifteen to twenty-two
   * turns; an HTTP client gives up long before that, and the first live run
   * proved it by reporting the engine unreachable while the daemon finished
   * fine. Poll `spoolWork()` for progress.
   *
   * `alreadyRunning` COMES BACK WITH THE EXISTING RECORD rather than a refusal.
   * Two clicks are one pass, and the second click's answer is "here is the one
   * you already have" — which is what the caller wanted to see anyway.
   */
  startSpoolExpert(id: string): Promise<{ work: SpoolWork | null; refused?: string; alreadyRunning?: boolean }> {
    return this.request("POST", `/v2/spool/items/${encodeURIComponent(id)}/expert`, { detach: true });
  }

  /** What the night did, or null when it has never run. */
  spoolNight(): Promise<{ night: SpoolNight | null }> {
    return this.request("GET", "/v2/spool/night");
  }

  /**
   * Start tonight's queue, or continue the one that stopped, and return at once
   * with the plan it intends to work.
   *
   * IT DOES NOT WAIT. A night is minutes of model calls and an HTTP client will
   * give up long before it ends — which is exactly what happened the first time
   * this was run for real. Poll `spoolNight()` for progress; the record is
   * written after every job, so that read is always current.
   *
   * It answers `{night: null, refused}` rather than starting while a person is
   * working, because a run that immediately stands down burns its plan and
   * records a stop for nothing.
   */
  startSpoolNight(
    input: { maxJobs?: number; maxCostUsd?: number } = {},
  ): Promise<{ night: SpoolNight | null; alreadyRunning?: boolean; refused?: string }> {
    return this.request("POST", "/v2/spool/night", input);
  }

  /**
   * Every subject, reconciled against what the items on disk actually name.
   *
   * READING IS ALSO HOW THE MIGRATION RUNS — a subject an item names and nothing
   * has registered is derived here. Idempotent, touches no packet, and
   * self-healing, which is why there is no boot hook to leave half-done.
   */
  spoolSubjects(): Promise<{ subjects: SpoolSubject[] }> {
    return this.request("GET", "/v2/spool/subjects");
  }

  /**
   * MISSION CONTROL — every subject's lobby card, ranked, pure composition
   * (§13.2). `today`, in `YYYY-MM-DD`, is the caller's own statement of what
   * day it is; omit it and the today-relative facts (a subject's
   * pinned-to-today count, its `nextPin`) simply do not appear.
   */
  spoolLobby(today?: string): Promise<{ lobby: SpoolLobby }> {
    return this.request("GET", `/v2/spool/lobby${today ? `?today=${encodeURIComponent(today)}` : ""}`);
  }

  /**
   * THE RE-ENTRY BRIEF — one subject's room, opened: where you left off, what
   * moved, what's open, what's next, cited. Same `today` convention as
   * `spoolLobby`.
   */
  spoolSubjectBrief(key: string, today?: string): Promise<{ brief: SpoolBrief }> {
    return this.request(
      "GET",
      `/v2/spool/subjects/${encodeURIComponent(key)}/brief${today ? `?today=${encodeURIComponent(today)}` : ""}`,
    );
  }

  /**
   * Set what may happen on a subject unattended — §7.6.
   *
   * NOT DECORATIVE: `read` gates ripening and `draft` gates drafting, so
   * lowering a subject stops the night working it tonight.
   */
  setSpoolSubjectPermits(key: string, permits: SpoolSubjectPermits): Promise<{ subject: SpoolSubject }> {
    // Rejects `not_found` for a key nothing goes by, which the web adapter maps
    // to a 404. It is not a refusal carrying a next move, so it is an error.
    return this.request("PATCH", `/v2/spool/subjects/${encodeURIComponent(key)}`, { permits });
  }

  /**
   * Say where a subject lives — `docs/spool-loops.md` §3's terrain. `null`
   * clears (a corrected statement, not a deletion; the subject's looks stay).
   * Rejects with the store's own sentence for an address it cannot hold.
   */
  setSpoolSubjectTerrain(key: string, terrain: SpoolTerrain | null): Promise<{ subject: SpoolSubject }> {
    return this.request("PATCH", `/v2/spool/subjects/${encodeURIComponent(key)}`, { terrain });
  }

  /**
   * Say whose a subject is — its `area` (the user's group name), its `color`
   * (a token from the closed identity set) and/or its `rank` (the user's own
   * manual position among the other subjects in that SAME area). `null`
   * clears a field, an absent key leaves it untouched — the same `in` rule as
   * terrain, spelled with explicit spreads because JSON.stringify would erase
   * `undefined` and make "leave it" indistinguishable from a bug. Identity,
   * never state. Rejects with the store's own sentence for a value it must
   * not hold.
   */
  setSpoolSubjectIdentity(
    key: string,
    patch: { area?: string | null; color?: SpoolSubjectColor | null; rank?: number | null },
  ): Promise<{ subject: SpoolSubject }> {
    return this.request("PATCH", `/v2/spool/subjects/${encodeURIComponent(key)}`, {
      ...("area" in patch ? { area: patch.area } : {}),
      ...("color" in patch ? { color: patch.color } : {}),
      ...("rank" in patch ? { rank: patch.rank } : {}),
    });
  }

  /**
   * Every area the store knows — the stored ceiling records merged with the
   * area names subjects reference. Joined by `name` against
   * `SpoolSubject.area`, the same join-by-key idiom terrain and permits use.
   */
  spoolAreas(): Promise<{ areas: SpoolArea[] }> {
    return this.request("GET", "/v2/spool/areas");
  }

  /**
   * State a ceiling on an area — every member subject's effective permit is
   * clamped DOWN to it — or withdraw one with `null`. Never raises anything:
   * a ceiling above a subject's own permit changes nothing for that subject.
   * Rejects with the store's own sentence for a level it does not know.
   */
  setSpoolAreaCeiling(name: string, ceiling: SpoolSubjectPermits | null): Promise<{ area: SpoolArea }> {
    return this.request("PATCH", `/v2/spool/areas/${encodeURIComponent(name)}`, { ceiling });
  }

  /** Every tag in use across items and notes, alphabetised, with its two
   *  counts — a read-time projection, no tag record on disk. */
  spoolTags(): Promise<{ tags: SpoolTagUsage[] }> {
    return this.request("GET", "/v2/spool/tags");
  }

  /**
   * Rename a tag everywhere it appears — every item and every note that
   * carries it. Renaming onto a name already in use MERGES the two (see
   * `apps/engine/src/spool/tags.ts`). Rejects with the store's own sentence
   * for a blank name or a `to` identical to `from`.
   */
  renameSpoolTag(from: string, to: string): Promise<{ tag: string; items: number; notes: number }> {
    return this.request("PATCH", `/v2/spool/tags/${encodeURIComponent(from)}`, { to });
  }

  /**
   * The room's smart view — which computed scope the wide room is showing.
   * One current value, no history; subject focus is a deeper aperture and
   * lives in the focus store, never here.
   */
  spoolAperture(): Promise<{ aperture: SpoolAperture }> {
    return this.request("GET", "/v2/spool/aperture");
  }

  /**
   * Point the room at a smart view. PUT because it replaces the one whole
   * value — idempotent, last writer wins, and the chat's tool and the hand's
   * click land on the same slot so neither can drift from the other.
   */
  setSpoolAperture(view: SpoolApertureView): Promise<{ aperture: SpoolAperture }> {
    return this.request("PUT", "/v2/spool/aperture", { view });
  }

  /**
   * RECONCILE-ON-LOOK — read the subject's terrain NOW, diff against the last
   * look, and return the fresh one. THE CALLER IS THE TRIGGER: this is the
   * pull in pull-never-push, called on arrival and on focus, never by a timer.
   *
   * NEVER REJECTS FOR THE WORLD BEING UNREACHABLE. `gh` failing comes back as
   * `{fresh: false, error}` beside the stale look, and a subject with no
   * terrain answers `{note}` — both are answers a surface renders, not faults.
   */
  reconcileSpoolLook(subjectKey: string): Promise<{ look: SpoolLookOutcome }> {
    return this.request("POST", "/v2/spool/look", { subjectKey });
  }

  /** Every subject's STORED look — what the Spool last saw, honestly stale
   *  (`fresh: false` on each), with no network read. The arrival read. */
  spoolLooks(): Promise<{ looks: SpoolLookOutcome[] }> {
    return this.request("GET", "/v2/spool/looks");
  }

  spoolLook(subject: string): Promise<{ look: SpoolLookOutcome }> {
    return this.request("GET", `/v2/spool/looks/${encodeURIComponent(subject)}`);
  }

  /** "Noted" — drains one observation. The row stays, marked; nothing here
   *  deletes. */
  acknowledgeSpoolObservation(subject: string, observationId: string): Promise<{ look: SpoolLook }> {
    return this.request("POST", `/v2/spool/looks/${encodeURIComponent(subject)}/ack`, { observationId });
  }

  /** "Noted", in bulk — drains every named observation, which is how a digest
   *  line's whole group goes quiet in one gesture. Idempotent: an id already
   *  drained, or one nothing goes by, changes nothing and fails nothing. */
  acknowledgeSpoolObservations(
    subject: string,
    observationIds: string[],
  ): Promise<{ look: SpoolLook; acknowledged: number }> {
    return this.request("POST", `/v2/spool/looks/${encodeURIComponent(subject)}/ack-all`, { observationIds });
  }

  /**
   * BRIEFED ARRIVAL — the composed opening context for "work on this".
   *
   * A READ: the engine composes the packet, the raw words, the thread state
   * and the delta from the subject's stored look into one deterministic text —
   * no model call, no session created, no turn queued. The web writes it into
   * the composer as a draft and the human sends it. `briefing.project` absent
   * means no registered project matches the item's subject, which is an
   * ordinary answer to render, never a reason to invent a project.
   */
  spoolBriefing(itemId: string): Promise<{ briefing: SpoolBriefing }> {
    return this.request("GET", `/v2/spool/items/${encodeURIComponent(itemId)}/briefing`);
  }

  /**
   * THE SHELF — documents beside the items (`docs/spool-loops.md` §10.1).
   * Retired notes ride along, marked: dismissing drains, and a list that hid
   * them would make retirement indistinguishable from deletion.
   */
  spoolNotes(subject?: string): Promise<{ notes: SpoolNote[] }> {
    return this.request("GET", `/v2/spool/notes${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`);
  }

  spoolNote(id: string): Promise<{ note: SpoolNote }> {
    return this.request("GET", `/v2/spool/notes/${encodeURIComponent(id)}`);
  }

  createSpoolNote(input: {
    title: string;
    body: string;
    tags?: string[];
    subjectKey?: string;
    /** Whose hand wrote it. ABSENT MEANS THE HUMAN'S ("you") — only the
     *  engine's own tool wall declares "session", exactly as items do. */
    author?: "you" | "session";
  }): Promise<{ note: SpoolNote }> {
    return this.request("POST", "/v2/spool/notes", input);
  }

  /** Edit a note's title, body or tags. The author NEVER changes — the engine
   *  refuses a patch that names it, so provenance survives every edit. */
  updateSpoolNote(
    id: string,
    patch: { title?: string; body?: string; tags?: string[] },
  ): Promise<{ note: SpoolNote }> {
    return this.request("PATCH", `/v2/spool/notes/${encodeURIComponent(id)}`, patch);
  }

  /** Retire a note — drains it off the working shelf with the reason, deletes
   *  nothing. The reason is required; withdrawing knowledge silently is how a
   *  shelf stops being trustworthy. */
  retireSpoolNote(id: string, reason: string): Promise<{ note: SpoolNote }> {
    return this.request("POST", `/v2/spool/notes/${encodeURIComponent(id)}/retire`, { reason });
  }

  /**
   * THE SEARCH — deterministic, lexical, model-free (§10.2), over items,
   * threads, notes and observations. Closed things are included and marked,
   * ranked below open ones.
   */
  spoolSearch(query: string, options: { subject?: string; limit?: number } = {}): Promise<{ hits: SpoolSearchHit[] }> {
    const params = new URLSearchParams({ q: query });
    if (options.subject) params.set("subject", options.subject);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    return this.request("GET", `/v2/spool/search?${params.toString()}`);
  }

  /** The outward MCP socket's connect card: where it listens, its dedicated
   *  secret (NOT the engine token), and the composed `claude mcp add` line. */
  spoolMcpInfo(): Promise<{ mcp: SpoolMcpInfo }> {
    return this.request("GET", "/v2/spool/mcp-info");
  }

  /**
   * Everything the Spool remembers, in one read — per subject, plus the front
   * door's own.
   *
   * RETIRED FACTS ARE INCLUDED. They leave the model's PROMPT, not the human's
   * view: "dismissing drains" means the record stays legible, and hiding them
   * would make retirement indistinguishable from the deletion this store has no
   * path for.
   */
  spoolMemory(): Promise<{ subjects: Array<{ key: string; facts: SpoolMemoryFact[] }>; self: SpoolMemoryFact[] }> {
    return this.request("GET", "/v2/spool/memory");
  }

  /**
   * THE MAP — every subject's open questions, their weave, and what no thread
   * claims yet.
   *
   * ONE CALL, for the reason `spoolSnapshot` states: these are projections of
   * the same items and the same digests, and fetching them per subject could
   * draw one subject's weave a tick apart from another's.
   */
  spoolMap(): Promise<SpoolMap> {
    return this.request("GET", "/v2/spool/threads");
  }

  spoolThreads(subject: string): Promise<SpoolSubjectThreads> {
    return this.request("GET", `/v2/spool/threads/${encodeURIComponent(subject)}`);
  }

  /**
   * WHERE TO PICK UP, and the day reading under it.
   *
   * ONE CALL: these are two views of the same focus log and the same map, so
   * fetching them apart could draw a brief that disagrees with its own history.
   */
  spoolFocus(): Promise<{ pickup: SpoolPickup; days: SpoolFocusDay[] }> {
    return this.request("GET", "/v2/spool/focus");
  }

  /** Start being on something. YOU set this — the system proposes, never picks. */
  openSpoolFocus(input: { subject: string; threadId?: string; note?: string }): Promise<{ focus: SpoolFocusEntry }> {
    return this.request("POST", "/v2/spool/focus", input);
  }

  /** Stop, and say where you left it. The note is what "pick back up" means. */
  closeSpoolFocus(id: string, end: { reason: SpoolFocusEnd; note?: string }): Promise<{ focus: SpoolFocusEntry }> {
    return this.request("PATCH", `/v2/spool/focus/${encodeURIComponent(id)}`, { end });
  }

  /**
   * Correct an entry, keeping what it said before.
   *
   * `threadId: null` CLEARS it — "I was on the subject, not that one thread" is
   * a real correction that `undefined` cannot express, since that means "leave
   * alone" everywhere else in this patch.
   */
  amendSpoolFocus(
    id: string,
    amend: { subject?: string; threadId?: string | null; note?: string; why?: string },
  ): Promise<{ focus: SpoolFocusEntry }> {
    return this.request("PATCH", `/v2/spool/focus/${encodeURIComponent(id)}`, { amend });
  }

  /**
   * Map a subject into the questions it is made of, and RETURN AT ONCE.
   *
   * IT DOES NOT WAIT, the same shape `startSpoolExpert` takes and for the same
   * reason: this reads every capture in a subject through a model. Poll
   * `spoolWork()` for progress — the record is addressed by SUBJECT, not by an
   * item, so two clicks anywhere are one pass.
   */
  startSpoolThreadPass(
    subject: string,
  ): Promise<{ work: SpoolWork | null; refused?: string; alreadyRunning?: boolean }> {
    return this.request("POST", `/v2/spool/threads/${encodeURIComponent(subject)}`, { detach: true });
  }

  /**
   * Write down what a question turned out to be — the store's first exit that is
   * not a deletion.
   *
   * AN ANSWER IS REQUIRED, and both the daemon and the store refuse without one.
   * A settle with no answer would be a status flip, which `SpoolThread`
   * deliberately cannot express.
   */
  settleSpoolThread(subject: string, threadId: string, answer: string): Promise<{ thread: SpoolThread }> {
    return this.request(
      "PATCH",
      `/v2/spool/threads/${encodeURIComponent(subject)}/${encodeURIComponent(threadId)}`,
      { settle: { answer } },
    );
  }

  /**
   * Settle MANY threads, each with its own required answer — the selection
   * model's settle. Per-thread failures come back in `refused` beside the ones
   * that landed rather than failing the batch: a thread already settled, or an
   * empty answer, refuses that ROW with the store's own sentence.
   */
  settleSpoolThreadsMany(
    subject: string,
    settles: Array<{ threadId: string; answer: string }>,
  ): Promise<{ settled: SpoolThread[]; refused: Array<{ threadId: string; reason: string }> }> {
    return this.request("POST", `/v2/spool/threads/${encodeURIComponent(subject)}/settle-many`, { settles });
  }

  /**
   * Open ONE question on a subject's map, deliberately. Every law that binds a
   * mapping pass binds this — at least one capture, dedupe against restated
   * questions, the grouping marked `proposed` — enforced in the store.
   */
  openSpoolThread(
    subject: string,
    input: {
      question: string;
      handle?: string;
      items: string[];
      waiting?: { kind: "you" | "agent" | "person"; who?: string; note?: string };
    },
  ): Promise<{ thread: SpoolThread }> {
    return this.request("POST", `/v2/spool/threads/${encodeURIComponent(subject)}/open`, input);
  }

  /** Who a thread is stuck on. Normalised by the store ("person" naming the
   *  human IS "you"), and refused on a settled thread. */
  setSpoolThreadWaiting(
    subject: string,
    threadId: string,
    waiting: { kind: "you" | "agent" | "person"; who?: string; note?: string },
  ): Promise<{ thread: SpoolThread }> {
    return this.request(
      "PATCH",
      `/v2/spool/threads/${encodeURIComponent(subject)}/${encodeURIComponent(threadId)}`,
      { waiting },
    );
  }

  /** A human looked at an agent's grouping — clears `proposed` and nothing else. */
  reviewSpoolThread(subject: string, threadId: string): Promise<{ thread: SpoolThread }> {
    return this.request(
      "PATCH",
      `/v2/spool/threads/${encodeURIComponent(subject)}/${encodeURIComponent(threadId)}`,
      { reviewed: true },
    );
  }

  /** Move a capture to another thread, or off the map with `to: null`. */
  refileSpoolCapture(
    subject: string,
    itemId: string,
    to: string | null,
  ): Promise<{ map: SpoolSubjectThreads }> {
    return this.request("POST", "/v2/spool/threads-refile", { subject, itemId, to });
  }

  /**
   * A human's verdict on one remembered fact: retire it, or confirm it.
   *
   * THE OTHER DOOR from the one an agent uses. A pass may propose retiring a
   * fact and is refused for `person` facts; this caller is the person, so it has
   * no such rule. `subject` absent means the front door's own memory.
   */
  judgeSpoolFact(input: {
    id: string;
    subject?: string;
    retire?: { why: string };
    reviewed?: boolean;
  }): Promise<{ fact: SpoolMemoryFact }> {
    const { id, ...rest } = input;
    return this.request("PATCH", `/v2/spool/memory/${encodeURIComponent(id)}`, rest);
  }

  /**
   * What the Spool is doing right now, and what it just finished.
   *
   * POLLED, NOT STREAMED, and only while something is running. The record is
   * in memory on the daemon — a pass in flight is not durable data and never
   * pretends to be — so this is the only way to see one, and a caller that
   * stops asking simply stops seeing it.
   */
  spoolWork(): Promise<{ work: SpoolWork[] }> {
    return this.request("GET", "/v2/spool/work");
  }

  /** The screen the assistant is composing right now. Poll it — `rev` rises on
   *  every block, so a client can skip a render it has already seen. */
  spoolCanvas(): Promise<SpoolCanvasState> {
    return this.request("GET", "/v2/spool/canvas");
  }

  /**
   * ASK FOR A SCREEN, and get an answer immediately.
   *
   * The composition does NOT come back here — it lands on the canvas, block by
   * block, while the model works. That is the whole shape being tested: a
   * response that waited for the finished screen would take half a minute and
   * arrive all at once, which is the same information in the least useful order.
   */
  askSpoolCanvas(asked: string): Promise<{ asked: string }> {
    return this.request("POST", "/v2/spool/canvas", { asked });
  }

  /** Stop one pass. `{stopped: false}` when nothing is running under that id,
   *  which is an answer rather than an error — see the daemon's own note. */
  cancelSpoolWork(id: string): Promise<{ stopped: boolean }> {
    return this.request("DELETE", `/v2/spool/work/${encodeURIComponent(id)}`);
  }

  /** The Spool's project-less master chat, ensured. A SINGLETON: calling this
   *  twice returns the same session, so it is safe on every page load. */
  spoolMaster(): Promise<{ session: Session }> {
    return this.request("GET", "/v2/spool/master");
  }

  spoolLanes(): Promise<{ lanes: SpoolLane[] }> {
    return this.request("GET", "/v2/spool/lanes");
  }

  createSpoolLane(input: { label: string; window: string; note?: string }): Promise<{ lane: SpoolLane }> {
    return this.request("POST", "/v2/spool/lanes", input);
  }

  renameSpoolLane(key: string, label: string): Promise<{ lane: SpoolLane }> {
    return this.request("PATCH", `/v2/spool/lanes/${encodeURIComponent(key)}`, { label });
  }

  /** A REFUSAL IS A RESULT, not a thrown error: the reason names what the human
   *  must move first, and it is the answer to the question rather than a fault. */
  retireSpoolLane(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.request("DELETE", `/v2/spool/lanes/${encodeURIComponent(key)}`);
  }

  reorderSpoolLane(key: string, items: string[]): Promise<{ lane: SpoolLane }> {
    return this.request("POST", `/v2/spool/lanes/${encodeURIComponent(key)}/reorder`, { items });
  }

  /** Split rows out of a lane into a new one — `createLane` plus two reorders,
   *  never a fifth lane primitive, and reachable only from a human's click. */
  splitSpoolLane(
    sourceKey: string,
    input: { label: string; window: string; note?: string },
    items: string[],
  ): Promise<{ source: SpoolLane; created: SpoolLane }> {
    return this.request("POST", "/v2/spool/lanes/split", { sourceKey, ...input, items });
  }

  /** A project's git state — branch, dirty count, divergence, worktrees.
   *  Read fresh on every call: it describes a working tree that changes
   *  underneath the engine, and a stale branch name is worse than a slow one. */
  projectGit(projectId: string): Promise<{ git: GitOverview }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/git`);
  }

  /**
   * THE PROJECT NOTEBOOK — `docs/design/project-notes.md`.
   *
   * Notes hang off the PROJECT, so every session on it reads the same notebook,
   * and the composer's foot draws this list. Already ordered — pinned first,
   * then the user's own order — so no caller re-sorts.
   */
  projectNotes(projectId: string): Promise<{ notes: ProjectNote[] }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/notes`);
  }

  projectNote(projectId: string, noteId: string): Promise<{ note: ProjectNote }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`);
  }

  /** A body may be empty — the gesture is "+, type a title, come back to it",
   *  and a store that refused the half-written note would lose the title. */
  createProjectNote(
    projectId: string,
    input: {
      title: string;
      body?: string;
      pinned?: boolean;
      /** Whose hand. ABSENT MEANS THE HUMAN'S ("you") — only the engine's own
       *  tool wall declares "session", exactly as spool notes do. */
      author?: ProjectNoteAuthor;
    },
  ): Promise<{ note: ProjectNote }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/notes`, input);
  }

  /** The author NEVER changes — the engine refuses a patch that names it, so
   *  provenance survives every edit, as it does on the shelf. */
  updateProjectNote(
    projectId: string,
    noteId: string,
    patch: { title?: string; body?: string; pinned?: boolean; order?: number },
  ): Promise<{ note: ProjectNote }> {
    return this.request("PATCH", `/v2/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`, patch);
  }

  /** A REAL DELETE, unlike the shelf's retire: a project note is a scratchpad,
   *  and `deleted: false` means it was already gone — never an error. */
  deleteProjectNote(projectId: string, noteId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`);
  }

  pinProjectNote(projectId: string, noteId: string, pinned: boolean): Promise<{ note: ProjectNote }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}/pin`, { pinned });
  }

  /** The notebook socket's connect card — what the user's OTHER app is
   *  configured with. Its own secret, not the engine token. */
  notesMcpInfo(): Promise<{ mcp: NotesMcpInfo }> {
    return this.request("GET", "/v2/notes/mcp-info");
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

  /**
   * What there is to filter by in this repository — milestones, labels, who can be
   * assigned, and the login `gh` is signed in as.
   *
   * ITS OWN ROUTE AND ITS OWN CACHE, five minutes rather than thirty seconds: these
   * change on the timescale of a sprint. Nothing asks for it until a filter menu
   * opens, so a reader who never filters never pays for it.
   */
  projectForgeFacets(projectId: string, options: { refresh?: boolean } = {}): Promise<{ facets: GitHubFacets }> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/facets${suffix}`);
  }

  /**
   * One failing check's log — the tail of `gh run view --log-failed`.
   *
   * NOT CACHED anywhere: a finished job's log never changes, so there is nothing to
   * save, and a running job's is the one thing that must not be stale.
   */
  projectCheckLog(projectId: string, jobId: string): Promise<{ log: GitHubCheckLog }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/checks/${encodeURIComponent(jobId)}/log`);
  }

  /**
   * Ignore Telar's own files in a project's repository.
   *
   * NO BODY, AND THAT IS THE SAFETY: the rules are the engine's, so a client
   * cannot use this to append arbitrary lines to a file in somebody's checkout.
   * The answer reports what was added AND what a rule already covered, because a
   * repository that already ignores everything is a success that would otherwise
   * look like a no-op.
   */
  projectGitignore(projectId: string): Promise<{ gitignore: GitignoreResult }> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/gitignore`, {});
  }

  /**
   * Take those rules back out — the Undo behind the toast that reports them.
   *
   * ONLY THE BLOCK THIS ENGINE WROTE: its header and the run of its own rules
   * directly under it. A `.telar/` somebody added in their own section is theirs
   * and survives. `removed: []` is a success, not a failure — it means there was
   * nothing of Telar's left to remove.
   */
  undoProjectGitignore(projectId: string): Promise<{ gitignore: GitignoreRemoval }> {
    return this.request("DELETE", `/v2/projects/${encodeURIComponent(projectId)}/gitignore`);
  }

  /**
   * ONE issue or ONE pull request — the body, the conversation, and for a pull
   * request its reviews, its checks and whether GitHub will merge it.
   *
   * THE ANSWER IS A UNION, not a throw: `{ issue }` or `{ unavailable, message? }`.
   * A detail read has a fifth way to be unavailable that a list read does not
   * (`not_found` — there is no #999), and all five are sentences a reader can act
   * on rather than HTTP failures.
   */
  projectIssue(projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubIssueRead> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/issues/${number}${suffix}`);
  }

  projectPull(projectId: string, number: number, options: { refresh?: boolean } = {}): Promise<GitHubPullRead> {
    const suffix = options.refresh ? "?refresh=1" : "";
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}${suffix}`);
  }

  /**
   * Merge a pull request.
   *
   * `expectedHeadOid` IS REQUIRED AND IS THE POINT. It is the `headRefOid` the
   * detail read returned, and it goes to GitHub as `--match-head-commit`, so a
   * commit pushed after the review — by a person or by an agent — makes this
   * refuse rather than merge something nobody read. There is deliberately no way
   * to say "merge whatever is on the branch now".
   *
   * A refusal is `{ merged: false, refusal }` with seven named reasons, not an
   * exception; see `GitHubMergeRefusal`.
   */
  mergeProjectPull(
    projectId: string,
    number: number,
    input: { method: GitHubMergeMethod; expectedHeadOid: string },
  ): Promise<GitHubMergeResult> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/merge`, input);
  }

  /** What is uncommitted in a project right now — the review a canvas shows
   *  before its conversation exists. */
  projectDiff(projectId: string): Promise<{ diff: SessionDiff }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/diff`);
  }

  projectFilePatch(projectId: string, path: string, options: { untracked?: boolean } = {}): Promise<{ file: { patch: string; binary: boolean } }> {
    const query = new URLSearchParams({ path });
    if (options.untracked) query.set("untracked", "1");
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/diff?${query.toString()}`);
  }

  /**
   * Every file in a checkout, for the Files tree.
   *
   * NOT CACHED AND NOT POLLED. It is git reading its own index — 18ms for this
   * repository — and a tree that reorders itself under the cursor on a timer is
   * worse than one that waits to be asked. The surface has a refresh button.
   */
  projectFiles(projectId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/files`);
  }

  sessionFiles(sessionId: string): Promise<{ listing: WorkspaceListing }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files`);
  }

  /**
   * What this session's provider can be asked to do — its skills and its slash
   * commands, read where the session actually runs.
   *
   * PER SESSION RATHER THAN PER PROJECT because the checkout is: a worktree
   * session's `.claude` is its own copy's, and the provider answers about the
   * directory it was started in. Cached in the engine (see
   * `provider-skills.ts`), so a menu may ask on every keystroke.
   */
  sessionSkills(sessionId: string): Promise<ProviderSkills> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/skills`);
  }

  /** One file's text, as it is on disk. Fenced inside the checkout by the
   *  engine — see `readFenced` there for why the check is not at the route. */
  projectFile(projectId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`);
  }

  sessionFile(sessionId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`);
  }

  /**
   * One file's BYTES — what the cockpit's media viewers (image, PDF, video)
   * render. The text routes above deliberately withhold a binary file's
   * content; this is the read that serves it, refused past the engine's raw
   * ceiling rather than truncated.
   */
  projectFileBytes(projectId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.rawBytes(`/v2/projects/${encodeURIComponent(projectId)}/files/raw?${new URLSearchParams({ path }).toString()}`);
  }

  sessionFileBytes(sessionId: string, path: string): Promise<{ data: Uint8Array; contentType: string }> {
    return this.rawBytes(`/v2/sessions/${encodeURIComponent(sessionId)}/files/raw?${new URLSearchParams({ path }).toString()}`);
  }

  /**
   * Save a file a human edited.
   *
   * `expectedSha256` IS THE SAFETY, not an optimisation: it is the hash the read
   * returned, and the engine refuses the write if disk no longer matches — which
   * happens for real, because an agent may be writing this file mid-turn. A
   * refusal comes back as `written: false` rather than as a thrown error; see
   * `WorkspaceWriteResult`.
   */
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

  /**
   * Which models a provider says it has, as one login reads them.
   *
   * The PROVIDER answer is cached in the engine for five minutes — answering
   * means spawning the provider's own CLI. The reader's overlay on top of it is
   * not cached at all, so a hide or an added id shows up on the very next call
   * without `refresh`. Omitting `instanceId` gets the driver's built-in slot.
   */
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
    patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[] },
  ): Promise<{ overlay: ModelOverlay }> {
    return this.request("PATCH", `/v2/provider-instances/${encodeURIComponent(instanceId)}/models`, patch);
  }

  listSessions(projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  /**
   * Every LIVE session on the engine, across projects, with the project
   * registry beside it — one read rather than one per project, so the two
   * halves cannot be composed from different instants.
   */
  /**
   * WHAT THIS MAC ALLOWS, and its machine-level plugin settings.
   *
   * Scoped to the engine this client points at — a cockpit viewing a remote Mac
   * reads that Mac's answer, never the one it happens to run beside.
   */
  machinePlugins(): Promise<{ plugins: PluginStatus[]; machine: ProjectPlugins }> {
    return this.request("GET", "/v2/plugins");
  }

  /** Turn a plugin on or off for this Mac, or change its machine settings. */
  updateMachinePlugins(
    plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>,
  ): Promise<{ machine: ProjectPlugins }> {
    return this.request("PATCH", "/v2/plugins", { plugins });
  }

  /**
   * Assignments ride this list so a sidebar never fetches a history per row.
   *
   * AND SO DOES THE ARRANGEMENT. `layout` is the engine's whole
   * `sidebar-layout.json`, carried here because this is the one route every
   * rail already polls — which is what lets a drag on one device reach the
   * others without a second request or a connection of its own. Optional: an
   * engine older than the field says nothing, and a rail reads that as "keep
   * the copy I have" rather than "nobody has arranged anything".
   */
  liveSessions(): Promise<{
    sessions: Session[];
    projects: Array<{ id: string; name: string }>;
    assignments?: Record<string, SessionAssignment[]>;
    layout?: SidebarLayout;
  }> {
    return this.request("GET", "/v2/sessions/live");
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
    /** What a worktree is cut from — any name in `GitOverview.refs`
     *  (`main`, `origin/feature-x`). Absent means HEAD. Worktree only. */
    baseRef?: string;
    /** A human's own name for the new branch, OUTSIDE loom//telar/. The engine
     *  refuses (never resets) a collision with an existing branch. */
    branchName?: string;
    /**
     * WHO ASKED — provenance, never a link to anything and never a count.
     * `"session"` marks a session that the `sessions` toolkit created; absent
     * is a human's own click. Declared by the calling CODE, never by a model
     * argument.
     */
    origin?: SessionOrigin;
  }): Promise<{ session: Session }> {
    return this.request("POST", "/v2/sessions", input);
  }

  /**
   * Where the outward `sessions` MCP socket listens, and its dedicated secret —
   * the `sessions` half of `spoolMcpInfo`. Behind the normal bearer, because
   * reading it mints and reveals a credential.
   */
  sessionsMcpInfo(): Promise<{ mcp: { url: string; secret: string; addCommand: string } }> {
    return this.request("GET", "/v2/sessions/mcp-info");
  }

  /**
   * A HUMAN WAS SHOWN THIS TURN'S RESULT — the read receipt behind unread.
   *
   * NAMES THE TURN, NOT A TIME. A "read as of now" would swallow whatever
   * finished between the render being reported on and this request landing,
   * which is exactly the answer nobody has seen. The engine keeps the highest
   * result sequence anybody has confirmed, so a late or duplicate receipt is a
   * no-op rather than a regression, and a turn that is still running — or was
   * steered or discarded — is refused.
   */
  markSessionRead(sessionId: string, runId: string): Promise<{ session: Session }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/read`, { runId });
  }

  /**
   * Change a live session. `runtimeMode` takes effect on the very NEXT tool
   * call, including inside a turn that is already running — it is the brake a
   * human reaches for when a detached session does something unexpected.
   */
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
  ): Promise<{ session: Session }> {
    return this.request("PATCH", `/v2/sessions/${encodeURIComponent(sessionId)}`, patch);
  }

  /**
   * THE ONE FIELD OF `updateSession` A WORKER MAY TOUCH. The worker's client
   * is a `Pick`, so an orchestrating session can shelve a peer it finished
   * with without gaining the mode, model or title of any session — see
   * `sessions_settle`.
   */
  settleSession(sessionId: string, settled: boolean): Promise<{ session: Session }> {
    return this.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" });
  }

  session(sessionId: string, window?: SnapshotWindow): Promise<SessionSnapshot> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}${snapshotQuery(window)}`);
  }

  events(sessionId: string, after = 0): Promise<{ events: EngineEvent[]; cursor: number; more: boolean }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
  }

  /**
   * Queue one message. `model` applies to THIS turn only and cannot name an
   * instance — the provider is the session's for its whole life (see
   * `TurnModelSelection`). `attachments` are ids from `uploadAttachment`.
   */
  submitTurn(
    sessionId: string,
    input: { runId: string; input: string; kind?: "message" | "compact"; model?: TurnModelSelection; attachments?: string[] },
  ): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns`, input);
  }

  /**
   * Queue one message AS AN AGENT — the worker's half of `sessions_send`.
   * `proof` is the sending turn's own claim; the engine stamps the sender
   * from it and never from anything a model typed. See `AgentTurnInput`.
   */
  submitAgentTurn(sessionId: string, input: AgentTurnInput): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/agent`, input);
  }

  /**
   * ONE DOOR TO THE SESSION'S KERNEL. `method` is the verb — `execute`,
   * `notebook/run`, `snapshot`… — and it is always a POST, because even a read
   * of the namespace may start the kernel. The daemon's `storeDsCapability`
   * is the implementation; this is its wire.
   */
  ds<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/ds/${method}`, body ?? {});
  }

  /**
   * ONE DOOR TO THE SESSION'S LATEX, shaped like `ds` above: `method` is the
   * verb — `compile`, `status`, `log`… — always a POST. The daemon's
   * `storeLatexCapability` is the implementation; this is its wire.
   */
  latex<T>(sessionId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/latex/${method}`, body ?? {});
  }

  /**
   * ONE DOOR TO EVERY PLUGIN — `ds` and `latex` above, generalised, and the
   * reason a third feature needs no third method here. `pluginId` picks the
   * plugin, `method` its verb; the daemon resolves the capability (which
   * project, has it opted in) and hands it to the plugin's own route.
   *
   * `ds` and `latex` REMAIN as their own methods rather than becoming callers
   * of this: they are the shape a released client already speaks, and an old
   * client pointed at a new daemon has to keep working.
   */
  plugin<T>(sessionId: string, pluginId: string, method: string, body?: unknown): Promise<T> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/plugins/${pluginId}/${method}`, body ?? {});
  }

  /**
   * The project's saved launch recipes and its one local deployment.
   *
   * SESSION-SCOPED URLS, PROJECT-SCOPED ANSWERS, and the mismatch is the design
   * rather than an oversight. A run belongs to the project — every session
   * looking at it sees the same deployment — but WHICH project, and which
   * worktree the caller is sitting on, is something only the engine can resolve
   * from a session id. So the session names the caller; the answer describes the
   * project, and says which tree the caller is on so a client can tell "my dev
   * server" from "the one started from another branch".
   */
  runConfigurations(sessionId: string): Promise<RunConfigurationsAnswer> {
    return this.request("GET", `${runBase(sessionId)}/configs`);
  }

  createRunConfiguration(sessionId: string, draft: RunConfigurationDraft): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs`, draft);
  }

  /**
   * PATCH SEMANTICS, AND `env` IS THE ONE THAT MATTERS. The engine merges this
   * shallowly, so omitting `env` preserves what is stored — which is the only
   * way a client that was never sent a secret value can edit a configuration
   * without erasing it. Sending `env` replaces the whole list.
   */
  updateRunConfiguration(sessionId: string, configId: string, patch: Partial<RunConfigurationDraft>): Promise<RunConfigurationView> {
    return this.request("POST", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`, patch);
  }

  removeRunConfiguration(sessionId: string, configId: string): Promise<{ removed: string }> {
    return this.request("DELETE", `${runBase(sessionId)}/configs/${encodeURIComponent(configId)}`);
  }

  runStatus(sessionId: string): Promise<RunStatusAnswer> {
    return this.request("GET", `${runBase(sessionId)}/status`);
  }

  /**
   * Start a configuration. `replace` is REFUSED BY DEFAULT rather than assumed:
   * a project has one local deployment, and taking over one somebody else is
   * watching has to be asked for by name. Without it, a project that is already
   * running answers `conflict`.
   */
  startRun(sessionId: string, input: RunStartInput): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/start`, input);
  }

  stopRun(sessionId: string, runId?: string): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/stop`, runId === undefined ? {} : { runId });
  }

  restartRun(sessionId: string, runId?: string): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/restart`, runId === undefined ? {} : { runId });
  }

  /**
   * Give up the project's slot for a run the engine has lost contact with.
   * SIGNALS NOTHING — that is the point: whatever is still holding the port is
   * the human's to deal with, and this is them saying they have checked.
   */
  releaseRun(sessionId: string, runId: string): Promise<RunView> {
    return this.request("POST", `${runBase(sessionId)}/release`, { runId });
  }

  /** Captured output from `after`. A cursor that goes BACKWARDS means a
   *  different run, not lost lines — see `RunOutputAnswer`. */
  runOutput(sessionId: string, input: { runId?: string; after?: number } = {}): Promise<RunOutputAnswer> {
    const query = new URLSearchParams();
    if (input.runId !== undefined) query.set("runId", input.runId);
    if (input.after !== undefined) query.set("after", String(input.after));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.request("GET", `${runBase(sessionId)}/output${suffix}`);
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
    return this.rawBytes(`/v2/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  /** A GET whose answer is content rather than JSON — attachments and raw
   *  workspace files. Errors still arrive as JSON and are decoded as such. */
  private async rawBytes(pathAndQuery: string): Promise<{ data: Uint8Array; contentType: string }> {
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
      let code: EngineErrorCode = "engine_unavailable";
      let message = "engine request failed";
      try {
        const error = ((await response.json()) as EngineErrorBody | null)?.error;
        if (error) ({ code, message } = error);
      } catch { /* keep defaults */ }
      throw new EngineClientError(code, message, response.status);
    }
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  /**
   * Put a file where the session's provider can reach it, BEFORE the message
   * that refers to it.
   *
   * Raw bytes rather than JSON: base64 costs a third of the payload again on
   * the largest thing a client ever sends, and the engine's JSON body cap is
   * deliberately small for everything else.
   */
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

  /**
   * What this session has done to the repository since it started — committed
   * and uncommitted together, measured from the base recorded when it was
   * created. See `SessionDiff` for why that framing rather than `git status`.
   */
  sessionDiff(sessionId: string): Promise<{ diff: SessionDiff }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/diff`);
  }

  /** One file's patch. Separate from the review for the same reason a screenshot
   *  is separate from the browser's tab list: size, and nobody reads all of it. */
  sessionFilePatch(sessionId: string, path: string, options: { untracked?: boolean } = {}): Promise<{ file: { patch: string; binary: boolean } }> {
    const query = new URLSearchParams({ path });
    if (options.untracked) query.set("untracked", "1");
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/diff?${query.toString()}`);
  }

  /** Snapshot the session's work as one commit. The engine's only git mutation —
   *  additive, reversible, and never automatic. */
  commitSessionWork(sessionId: string, message: string): Promise<{ committed: boolean; commit?: GitCommitEntry; reason?: string }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/git/commit`, { message });
  }

  /**
   * What the session's browser is looking at, with pixels.
   *
   * `screenshot` costs a real round trip through Chromium, so it is opt-in; and
   * `start` is opt-in for a bigger reason — a panel that polled for state would
   * otherwise LAUNCH a browser for every session it rendered.
   */
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

  /**
   * The MACHINE-WIDE MCP servers — the ones every project sees.
   *
   * A project's own live under `listProjectMcpServers`, and the URL is what
   * says which scope you are in. Two shapes rather than one with a filter,
   * because "all of them" and "the global ones" being the same request is how a
   * delete lands in the wrong scope.
   */
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

  /**
   * Whether each http server wants a login, and whether ours works.
   *
   * COSTS TWO NETWORK ROUND TRIPS PER SERVER — a detection probe and an
   * authenticated `initialize` — so it is a call a page makes when it opens or
   * when somebody presses refresh, never a poll.
   *
   * `projectId` SCOPES IT the same way the server list does: absent asks about
   * the machine-wide servers, present asks about the merge that project's
   * sessions actually run with.
   */
  mcpOAuthStatus(projectId?: string): Promise<{ statuses: McpOAuthStatus[] }> {
    return this.request("GET", projectId ? `/v2/mcp-oauth?projectId=${encodeURIComponent(projectId)}` : "/v2/mcp-oauth");
  }

  /**
   * Start a browser sign-in and get the URL to send them to.
   *
   * NOTHING SECRET CROSSES THIS CALL IN EITHER DIRECTION. The PKCE verifier and
   * the state stay in the engine, keyed by the state the authorization server
   * will echo back; the caller receives only a URL it could have been shown
   * anyway.
   *
   * `redirectOrigin` is the ORIGIN OF THE PAGE the user is looking at, because
   * the authorization server sends the browser back there — and on a cockpit
   * reachable by more than one name, a constant would send it to the wrong one.
   */
  connectMcpOAuth(input: { serverId: string; projectId?: string; redirectOrigin: string }): Promise<{ authorizationUrl: string }> {
    return this.request("POST", "/v2/mcp-oauth/connect", input);
  }

  /** Finish a flow: hand back the `code` and `state` the authorization server
   *  put on the callback URL. Single-use — a replayed callback finds nothing. */
  completeMcpOAuth(input: { state: string; code: string }): Promise<{ serverId: string; projectId?: string }> {
    return this.request("POST", "/v2/mcp-oauth/callback", input);
  }

  /** Forget a stored grant. Idempotent; `removed` says whether one existed. */
  disconnectMcpOAuth(input: { serverId: string; projectId?: string }): Promise<{ removed: boolean }> {
    return this.request("POST", "/v2/mcp-oauth/disconnect", input);
  }

  /**
   * The configured logins, and what the machine says about each.
   *
   * ONE CALL FOR BOTH: a settings row needs the configuration and the probe to
   * render at all, and splitting them would let the page paint a green dot
   * beside an instance the second call is about to report missing.
   *
   * SENSITIVE ENVIRONMENT VALUES ARE NOT IN THIS ANSWER. They come back as
   * `{ value: "", valueRedacted: true }`; sending that same shape to
   * `saveProviderInstance` keeps the stored secret.
   */
  listProviderInstances(options: { refresh?: boolean } = {}): Promise<{ providerInstances: ProviderInstance[]; probes: ProviderProbe[] }> {
    return this.request("GET", `/v2/provider-instances${options.refresh ? "?refresh=1" : ""}`);
  }

  /**
   * Update the CLI behind one login, and report what happened.
   *
   * THERE IS NO COMMAND IN THIS CALL. The instance id is the whole input; the
   * engine resolves which binary that login runs and derives what would update
   * it from the install it found. Anything else would make this a remote shell
   * with a settings button on it.
   *
   * KEYED ON THE LOGIN, not the driver, because a login can pin its own
   * `binaryPath`. Rows sharing a binary still all change together — that falls
   * out of them resolving to the same file, rather than being assumed.
   *
   * THE FRESH PROBES COME BACK IN THE SAME ANSWER, past every cache, so the
   * caller cannot paint the version it just replaced.
   */
  updateProviderCli(instanceId: string): Promise<{
    result: ProviderUpdateRun;
    providerInstances: ProviderInstance[];
    probes: ProviderProbe[];
  }> {
    return this.request("POST", `/v2/provider-updates/${encodeURIComponent(instanceId)}`, {});
  }

  /** `null` clears a field, an absent key leaves it alone. Two different
   *  requests, and JSON has no other way to say so. */
  saveProviderInstance(input: {
    id: string;
    driver?: ProviderDriverKind;
    displayName?: string | null;
    accentColor?: string | null;
    configDir?: string | null;
    binaryPath?: string | null;
    enabled?: boolean;
    env?: ProviderInstanceEnvVar[];
  }): Promise<{ providerInstance: ProviderInstance }> {
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

  /** End all session-owned active, queued, held and background work.
   * Delivered messages remain in history; the next message needs no Resume.
   * `stopTurn` is the separate operation that interrupts only one run. */
  stopSession(sessionId: string, by: "user" | "agent" = "user", commandId?: string): Promise<{ stopped: Turn[]; live?: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop`, { scope: "session", by, commandId });
  }

  /**
   * Stop the session's lingering background tasks — the "N tasks still
   * working" chip. A DIFFERENT verb from `stopTurn`: background work outlives
   * its turn, so there may be no turn to stop, and the turn Stop deliberately
   * spares it. `stopped` is how many tasks it ended.
   */
  stopBackgroundTasks(sessionId: string): Promise<{ stopped: number }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/stop-background`, {});
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

  /**
   * REMOVE A SESSION AND EVERYTHING IT OWNS. There is no undo.
   *
   * Distinct from `archiveSession` in the only way that matters: archiving
   * keeps the record and the transcript, this does not. It exists because
   * settling is now the way to put a session down, and a lifecycle whose only
   * exit is the concept you retired has no exit at all.
   *
   * Refuses while a turn is in flight — the journal is still being written to.
   */
  deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Explicit human resolution for a turn whose provider effects are uncertain. */
  /** Let a message recovery held run after a human has re-read it. */
  releaseHeldTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/release`, {});
  }

  /**
   * RESUME NOW — don't wait for the limit to lift.
   *
   * A HUMAN gesture like release and discard, so no claim token: the person
   * pressing this is not a worker reporting on a run. The engine checks the
   * turn really is a `rate_limited` failure; it does NOT check the clock,
   * because "I know something you don't" (another account, a limit already
   * lifted) is the entire reason the button exists.
   */
  resumeRateLimitedTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/resume`, {});
  }

  discardAmbiguousTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {});
  }

  /** SEND NOW: promote a queued turn into the running one. A promise of
   *  not-losing, never of delivery — see the engine's `promoteTurn`. */
  promoteTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/promote`, {});
  }

  /** The worker confirming a steered message reached its driver's mailbox.
   *  `runId` is the PROMOTED turn; the token proves the running claim. */
  ackSteer(sessionId: string, steerRunId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(steerRunId)}/steer-ack`, {
      claimToken,
    });
  }

  /**
   * `heartbeatIntervalMs` is the daemon's OWN answer, and the engine has always
   * sent it — this client simply dropped it from the type. It is the authority
   * on how long a worker may be out of contact before its lease expires (the
   * daemon prunes at three intervals), which is the timing contract a
   * supervisor must obey rather than invent a threshold of its own.
   * Optional because an older engine does not send it.
   */
  registerWorker(workerId: string): Promise<{ worker: { workerId: string }; heartbeatIntervalMs?: number }> {
    return this.request("POST", "/v2/workers/register", { workerId }, undefined, "registerWorker");
  }

  /** Idempotent control: reports state and drains already-decided deliveries,
   *  so re-polling on the next tick cannot duplicate work. `signal` lets the
   *  caller bound it — a heartbeat that never resolves must not pin its loop. */
  workerHeartbeat(workerId: string, signal?: AbortSignal, acknowledgedTaskStops?: string[]): Promise<WorkerStatus> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/heartbeat`, { acknowledgedTaskStops }, signal, "workerHeartbeat");
  }

  /**
   * `claimSeq` is the worker's per-registration high-watermark. Repeating a
   * sequence replays its outcome instead of allocating a second turn, which is
   * what makes a lost claim response safe to retry — see the daemon's route.
   * `signal` bounds it, so a hung claim cannot pin the caller's loop.
   */
  claimTurn(workerId: string, claimSeq: number, signal?: AbortSignal): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/claim`, { claimSeq }, signal, "claimTurn");
  }

  /**
   * Open a turn the PROVIDER started — a wake-up between turns. Returns a
   * turn that is already `running` under a claim this worker holds, so the
   * usual `openRequest`/`reportObservations`/`completeTurn` apply to it.
   */
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
    input: { requestId: string; kind: RequestKind; detail: RequestDetail; itemId?: string },
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

  /**
   * SUBSCRIPTIONS — being woken by another session. The subscriber is the
   * session in the path; the engine queues a `origin: "session"` turn on it
   * when the target does one of `events`. See `Subscription`.
   */
  subscribe(
    sessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean },
  ): Promise<{ subscription: Subscription }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/subscriptions`, input);
  }

  subscriptions(sessionId: string): Promise<{ subscriptions: Subscription[] }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/subscriptions`);
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

export { ENGINE_PROTOCOL_VERSION };
