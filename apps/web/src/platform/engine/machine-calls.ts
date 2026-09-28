import type { BuildChannel as Channel } from "@telar/engine-client";
import type {
GitHubIssueFilter,GitHubMergeMethod,
GitHubMergeResult,
GitHubReactionContent,
GitHubReactionResult,GitHubPullFilter,GitHubSnapshot,Schedule,
ScheduleRule,
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
LatexBootstrap,LatexConfig,LatexDistributions,
LatexJob,
LatexPackagesAnswer,
LatexToolchain,
ManagedTectonic,
InboxPolicy,EnvMode,
DictationAnswer,
DictationProviderId,SidebarLayout,
SidebarMode,RetentionBucket,
RetentionPolicy,TextGenPolicy,UsageReport,
UsageResolution,UsageLimitSource,
ModelCatalogue,
ModelOverlay,
CustomProviderModel,EngineHealth,ModelSelection,
Project,
ProjectNote,
PreparedPrompt,ProviderDriverKind,PublishedAppearance,WorkspaceConfig,
ProjectWorkspaceOverrides,
ProjectWorkspaceView
} from "@telar/engine-client";
import { forgeQuery } from "@telar/engine-client";
import type { DirectoryListing } from "@telar/engine-client";
import type { PublicHost } from "@telar/engine-client";
import { request, type Fetcher } from "./transport";

/** The cockpit's own machine calls: the ones no package domain client covers yet. */
export function machineCalls(fetcher: Fetcher) {
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
    /** Clone a repository into `parent` and register what landed, in one call —
     *  the caller cannot name the path in between, because `git clone` chooses
     *  the folder from the URL. `owner/repo` is expanded by the engine. */
    cloneProject: (input: { url: string; parent: string; name?: string }) =>
      request<{ project: Project }>(fetcher, "POST", "/api/projects/clone", input),
    fsDirs: (input: { path?: string; hidden?: boolean; nearest?: boolean } = {}) => {
      const query = new URLSearchParams();
      if (input.path) query.set("path", input.path);
      if (input.hidden) query.set("hidden", "1");
      if (input.nearest) query.set("nearest", "1");
      const search = query.toString();
      return request<DirectoryListing>(fetcher, "GET", search ? `/api/fs?${search}` : "/api/fs");
    },
    updateProject: (
      projectId: string,
      patch: {
        name?: string;
        // `null` REMOVES a stored answer rather than storing a neutral one: a
        // project with no `envMode` follows this Mac's `SessionDefaults`, which
        // is a different sentence from either value it could hold. `name` has
        // no `null` — every project has one.
        /** One id from `TELAR_ICONS` — see `Project.iconName`. */
        iconName?: string | null;
        /** Legacy; nothing writes a value now. `null` clears a stored mark. */
        iconEmoji?: string | null;
        defaultModel?: ModelSelection | null;
        envMode?: EnvMode | null;
        dataScience?: DataScienceConfig | null;
        latex?: LatexConfig | null;
        // The generic arm — one entry per plugin, `null` to turn it off.
        plugins?: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>;
      },
    ) =>
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
    /** Telar's own Tectonic — cheap enough to poll while an install downloads. */
    managedTectonic: () => request<{ managed: ManagedTectonic }>(fetcher, "GET", "/api/latex/managed"),
    /** Fetch it. Idempotent: a second press joins the install already running. */
    installManagedTectonic: () => request<{ managed: ManagedTectonic }>(fetcher, "POST", "/api/latex/managed", {}),
    latexJob: (jobId: string, after = 0) => request<{ job: LatexJob }>(fetcher, "GET", `/api/latex/jobs/${encodeURIComponent(jobId)}?after=${after}`),
    latexCancelJob: (jobId: string) => request<Record<string, never>>(fetcher, "DELETE", `/api/latex/jobs/${encodeURIComponent(jobId)}`),
  };
}

export function settingsCalls(fetcher: Fetcher) {
  return {
    /** How this machine's inbox bands — the auto-settle window, or `null` for
     *  no clock at all. One answer for every client of this engine. */
    inbox: () => request<{ inbox: InboxPolicy }>(fetcher, "GET", "/api/inbox"),
    setInbox: (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number }) =>
      request<{ inbox: InboxPolicy }>(fetcher, "PATCH", "/api/inbox", patch),
    /** How worktrees are prepared — `protocol/workspace.ts`. Both writes are
     *  whole-layer PUTs: the body IS the new layer, not a patch onto it. */
    machineWorkspace: () => request<{ machine: WorkspaceConfig }>(fetcher, "GET", "/api/workspace"),
    setMachineWorkspace: (machine: WorkspaceConfig) =>
      request<{ machine: WorkspaceConfig }>(fetcher, "PUT", "/api/workspace", { machine }),
    projectWorkspace: (projectId: string) =>
      request<{ workspace: ProjectWorkspaceView }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/workspace`),
    setProjectWorkspace: (projectId: string, overrides: ProjectWorkspaceOverrides) =>
      request<{ workspace: ProjectWorkspaceView }>(fetcher, "PUT", `/api/projects/${encodeURIComponent(projectId)}/workspace`, {
        overrides,
      }),
    /** Choose a provider, choose a language, paste its key, or clear the key
     *  with an empty string. The key is WRITE-ONLY: it goes down and never
     *  comes back. Any field absent leaves the stored one alone — switching
     *  providers throws away neither a key nor a language. */
    setDictation: (patch: { provider?: DictationProviderId; apiKey?: string; language?: string }) =>
      request<DictationAnswer>(fetcher, "PATCH", "/api/dictation", patch),
    setSidebarLayout: (patch: { projectOrder?: string[]; sessionOrder?: Record<string, string[]>; pinnedOrder?: string[]; mode?: SidebarMode }) =>
      request<{ layout: SidebarLayout }>(fetcher, "PATCH", "/api/sidebar-layout", patch),
    /** Spend over time, folded from the engine's journals. */
    usage: (input: { sinceMs: number; untilMs: number; resolution?: UsageResolution; timeZone?: string }) => {
      const query = new URLSearchParams({ since: String(input.sinceMs), until: String(input.untilMs) });
      if (input.resolution) query.set("resolution", input.resolution);
      if (input.timeZone) query.set("tz", input.timeZone);
      return request<{ usage: UsageReport }>(fetcher, "GET", `/api/usage?${query.toString()}`);
    },
    /** Create or replace one. An EMPTY `managementKey` keeps the stored one, so
     *  saving a row read back redacted is safe. */
    saveUsageLimitSource: (input: { id: string; label?: string | null; url?: string; managementKey?: string; enabled?: boolean }) => {
      const { id, ...patch } = input;
      return request<{ source: UsageLimitSource }>(fetcher, "PUT", `/api/usage/sources/${encodeURIComponent(id)}`, patch);
    },
    /** The retention window in force, and what each candidate window would take
     *  on THIS store — see `RetentionBucket`. Read-only: nothing is deleted to
     *  answer it. `bytes` costs a scan of every qualifying row's text where the
     *  counts beside it are index ranges, so ask only when a person is looking
     *  at the figure, and never on a timer (#629). */
    retention: (options: { bytes?: boolean; signal?: AbortSignal } = {}) =>
      request<{ retention: RetentionPolicy; buckets: RetentionBucket[] }>(
        fetcher,
        "GET",
        `/api/storage/retention${options.bytes ? "?bytes=1" : ""}`,
        undefined,
        options.signal,
      ),
    /** Create a row, or replace one by `id`. `nextRunAt` is the ENGINE's to
     *  compute: a caller that could name it could aim a row at the past, where
     *  the grace rule would skip it for ever. */
    putSchedule: (input: { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean }) =>
      request<{ schedule: Schedule }>(fetcher, "POST", "/api/schedules", input),
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
    /** Which models a provider says it has — asked of the provider where it can
     *  answer, and this cockpit's own short list where it cannot. */
    modelCatalogue: (driver: ProviderDriverKind, options: { refresh?: boolean; instanceId?: string } = {}) => {
      const query = new URLSearchParams({ driver });
      if (options.refresh) query.set("refresh", "1");
      if (options.instanceId) query.set("instanceId", options.instanceId);
      return request<{ catalogue: ModelCatalogue }>(fetcher, "GET", `/api/models?${query.toString()}`);
    },
    /** Presence is the patch: a submitted list replaces its own whole, so
     *  `{ hidden: [] }` clears the hides and omitting `hidden` leaves them. */
    setModelOverlay: (
      instanceId: string,
      patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
    ) =>
      request<{ overlay: ModelOverlay }>(
        fetcher,
        "PATCH",
        `/api/provider-instances/${encodeURIComponent(instanceId)}/models`,
        patch,
      ),
    /** A body may be empty: "+, type a title, come back to it" is the gesture,
     *  and refusing the half-written note would lose the title just typed. */
    createProjectNote: (projectId: string, input: { title: string; body?: string; pinned?: boolean }) =>
      request<{ note: ProjectNote }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/notes`, input),
    /** The author NEVER changes — the engine refuses a patch that names it, so a
     *  note an agent wrote stays marked as one after the user rewrites it. */
    updateProjectNote: (projectId: string, noteId: string, patch: { title?: string; body?: string; pinned?: boolean; order?: number }) =>
      request<{ note: ProjectNote }>(
        fetcher,
        "PATCH",
        `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`,
        patch,
      ),
    /** `text` is required and may not be blank: a prepared prompt with no
     *  message is a row that does nothing when you press it. */
    createProjectPrompt: (projectId: string, input: { title: string; text: string; reason?: string; sessionId?: string }) =>
      request<{ prompt: PreparedPrompt }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/prompts`, input),
    /** The author NEVER changes — the engine refuses a patch that names it. */
    updateProjectPrompt: (projectId: string, promptId: string, patch: { title?: string; text?: string; reason?: string }) =>
      request<{ prompt: PreparedPrompt }>(
        fetcher,
        "PATCH",
        `/api/projects/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(promptId)}`,
        patch,
      ),
    /** Issues and pull requests. A NETWORK read behind a thirty-second cache —
     *  `refresh` is what the button sends, and nothing else may send it. */
    projectGitHub: (projectId: string, options: { refresh?: boolean; issues?: GitHubIssueFilter; pulls?: GitHubPullFilter } = {}) =>
      // `forgeQuery` is the CONTRACT's own builder, not a second copy: the engine
      // route parses these names, and two hand-written versions of the same query
      // string would drift on the first filter anybody adds.
      request<{ github: GitHubSnapshot }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/github${forgeQuery(options)}`),
    mergeProjectPull: (projectId: string, number: number, input: { method: GitHubMergeMethod; expectedHeadOid: string }) =>
      request<GitHubMergeResult>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/github/pulls/${number}/merge`, input),
    /** Add or remove one reaction (#842). A refusal is `reacted: false` with a
     *  reason — `scope` is the one with a command behind it. */
    reactOnProjectForge: (
      projectId: string,
      kind: "issue" | "pull",
      number: number,
      input: { subjectId: string; content: GitHubReactionContent; react: boolean },
    ) =>
      request<GitHubReactionResult>(
        fetcher,
        "POST",
        `/api/projects/${encodeURIComponent(projectId)}/github/${kind === "issue" ? "issues" : "pulls"}/${number}/reactions`,
        input,
      ),
  };
}
