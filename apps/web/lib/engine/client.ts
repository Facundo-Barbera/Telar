// Type-only, so the browser bundle never follows it into `node:fs`: the channel
// is DECIDED server-side (lib/build-identity.ts) and only described here.
import type { Channel } from "@/lib/build-identity";
import type {
  BrowserSnapshot,
  GitCommitEntry,
  GitHubCheckLog,
  GitHubFacets,
  GitHubIssueFilter,
  GitHubIssueRead,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubPullFilter,
  GitHubPullRead,
  GitHubSnapshot,
  GitignoreResult,
  GitOverview,
  ComputerUseBackend,
  ComputerUseStatus,
  RememberedLogin,
  DataScienceBootstrap,
  DataScienceConfig,
  DataScienceCreateEnvironment,
  DataScienceEnvironments,
  DataScienceJob,
  DataScienceInstallCommand,
  DataScienceManager,
  DataSciencePackage,
  DataSciencePreflight,
  DataScienceRequirementsSource,
  DataScienceToolchain,
  LatexBootstrap,
  LatexCompileStatus,
  LatexConfig,
  LatexDiagnostic,
  LatexDistributions,
  LatexJob,
  LatexPackagesAnswer,
  LatexToolchain,
  InboxPolicy,
  EnvMode,
  SessionDefaults,
  SidebarLayout,
  TextGenPolicy,
  UsageReport,
  UsageResolution,
  ModelCatalogue,
  ModelOverlay,
  CustomProviderModel,
  SessionDiff,
  EngineErrorCode,
  EngineEvent,
  EngineHealth,
  McpOAuthStatus,
  McpServer,
  McpServerSpec,
  ModelSelection,
  Project,
  TurnAttachment,
  TurnModelSelection,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceEnvVar,
  ProviderProbe,
  ProviderUpdateRun,
  PublishedAppearance,
  EngineRequest,
  RequestDecision,
  RuntimeMode,
  Session,
  SessionSnapshot,
  SnapshotWindow,
  Turn,
  TurnSubmissionResult,
  WorkspaceFile,
  WorkspaceListing,
  WorkspaceWriteResult,
} from "@telar/engine-client";
import { forgeQuery, snapshotQuery } from "@telar/engine-client";
import { pathnameFetcher } from "@/lib/hosts/client";
import type { ExecResult, KernelState, NotebookRead, TableWindow, VarRow } from "@/lib/ds";
// Type-only, like `Channel` above: the store reads the filesystem and must not
// follow into the browser bundle.
import type { PublicHost } from "@/lib/hosts/store";

/**
 * DERIVED FROM THE CONTRACT, not re-listed beside it. This union used to be ten
 * hand-written literals that had to be kept in step with the engine's own
 * `EngineErrorCode` by hand — and when v2 added `protocol_mismatch`, the copy
 * here was the thing that went stale. An alias cannot.
 *
 * `cockpit_unauthorized` is the one cockpit-minted addition: the pairing gate
 * (proxy.ts) answers 401 with it. It is NOT in the engine contract because
 * the engine never sees an unpaired request — the cockpit refuses it first.
 */
export type EngineApiErrorCode = EngineErrorCode | "cockpit_unauthorized";

export class EngineApiError extends Error {
  constructor(readonly code: EngineApiErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "EngineApiError";
  }
}

type Fetcher = typeof fetch;

async function request<T>(fetcher: Fetcher, method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(pathname, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    // An abort is the CALLER's decision arriving back, not the adapter being
    // away — it must surface as itself so the UI can say "Stopped".
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new EngineApiError("engine_unavailable", "The cockpit cannot reach its local adapter.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngineApiError("engine_unavailable", "The engine adapter returned an invalid response.", response.status);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: EngineApiErrorCode; message?: string } } | null)?.error;
    throw new EngineApiError(error?.code ?? "internal_error", error?.message ?? "The engine request failed.", response.status);
  }
  return payload as T;
}

/**
 * THE DEFAULT FETCHER FOLLOWS THE ADDRESS BAR (lib/hosts/client.ts): a screen
 * under `/hosts/:id/…` is about another Mac, and every call this api makes
 * from it is routed through that Mac's proxy. Callers that know which host
 * they mean regardless of the URL — the sidebar fanning out over all of them
 * — pass `hostFetcher(id)` instead.
 */
export function createEngineApi(fetcher: Fetcher = pathnameFetcher) {
  return {
    health: () => request<EngineHealth>(fetcher, "GET", "/api/health"),
    /** Which build this is, what it looks like, and where its state lives.
     *  Deliberately does NOT go through the engine: every answer here matters
     *  most when the engine is down. `iconUrl` is absent when this layout has no
     *  icon to serve, so it is never a URL that 404s. */
    about: () =>
      request<{ appVersion: string; appName: string; channel: Channel; iconUrl?: string; stateRoot?: string }>(
        fetcher,
        "GET",
        "/api/about",
      ),
    /** `includeRemoved` also returns put-away projects, which carry `removedAt`.
     *  Only the project settings page asks for them. */
    projects: (options: { includeRemoved?: boolean } = {}) =>
      request<{ projects: Project[] }>(fetcher, "GET", options.includeRemoved ? "/api/projects?includeRemoved=1" : "/api/projects"),
    /** The other Macs this cockpit is paired with — always THIS cockpit's book,
     *  whichever host the fetcher points at (lib/hosts/client.ts). */
    hosts: () => request<{ hosts: PublicHost[] }>(fetcher, "GET", "/api/hosts"),
    addHost: (input: { pairingUrl: string; name?: string }) => request<{ host: PublicHost }>(fetcher, "POST", "/api/hosts", input),
    renameHost: (hostId: string, name: string) =>
      request<{ host: PublicHost }>(fetcher, "PATCH", `/api/hosts/${encodeURIComponent(hostId)}`, { name }),
    removeHost: (hostId: string) => request<{ ok: boolean }>(fetcher, "DELETE", `/api/hosts/${encodeURIComponent(hostId)}`),
    registerProject: (input: { name: string; root: string }) =>
      request<{ project: Project }>(fetcher, "POST", "/api/projects", input),
    updateProject: (projectId: string, patch: { dataScience?: DataScienceConfig | null; latex?: LatexConfig | null }) =>
      request<{ project: Project }>(fetcher, "PATCH", `/api/projects/${encodeURIComponent(projectId)}`, patch),
    /** Remove a project from Telar. Nothing on disk is touched and the record
     *  is kept — see the engine client's `unregisterProject`. 409 while a
     *  session on it is working. */
    unregisterProject: (projectId: string) =>
      request<{ project: Project; sessions: number }>(fetcher, "DELETE", `/api/projects/${encodeURIComponent(projectId)}`),
    /** Put a removed project back: same id, same settings, same sessions. */
    restoreProject: (projectId: string) =>
      request<{ project: Project }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/restore`, {}),
    /** Spawns each interpreter it finds — open a page, never poll. */
    dataScienceEnvironments: (projectId: string) =>
      request<DataScienceEnvironments>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/data-science/environments`),
    dataScienceCreateEnvironment: (projectId: string, input: DataScienceCreateEnvironment) =>
      request<{ jobId: string }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/data-science/environments`, input),
    dataSciencePackages: (projectId: string) =>
      request<{ packages: DataSciencePackage[]; environment: { manager: DataScienceManager; root: string; python: string; command: DataScienceInstallCommand } }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/data-science/packages`),
    dataScienceInstall: (projectId: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }) =>
      request<{ jobId: string }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/data-science/packages`, input),
    dataScienceBootstrap: (input: DataScienceBootstrap) => request<{ jobId: string }>(fetcher, "POST", "/api/data-science/bootstrap", input),
    dataScienceToolchain: (fresh = false) => request<{ toolchain: DataScienceToolchain }>(fetcher, "GET", `/api/data-science/toolchain${fresh ? "?fresh=1" : ""}`),
    dataScienceJob: (jobId: string, after = 0) => request<{ job: DataScienceJob }>(fetcher, "GET", `/api/data-science/jobs/${encodeURIComponent(jobId)}?after=${after}`),
    dataScienceCancelJob: (jobId: string) => request<Record<string, never>>(fetcher, "DELETE", `/api/data-science/jobs/${encodeURIComponent(jobId)}`),
    dataScienceProbe: (projectId: string, path: string) =>
      request<{ probe: DataSciencePreflight & { relativePath?: string; root?: string; manager?: DataScienceManager } }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/data-science/probe`, { path }),
    /** Spawns `--version` probes for each TeX root — open a page, never poll. */
    latexDistributions: (projectId: string) =>
      request<LatexDistributions>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/latex/distributions`),
    latexPackages: (projectId: string) =>
      request<LatexPackagesAnswer>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/latex/packages`),
    latexInstall: (projectId: string, input: { add?: string[]; remove?: string[] }) =>
      request<{ jobId: string }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/latex/packages`, input),
    latexBootstrap: (input: LatexBootstrap) => request<{ jobId: string }>(fetcher, "POST", "/api/latex/bootstrap", input),
    latexToolchain: (fresh = false) => request<{ toolchain: LatexToolchain }>(fetcher, "GET", `/api/latex/toolchain${fresh ? "?fresh=1" : ""}`),
    latexJob: (jobId: string, after = 0) => request<{ job: LatexJob }>(fetcher, "GET", `/api/latex/jobs/${encodeURIComponent(jobId)}?after=${after}`),
    latexCancelJob: (jobId: string) => request<Record<string, never>>(fetcher, "DELETE", `/api/latex/jobs/${encodeURIComponent(jobId)}`),
    /** How this machine's inbox bands — the auto-settle window, or `null` for
     *  no clock at all. One answer for every client of this engine. */
    inbox: () => request<{ inbox: InboxPolicy }>(fetcher, "GET", "/api/inbox"),
    setInbox: (patch: { autoSettleAfterHours?: number | null }) =>
      request<{ inbox: InboxPolicy }>(fetcher, "PATCH", "/api/inbox", patch),
    /** What a new session is built with when nobody said — see
     *  `SessionDefaults`. One answer for every client of this engine. */
    sessionDefaults: () => request<{ sessionDefaults: SessionDefaults }>(fetcher, "GET", "/api/session-defaults"),
    setSessionDefaults: (patch: { envMode?: EnvMode }) =>
      request<{ sessionDefaults: SessionDefaults }>(fetcher, "PATCH", "/api/session-defaults", patch),
    /** Where each project group sits in the rail — see `SidebarLayout`. One
     *  arrangement for every client of this engine. */
    sidebarLayout: () => request<{ layout: SidebarLayout }>(fetcher, "GET", "/api/sidebar-layout"),
    setSidebarLayout: (patch: { projectOrder?: string[] }) =>
      request<{ layout: SidebarLayout }>(fetcher, "PATCH", "/api/sidebar-layout", patch),
    /** Spend over time, folded from the engine's journals. */
    usage: (input: { sinceMs: number; untilMs: number; resolution?: UsageResolution; timeZone?: string }) => {
      const query = new URLSearchParams({ since: String(input.sinceMs), until: String(input.untilMs) });
      if (input.resolution) query.set("resolution", input.resolution);
      if (input.timeZone) query.set("tz", input.timeZone);
      return request<{ usage: UsageReport }>(fetcher, "GET", `/api/usage?${query.toString()}`);
    },
    /** Who writes generated titles and branch names — see `TextGenPolicy`. */
    textGen: () => request<{ textGen: TextGenPolicy }>(fetcher, "GET", "/api/textgen"),
    setTextGen: (patch: { titles?: boolean; renameBranches?: boolean; driver?: ProviderDriverKind; model?: string | null }) =>
      request<{ textGen: TextGenPolicy }>(fetcher, "PATCH", "/api/textgen", patch),
    /** One structured completion from the policy's harness. SLOW (a cold CLI
     *  start plus a completion) and fallible — a harness that does not answer
     *  is a 502, never an empty result. `effort` asks the harness to think
     *  harder than the title-generation default; `signal` aborts the wait
     *  (the harness may still finish server-side — its answer is discarded). */
    complete: (
      input: { prompt: string; schema: Record<string, unknown>; model?: string; effort?: "low" | "medium" | "high" },
      options: { signal?: AbortSignal } = {},
    ) => request<{ result: Record<string, unknown> }>(fetcher, "POST", "/api/textgen/complete", input, options.signal),
    /** The host cockpit's published look, for windows that want to wear it.
     *  Already parsed by the shared total parser on the engine adapter's side,
     *  so `null` covers both "nothing published" and "nothing readable" — the
     *  same instruction to a reader either way. */
    appearance: () => request<{ appearance: PublishedAppearance | null; updatedAt: number | null }>(fetcher, "GET", "/api/appearance"),
    /** Replaces the published look wholesale — a snapshot, never a patch. */
    setAppearance: (blob: PublishedAppearance) => request<{ ok: boolean; updatedAt: number; etag: string }>(fetcher, "PUT", "/api/appearance", blob),
    /** Withdraw the published look. Idempotent — there is nothing to publish
     *  and nothing to fail. */
    clearAppearance: () => request<{ ok: boolean }>(fetcher, "DELETE", "/api/appearance"),
    /** Which models a provider says it has — asked of the provider where it can
     *  answer, and this cockpit's own short list where it cannot. */
    modelCatalogue: (driver: ProviderDriverKind, options: { refresh?: boolean; instanceId?: string } = {}) => {
      const query = new URLSearchParams({ driver });
      if (options.refresh) query.set("refresh", "1");
      if (options.instanceId) query.set("instanceId", options.instanceId);
      return request<{ catalogue: ModelCatalogue }>(fetcher, "GET", `/api/models?${query.toString()}`);
    },
    /** What this login's reader did to that list. An untouched overlay is a real
     *  answer, not a 404. */
    modelOverlay: (instanceId: string) =>
      request<{ overlay: ModelOverlay }>(fetcher, "GET", `/api/provider-instances/${encodeURIComponent(instanceId)}/models`),
    /** Presence is the patch: a submitted list replaces its own whole, so
     *  `{ hidden: [] }` clears the hides and omitting `hidden` leaves them. */
    setModelOverlay: (
      instanceId: string,
      patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[] },
    ) =>
      request<{ overlay: ModelOverlay }>(
        fetcher,
        "PATCH",
        `/api/provider-instances/${encodeURIComponent(instanceId)}/models`,
        patch,
      ),
    projectGit: (projectId: string) =>
      request<{ git: GitOverview }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/git`),
    /** Issues and pull requests. A NETWORK read behind a thirty-second cache —
     *  `refresh` is what the button sends, and nothing else may send it. */
    projectGitHub: (projectId: string, options: { refresh?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {}) =>
      // `forgeQuery` is the CONTRACT's own builder, not a second copy: the engine
      // route parses these names, and two hand-written versions of the same query
      // string would drift on the first filter anybody adds.
      request<{ github: GitHubSnapshot }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/github${forgeQuery(options)}`),
    /** What there is to filter by. Asked only when a filter menu opens, and cached
     *  for five minutes in the engine — milestones change on the timescale of a
     *  sprint. */
    projectForgeFacets: (projectId: string, options: { refresh?: boolean } = {}) =>
      request<{ facets: GitHubFacets }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/github/facets${options.refresh ? "?refresh=1" : ""}`,
      ),
    /** One failing check's log. Never cached: a finished job's log cannot change and
     *  a running job's must not be stale. */
    projectCheckLog: (projectId: string, jobId: string) =>
      request<{ log: GitHubCheckLog }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/github/checks/${encodeURIComponent(jobId)}/log`,
      ),
    /** Ignore Telar's own files in a project's repository. No body: the rules are
     *  the engine's, so this cannot be used to append arbitrary lines to a file in
     *  somebody's checkout. */
    projectGitignore: (projectId: string) =>
      request<{ gitignore: GitignoreResult }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/gitignore`, {}),
    /**
     * ONE issue or ONE pull request, opened as its own panel tab.
     *
     * THE ANSWER IS A UNION rather than a throw — `{ issue }` or
     * `{ unavailable, message? }` — because a detail tab restored from a previous
     * run can open into a machine where `gh` has since been logged out, and the
     * five sentences that say what to do about that are the answer.
     */
    projectIssue: (projectId: string, number: number, options: { refresh?: boolean } = {}) =>
      request<GitHubIssueRead>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/github/issues/${number}${options.refresh ? "?refresh=1" : ""}`,
      ),
    projectPull: (projectId: string, number: number, options: { refresh?: boolean } = {}) =>
      request<GitHubPullRead>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/github/pulls/${number}${options.refresh ? "?refresh=1" : ""}`,
      ),
    /**
     * Merge a pull request.
     *
     * `expectedHeadOid` is the head the person pressing the button reviewed, and
     * it is required: it becomes `--match-head-commit`, so a commit pushed since
     * the read makes GitHub refuse rather than merge code nobody saw. A refusal
     * arrives as `merged: false` with one of seven reasons, not as a thrown error.
     */
    mergeProjectPull: (projectId: string, number: number, input: { method: GitHubMergeMethod; expectedHeadOid: string }) =>
      request<GitHubMergeResult>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/merge`, input),
    sessions: (projectId: string) =>
      request<{ sessions: Session[] }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/sessions`),
    liveSessions: () => request<{ sessions: Session[]; projects: Project[] }>(fetcher, "GET", "/api/sessions/live"),
    createSession: (
      projectId: string,
      input: {
        id?: string;
        draft?: boolean;
        title?: string;
        driver?: ProviderDriverKind;
        envMode?: "local" | "worktree";
        /** Worktree base — any name from `GitOverview.refs`. Absent = HEAD. */
        baseRef?: string;
        /** A human's own branch name, outside loom//telar/. */
        branchName?: string;
      } = {},
    ) =>
      request<{ session: Session }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/sessions`, input),
    // The contract's own snapshot type, not a hand-copied structural twin: this
    // route proxies the engine verbatim, so a field the engine adds is already
    // arriving and a local re-declaration only hides it.
    session: (sessionId: string, window?: SnapshotWindow) =>
      request<SessionSnapshot>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}${snapshotQuery(window)}`),
    /** Rename, change the model, or change what the session may do without
     *  asking. The model must belong to the session's provider instance — the
     *  engine rejects anything else, because a turn is routed by that instance
     *  and the provider owns the resume cursor. */
    updateSession: (
      sessionId: string,
      patch: {
        title?: string;
        runtimeMode?: RuntimeMode;
        detached?: boolean;
        model?: ModelSelection | null;
        /** Shelve or pin this session in the sidebar. `null` hands it back to
         *  the inactivity rule — see `Session.settledOverride`. */
        settledOverride?: "settled" | "active" | null;
        snoozedUntil?: number | null;
      },
    ) => request<{ session: Session }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, patch),
    /**
     * A HUMAN WAS SHOWN THIS TURN'S RESULT. Names the turn rather than a time,
     * so a receipt that lands after newer work cannot mark that work read —
     * the engine keeps the highest sequence and ignores the rest. Sent from
     * the cockpit only when the answer is actually on screen; see
     * `lib/session-read-receipt.ts`.
     */
    markSessionRead: (sessionId: string, runId: string) =>
      request<{ session: Session }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/read`, { runId }),
    /** Computer use, measured — slow by design (one subprocess round trip in
     *  the engine), and the probe doubles as the macOS granting flow. */
    computerUseStatus: () => request<{ computerUse: ComputerUseStatus }>(fetcher, "GET", "/api/computer-use"),
    /** Wake the Sky host app in the background. Idempotent. */
    wakeComputerUseHost: () => request<{ ok: boolean }>(fetcher, "POST", "/api/computer-use/host", {}),
    /** cua's native granting flow — CuaDriver.app requests the grants. No-op for Sky. */
    grantComputerUseAccess: () =>
      request<{ started: boolean; backend?: ComputerUseBackend }>(fetcher, "POST", "/api/computer-use/grant", {}),
    /** The logins a person allowed agents to fill without being asked again —
     *  metadata only, never a value. Revoking is the only write. */
    browserLogins: () => request<{ logins: RememberedLogin[] }>(fetcher, "GET", "/api/browser-logins"),
    revokeBrowserLogin: (id: string) =>
      request<{ ok: boolean }>(fetcher, "DELETE", `/api/browser-logins/${encodeURIComponent(id)}`),
    /** End a session and free its worktree. The branch survives. */
    archiveSession: (sessionId: string) =>
      request<{ session: Session }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/archive`, {}),
    /** REMOVE A SESSION AND EVERYTHING IT OWNS — transcript included. No undo,
     *  and the engine refuses while a turn is in flight. */
    deleteSession: (sessionId: string) =>
      request<{ deleted: boolean }>(fetcher, "DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`),
    /** `answers` is only meaningful for a `user_input` request — the route has
     *  always forwarded it; this signature simply never offered it, so the one
     *  request kind that asks a question could not be answered from the UI. */
    resolveRequest: (
      sessionId: string,
      requestId: string,
      input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown> },
    ) =>
      request<{ request: EngineRequest }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, input),
    events: (sessionId: string, after: number) =>
      request<{ events: EngineEvent[]; cursor: number; more: boolean }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`),
    /** `model` rides with THIS message — queue three with different models and
     *  each runs on the one it was written under. It cannot name a provider
     *  instance, so the session's provider is fixed for its whole life. */
    submitTurn: (sessionId: string, input: { runId: string; input: string; kind?: "message" | "compact"; model?: TurnModelSelection; attachments?: string[] }) =>
      request<TurnSubmissionResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, input),
    /**
     * Put a file where the session's provider can reach it.
     *
     * A `File` goes over the wire as ITS OWN BODY rather than as base64 inside
     * JSON: base64 costs a third again on the largest thing this client ever
     * sends, and the JSON limit on every other route is deliberately small.
     */
    uploadAttachment: async (sessionId: string, file: File): Promise<{ attachment: TurnAttachment }> => {
      let response: Response;
      try {
        response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            // Encoded because a filename may hold bytes a header may not.
            "x-telar-attachment-name": encodeURIComponent(file.name),
          },
          body: file,
        });
      } catch {
        throw new EngineApiError("engine_unavailable", "The cockpit cannot reach its local adapter.");
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = (payload as { error?: { code?: EngineApiErrorCode; message?: string } } | null)?.error;
        throw new EngineApiError(error?.code ?? "internal_error", error?.message ?? "That file could not be attached.", response.status);
      }
      return payload as { attachment: TurnAttachment };
    },
    /** What is uncommitted in a project right now — what the canvas reviews
     *  before its conversation exists. */
    projectDiff: (projectId: string) =>
      request<{ diff: SessionDiff }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/diff`),
    projectFilePatch: (projectId: string, path: string, options: { untracked?: boolean } = {}) => {
      const query = new URLSearchParams({ path });
      if (options.untracked) query.set("untracked", "1");
      return request<{ file: { patch: string; binary: boolean } }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/diff?${query.toString()}`,
      );
    },
    /** What this session has done to the repository since it started — committed
     *  and uncommitted together, from the base recorded at creation. */
    sessionDiff: (sessionId: string) =>
      request<{ diff: SessionDiff }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/diff`),
    /** One file's patch, opened on demand. */
    sessionFilePatch: (sessionId: string, path: string, options: { untracked?: boolean } = {}) => {
      const query = new URLSearchParams({ path });
      if (options.untracked) query.set("untracked", "1");
      return request<{ file: { patch: string; binary: boolean } }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/diff?${query.toString()}`,
      );
    },
    /**
     * Every file in a checkout, for the Files tree — and one file's text.
     *
     * NEITHER IS POLLED. The listing is git reading an index it already has, but a
     * tree that reorders itself under the cursor on a timer is hostile in a way a
     * stale figure is not; both surfaces have a refresh button and re-read when a
     * turn settles.
     */
    projectFiles: (projectId: string) =>
      request<{ listing: WorkspaceListing }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/files`),
    sessionFiles: (sessionId: string) =>
      request<{ listing: WorkspaceListing }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/files`),
    projectFile: (projectId: string, path: string) =>
      request<{ file: WorkspaceFile }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`,
      ),
    sessionFile: (sessionId: string, path: string) =>
      request<{ file: WorkspaceFile }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
      ),
    /**
     * Save an edited file.
     *
     * `expectedSha256` is the hash the read returned. The engine refuses the write
     * when disk no longer matches — an agent writing the same file mid-turn is the
     * case this exists for — and a refusal arrives as `written: false` rather than
     * as a thrown error, because "the file changed under you" is something the
     * editor has to render.
     */
    writeProjectFile: (projectId: string, path: string, text: string, expectedSha256: string) =>
      request<WorkspaceWriteResult>(
        fetcher,
        "PUT",
        `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path }).toString()}`,
        { text, expectedSha256 },
      ),
    writeSessionFile: (sessionId: string, path: string, text: string, expectedSha256: string) =>
      request<WorkspaceWriteResult>(
        fetcher,
        "PUT",
        `/api/sessions/${encodeURIComponent(sessionId)}/files?${new URLSearchParams({ path }).toString()}`,
        { text, expectedSha256 },
      ),
    /**
     * THE SESSION'S KERNEL, NOTEBOOKS AND PLOTS. Every verb is a POST to one
     * `ds/<method>` door on the engine — the same door the agent's toolkit
     * uses — so a cell run from here and one run by `notebook_run_cell` land
     * in the same kernel and write the same file.
     */
    kernel: (sessionId: string) =>
      request<{ state: KernelState; executionCount?: number; modules?: Record<string, boolean>; python?: string; executable?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/kernel`, {}),
    kernelInterrupt: (sessionId: string) => request<object>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/interrupt`, {}),
    kernelRestart: (sessionId: string) => request<object>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/restart`, {}),
    kernelExecute: (sessionId: string, code: string) => request<ExecResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/execute`, { code, producer: "cockpit" }),
    kernelVars: (sessionId: string, limit = 200) => request<VarRow[]>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/vars`, { limit }),
    /** The project's environment as THIS session resolves it (worktree rule), and its packages. */
    sessionPackages: (sessionId: string) =>
      request<{ packages: DataSciencePackage[]; environment: { manager: DataScienceManager; root: string; python: string; command: DataScienceInstallCommand } }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/packages`, {}),
    /** Install / remove in the session's environment. WAITS for the job (the engine's tool does the same). */
    sessionInstall: (sessionId: string, input: { add?: string[]; remove?: string[]; requirements?: DataScienceRequirementsSource }) =>
      request<{ ok: boolean; lines: string[]; error?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/install`, input),
    kernelInspect: (sessionId: string, name: string, depth = 10) =>
      request<Record<string, unknown>>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/inspect`, { name, depth }),
    /**
     * THE SESSION'S LATEX DOOR — the same capability the agent's `latex_*`
     * tools use, so a compile pressed here and one the model ran land on the
     * same job runner and the same last-compile memory.
     */
    latexCompile: (sessionId: string, input: { path?: string; timeoutMs?: number } = {}) =>
      request<{ ok: boolean; path: string; pdfPath?: string; diagnostics: LatexDiagnostic[]; logTail: string[]; error?: string }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/compile`, input),
    latexStatus: (sessionId: string) =>
      request<LatexCompileStatus | { status: "never" }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/status`, {}),
    latexLog: (sessionId: string, input: { tail?: number; around?: number; find?: string } = {}) =>
      request<{ lines: string[] }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/log`, input),
    sessionLatexToolchain: (sessionId: string) =>
      request<{ kind: "tectonic" | "texlive"; binPath: string; engine?: string; version?: string; tlmgr: boolean; mainFile?: string; available: LatexToolchain }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/toolchain`, {}),
    latexClean: (sessionId: string, input: { pdf?: boolean } = {}) =>
      request<{ removed: string[] }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/latex/clean`, input),
    notebook: (sessionId: string, path: string, options: { from?: number; to?: number; withOutputs?: boolean } = {}) =>
      request<NotebookRead>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/read`, { path, ...options }),
    notebookEdit: (
      sessionId: string,
      path: string,
      edit:
        | { kind: "set"; cellId?: string; index?: number; source?: string; cellType?: "code" | "markdown" | "raw" }
        | { kind: "insert"; after?: string | number; source: string; cellType?: "code" | "markdown" | "raw" }
        | { kind: "delete"; cellId?: string; index?: number }
        | { kind: "create" },
    ) => request<NotebookRead>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/edit`, { path, edit }),
    notebookRun: (sessionId: string, path: string, input: { cellId?: string; all?: boolean; stopOnError?: boolean }) =>
      request<{ results: Array<{ cellId: string; result: ExecResult }>; notebook: NotebookRead }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/ds/notebook/run`,
        { path, ...input },
      ),
    /** The attachment index, optionally by tag. `plot` is what the gallery reads. */
    attachments: (sessionId: string, options: { tag?: string } = {}) =>
      request<{ attachments: TurnAttachment[] }>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments${options.tag ? `?tag=${encodeURIComponent(options.tag)}` : ""}`,
      ),
    tagAttachment: (sessionId: string, attachmentId: string, tags: string[]) =>
      request<{ attachment: TurnAttachment }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { tags }),
    /** A window of rows from a CSV, TSV or Parquet file, for the table view. */
    sessionTable: (sessionId: string, path: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }) =>
      request<TableWindow>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/data/table?${new URLSearchParams({
          path,
          offset: String(options.offset),
          limit: String(options.limit),
          ...(options.sort ? { sort: options.sort } : {}),
          ...(options.desc ? { desc: "1" } : {}),
        }).toString()}`,
      ),
    /** Snapshot the session's work as one commit. A refusal ("nothing to commit",
     *  a hook that said no) comes back as `committed: false` with a reason, not
     *  as a thrown error — it is an answer about the repository. */
    commitSessionWork: (sessionId: string, message: string) =>
      request<{ committed: boolean; commit?: GitCommitEntry; reason?: string }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/git/commit`,
        { message },
      ),
    /** What the session's browser is looking at. `screenshot` costs a round trip
     *  through Chromium and `start` would LAUNCH one, so both are opt-in. */
    browserState: (sessionId: string, options: { screenshot?: boolean; start?: boolean } = {}) => {
      const query = new URLSearchParams();
      if (options.screenshot) query.set("screenshot", "1");
      if (options.start) query.set("start", "1");
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<{ browser: BrowserSnapshot }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/browser${suffix}`);
    },
    /** Open a page in the session's browser as the human — the engine's door,
     *  for a client with no native shell (a remote cockpit, a phone). */
    browserOpen: (sessionId: string, url: string) =>
      request<{ browser: BrowserSnapshot }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/browser/open`, { url }),
    /** The MACHINE-WIDE MCP servers — the ones every project sees. A project's
     *  own live under `projectMcpServers`, and the URL is what says which scope
     *  a write lands in. */
    mcpServers: () => request<{ mcpServers: McpServer[] }>(fetcher, "GET", "/api/mcp-servers"),
    /** This project's servers, plus `effective` — the merge its sessions run
     *  with, computed by the engine rather than re-derived here. */
    projectMcpServers: (projectId: string) =>
      request<{ mcpServers: McpServer[]; effective: McpServer[] }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      ),
    saveMcpServer: (input: { id: string; projectId?: string; label?: string; enabled?: boolean; spec: McpServerSpec }) => {
      const { projectId, ...rest } = input;
      return request<{ mcpServer: McpServer }>(
        fetcher,
        "PUT",
        projectId ? `/api/projects/${encodeURIComponent(projectId)}/mcp-servers` : "/api/mcp-servers",
        rest,
      );
    },
    removeMcpServer: (id: string, projectId?: string) =>
      request<{ removed: boolean }>(
        fetcher,
        "DELETE",
        projectId
          ? `/api/projects/${encodeURIComponent(projectId)}/mcp-servers/${encodeURIComponent(id)}`
          : `/api/mcp-servers/${encodeURIComponent(id)}`,
      ),
    /**
     * Whether each http server wants a login and whether ours works.
     *
     * TWO NETWORK ROUND TRIPS PER SERVER, so this is what a page does when it
     * opens or when somebody presses refresh — never a poll. It is also why it
     * is a SEPARATE call from the server list: the list must paint immediately,
     * and an unreachable server must not hold the whole pane blank.
     */
    mcpOAuthStatus: (projectId?: string) =>
      request<{ statuses: McpOAuthStatus[] }>(
        fetcher,
        "GET",
        projectId ? `/api/mcp/oauth?projectId=${encodeURIComponent(projectId)}` : "/api/mcp/oauth",
      ),
    /** Returns the URL to send the browser to. The redirect origin is decided by
     *  the route from the request, never passed from here — it is the one field
     *  in an OAuth flow that must not be client-chosen. */
    connectMcpOAuth: (serverId: string, projectId?: string) =>
      request<{ authorizationUrl: string }>(fetcher, "POST", "/api/mcp/oauth", {
        serverId,
        ...(projectId ? { projectId } : {}),
      }),
    disconnectMcpOAuth: (serverId: string, projectId?: string) =>
      request<{ removed: boolean }>(fetcher, "POST", "/api/mcp/oauth", {
        action: "disconnect",
        serverId,
        ...(projectId ? { projectId } : {}),
      }),
    /**
     * The configured logins and what the machine says about each, in ONE call —
     * a settings row needs both to render, and two would let it paint a green
     * dot beside an instance the second is about to report missing.
     *
     * `refresh` costs a subprocess per driver, so it is a button and never a
     * repaint.
     */
    providerInstances: (options: { refresh?: boolean } = {}) =>
      request<{ providerInstances: ProviderInstance[]; probes: ProviderProbe[] }>(
        fetcher,
        "GET",
        `/api/provider-instances${options.refresh ? "?refresh=1" : ""}`,
      ),
    /** `null` clears a field; an absent key leaves it alone. Sensitive values
     *  round-trip as `{ value: "", valueRedacted: true }` and keep their
     *  stored secret. */
    saveProviderInstance: (input: {
      id: string;
      driver?: ProviderDriverKind;
      displayName?: string | null;
      accentColor?: string | null;
      configDir?: string | null;
      binaryPath?: string | null;
      enabled?: boolean;
      env?: ProviderInstanceEnvVar[];
    }) => request<{ providerInstance: ProviderInstance }>(fetcher, "PUT", "/api/provider-instances", input),
    removeProviderInstance: (id: string) =>
      request<{ removed: boolean }>(fetcher, "DELETE", `/api/provider-instances/${encodeURIComponent(id)}`),
    /**
     * Update the CLI behind one login, and get the re-probed list back with it.
     *
     * NO COMMAND CROSSES THIS CALL — the instance id is the whole input, and the
     * engine resolves which binary that login runs before deciding what would
     * update it. Keyed on the login rather than the driver because a login can
     * pin its own binary; rows that share one still change together, because
     * they resolve to the same file.
     */
    updateProviderCli: (instanceId: string) =>
      request<{ result: ProviderUpdateRun; providerInstances: ProviderInstance[]; probes: ProviderProbe[] }>(
        fetcher,
        "POST",
        `/api/provider-updates/${encodeURIComponent(instanceId)}`,
        {},
      ),
    stopTurn: (sessionId: string, runId?: string) =>
      request<{ turn?: Turn; stopped: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { runId }),
    /** THE STOP BUTTON: end the live turn and settle what was waiting behind
     *  it, leaving the session idle. No latch — the next message just runs. */
    stopSession: (sessionId: string) =>
      request<{ stopped: Turn[]; live?: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { scope: "session" }),
    /** Stop the session's lingering background tasks — the "N tasks still
     *  working" chip. Separate from `stopTurn`, which spares them. */
    /** PAUSE the session: stop the live turn and hold everything queued — and
     *  everything that arrives — until `resumeSession`. `stopTurn` ends one
     *  run and the worker takes the next; this is the one that stays stopped. */
    pauseSession: (sessionId: string) =>
      request<{ session: Session; stopped?: Turn; held: number; already: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/pause`, {}),
    resumeSession: (sessionId: string) =>
      request<{ session: Session; released: number; already: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/resume`, {}),
    stopBackgroundTasks: (sessionId: string) =>
      request<{ stopped: number }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop-background`, {}),
    discardAmbiguousTurn: (sessionId: string, runId: string) =>
      request<{ turn: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/discard`, {}),
    /** Run a message recovery held, now that a person has re-read it. Dropping
     *  one instead is `stopTurn` — it is still an ordinary queued turn. */
    releaseHeldTurn: (sessionId: string, runId: string) =>
      request<{ turn: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/release`, {}),
    /** SEND NOW: promote a queued message into the running turn. */
    promoteTurn: (sessionId: string, runId: string) =>
      request<{ turn: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/promote`, {}),
  };
}

/**
 * A UUID, INCLUDING ON ORIGINS THE BROWSER DOES NOT CALL SECURE.
 *
 * `crypto.randomUUID` exists ONLY IN A SECURE CONTEXT — HTTPS, or a loopback
 * host. Served over plain HTTP from any other address it is simply not there,
 * and this cockpit is served that way the moment it is bound to something other
 * than localhost so another machine can reach it.
 *
 * THE FAILURE LANDED ON THE FIRST MESSAGE OF A NEW CONVERSATION, which is the
 * worst place it could have: `submit` mints a run id before it does anything
 * else, so the whole app worked until you tried to say something, and then threw
 * `crypto.randomUUID is not a function` from inside a click handler.
 *
 * `getRandomValues` CARRIES NO SUCH RESTRICTION, so the fallback is the same
 * randomness with the version and variant bits set by hand. Deliberately NOT
 * `Math.random`, which is what most snippets substitute here: this id is the
 * idempotency key a retried submission is matched on, and a weak one turns a
 * collision from impossible into merely unlikely.
 */
function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 1
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Browser-generated ids are stable if the submission has to be retried. */
export function newRunId(uuid: () => string = randomUuid): string {
  return `run_${uuid().replaceAll("-", "")}`;
}

type TurnApi = Pick<ReturnType<typeof createEngineApi>, "discardAmbiguousTurn" | "submitTurn">;

/**
 * CONTINUE — abandon the lost run's execution and carry on talking.
 *
 * The discard is the whole of it, and that is the point: it releases the
 * session's held dispatch and leaves EVERYTHING else standing — the partial
 * transcript, the provider cursor, the record that a turn was cut off. Nothing
 * is submitted here; the caller prepares a message and the person sends it, so
 * the next turn is whatever they choose to say rather than a replay.
 *
 * WHY IT IS NOT MERELY `discardAmbiguousTurn` UNDER A NICER NAME: it is that
 * call, but the name is the fix. The cockpit's only non-replaying door was
 * labelled "Discard recovered run", which reads as "throw my work away" — so
 * people pressed "Retry", which resends the original prompt and redoes work.
 * The capability was always there; nobody could tell.
 */
export async function continueAfterAmbiguousTurn(
  api: Pick<ReturnType<typeof createEngineApi>, "discardAmbiguousTurn">,
  sessionId: string,
  turn: Pick<Turn, "runId" | "state">,
): Promise<void> {
  if (turn.state !== "ambiguous") {
    throw new EngineApiError("conflict", "Only an ambiguous turn needs a recovery decision.");
  }
  await api.discardAmbiguousTurn(sessionId, turn.runId);
}

/**
 * RE-RUN THE LOST PROMPT — deliberately the other thing, and deliberately not
 * the default. Two commands: persist the human discard decision, then submit
 * the same prompt under a new id. The ambiguous run id is never replayed in
 * place, and the work the first attempt may already have done is NOT undone —
 * which is why this asks before it is reached.
 */
export async function retryAmbiguousTurn(
  api: TurnApi,
  sessionId: string,
  turn: Pick<Turn, "runId" | "state" | "input">,
  createRunId: () => string = newRunId,
): Promise<TurnSubmissionResult> {
  if (turn.state !== "ambiguous") {
    throw new EngineApiError("conflict", "Only an ambiguous turn requires explicit discard before retrying.");
  }
  await api.discardAmbiguousTurn(sessionId, turn.runId);
  const runId = createRunId();
  if (runId === turn.runId) {
    throw new EngineApiError("conflict", "Retry must use a fresh run id.");
  }
  return api.submitTurn(sessionId, { runId, input: turn.input });
}
