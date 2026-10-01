import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxPolicy, Project, PublicHost, SidebarLayout } from "@telar/engine-client";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { createEngineApi, type LiveSessionsPage } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";
import { PROJECTS_CHANGED_EVENT } from "@/features/projects";
import { dedupeAcrossHosts } from "../session-groups";
import { sessionKey, toSidebarSession, type SidebarSession } from "../session-list";
import { applyRowChange, type SessionRowChange } from "../session-mutations";
import { readSettledCache, readSidebarCache, rememberRows, staleRows, writeSettledCache, writeSidebarCache } from "./sidebar-cache";
import { observeSidebarLayout } from "./sidebar-layout";
import { LOCAL_HOST } from "../snapshot-cache";

const api = createEngineApi();

export type RemoteProject = Pick<Project, "id" | "name" | "icon" | "iconName"> & { hostId: string; hostName: string };

type HostPage = {
  projects: Project[];
  sessions: SidebarSession[];
  daemonId?: string;
  policy?: InboxPolicy;
  layout?: SidebarLayout;
  settledCount?: number;
};

type HostCache = {
  tags: Map<string, string>;
  revisions: Map<string, number>;
  pages: Map<string, HostPage>;
  staleShelves: Set<string>;
};

type Scope = "lean" | "shelf";
type HostApi = ReturnType<typeof createEngineApi>;

const SHELF = "#shelf";
const shelfKey = (key: string): string => `${key}${SHELF}`;

function markShelvesStale(cache: HostCache): void {
  cache.staleShelves.add(LOCAL_HOST);
  for (const key of cache.pages.keys()) if (!key.endsWith(SHELF)) cache.staleShelves.add(key);
}

async function readList(cache: HostCache, hostApi: HostApi, key: string, scope: Scope, host: { id: string; name: string } | undefined): Promise<{ page: HostPage; changed: boolean }> {
  const known = cache.tags.get(key);
  const cursor = cache.revisions.get(key);
  const shelf = scope === "shelf";
  const answer = known === undefined && !shelf && cursor !== undefined
    ? await hostApi.liveSessionsSince(cursor).then((page) => (page.unchanged ? { notModified: true as const, etag: "" } : { ...page, notModified: false as const, etag: undefined }))
    : await hostApi.liveSessionsMatching({
      ...(known === undefined ? {} : { etag: known }),
      ...(shelf ? { shelf: true } : {}),
    });
  if (answer.notModified) {
    const held = cache.pages.get(key);
    if (held) return { page: held, changed: false };
  }
  const result = answer.notModified ? await hostApi.liveSessions({ shelf }) : answer;
  if (answer.etag) cache.tags.set(key, answer.etag);
  else cache.tags.delete(key);
  if (result.revision === undefined || shelf) cache.revisions.delete(key);
  else cache.revisions.set(key, result.revision);
  const page = toHostPage(result, host);
  if (cache.tags.has(key) || cache.revisions.has(key)) cache.pages.set(key, page);
  return { page, changed: true };
}

function toHostPage(result: LiveSessionsPage, host: { id: string; name: string } | undefined): HostPage {
  const daemonId = result.daemonId;
  const policy = result.inbox;
  const names = new Map(result.projects.map((project) => [project.id, project.name]));
  const branches = new Map(result.projects.map((project) => [project.id, project.branch]));
  const icons = new Map(result.projects.map((project) => [project.id, project.icon]));
  const glyphs = new Map(result.projects.map((project) => [project.id, project.iconName]));
  const remotes = new Map(result.projects.map((project) => [project.id, project.remoteUrl]));
  const availability = new Map(result.projects.map((project) => [project.id, project.availability]));
  const titles = new Map(result.sessions.map((session) => [session.id, session.title]));
  const sessions = result.sessions.map((session) =>
    toSidebarSession(
      session,
      session.projectId ? names.get(session.projectId) : undefined,
      session.projectId ? branches.get(session.projectId) : undefined,
      session.projectId ? icons.get(session.projectId) : undefined,
      host,
      result.assignments?.[session.id],
      session.projectId ? remotes.get(session.projectId) : undefined,
      session.projectId ? glyphs.get(session.projectId) : undefined,
      session.settledBy ? titles.get(session.settledBy.coordinatorSessionId) : undefined,
      session.projectId ? availability.get(session.projectId) : undefined,
      result.terminals?.[session.id],
    ),
  );
  return {
    projects: result.projects,
    sessions,
    ...(daemonId ? { daemonId } : {}),
    ...(policy ? { policy } : {}),
    ...(result.layout ? { layout: result.layout } : {}),
    ...(result.settledCount === undefined ? {} : { settledCount: result.settledCount }),
  };
}

function withShelf(rows: readonly SidebarSession[], shelf: readonly SidebarSession[]): SidebarSession[] {
  const listed = new Set(rows.map(sessionKey));
  return [...rows, ...shelf.filter((row) => !listed.has(sessionKey(row)))];
}

/** The unsettled list, and with `wide` the shelf beside it: read again only when opened, changed, or the list moved. */
async function readHostPage(cache: HostCache, wide: boolean, host: { id: string; name: string } | undefined): Promise<HostPage> {
  const hostApi = createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID));
  const key = host?.id ?? LOCAL_HOST;
  const lean = await readList(cache, hostApi, key, "lean", host);
  if (!wide) return lean.page;
  const held = cache.pages.get(shelfKey(key));
  const shelf = held && !lean.changed && !cache.staleShelves.has(key) ? held : (await readList(cache, hostApi, shelfKey(key), "shelf", host)).page;
  cache.staleShelves.delete(key);
  const tag = cache.tags.get(shelfKey(key));
  if (shelf !== held && tag) writeSettledCache({ ...readSettledCache(), [key]: { etag: tag, sessions: shelf.sessions } });
  return { ...lean.page, sessions: withShelf(lean.page.sessions, shelf.sessions) };
}

function heldShelves(cache: HostCache): SidebarSession[] {
  const remembered = readSettledCache();
  for (const [key, entry] of Object.entries(remembered)) {
    if (cache.pages.has(shelfKey(key))) continue;
    cache.pages.set(shelfKey(key), { projects: [], sessions: entry.sessions });
    cache.tags.set(shelfKey(key), entry.etag);
  }
  return [...cache.pages].flatMap(([key, page]) => (key.endsWith(SHELF) ? page.sessions : []));
}

/** Every host's live sessions and projects, polled faster while anything runs. */
export function useRailData() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  const [renderedAt, setRenderedAt] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [shelvedOnEngines, setShelvedOnEngines] = useState(0);
  const [hosts, setHosts] = useState<PublicHost[]>([]);
  const [unreachable, setUnreachable] = useState<Set<string>>(() => new Set());
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [hostWindows, setHostWindows] = useState<Map<string, number | null>>(() => new Map());
  const [staleByHost, setStaleByHost] = useState<Map<string, SidebarSession[]>>(() => new Map());
  const loadAllRunning = useRef(false);
  const loadAllAgain = useRef(false);
  const cache = useRef<HostCache>({ tags: new Map(), revisions: new Map(), pages: new Map(), staleShelves: new Set() });
  const wantsSettled = useRef(false);

  const loadHost = useCallback((host: { id: string; name: string } | undefined) => readHostPage(cache.current, wantsSettled.current, host), []);

  const loadOnce = useCallback(async () => {
    const cache = typeof window === "undefined" ? {} : readSidebarCache();
    const book = await api.hosts().then((answer) => answer.hosts).catch(() => [] as PublicHost[]);
    setHosts(book);
    const [local, ...remotes] = await Promise.allSettled([loadHost(undefined), ...book.map((host) => loadHost({ id: host.id, name: host.name }))]);
    if (local.status !== "fulfilled") {
      setUnavailable(true);
      const remembered = staleRows(cache, LOCAL_HOST);
      if (remembered.length > 0) {
        setSessions(remembered);
        setRenderedAt(Date.now());
      }
      return;
    }
    setUnavailable(false);
    setProjects(local.value.projects);
    observeSidebarLayout(local.value.layout);
    const away = new Set<string>();
    const reads: { daemonId?: string; sessions: SidebarSession[]; settledCount?: number }[] = [local.value];
    const remoteProjects: RemoteProject[] = [];
    const windows = new Map<string, number | null>();
    if (local.value.policy) windows.set(LOCAL_HOST, local.value.policy.autoSettleAfterHours);
    let next = rememberRows(cache, LOCAL_HOST, local.value.sessions);
    remotes.forEach((page, index) => {
      const host = book[index]!;
      if (page.status === "fulfilled") {
        next = rememberRows(next, host.id, page.value.sessions);
        reads.push(page.value);
        if (page.value.policy) windows.set(host.id, page.value.policy.autoSettleAfterHours);
        if (!page.value.daemonId || page.value.daemonId !== local.value.daemonId) {
          remoteProjects.push(...page.value.projects.map((project) => ({ ...project, hostId: host.id, hostName: host.name })));
        }
      } else {
        away.add(host.id);
      }
    });
    writeSidebarCache(next);
    setRemoteProjects(remoteProjects);
    setHostWindows(windows);
    const remembered = new Map<string, SidebarSession[]>();
    for (const id of away) {
      const rows = staleRows(cache, id);
      if (rows.length > 0) remembered.set(id, rows);
    }
    setStaleByHost(remembered);
    setUnreachable(away);
    setShelvedOnEngines(reads.reduce((total, read) => total + (read.settledCount ?? 0), 0));
    setSessions(dedupeAcrossHosts(reads));
    setRenderedAt(Date.now());
  }, [loadHost]);

  // A reload asked for mid-read (a project just added) runs once more rather than being dropped.
  const loadAll = useCallback(async () => {
    if (loadAllRunning.current) {
      loadAllAgain.current = true;
      return;
    }
    loadAllRunning.current = true;
    try {
      do {
        loadAllAgain.current = false;
        await loadOnce();
      } while (loadAllAgain.current);
    } finally {
      loadAllRunning.current = false;
    }
  }, [loadOnce]);

  const onRowChanged = useCallback((change: SessionRowChange) => {
    setSessions((rows) => applyRowChange(rows, change));
    markShelvesStale(cache.current);
    for (const [key, page] of cache.current.pages) {
      const next = applyRowChange(page.sessions, change);
      if (next.length !== page.sessions.length || next.some((row, index) => row !== page.sessions[index])) {
        cache.current.pages.set(key, { ...page, sessions: next });
      }
    }
  }, []);

  const toggleSettled = useCallback(() => {
    const next = !wantsSettled.current;
    wantsSettled.current = next;
    setSettledOpen(next);
    if (!next) return;
    markShelvesStale(cache.current);
    const held = heldShelves(cache.current);
    if (held.length > 0) setSessions((rows) => withShelf(rows, held));
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadAll(), 0);
    const onProjectsChanged = () => void loadAll();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    };
  }, [loadAll]);

  const anyLive = sessions.some((session) => session.activity !== "idle" && session.activity !== "waiting" && session.activity !== "scheduled");
  useEffect(() => {
    const timer = window.setInterval(() => void loadAll(), anyLive ? 3_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [loadAll, anyLive]);

  return {
    projects,
    sessions,
    renderedAt,
    settledOpen,
    toggleSettled,
    unavailable,
    shelvedOnEngines,
    hosts,
    unreachable,
    remoteProjects,
    hostWindows,
    staleByHost,
    onRowChanged,
    loadAll,
  };
}

export type RailData = ReturnType<typeof useRailData>;
