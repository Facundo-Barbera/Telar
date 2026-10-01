import type {
ComputerUseGrant,
ComputerUseStatus,
RememberedLogin,EventPage,ModelSelection,TurnAttachment,
TurnModelSelection,
ProviderDriverKind,EngineRequest,
HeldReports,
RequestDecision,
RuntimeMode,Session,
SessionBootstrap,
SessionSettleEnded,
SessionSnapshot,
SnapshotWindow,
Turn,
TurnSubmissionResult,PluginStatus,
ProjectPlugins,
Subscription,
WakeKind,TaskOutputPage
} from "@telar/engine-client";
import { snapshotQuery } from "@telar/engine-client";
import { EngineApiError, opens, request, requestIfChanged, type EngineApiErrorCode } from "./transport";
import type { Fetcher } from "./host-client";
import type { LiveSessionsPage } from "./client";
import { randomUuid } from "@/platform/random-uuid";

/** `all` adds the settled rows to the list; `shelf` asks for them alone. */
type LiveScope = { all?: boolean; shelf?: boolean };

// An engine that predates `shelf` reads it as `all`, which still carries every settled row.
const livePath = ({ all, shelf }: LiveScope): string =>
  shelf ? "/api/sessions/live?all=1&shelf=1" : all ? "/api/sessions/live?all=1" : "/api/sessions/live";

/** The cockpit's own sessions calls: the ones no package domain client covers yet. */
export function sessionCalls(fetcher: Fetcher) {
  return {
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
    installPlugin: (input: { path: string; mode: "copy" | "link" }) =>
      request<{ plugin: PluginStatus }>(fetcher, "POST", "/api/plugins/installed", input),
    uninstallPlugin: (id: string) => request<{ removed: true }>(fetcher, "DELETE", `/api/plugins/installed/${encodeURIComponent(id)}`),
    /** Any plugin's session verb, through the generic door. */
    sessionPluginVerb: (sessionId: string, plugin: string, verb: string, input: Record<string, unknown> = {}) =>
      request<unknown>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(plugin)}/${encodeURIComponent(verb)}`, input),
    updateMachinePlugins: (plugins: Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>) =>
      request<{ machine: ProjectPlugins }>(fetcher, "PATCH", "/api/plugins", { plugins }),
    liveSessions: (options: LiveScope = {}) => request<LiveSessionsPage>(fetcher, "GET", livePath(options)),
    projectActivity: () =>
      request<{ projects: Array<{ projectId: string; updatedAt: number }> }>(fetcher, "GET", "/api/sessions/activity"),
    liveSessionsSince: (since: number) =>
      request<LiveSessionsPage | { unchanged: true; revision: number; daemonId?: string }>(
        fetcher,
        "GET",
        `/api/sessions/live?since=${encodeURIComponent(String(since))}`,
      ),
    liveSessionsMatching: async (
      options: LiveScope & { etag?: string } = {},
    ): Promise<{ notModified: true; etag: string } | (LiveSessionsPage & { notModified?: false; etag?: string })> => {
      const read = await requestIfChanged<LiveSessionsPage>(fetcher, livePath(options), options.etag);
      if (read.unchanged) return { notModified: true, etag: read.etag ?? options.etag ?? "" };
      return { ...read.payload, ...(read.etag === undefined ? {} : { etag: read.etag }) };
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
      },
    ) => request<{ session: Session; ended?: SessionSettleEnded }>(fetcher, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, patch),
    /** How many peer reports the session is holding; not on the session record. */
    sessionHeldReports: (sessionId: string) =>
      request<HeldReports>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/held-reports`),
    markSessionRead: (sessionId: string, runId: string) =>
      request<{ session: Session }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/read`, { runId }),
  };
}

export function turnCalls(fetcher: Fetcher) {
  return {
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
    regenerateSessionTitle: (sessionId: string) =>
      request<{ session: Session; changed: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/regenerate-title`, {}),
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
    stopTurn: (sessionId: string, runId?: string) =>
      request<{ turn?: Turn; stopped: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { runId }),
    /** THE STOP BUTTON: end the live turn and settle what was waiting behind
     *  it, leaving the session idle. No latch — the next message just runs. */
    stopSession: (sessionId: string) =>
      request<{ stopped: Turn[]; live?: Turn }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, { scope: "session", commandId: randomUuid() }),
    /** Deprecated compatibility alias for session Stop; never creates a latch. */
    pauseSession: (sessionId: string) =>
      request<{ session: Session; stopped?: Turn; held: number; already: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/pause`, {}),
    resumeSession: (sessionId: string) =>
      request<{ session: Session; released: number; already: boolean }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/resume`, {}),
    stopBackgroundTasks: (sessionId: string) =>
      request<{ stopped: number }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop-background`, {}),
    /** What Settle would close, asked as a menu opens (#883). */
    sessionTerminals: (sessionId: string) =>
      request<{ open: number }>(fetcher, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/terminals`),
    /** Close a session's terminals, as the person (#883). */
    closeSessionTerminals: (sessionId: string) =>
      request<{ closed: number }>(fetcher, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/terminals/close`, {}),
    /** A page of a background task's log from byte `after`; without it, the tail. */
    taskOutput: (sessionId: string, taskId: string, after?: number) =>
      request<TaskOutputPage>(
        fetcher,
        "GET",
        `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output${after === undefined ? "" : `?after=${after}`}`,
      ),
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
