import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxPolicy, Project, PublicHost, SidebarLayout } from "@telar/engine-client";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { hostFetcher } from "@/lib/hosts/client";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { dedupeAcrossHosts } from "@/lib/session-groups";
import { toSidebarSession, type SidebarSession } from "@/lib/session-list";
import { applyRowChange, type SessionRowChange } from "@/lib/session-mutations";
import { readSidebarCache, rememberRows, staleRows, writeSidebarCache } from "@/lib/sidebar-cache";
import { observeSidebarLayout } from "@/lib/sidebar-layout";
import { LOCAL_HOST } from "@/lib/snapshot-cache";

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

type HostCache = { tags: Map<string, string>; revisions: Map<string, number>; pages: Map<string, HostPage> };

async function readHostPage(cache: HostCache, wide: boolean, host: { id: string; name: string } | undefined): Promise<HostPage> {
  const hostApi = createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID));
  const key = host?.id ?? LOCAL_HOST;
  const known = cache.tags.get(key);
  const cursor = cache.revisions.get(key);
  const answer = known === undefined && !wide && cursor !== undefined
    ? await hostApi.liveSessionsSince(cursor).then((page) => (page.unchanged ? { notModified: true as const, etag: "" } : { ...page, notModified: false as const, etag: undefined }))
    : await hostApi.liveSessionsMatching({
      ...(known === undefined ? {} : { etag: known }),
      ...(wide ? { all: true } : {}),
    });
  if (answer.notModified) {
    const held = cache.pages.get(key);
    if (held) return held;
  }
  const result = answer.notModified ? await hostApi.liveSessions({ all: wide }) : answer;
  if (answer.etag) cache.tags.set(key, answer.etag);
  else cache.tags.delete(key);
  if (result.revision === undefined) cache.revisions.delete(key);
  else cache.revisions.set(key, result.revision);
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
  const page: HostPage = {
    projects: result.projects,
    sessions,
    ...(daemonId ? { daemonId } : {}),
    ...(policy ? { policy } : {}),
    ...(result.layout ? { layout: result.layout } : {}),
    ...(result.settledCount === undefined ? {} : { settledCount: result.settledCount }),
  };
  if (cache.tags.has(key) || cache.revisions.has(key)) cache.pages.set(key, page);
  return page;
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
  const cache = useRef<HostCache>({ tags: new Map(), revisions: new Map(), pages: new Map() });
  const wantsSettled = useRef(false);

  const loadHost = useCallback((host: { id: string; name: string } | undefined) => readHostPage(cache.current, wantsSettled.current, host), []);

  const loadAll = useCallback(async () => {
    if (loadAllRunning.current) return;
    loadAllRunning.current = true;
    try {
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
    } finally {
      loadAllRunning.current = false;
    }
  }, [loadHost]);

  const onRowChanged = useCallback((change: SessionRowChange) => {
    setSessions((rows) => applyRowChange(rows, change));
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
    if (next) void loadAll();
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
