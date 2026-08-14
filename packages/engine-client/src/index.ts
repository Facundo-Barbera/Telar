/**
 * engine client — protocol v2.
 *
 * PROTOCOL v1 IS GONE, not deprecated. Its eleven flat `turn.*` events were not
 * a subset of v2 and there is no dual-emit path; an engine speaking v2 answers
 * on `/v2/**` and a v1 client gets a 404 rather than a confusing parse failure
 * three layers in. The routes moved with the version deliberately, so the break
 * is visible at the URL.
 */
import {
  ENGINE_PROTOCOL_VERSION,
  EngineDiscovery,
  type BrowserSnapshot,
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
  type GitignoreResult,
  type InboxPolicy,
  type ModelCatalogue,
  type SessionDiff,
  type McpOAuthStatus,
  type McpServer,
  type McpServerSpec,
  type TurnAttachment,
  type TurnModelSelection,
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
  type Session,
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
  type WorkerClaim,
  type WorkerStatus,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceWriteResult,
} from "./protocol";

export * from "./protocol";

export class EngineClientError extends Error {
  readonly code: EngineErrorCode;
  readonly status?: number;

  constructor(code: EngineErrorCode, message: string, status?: number) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
    this.status = status;
  }
}

/** Engine discovery (`discoverEngine`/`connectEngine`) lives in `./node`, a
 *  separate entry point, because it reads the filesystem and this root export
 *  is bundled into browser client components — a top-level `node:fs/promises`
 *  import here is a hard Turbopack error. */
export type FetchLike = typeof fetch;

/** What `GET /v2/sessions/:id` answers with — the snapshot a client opens on
 *  so it does not have to replay the journal from zero. */
export type SessionSnapshot = {
  session: Session;
  turns: Turn[];
  items: Item[];
  requests: EngineRequest[];
  /** Sub-agents and background work. A background task OUTLIVES the turn that
   *  started it, so this is the only thing that can tell a client opening a
   *  cold session that it is still working. */
  tasks: Task[];
};

export class EngineClient {
  constructor(
    readonly discovery: EngineDiscovery,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`http://${this.discovery.host}:${this.discovery.port}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.discovery.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      const code: EngineErrorCode = error?.code ?? "engine_unavailable";
      throw new EngineClientError(code, error?.message ?? "engine request failed", response.status);
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

  listProjects(): Promise<{ projects: Project[] }> {
    return this.request("GET", "/v2/projects");
  }

  registerProject(input: { id?: string; name: string; root: string }): Promise<{ project: Project }> {
    return this.request("POST", "/v2/projects", input);
  }

  /** The inbox's standing rule — see `InboxPolicy`. Environment-wide, so every
   *  client that reads this engine bands its list the same way. */
  inboxPolicy(): Promise<{ inbox: InboxPolicy }> {
    return this.request("GET", "/v2/inbox");
  }

  setInboxPolicy(patch: { autoSettleAfterDays?: number | null }): Promise<{ inbox: InboxPolicy }> {
    return this.request("PATCH", "/v2/inbox", patch);
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

  /** One file's text, as it is on disk. Fenced inside the checkout by the
   *  engine — see `readFenced` there for why the check is not at the route. */
  projectFile(projectId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`);
  }

  sessionFile(sessionId: string, path: string): Promise<{ file: WorkspaceFile }> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`);
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

  /** Which models a provider says it has. Cached in the engine for five
   *  minutes — answering means spawning the provider's own CLI. */
  modelCatalogue(driver: ProviderDriverKind, options: { refresh?: boolean } = {}): Promise<{ catalogue: ModelCatalogue }> {
    const query = new URLSearchParams({ driver });
    if (options.refresh) query.set("refresh", "1");
    return this.request("GET", `/v2/models?${query.toString()}`);
  }

  listSessions(projectId: string): Promise<{ sessions: Session[] }> {
    return this.request("GET", `/v2/sessions?projectId=${encodeURIComponent(projectId)}`);
  }

  createSession(input: {
    id?: string;
    projectId: string;
    title?: string;
    detached?: boolean;
    envMode?: "local" | "worktree";
    /** Which provider runs this session's turns. Defaults to Claude. */
    driver?: ProviderDriverKind;
  }): Promise<{ session: Session }> {
    return this.request("POST", "/v2/sessions", input);
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
    },
  ): Promise<{ session: Session }> {
    return this.request("PATCH", `/v2/sessions/${encodeURIComponent(sessionId)}`, patch);
  }

  session(sessionId: string): Promise<SessionSnapshot> {
    return this.request("GET", `/v2/sessions/${encodeURIComponent(sessionId)}`);
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
    input: { runId: string; input: string; model?: TurnModelSelection; attachments?: string[] },
  ): Promise<TurnSubmissionResult> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns`, input);
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

  /** `null` clears a field, an absent key leaves it alone. Two different
   *  requests, and JSON has no other way to say so. */
  saveProviderInstance(input: {
    id: string;
    driver?: ProviderDriverKind;
    displayName?: string | null;
    accentColor?: string | null;
    configDir?: string | null;
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
  discardAmbiguousTurn(sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {});
  }

  registerWorker(workerId: string): Promise<{ worker: { workerId: string } }> {
    return this.request("POST", "/v2/workers/register", { workerId });
  }

  workerHeartbeat(workerId: string): Promise<WorkerStatus> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/heartbeat`, {});
  }

  claimTurn(workerId: string): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", `/v2/workers/${encodeURIComponent(workerId)}/claim`, {});
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

  /** A human answering a parked request. */
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown> },
  ): Promise<{ request: EngineRequest }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input);
  }

  completeTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    result: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
  ): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/complete`, {
      claimToken,
      ...result,
    });
  }

  failTurn(
    sessionId: string,
    runId: string,
    claimToken: string,
    failure: { code: "provider_unavailable" | "driver_failed" | "budget_exhausted"; message: string },
  ): Promise<{ turn: Turn }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/fail`, {
      claimToken,
      ...failure,
    });
  }
}

export { ENGINE_PROTOCOL_VERSION };
