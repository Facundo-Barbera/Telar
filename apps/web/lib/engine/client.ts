// Type-only, so the browser bundle never follows it into `node:fs`: the channel
// is DECIDED server-side (lib/build-identity.ts) and only described here.
import type { Channel } from "@/lib/build-identity";
import type {
  BrowserSnapshot,
  ClaudeConversation,
  ConversationImportDetail,
  GitCommitEntry,
  GitHubCheckLog,
  GitHubFacets,
  GitHubIssueFilter,
  GitHubIssueRead,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubPullCreateResult,
  GitPushResult,
  GitHubPullFilter,
  GitHubPullRead,
  GitHubSnapshot,
  GitignoreRemoval,
  GitignoreResult,
  GitOverview,
  ComputerUseGrant,
  ComputerUseStatus,
  RememberedLogin,
  Schedule,
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
  LatexBootstrap,
  LatexCompileStatus,
  LatexConfig,
  LatexDiagnostic,
  LatexDistributions,
  LatexJob,
  LatexPackagesAnswer,
  LatexToolchain,
  ManagedTectonic,
  InboxPolicy,
  AgentOrientation,
  EnvMode,
  DictationAnswer,
  DictationProviderId,
  DictationDiagnosisAnswer,
  DictationTokenAnswer,
  SessionDefaults,
  SidebarLayout,
  CleanupPolicy,
  CleanupState,
  JournalReclaim,
  JournalRetirement,
  RetentionBucket,
  RetentionPolicy,
  StoreCopy,
  StorageReport,
  TextGenPolicy,
  WorktreeMoveResult,
  WorktreeInventory,
  WorktreeReclaimItem,
  WorktreeReclaimOutcome,
  WorktreesRoot,
  UsageReport,
  UsageResolution,
  UsageLimits,
  UsageLimitSource,
  ModelCatalogue,
  ModelOverlay,
  CustomProviderModel,
  SessionDiff,
  EngineErrorCode,
  EngineHealth,
  EventPage,
  McpOAuthStatus,
  McpServer,
  McpServerSpec,
  ModelSelection,
  Project,
  ProjectNote,
  PreparedPrompt,
  TurnAttachment,
  TurnModelSelection,
  ProviderDriverKind,
  ProviderSkills,
  ProviderInstance,
  ProviderInstanceEnvVar,
  ProviderProbe,
  ProviderUpdateRun,
  PublishedAppearance,
  EngineRequest,
  ReportCadence,
  ReportWindowStatus,
  RequestDecision,
  RuntimeMode,
  LiveSessionRow,
  Session,
  SessionBootstrap,
  SessionSettleEnded,
  SessionSnapshot,
  SnapshotWindow,
  Turn,
  TurnSubmissionResult,
  WorkspaceFile,
  WorkspaceListing,
  WorkspaceWriteResult,
  WorkspaceConfig,
  ProjectWorkspaceOverrides,
  ProjectWorkspaceView,
  SessionAssignment,
  PluginStatus,
  ProjectPlugins,
  Subscription,
  WakeKind,
  GitFilePatch,
  DiffBaseOption,
  FilePatchOptions,
} from "@telar/engine-client";
import { diffBaseQuery, filePatchQuery, forgeQuery, snapshotQuery } from "@telar/engine-client";
import { hostName, HOST_NAME_HEADER, LOCAL_HOST_ID, pathnameFetcher, pinnedHost } from "@/lib/hosts/client";
// Type-only, like `Channel` above: `lib/fs-dirs.ts` reads the filesystem and
// must not follow into the browser bundle.
import type { DirectoryListing } from "@/lib/fs-dirs";
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

/** WHICH MAC AN ANSWER CAME FROM. `id` is this cockpit's own id for it (the one
 *  in the URL); `name` is what that Mac calls itself, when it has said. */
export type ErrorHost = { id: string; name?: string };

export class EngineApiError extends Error {
  constructor(
    readonly code: EngineApiErrorCode,
    message: string,
    readonly status?: number,
    /**
     * THE MACHINE THAT REFUSED (#204). A session id is minted per engine, so a
     * 404 is only interpretable once you know whose session store was asked:
     * "session does not exist" against the wrong Mac reads as a broken app,
     * and against the right one it is the plain truth. Absent for local, which
     * needs no attribution — there is only one of it.
     */
    readonly host?: ErrorHost,
  ) {
    super(message);
    this.name = "EngineApiError";
  }
}

/** The Mac to name in a failure, or nothing when this one answered. The UI
 *  shows the name when the Mac has given one, and falls back to the id rather
 *  than to silence — an id at least distinguishes two paired Macs. */
export function refusedBy(error: EngineApiError): string | undefined {
  if (!error.host || error.host.id === LOCAL_HOST_ID) return undefined;
  return error.host.name ?? error.host.id;
}

type Fetcher = typeof fetch;

/** What the request reached, as opposed to what it meant to reach: the pin on
 *  the fetcher, corrected by the name the proxy stamped on the way back. */
function answeringHost(fetcher: Fetcher, response?: Response): ErrorHost | undefined {
  const id = pinnedHost(fetcher);
  if (!id || id === LOCAL_HOST_ID) return undefined;
  const name = response?.headers.get(HOST_NAME_HEADER) ?? hostName(id);
  return name ? { id, name } : { id };
}

/**
 * THE CONNECTION BUDGET (#82).
 *
 * A browser opens at most six connections per origin over HTTP/1.1, and EVERY
 * App Router navigation needs a free one for its RSC fetch. Reach the cap and
 * navigation does not degrade — it queues, behind whatever is holding the
 * sockets, and the cockpit stops responding to clicks until something finishes.
 * That was measured live: exactly six established connections to the packaged
 * server while a session worked, and no way to switch conversations.
 *
 * WHAT HOLDS THEM NOW IS NOT WHAT THE ISSUE DESCRIBED — but two sentences of
 * this note went stale and are corrected here rather than left to mislead the
 * next person costing a connection budget (#586).
 *
 * THE COCKPIT DOES OPEN A STREAMING FETCH, AND THE ENGINE DOES SERVE ONE. The
 * run feed holds one for as long as the masthead is mounted
 * (`lib/run/status-stream.ts`). #82 is
 * not an argument against HAVING one — it is CLOSED, and its own slice 4 names
 * "one multiplexed per-client events channel… 1–2 regardless of activity" as
 * the durable answer. What it forbids is STACKING them.
 *
 * THE RAIL'S PASS IS ONE READ, NOT A FAN-OUT. #459 folded `daemonId` and the
 * inbox policy onto the live list itself, and `sidebar-one-read.test.ts` pins
 * that — no health probe, no inbox call, no `Promise.all` in `loadHost`.
 *
 * So the burst is smaller than this note claimed and the streams are realer.
 * Liveness is still mostly polling: the session tail once a second — now
 * conditional, answering 304 in no bytes when nothing moved (#586) — and the
 * rail every ten seconds quiet, three when a row is live. A poll RETURNS its
 * socket to the keep-alive pool, where a navigation can take it.
 *
 * THE BUDGET MUST BE SPENT DELIBERATELY, which is the live constraint. A
 * streaming fetch is a BARE `fetch` and so bypasses the gate below while still
 * holding one of the six: the run feed plus a sessions stream plus two
 * gated reads is four of six, leaving two for navigation. Workable, and it has
 * to be counted rather than discovered — an ungated stream nobody budgeted for
 * is exactly the shape #82 was filed about.
 *
 * So the ceiling is enforced HERE, at the one chokepoint every call already
 * passes through, rather than at each of the twenty-eight call sites that would
 * otherwise have to agree. Two concurrent reads leaves four connections free,
 * which is the budget the issue asks for and four more than navigation needs.
 *
 * NOTHING IS DROPPED OR DEBOUNCED: over-budget reads queue in FIFO order and go
 * out as slots free. A caller sees latency under contention, never a failure,
 * and the ordering it would have got from the browser's own socket queue.
 *
 * ONE GATE FOR EVERY HOST, deliberately. A remote Mac's reads are proxied
 * through THIS origin (`/api/hosts/:id/…` — see lib/hosts/client.ts), so they
 * spend the same six connections a local read does. A per-host gate would count
 * the wrong thing and let two hosts reach the cap between them.
 */
export const READ_BUDGET = 2;

/**
 * …AND ONE SLOT THAT ONLY AN OPENING MAY TAKE (#497).
 *
 * `/bootstrap` is the read that IS the click. Everything else the budget
 * governs is a poll on a timer nobody pressed — and a poll landing a
 * microsecond earlier was enough to put the one read a person is waiting on
 * third in a queue of two. That is "opening a conversation takes three serial
 * round trips": the wait was not the engine answering, it was this gate
 * deciding the rail's housekeeping went first.
 *
 * THE ATTRIBUTION HAS BEEN DROPPED, NOT THE CLAIM. This cited "#490's audit",
 * which was never produced (`docs/investigations/closure-audit-2026-09-19.md`)
 * — so it pointed at nothing a reader could check. The mechanism does not need
 * it: three reads against a budget of two is arithmetic over `READ_BUDGET`
 * above, and `client.test.ts` exercises it in a fixture.
 *
 * ONE, NOT MORE, AND SEPARATE RATHER THAN RESERVED. Separate because a slot
 * carved out of the two would halve ordinary read throughput for the whole life
 * of the tab to serve a read that happens on a click; one because a person
 * opens one conversation at a time, and the rail's warm-ups (lib/rail-prefetch)
 * coalesce onto the same `SessionConnection` the cockpit reads, so two
 * concurrent openings of the same conversation are one request already.
 *
 * THE CEILING IS THEREFORE THREE, not two — and #82's arithmetic still holds
 * with room over: six connections per origin, minus three, leaves three free
 * for navigation, which needs one. In practice the opening burst got SMALLER,
 * not larger: `/projects` and `/browser` no longer go out beside `/bootstrap`
 * at all (see the cockpit's `transcriptLanded` gate), so what used to be three
 * reads contending for two slots is now one read on a slot of its own.
 */
export const OPEN_BUDGET = 1;

/**
 * One budget and its queue.
 *
 * WAS TWO MODULE-LEVEL VARIABLES AND TWO FUNCTIONS, which is fine for one gate
 * and a copy-paste bug waiting for the second. The behaviour is unchanged and
 * the comments below are the originals: nothing is dropped or debounced,
 * over-budget callers queue FIFO and go out as slots free.
 */
function gate(budget: number) {
  let live = 0;
  const queued: Array<() => void> = [];
  return {
    /** Take a slot, waiting in line when the budget is spent. */
    async take(): Promise<void> {
      if (live < budget) {
        live += 1;
        return;
      }
      await new Promise<void>((resolve) => queued.push(resolve));
    },
    /**
     * Hand the slot to whoever is next in line, or give it back.
     *
     * The waiter is resumed WITHOUT touching `live` — the slot is transferred,
     * not released and re-taken, so a third caller arriving in the same tick
     * cannot slip past the queue into the gap that a decrement would open.
     */
    give(): void {
      const next = queued.shift();
      if (next) {
        next();
        return;
      }
      live -= 1;
    },
  };
}

type Gate = ReturnType<typeof gate>;

const reads = gate(READ_BUDGET);
/** The opening's own slot. Exported for the cockpit's sake only in the sense
 *  that `sessionBootstrap` below is the single caller — nothing else may take
 *  it, or it stops being the thing that makes an opening never wait. */
const opens = gate(OPEN_BUDGET);

async function request<T>(
  fetcher: Fetcher,
  method: string,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
  lane: Gate = reads,
): Promise<T> {
  /**
   * READS ARE BUDGETED; EVERYTHING ELSE GOES STRAIGHT OUT.
   *
   * The traffic that stacks is background reads — polls, on timers nobody
   * pressed. A mutation is somebody's click, it is rare next to a poll, and
   * making a send wait behind two rail reads would trade the freeze this fixes
   * for a slower Send button.
   *
   * A request carrying a signal is exempt for the opposite reason: it is the
   * long, cancellable kind (`/api/textgen/complete` waits on a model), and one
   * of those parked in a slot would starve the tail for as long as it ran.
   */
  const budgeted = method === "GET" && signal === undefined;
  if (budgeted) await lane.take();
  try {
    return await send<T>(fetcher, method, pathname, body, signal);
  } finally {
    if (budgeted) lane.give();
  }
}

async function send<T>(fetcher: Fetcher, method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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
    // A remote hop that throws here never reached this cockpit's proxy, so the
    // sentence about a "local adapter" would name the wrong machine.
    const host = answeringHost(fetcher);
    throw new EngineApiError(
      "engine_unavailable",
      host ? `The cockpit cannot reach ${host.name ?? "that Mac"}.` : "The cockpit cannot reach its local adapter.",
      undefined,
      host,
    );
  }

  const host = answeringHost(fetcher, response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngineApiError("engine_unavailable", "The engine adapter returned an invalid response.", response.status, host);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: EngineApiErrorCode; message?: string } } | null)?.error;
    throw new EngineApiError(error?.code ?? "internal_error", error?.message ?? "The engine request failed.", response.status, host);
  }
  return payload as T;
}

/**
 * ONE PASS OF THE RAIL, in the two shapes it can come back in.
 *
 * A UNION, SO `sessions` CANNOT BE READ WITHOUT CHECKING `unchanged` FIRST. That
 * flag means "keep what you have" — not "there is nothing" — and a rail that
 * redrew from the absent rows would blank itself once a tick. The type is what
 * makes that a compile error rather than a thing to remember.
 */
export type LiveSessionsPage = {
  sessions: LiveSessionRow[];
  projects: Project[];
  assignments?: Record<string, SessionAssignment[]>;
  layout?: SidebarLayout;
  /** Which engine answered — what folds two reads that reached ONE Mac.
   *  Absent from an engine too old to stamp it; the rail then leaves its
   *  hosts undeduplicated rather than dropping rows. */
  daemonId?: string;
  /** The settling window these rows band by, this engine's own. Absent
   *  from an older engine; the rail falls back to its default. */
  inbox?: InboxPolicy;
  /** What to pass as `since` next time. Absent from an engine too old to
   *  count, which keeps every read a full one. */
  revision?: number;
  /** How many SETTLED rows this answer left out (#457) — the size of the shelf
   *  behind `?all=1`. Absent from an engine that predates the filter, which
   *  means "you have everything", never "the shelf is empty". */
  settledCount?: number;
  unchanged?: false;
};

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
    /** Clone a repository into `parent` and register what landed, in one call —
     *  the caller cannot name the path in between, because `git clone` chooses
     *  the folder from the URL. `owner/repo` is expanded by the engine. */
    cloneProject: (input: { url: string; parent: string; name?: string }) =>
      request<{ project: Project }>(fetcher, "POST", "/api/projects/clone", input),
    /**
     * The folders inside one folder, for the Add-project browser — the same
     * route the phone's browser drills through (app/api/fs/route.ts).
     *
     * No `path` means the ANSWERING machine's home, which on a remote screen is
     * the paired Mac's: this fetcher follows the address bar
     * (lib/hosts/client.ts), so the browser lists the disk the project is
     * actually being registered on. `hidden` opts in to dotfolders.
     */
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
    /** How this machine's inbox bands — the auto-settle window, or `null` for
     *  no clock at all. One answer for every client of this engine. */
    inbox: () => request<{ inbox: InboxPolicy }>(fetcher, "GET", "/api/inbox"),
    setInbox: (patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number }) =>
      request<{ inbox: InboxPolicy }>(fetcher, "PATCH", "/api/inbox", patch),
    /** Whether Telar may tell an agent where it is — the preamble and the
     *  `telar` skill. One answer for every client of this engine. */
    orientation: () => request<{ orientation: AgentOrientation; text: string }>(fetcher, "GET", "/api/orientation"),
    setOrientation: (patch: { preamble?: boolean; skill?: boolean }) =>
      request<{ orientation: AgentOrientation; text: string }>(fetcher, "PATCH", "/api/orientation", patch),
    /** What a new session is built with when nobody said — see
     *  `SessionDefaults`. One answer for every client of this engine. */
    sessionDefaults: () => request<{ sessionDefaults: SessionDefaults }>(fetcher, "GET", "/api/session-defaults"),
    setSessionDefaults: (patch: { envMode?: EnvMode }) =>
      request<{ sessionDefaults: SessionDefaults }>(fetcher, "PATCH", "/api/session-defaults", patch),
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
    /* -------------------------------------------------------------- *
     * DICTATION — issue #544, first step.
     *
     * NO AUDIO GOES THROUGH THE ENGINE. The microphone is in this browser,
     * so the engine holds the key and hands out a token that dies in
     * minutes; the page opens its own socket to the provider with it. Both
     * answers carry `provider` so a second vendor can follow without every
     * surface being rebuilt to guess.
     * -------------------------------------------------------------- */
    /** Which provider transcribes, and whether this Mac has its key. NEVER the
     *  key — `configured` is the whole of what may be said about it. */
    dictation: () => request<DictationAnswer>(fetcher, "GET", "/api/dictation"),
    /** Choose a provider, choose a language, paste its key, or clear the key
     *  with an empty string. The key is WRITE-ONLY: it goes down and never
     *  comes back. Any field absent leaves the stored one alone — switching
     *  providers throws away neither a key nor a language. */
    setDictation: (patch: { provider?: DictationProviderId; apiKey?: string; language?: string }) =>
      request<DictationAnswer>(fetcher, "PATCH", "/api/dictation", patch),
    /** Mint a token for one dictation. Fetch one per press of the button
     *  rather than holding one: it expires in minutes, and `expiresAt` is an
     *  instant so a caller compares it against its own clock. */
    dictationToken: () => request<DictationTokenAnswer>(fetcher, "POST", "/api/dictation/token"),
    /**
     * Why the last dictation failed (#711).
     *
     * AFTER A SOCKET FAILS, NOT BEFORE ONE OPENS. A browser's `WebSocket` error
     * event carries no reason BY DESIGN — the status of a failed cross-origin
     * handshake would be an oracle — so this asks the engine, which holds the
     * key, to ask Deepgram and answer in Deepgram's own words.
     *
     * A CALLER MUST SURVIVE IT FAILING. The sentence it already has is honest;
     * this one is better. An engine too old for this route answers 404, and
     * then the honest one is what a person sees.
     */
    dictationDiagnosis: () => request<DictationDiagnosisAnswer>(fetcher, "POST", "/api/dictation/diagnose"),
    /** Where each project group sits in the rail — see `SidebarLayout`. One
     *  arrangement for every client of this engine. */
    sidebarLayout: () => request<{ layout: SidebarLayout }>(fetcher, "GET", "/api/sidebar-layout"),
    setSidebarLayout: (patch: { projectOrder?: string[]; sessionOrder?: Record<string, string[]>; pinnedOrder?: string[] }) =>
      request<{ layout: SidebarLayout }>(fetcher, "PATCH", "/api/sidebar-layout", patch),
    /** Spend over time, folded from the engine's journals. */
    usage: (input: { sinceMs: number; untilMs: number; resolution?: UsageResolution; timeZone?: string }) => {
      const query = new URLSearchParams({ since: String(input.sinceMs), until: String(input.untilMs) });
      if (input.resolution) query.set("resolution", input.resolution);
      if (input.timeZone) query.set("tz", input.timeZone);
      return request<{ usage: UsageReport }>(fetcher, "GET", `/api/usage?${query.toString()}`);
    },
    /** The CLIProxyAPI hubs quota is read from. Keys never come back: every row
     *  reads `managementKey: ""`, with `keyRedacted` when one is stored. */
    usageLimitSources: () => request<{ sources: UsageLimitSource[] }>(fetcher, "GET", "/api/usage/sources"),
    /** Create or replace one. An EMPTY `managementKey` keeps the stored one, so
     *  saving a row read back redacted is safe. */
    saveUsageLimitSource: (input: { id: string; label?: string | null; url?: string; managementKey?: string; enabled?: boolean }) => {
      const { id, ...patch } = input;
      return request<{ source: UsageLimitSource }>(fetcher, "PUT", `/api/usage/sources/${encodeURIComponent(id)}`, patch);
    },
    removeUsageLimitSource: (id: string) => request<{ removed: boolean }>(fetcher, "DELETE", `/api/usage/sources/${encodeURIComponent(id)}`),
    /** What the hubs currently report. Served from a short-lived cache unless
     *  `refresh`, which waits for a fresh read of every configured hub. */
    usageLimits: (options: { refresh?: boolean } = {}) =>
      request<{ limits: UsageLimits }>(fetcher, "GET", `/api/usage/limits${options.refresh ? "?refresh=1" : ""}`),
    /** What Telar keeps on disk, by category — see `StorageReport`. The first
     *  call of an engine's life walks the store and is SLOW; every call after
     *  it returns that walk's answer with the moment it was taken, until
     *  `refresh` asks for another. Never put this on a timer (#629). */
    /** `signal` both lets the pane hang up on unmount and keeps this read out
     *  of the shared read budget — see `request`. */
    storage: (options: { refresh?: boolean; signal?: AbortSignal } = {}) =>
      request<{ storage: StorageReport }>(fetcher, "GET", `/api/storage${options.refresh ? "?refresh=1" : ""}`, undefined, options.signal),
    /** Compact the turn journal and return its freed pages to the filesystem —
     *  see `JournalReclaim`. SLOW and exclusive: the vacuum behind it rewrites
     *  the database under a lock. It drops rows a settled turn has superseded
     *  and never a turn, an item or an answer. */
    reclaimJournal: () => request<{ reclaimed: JournalReclaim }>(fetcher, "POST", "/api/storage/journal/reclaim", {}),
    /** A copy of this store somebody can open without risk — see `StoreCopy`.
     *  SLOW, writes to a destination that must not exist, and never touches the
     *  live store: the database goes through `VACUUM INTO`. The reproducible
     *  tier (checkouts, Python, toolchains) is deliberately not carried. */
    copyStore: (destination: string) => request<{ copy: StoreCopy }>(fetcher, "POST", "/api/storage/copy", { destination }),
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
    /** Set the window, or turn it off with `idleAfterDays: null`. A window with
     *  no export destination is refused — the copy comes before the delete. */
    setRetention: (patch: { idleAfterDays?: number | null; exportTo?: string | null }) =>
      request<{ retention: RetentionPolicy }>(fetcher, "PUT", "/api/storage/retention", patch),
    /** Sweep now — the distinct visible act, not something startup does quietly.
     *  SLOW on a backlog, and it returns COUNTS: a delete moves pages to the
     *  freelist, so the store weighs the same until Reclaim rewrites it. */
    sweepRetention: () => request<{ swept: JournalRetirement }>(fetcher, "POST", "/api/storage/retention/sweep", {}),
    /** The standing instructions on this install — issue #543 — or one
     *  session's. READ ONCE, NEVER ON A TIMER: a row changes only when a sweep
     *  touches it, and this pane is looked at rather than watched (#629). */
    schedules: (sessionId?: string) =>
      request<{ schedules: Schedule[] }>(fetcher, "GET", `/api/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
    /** Create a row, or replace one by `id`. `nextRunAt` is the ENGINE's to
     *  compute: a caller that could name it could aim a row at the past, where
     *  the grace rule would skip it for ever. */
    putSchedule: (input: { id?: string; sessionId: string; prompt: string; rule: ScheduleRule; zone: string; enabled?: boolean }) =>
      request<{ schedule: Schedule }>(fetcher, "POST", "/api/schedules", input),
    /** Forget a row. There is no "run now" — it would start a turn with none of
     *  the sweep's re-aiming, so twice pressed means two turns. */
    deleteSchedule: (id: string) => request<{ deleted: boolean }>(fetcher, "DELETE", `/api/schedules/${encodeURIComponent(id)}`),
    /** The automatic cleanup's switches and last result — see `CleanupState`. */
    cleanup: () => request<{ cleanup: CleanupState }>(fetcher, "GET", "/api/cleanup"),
    setCleanupPolicy: (patch: Partial<CleanupPolicy>) => request<{ cleanup: CleanupState }>(fetcher, "PUT", "/api/cleanup", patch),
    /** Sweep now; answers when it is done. */
    runCleanup: () => request<{ cleanup: CleanupState }>(fetcher, "POST", "/api/cleanup/run", {}),
    /** Where session checkouts go on this install — see `WorktreesRoot`. */
    worktreesRoot: () => request<{ worktreesRoot: WorktreesRoot }>(fetcher, "GET", "/api/worktrees-root"),
    /** Put them somewhere else from the next cut on; `null` restores the
     *  default. Nothing is moved and no restart is needed — a checkout already
     *  cut is addressed by the path recorded on its session. */
    setWorktreesRoot: (root: string | null) => request<{ worktreesRoot: WorktreesRoot }>(fetcher, "PUT", "/api/worktrees-root", { root }),
    /** Move the checkouts already cut, by re-cutting each from its own branch.
     *  SLOW (two git commands per checkout) and partial by design: one holding
     *  uncommitted changes is refused by git, reported, and left alone. */
    moveWorktrees: () => request<{ move: WorktreeMoveResult }>(fetcher, "POST", "/api/worktrees-root/move", {}),
    /** Every checkout this install is keeping, CLASSIFIED — see
     *  `WorktreeVerdict` (#671). Each row carries a verdict rather than four
     *  columns to reason from: Telar proves merged, clean and unclaimed so a
     *  reader does not check three things by hand before daring to delete.
     *  SLOW — git reads per checkout — and never cached, because every rung
     *  of the classification is live and a cached verdict was true earlier.
     *  Sizes are the engine's background measurement; see `measuring`. */
    worktrees: (options: { signal?: AbortSignal } = {}) =>
      request<{ inventory: WorktreeInventory }>(fetcher, "GET", "/api/worktrees", undefined, options.signal),
    /** Give checkouts back. THIS ARCHIVES SESSIONS: a settled session's
     *  checkout is released by putting that session down, which is the only
     *  supported way (settling deliberately does not release one, and nothing
     *  re-cuts a missing worktree). `confirm` is the basename, typed, and is
     *  required for every `needs-force` row. Refusals come back per item, not
     *  as an error status. */
    reclaimWorktrees: (items: readonly WorktreeReclaimItem[]) =>
      request<{ reclaim: WorktreeReclaimOutcome }>(fetcher, "POST", "/api/worktrees/reclaim", { items }),
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
      patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
    ) =>
      request<{ overlay: ModelOverlay }>(
        fetcher,
        "PATCH",
        `/api/provider-instances/${encodeURIComponent(instanceId)}/models`,
        patch,
      ),
    projectGit: (projectId: string) =>
      request<{ git: GitOverview }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/git`),
    /**
     * THE PROJECT'S NOTEBOOK — the composer's foot and the `@` menu.
     *
     * Already ordered by the engine (pinned first, then the user's own order),
     * so nothing on this side re-sorts. Uncached, because the user's other app
     * writes to the same store over the notebook's MCP socket and a copy held
     * here would hide what it wrote.
     */
    projectNotes: (projectId: string) =>
      request<{ notes: ProjectNote[] }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/notes`),
    projectNote: (projectId: string, noteId: string) =>
      request<{ note: ProjectNote }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`),
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
    /** A REAL delete, not a retire — a project note is a scratchpad.
     *  `deleted: false` means it was already gone, never an error. */
    deleteProjectNote: (projectId: string, noteId: string) =>
      request<{ deleted: boolean }>(fetcher, "DELETE", `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}`),
    /**
     * THE PROJECT'S PROMPT SHELF — the composer's stash draws this beside the
     * ⌘S queue.
     *
     * Uncached for a sharper version of the notebook's reason: the other writer
     * is a WORKER, drafting a follow-up while you watch the turn that writes it.
     * Already ordered newest-first, so nothing on this side re-sorts.
     */
    projectPrompts: (projectId: string) =>
      request<{ prompts: PreparedPrompt[] }>(fetcher, "GET", `/api/projects/${encodeURIComponent(projectId)}/prompts`),
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
    /** How a prepared prompt ends: sent, or discarded. `deleted: false` means it
     *  was already gone, never an error. */
    deleteProjectPrompt: (projectId: string, promptId: string) =>
      request<{ deleted: boolean }>(
        fetcher,
        "DELETE",
        `/api/projects/${encodeURIComponent(projectId)}/prompts/${encodeURIComponent(promptId)}`,
      ),
    pinProjectNote: (projectId: string, noteId: string, pinned: boolean) =>
      request<{ note: ProjectNote }>(
        fetcher,
        "POST",
        `/api/projects/${encodeURIComponent(projectId)}/notes/${encodeURIComponent(noteId)}/pin`,
        { pinned },
      ),
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
    /** Take those rules back out — the Undo in the toast that reports the write.
     *  Only the block the engine wrote; a `.telar/` somebody added in their own
     *  section survives, and `removed: []` is a success. */
    undoProjectGitignore: (projectId: string) =>
      request<{ gitignore: GitignoreRemoval }>(fetcher, "DELETE", `/api/projects/${encodeURIComponent(projectId)}/gitignore`),
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
    // `assignments` rides this list so Related work needs no per-session
    // history read. Optional: an older engine does not send it.
    /**
     * FOLLOWING — who this session is woken by. One-directional and revocable;
     * it changes what wakes you and confers nothing else.
     */
    sessionSubscriptions: (sessionId: string) =>
      request<{ subscriptions: Subscription[] }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/subscriptions`),
    follow: (sessionId: string, input: { targetSessionId: string; events?: WakeKind[]; once?: boolean }) =>
      request<{ subscription: Subscription }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/subscriptions`, input),
    unfollow: (subscriptionId: string, subscriberSessionId?: string) =>
      request<{ removed: boolean }>(fetcher, "DELETE", `/api/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        ...(subscriberSessionId ? { subscriberSessionId } : {}),
      }),
    machinePlugins: () => request<{ plugins: PluginStatus[]; machine: ProjectPlugins }>(fetcher, "GET", "/api/plugins"),
    updateMachinePlugins: (plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>) =>
      request<{ machine: ProjectPlugins }>(fetcher, "PATCH", "/api/plugins", { plugins }),
    /**
     * The rail's own read. `layout` rides along because this is the one route
     * every rail already polls: it is how a drag on another device reaches this
     * one, without a second request or a connection of its own. Optional — an
     * engine older than the field simply says nothing about the arrangement,
     * and the rail keeps the copy it fetched when it mounted.
     *
     * ROWS, NOT WHOLE SESSIONS (#459). `LiveSessionRow` is every field a row
     * renders and none it does not — the route was answering 318 KB for 267
     * sessions, several times a second, most of it engine bookkeeping no rail
     * has ever read. A full `Session` is assignable to a row, so anything here
     * that was handed one keeps working.
     *
     * AND IT IS NOW THE RAIL'S WHOLE PASS. `daemonId` and `inbox` used to be a
     * `health()` and an `inbox()` issued beside this one, three concurrent reads
     * per host per tick; both answer one field that moves when somebody opens
     * Settings. They ride here for the same reason `layout` does.
     *
     * `since` MAKES THE PASS CONDITIONAL (#459). Hand back the `revision` from
     * last time and an engine with nothing to say answers `unchanged` — sixty
     * bytes and no fold — instead of every row the caller already has. Check
     * `unchanged` before reading `sessions`: it means "keep what you have", and
     * a rail that redrew from it would blank itself once a tick.
     *
     * `all` IS THE SHELF'S ASK (#457). The route answers only the UNSETTLED rows
     * by default — 7 of 291 on the owner's store — and `settledCount` says how
     * many it left out, so a rail can draw the shelf header that opens it and
     * only then pay for the rows behind it.
     */
    liveSessions: (options: { all?: boolean } = {}) =>
      request<LiveSessionsPage>(fetcher, "GET", options.all ? "/api/sessions/live?all=1" : "/api/sessions/live"),
    /**
     * WHEN EACH PROJECT WAS LAST WORKED IN — the front door's read, and nothing
     * else's (#490).
     *
     * THE RANKING WITHOUT THE ROWS. `composerProject` folds sessions into
     * `Map<projectId, max(updatedAt)>` and reads the top of it; the front door
     * was buying that fold with `liveSessions({ all: true })` — 101.6 KB, 291
     * sessions, 21.8 ms at the engine boundary — and rendering not one field of
     * it. This is the same fold, answered off the engine's session index — one
     * row per project, and no conversation opened to produce it.
     *
     * NOT A RAIL'S READ AND NOT A SHELF'S. It carries no title, no activity and
     * no settling state, so nothing here can be drawn; a surface that wants rows
     * still calls `liveSessions`.
     *
     * A PROJECT WITH NO ACTIVE SESSION IS ABSENT rather than 0 — identical to
     * `composerProject`'s fold, which seeds every registered project at 0 and
     * only raises it.
     */
    projectActivity: () =>
      request<{ projects: Array<{ projectId: string; updatedAt: number }> }>(fetcher, "GET", "/api/sessions/activity"),
    /**
     * THE SAME PASS, CONDITIONALLY — the read a RAIL should make (#459).
     *
     * Hand back the `revision` from last time and an engine with nothing to say
     * answers `{ revision, unchanged: true }`: sixty bytes, no fold over 267
     * sessions' queues, and no `listProjects()` behind it either. Everything
     * else here calls `liveSessions()` above, because a surface that reads the
     * list once has no cursor and wants the rows.
     *
     * THE UNION IS THE SAFETY. `unchanged` means "keep what you have", never
     * "there is nothing", and narrowing on it is what stops a rail redrawing
     * itself empty once a tick.
     */
    liveSessionsSince: (since: number) =>
      request<LiveSessionsPage | { unchanged: true; revision: number; daemonId?: string }>(
        fetcher,
        "GET",
        `/api/sessions/live?since=${encodeURIComponent(String(since))}`,
      ),
    /**
     * THE SAME PASS, CONDITIONAL ON AN ETAG — issue #457, step 3.
     *
     * `liveSessionsSince` is this in the body and it stays. What the header buys
     * is a 304 with NO BODY at all, and — the part the cursor cannot do — a
     * conditional WIDE read: the mode is inside the tag, where a `?since=`
     * earned against the unsettled list would have been answered "unchanged"
     * against `?all=1` and left the Settled shelf permanently empty.
     *
     * ITS OWN ENVELOPE, because `send` parses a JSON body on every path and a
     * 304 has none. It keeps the read budget, which is the part of that envelope
     * a poll actually needs — this is one of the reads the budget exists for.
     *
     * `cache: "no-store"` SO THE BROWSER STAYS OUT OF IT. The conditional here
     * is the rail's own, held per host in a ref; an HTTP cache revalidating
     * underneath it would answer from a copy this code never saw and the tag
     * bookkeeping would be describing someone else's state.
     */
    liveSessionsMatching: async (
      options: { etag?: string; all?: boolean } = {},
    ): Promise<{ notModified: true; etag: string } | (LiveSessionsPage & { notModified?: false; etag?: string })> => {
      const pathname = options.all ? "/api/sessions/live?all=1" : "/api/sessions/live";
      await reads.take();
      let response: Response;
      try {
        response = await fetcher(pathname, {
          method: "GET",
          cache: "no-store",
          ...(options.etag === undefined ? {} : { headers: { "if-none-match": options.etag } }),
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        const host = answeringHost(fetcher);
        throw new EngineApiError(
          "engine_unavailable",
          host ? `The cockpit cannot reach ${host.name ?? "that Mac"}.` : "The cockpit cannot reach its local adapter.",
          undefined,
          host,
        );
      } finally {
        reads.give();
      }
      const etag = response.headers.get("etag") ?? undefined;
      // 304 FIRST, AND WITHOUT TOUCHING THE BODY: there is none.
      if (response.status === 304) return { notModified: true, etag: etag ?? options.etag ?? "" };
      const host = answeringHost(fetcher, response);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new EngineApiError("engine_unavailable", "The engine adapter returned an invalid response.", response.status, host);
      }
      if (!response.ok) {
        const error = (payload as { error?: { code?: EngineApiErrorCode; message?: string } } | null)?.error;
        throw new EngineApiError(error?.code ?? "internal_error", error?.message ?? "The engine request failed.", response.status, host);
      }
      return { ...(payload as LiveSessionsPage), ...(etag === undefined ? {} : { etag }) };
    },
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
        /** A human's own branch name, outside telar/. */
        branchName?: string;
      } = {},
    ) =>
      request<{ session: Session }>(fetcher, "POST", `/api/projects/${encodeURIComponent(projectId)}/sessions`, input),
    // The contract's own snapshot type, not a hand-copied structural twin: this
    // route proxies the engine verbatim, so a field the engine adds is already
    // arriving and a local re-declaration only hides it.
    session: (sessionId: string, window?: SnapshotWindow) =>
      request<SessionSnapshot>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}${snapshotQuery(window)}`),
    /**
     * THE WHOLE OPENING IN ONE READ (#407) — snapshot, journal from its cursor,
     * and this session's subscriptions.
     *
     * `session` + `events` cannot be issued together: the journal's `after` IS
     * the snapshot's answer, so opening a conversation paid two SERIAL round
     * trips through this adapter before a transcript could be folded. Kept
     * beside `session` rather than replacing it — the paging path asks for a
     * window whose cursor it already holds and wants none of this.
     *
     * AND IT NO LONGER QUEUES BEHIND THE POLLS (#497). This is the one read a
     * person is actually waiting on, so it spends `OPEN_BUDGET` — a slot of its
     * own that the rail's passes and the cockpit's own housekeeping cannot
     * take. See the note on that constant for why one slot and why separate.
     */
    sessionBootstrap: (sessionId: string, window?: SnapshotWindow) =>
      request<SessionBootstrap>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/bootstrap${snapshotQuery(window)}`,
        undefined,
        undefined,
        opens,
      ),
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
        /** Sit out a usage limit and carry on. `null` returns the session to the
         *  driver's default — see `Session.resumeAfterRateLimit`. */
        resumeAfterRateLimit?: boolean | null;
        /** Hold routine peer reports and deliver them together on this cadence,
         *  or `HOLD_REPORTS` to hold them and never take them as a turn at all
         *  (#784). `null` returns the session to arrival delivery — see
         *  `Session.reportWindowMinutes`. */
        reportWindowMinutes?: ReportCadence | null;
      },
    ) => request<{ session: Session; ended?: SessionSettleEnded }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, patch),
    /**
     * THE CADENCE, AND WHAT IT IS HOLDING — the Agents panel's own read (#723).
     *
     * NOT ON `liveSessions`. `LiveSessionRow` omits `reportWindowMinutes` by
     * contract and the rail is measured against a per-row ceiling; the held
     * count is not on the session record at all. Two numbers, read only by the
     * surface that shows them, and only while it is open.
     */
    sessionReportWindow: (sessionId: string) =>
      request<ReportWindowStatus>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/report-window`),
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
     *  the engine). A granted answer is also what lets sessions claim the tools. */
    computerUseStatus: () => request<{ computerUse: ComputerUseStatus }>(fetcher, "GET", "/api/computer-use"),
    /** Asks macOS for the grants — through Telar's bundled helper when there
     *  is one, else through an external cua install. */
    grantComputerUseAccess: () => request<ComputerUseGrant>(fetcher, "POST", "/api/computer-use/grant", {}),
    /** Shows the bundled helper in Finder, to drag into a Settings list. */
    revealComputerUseHelper: () => request<{ revealed: boolean }>(fetcher, "POST", "/api/computer-use/reveal", {}),
    /** Clears the bundled helper's grants only; `reset: false` without one. */
    resetComputerUseAccess: () =>
      request<{ reset: boolean; message?: string }>(fetcher, "POST", "/api/computer-use/reset", {}),
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
    /**
     * ONE PAGE of the journal above `after` (#494). `more` true is ordinary,
     * not an error — see `drainEvents` in `session-sync.ts` for the loop.
     */
    events: (sessionId: string, after: number, limit?: number) =>
      request<EventPage>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}${limit === undefined ? "" : `&limit=${limit}`}`,
      ),
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
    projectFilePatch: (projectId: string, path: string, options: FilePatchOptions = {}) =>
      request<{ file: GitFilePatch }>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/diff?${filePatchQuery(path, options)}`,
      ),
    /** What this session has done to the repository, against the base the Diff
     *  surface asked for — see `DiffBaseOption` for the three states of one. */
    sessionDiff: (sessionId: string, options: DiffBaseOption = {}) => {
      const query = diffBaseQuery(options);
      return request<{ diff: SessionDiff }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/diff${query ? `?${query}` : ""}`);
    },
    /** One file's patch, opened on demand. */
    sessionFilePatch: (sessionId: string, path: string, options: FilePatchOptions = {}) =>
      request<{ file: GitFilePatch }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/diff?${filePatchQuery(path, options)}`),
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
    /**
     * The provider's own skills and slash commands, for the composer's `$` and
     * `/` menus. Asked when a menu first opens and cached by the caller for the
     * session, the way the path listing is — the engine caches it too, so the
     * cost of asking twice is a round trip rather than a subprocess.
     */
    sessionSkills: (sessionId: string) =>
      request<ProviderSkills>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/skills`),
    /**
     * THE PERSON'S OWN CLAUDE CODE CONVERSATIONS, for `/resume` (#616).
     *
     * ASKED PER LOGIN, NOT PER SESSION, because the picker runs on a canvas —
     * before the session it would adopt into exists. `instanceId` is whose
     * history to read (a configured login keeps its own config directory);
     * absent is the built-in slot, where a terminal `claude` writes.
     *
     * NOT SCOPED TO A PROJECT either. Resume finds a conversation by id from
     * any directory, so filtering to the current checkout would hide
     * conversations that would adopt perfectly well — the project path is shown
     * on each row instead, and the person decides.
     */
    claudeConversations: (instanceId?: string) =>
      request<{ conversations: ClaudeConversation[] }>(
        fetcher,
        "GET",
        `/api/claude-conversations${instanceId ? `?${new URLSearchParams({ instanceId }).toString()}` : ""}`,
      ),
    /** Adopt one: fork it, import its history, and point this session's next
     *  turn at the fork. The person's own conversation is not written to. */
    adoptClaudeConversation: (sessionId: string, sourceSessionId: string) =>
      request<{ session: Session; turn: Turn; provenance: ConversationImportDetail }>(
        fetcher,
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/adopt`,
        { sourceSessionId },
      ),
    /**
     * The same, one scope wider — what a CANVAS asks, because the session that
     * would answer for itself does not exist yet (#500). `driver` is the
     * canvas's pending choice; absent means the engine's default.
     */
    projectSkills: (projectId: string, driver?: ProviderDriverKind) =>
      request<ProviderSkills>(
        fetcher,
        "GET",
        `/api/projects/${encodeURIComponent(projectId)}/skills${driver ? `?${new URLSearchParams({ driver }).toString()}` : ""}`,
      ),
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
        | { kind: "move"; cellId?: string; index?: number; to: number }
        | { kind: "clearOutputs"; cellId?: string; index?: number }
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
    /** Publish this session's own branch (#670). A refusal — no origin, nothing
     *  to push, the remote said no — comes back as `pushed: false` with a named
     *  reason, not as a thrown error. Takes no body: the branch is the engine's
     *  to know, never the browser's to name. */
    pushSessionBranch: (sessionId: string) =>
      request<GitPushResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/git/push`, {}),
    /** Open a pull request for this session's branch (#670) — the second arm,
     *  which needs `gh` and a GitHub remote where the push arm needs neither. */
    openSessionPullRequest: (sessionId: string, input: { title: string; body?: string; base?: string }) =>
      request<GitHubPullCreateResult>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/github/pull`, input),
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
    /**
     * `null` clears a field; an absent key leaves it alone. Sensitive values
     * round-trip as `{ value: "", valueRedacted: true }` and keep their
     * stored secret.
     *
     * `stoppedInheriting` IS THE ANSWER TO "WHAT DID THAT COST" (#594): the
     * names this save stopped the login inheriting from the engine's own
     * environment, present only when there are any. Names, never values —
     * several of them are credentials.
     */
    saveProviderInstance: (input: {
      id: string;
      driver?: ProviderDriverKind;
      displayName?: string | null;
      accentColor?: string | null;
      /** A whole percentage of the model's window; `null` returns this login to
       *  the cockpit's default. */
      contextNoticePercent?: number | null;
      configDir?: string | null;
      binaryPath?: string | null;
      enabled?: boolean;
      env?: ProviderInstanceEnvVar[];
      /** Inherited variables to keep, by name. The engine supplies the values
       *  from its own environment; none crosses this call. */
      carryOverInherited?: string[];
    }) =>
      request<{ providerInstance: ProviderInstance; stoppedInheriting?: string[] }>(
        fetcher,
        "PUT",
        "/api/provider-instances",
        input,
      ),
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
      request<{ stopped: Turn[]; live?: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { scope: "session", commandId: crypto.randomUUID() }),
    /** Deprecated compatibility alias for session Stop; never creates a latch. */
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
    /** RESUME NOW: run a turn that is waiting out a usage limit, without
     *  waiting for the reset. The engine does not check the clock — the person
     *  pressing this may know the limit has already lifted. */
    resumeRateLimitedTurn: (sessionId: string, runId: string) =>
      request<{ turn: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(runId)}/resume`, {}),
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
