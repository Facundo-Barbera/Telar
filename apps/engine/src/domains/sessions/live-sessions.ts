import type { InboxPolicy, LiveSessionRow, Project, ProjectAvailability, Session, SessionAssignment, SidebarLayout } from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import type { SessionActivity } from "./activity";
import type { SessionRecords } from "./records";
import { newestFirst } from "./metadata";
import type { LiveScope, SessionIndex } from "./session-index";

// A pick rather than a delete-list, so a new `Session` field joins every poll only when someone writes it here.
const liveRow = (session: Session): LiveSessionRow => ({
  id: session.id,
  ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
  title: session.title,
  state: session.state,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  driver: session.driver,
  ...(session.model === undefined ? {} : { model: session.model }),
  envMode: session.envMode,
  workspace:
    session.workspace.mode === "worktree"
      ? { mode: "worktree", path: session.workspace.path, branch: session.workspace.branch }
      : session.workspace.mode === "none"
        ? { mode: "none" }
        : { mode: "local", path: session.workspace.path },
  ...(session.preparation === undefined ? {} : { preparation: session.preparation }),
  ...(session.draft === undefined ? {} : { draft: session.draft }),
  ...(session.usage === undefined ? {} : { usage: session.usage }),
  activity: session.activity,
  ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
  ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
  ...(session.lastTurnFailed === undefined ? {} : { lastTurnFailed: session.lastTurnFailed }),
  ...(session.lastTurnOrigin === undefined ? {} : { lastTurnOrigin: session.lastTurnOrigin }),
  ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
  ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
  ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
  ...(session.settledOverride === undefined ? {} : { settledOverride: session.settledOverride }),
  ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
  ...(session.settledBy === undefined ? {} : { settledBy: session.settledBy }),
  ...(session.terminalsClosed === undefined ? {} : { terminalsClosed: session.terminalsClosed }),
  ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
  ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
  ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
  ...(session.startedFrom === undefined ? {} : { startedFrom: session.startedFrom }),
});

type LiveOptions = { all?: boolean; shelf?: boolean };

const scopeOf = (options: LiveOptions): LiveScope => (options.shelf ? "shelf" : options.all ? "all" : "lean");

type LiveDeps = {
  records: SessionRecords;
  activity: SessionActivity;
  index: SessionIndex;
  getProject: (projectId: string) => Project;
  projects: () => Project[];
  availability: (project: Project) => ProjectAvailability;
  inbox: () => InboxPolicy;
  sidebarLayout: () => SidebarLayout;
  terminalCounts: (sessionIds: string[]) => Record<string, number>;
};

type LiveSessionsRead = {
  sessions: Session[];
  projects: Array<{ id: string; name: string; availability?: ProjectAvailability }>;
  assignments: Record<string, SessionAssignment[]>;
  layout: SidebarLayout;
};

/** What every rail polls: the live sessions with the registry, the layout and the settling window beside them. */
export class LiveSessions {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: LiveDeps,
  ) {}

  revision(options: LiveOptions = {}): number {
    return this.deps.index.revision(scopeOf(options));
  }

  /** One project's sessions, by the (project_id, updated_at) index so only its documents are parsed. */
  list(projectId: string): Session[] {
    this.deps.getProject(projectId);
    const rows = this.kernel.executionStore.projectSessionRows(projectId);
    return this.deps.records.read(new Set(rows.map((row) => row.id)));
  }

  /** Each project's latest activity off the index; active sessions only. */
  projectActivity(): { projectId: string; updatedAt: number }[] {
    return this.kernel.executionStore.projectActivity();
  }

  /** Every active session in one read; a removed project is never probed. */
  all(only?: Set<string>): LiveSessionsRead {
    const projects = this.deps.projects();
    const { sessions, assignments } = this.deps.activity.foldLive(only);
    return {
      sessions,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        ...(project.removedAt === undefined ? { availability: this.deps.availability(project) } : {}),
      })),
      assignments,
      layout: this.deps.sidebarLayout(),
    };
  }

  /** `all` projected to what a rail draws: unsettled rows by default, everything with `all`, the shelf alone with `shelf`. */
  rows(options: LiveOptions = {}): Omit<LiveSessionsRead, "sessions"> & {
    sessions: LiveSessionRow[];
    inbox: InboxPolicy;
    revision: number;
    settledCount: number;
    terminals: Record<string, number>;
  } {
    // Read first, so a write that lands mid-fold is reported by the next read rather than swallowed.
    const scope = scopeOf(options);
    const revision = this.deps.index.revision(scope);
    const inbox = this.deps.inbox();
    const indexed = this.deps.activity.shelf(inbox, scope !== "lean");
    const open = scope === "shelf" ? [] : [...indexed.chosen].filter((id) => !indexed.shelved.has(id));
    const live = this.all(new Set(open));
    const shelf = scope === "lean" ? { sessions: [], assignments: {} } : this.deps.activity.foldShelved(indexed.shelved, (id) => this.deps.index.stamp(id));
    const sessions = [...live.sessions, ...shelf.sessions].sort(newestFirst);
    return {
      ...live,
      sessions: sessions.map(liveRow),
      assignments: { ...live.assignments, ...shelf.assignments },
      inbox,
      revision,
      settledCount: indexed.settledCount,
      terminals: this.deps.terminalCounts(sessions.map((session) => session.id)),
    };
  }
}
