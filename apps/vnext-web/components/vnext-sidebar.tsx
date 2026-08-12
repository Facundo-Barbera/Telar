"use client";

// The app sidebar, ported from the frozen app's components/app-sidebar.tsx.
//
// STRUCTURE, TOP TO BOTTOM — this is the donor's, unchanged: a 56px header with
// the collapse trigger and the wordmark; a search field wearing its ⌘K hint and
// a new-session button beside it; a project scope dropdown with a register
// button; filter chips carrying live counts; the "Recent" band; a collapsed
// "Settled" shelf under it; Settings in the footer.
//
// WHAT IS NOT HERE, AND WHY. The donor's header also carried four nav glyphs —
// Overview, Projects, Looms, Workspace. Those views are deliberately out of
// scope for this rebuild, and a glyph that navigates nowhere is worse than a
// header without one. The Unread and Snoozed chips are gone for the reason given
// in lib/session-list.ts: the engine models neither, and a chip with an
// unbackable count is a lie with a number on it.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import {
  activeSessionFromPathname,
  deriveSessionList,
  SESSION_PAGE_SIZE,
  sessionHref,
  toSidebarSession,
  type SessionFilter,
  type SidebarSession,
} from "@/lib/session-list";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
  type SidebarResizableOptions,
  type SidebarWidthProposal,
  useSidebar,
} from "@/components/ui/sidebar";
import { SessionRow } from "@/components/session/session-row";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { APP_SIDEBAR_MAIN_MIN_WIDTH, APP_SIDEBAR_STORAGE_KEY, keepsRoomForMain, SIDEBAR_RESIZE_MIN_WIDTH } from "@/lib/sidebar-width";

const api = createVNextApi();

const APP_SIDEBAR_RESIZABLE = {
  minWidth: SIDEBAR_RESIZE_MIN_WIDTH,
  storageKey: APP_SIDEBAR_STORAGE_KEY,
  shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }: SidebarWidthProposal) =>
    keepsRoomForMain(currentWidth, nextWidth, wrapper.getBoundingClientRect().width, APP_SIDEBAR_MAIN_MIN_WIDTH),
} satisfies SidebarResizableOptions;

function TelarSidebarHeader() {
  return (
    <SidebarHeader className="h-14 justify-center border-b border-sidebar-border/60 px-2">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger aria-label="Hide main sidebar" title="Hide main sidebar" className="shrink-0" />
        <Link
          href="/"
          title="Projects"
          className="mr-auto flex min-w-0 items-center rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
        </Link>
      </div>
    </SidebarHeader>
  );
}

// The inbox's slice selector. A chip is a view over the same list, never a
// different screen — picking one flattens the shelf away (see deriveSessionList's
// `flat`) because a filtered list that still hides rows behind a collapsed shelf
// is the thing the filter was meant to stop.
const FILTERS: readonly { id: SessionFilter; label: string; count?: "active" | "archived" }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active", count: "active" },
  { id: "archived", label: "Archived", count: "archived" },
];

function FilterChips({
  value,
  onChange,
  activeCount,
  archivedCount,
}: {
  value: SessionFilter;
  onChange: (next: SessionFilter) => void;
  activeCount: number;
  archivedCount: number;
}) {
  return (
    <div role="tablist" aria-label="Session filter" className="flex items-center gap-1">
      {FILTERS.map(({ id, label, count }) => {
        const badge = count === "active" ? activeCount : count === "archived" ? archivedCount : 0;
        // An empty Archived chip is noise — nothing has been retired, so there
        // is nothing to switch to. Active stays put: it is the count you scan.
        if (count === "archived" && badge === 0 && value !== id) return null;
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/55 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
            }`}
          >
            {label}
            {count && badge > 0 ? <span className="font-mono text-[9px] text-sidebar-foreground/45">{badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// An empty chip view means "you are done with this slice", not "something is
// missing" — each one says so in its own terms rather than reusing the
// no-sessions-yet copy, which would read as if the filter had broken.
const EMPTY_BY_FILTER: Record<SessionFilter, { icon: React.ComponentType<{ className?: string }>; title: string; detail: string }> = {
  all: {
    icon: MessageSquareIcon,
    title: "No sessions yet",
    detail: "Start a new session from the button above.",
  },
  active: {
    icon: CheckIcon,
    title: "Nothing active",
    detail: "Every session here has been archived.",
  },
  archived: {
    icon: MessageSquareIcon,
    title: "Nothing archived",
    detail: "Archive a session when you are done with it.",
  },
};

function SidebarEmpty({
  icon: Icon,
  title,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
}) {
  return (
    <div className="px-3 py-6 text-center text-sidebar-foreground/55">
      <Icon className="mx-auto mb-2 size-5" />
      <p className="text-xs font-medium text-sidebar-foreground/75">{title}</p>
      <p className="mt-1 text-[11px] leading-4">{detail}</p>
    </div>
  );
}

// A collapsed band of rows below the live list. Renders nothing at all when
// empty: an always-present "Settled (0)" header would cost a row of chrome to
// say nothing.
function SessionShelf({
  label,
  count,
  rows,
  open,
  onToggle,
  hasMore,
  onShowMore,
  limit,
  activeSessionId,
  showProject,
  renderedAt,
  onRefresh,
}: {
  label: string;
  count: number;
  rows: SidebarSession[];
  open: boolean;
  onToggle: () => void;
  hasMore: boolean;
  onShowMore: () => void;
  limit: number;
  activeSessionId?: string;
  showProject: boolean;
  renderedAt: number;
  onRefresh: () => void;
}) {
  if (count === 0) return null;
  return (
    <SidebarGroup className="pt-0">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRightIcon className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
        <span className="ml-auto font-mono text-[10px]">{count}</span>
      </button>
      {open && (
        <SidebarGroupContent className="space-y-0.5">
          {rows.slice(0, limit).map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              showProject={showProject}
              renderedAt={renderedAt}
              onRefresh={onRefresh}
            />
          ))}
          {hasMore && (
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={onShowMore}
            >
              Show more
            </button>
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

function SidebarBody() {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  // The server and first client render must use the same clock. Reading
  // Date.now() independently on each side crosses minute boundaries often
  // enough to produce a hydration mismatch and force React to regenerate the
  // whole persistent sidebar. Refresh this clock only when sidebar data does.
  const [renderedAt, setRenderedAt] = useState(0);
  const [scope, setScope] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  // Deliberately NOT persisted, for the same reason scope is not: a filter you
  // forget you set is a bug report about missing sessions.
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(SESSION_PAGE_SIZE);
  const [unavailable, setUnavailable] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  // On a phone the rail is a sheet OVER the content, so following a link has to
  // close it — otherwise the destination is behind the thing you just used.
  const onNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const loadAll = useCallback(async () => {
    try {
      const result = await api.projects();
      const names = new Map(result.projects.map((project) => [project.id, project.name]));
      setProjects(result.projects);
      setUnavailable(false);
      // One request per project, in parallel, because the engine lists sessions
      // per project and this rail's default scope is "all of them".
      // `allSettled`, not `all`: one unreachable project must not blank the
      // whole list — the sessions that did answer are still worth showing.
      const pages = await Promise.allSettled(result.projects.map((project) => api.sessions(project.id)));
      setSessions(
        pages.flatMap((page) =>
          page.status === "fulfilled" ? page.value.sessions.map((session) => toSidebarSession(session, names.get(session.projectId))) : [],
        ),
      );
      setRenderedAt(Date.now());
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(task);
  }, [loadAll]);

  // Sessions advance without a local action — a detached turn finishes, a title
  // is derived — and there is no cross-session event stream to subscribe to, so
  // the rail re-reads on a slow timer. Slow on purpose: this is N+1 requests
  // over the project list, and it is a list of titles, not a live transcript.
  useEffect(() => {
    const timer = window.setInterval(() => void loadAll(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadAll]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const projectIds = projects.map((project) => project.id);
  const selectedScope = scope && projectIds.includes(scope) ? scope : undefined;
  const selectedProject = projects.find((project) => project.id === selectedScope);
  // With ONE registered project every row would carry the same project name,
  // which is not information — it is the same word repeated down the list,
  // wearing the space the title needs. Scoping to a project does the same thing.
  const showProject = !selectedScope && projects.length > 1;

  const activeSessionId = activeSessionFromPathname(pathname);
  const list = deriveSessionList({
    sessions,
    ...(selectedScope ? { projectId: selectedScope } : {}),
    query,
    filter,
    ...(activeSessionId ? { activeSessionId } : {}),
    now: renderedAt,
    limit: sessionLimit,
    settledLimit,
  });
  // The chip badges are counted over the scope ALONE — no query, no active chip
  // — so they stay still while you type and keep saying how much is actually
  // there rather than how much the current view happens to show. limit 0 makes
  // this a counting pass: no rows are materialized.
  const totals = deriveSessionList({
    sessions,
    ...(selectedScope ? { projectId: selectedScope } : {}),
    now: renderedAt,
    limit: 0,
  });

  const selectedSearchIndex = list.sessions.length ? Math.min(searchIndex, list.sessions.length - 1) : -1;

  const resetPaging = () => {
    setSessionLimit(SESSION_PAGE_SIZE);
    setSettledLimit(SESSION_PAGE_SIZE);
  };

  const selectScope = (next?: string) => {
    setScope(next);
    resetPaging();
  };

  const selectFilter = (next: SessionFilter) => {
    setFilter(next);
    resetPaging();
  };

  /**
   * OPENS A CANVAS; DOES NOT CREATE A SESSION.
   *
   * This used to mint an engine record on click, which put an empty "Untitled
   * session" in the rail for every idle press of the button and gave the reader
   * no chance to pick a provider or a model first. The donor's front door is a
   * composer with nothing behind it, and so is this: the first message is what
   * creates the session (see `app/projects/[projectId]/sessions/new/page.tsx`).
   *
   * UNSCOPED, IT STILL OPENS A COMPOSER. A session has to name a project, but
   * "which project" almost always has an obvious answer — the one you are
   * reading, then the one you touched last — and sending someone to a project
   * list to press a second button is the flow this screen exists to replace.
   * Only a cockpit with NO projects at all falls back, because then there is
   * genuinely nothing to open a conversation against.
   */
  const composerProjectId =
    selectedScope ??
    sessions.find((session) => session.id === activeSessionId)?.projectId ??
    [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.projectId ??
    projects[0]?.id;

  const startSession = () => {
    onNavigate();
    router.push(composerProjectId ? `/projects/${encodeURIComponent(composerProjectId)}/sessions/new` : "/");
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      if (query) {
        event.preventDefault();
        setQuery("");
        setSearchIndex(0);
      }
      return;
    }
    if (!query || list.sessions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSearchIndex((index) => (index + delta + list.sessions.length) % list.sessions.length);
    } else if (event.key === "Enter" && selectedSearchIndex >= 0) {
      event.preventDefault();
      const selected = list.sessions[selectedSearchIndex];
      if (selected) {
        onNavigate();
        router.push(sessionHref(selected));
      }
    }
  };

  return (
    <>
      <TelarSidebarHeader />
      <SidebarContent>
        <div className="space-y-1 px-3 pb-2 pt-3">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/45" />
              <Input
                ref={searchInput}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchIndex(0);
                  setSessionLimit(SESSION_PAGE_SIZE);
                }}
                onKeyDown={handleSearchKeyDown}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                placeholder="Search sessions"
                aria-label="Search sessions"
                role="combobox"
                aria-expanded={Boolean(query)}
                aria-controls="sidebar-session-results"
                aria-activedescendant={query && selectedSearchIndex >= 0 ? `sidebar-session-${list.sessions[selectedSearchIndex]?.id}` : undefined}
                className="h-8 border-transparent bg-transparent pl-7 pr-10 text-sm shadow-none hover:bg-sidebar-accent/70 focus-visible:border-sidebar-border focus-visible:bg-sidebar-accent/70"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear session search"
                  onClick={() => {
                    setQuery("");
                    setSearchIndex(0);
                  }}
                  className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[10px] text-sidebar-foreground/35">⌘K</kbd>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label="New conversation"
              title={composerProjectId ? "New conversation" : "Register a project first"}
              onClick={startSession}
            >
              <MessageSquarePlusIcon />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="sm" className="h-8 min-w-0 flex-1 justify-start px-2 text-sm font-normal" />}
              >
                <FolderGit2Icon />
                <span className="truncate">{selectedProject?.name ?? "All projects"}</span>
                <ChevronDownIcon className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Session scope</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => selectScope()}>
                    <span className="w-4">{selectedScope ? null : <CheckIcon />}</span>
                    All projects
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {projects.map((project) => (
                    <div key={project.id} className="flex items-center">
                      <DropdownMenuItem className="min-w-0 flex-1" onClick={() => selectScope(project.id)}>
                        <span className="w-4">{selectedScope === project.id ? <CheckIcon /> : null}</span>
                        <span className="truncate">{project.name}</span>
                      </DropdownMenuItem>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Open ${project.name}`}
                        title={project.root}
                        onClick={() => {
                          onNavigate();
                          router.push("/");
                        }}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </div>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RegisterProjectDialog onRegistered={() => void loadAll()} compact />
          </div>

          <FilterChips value={filter} onChange={selectFilter} activeCount={totals.activeCount} archivedCount={totals.archivedCount} />
        </div>

        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>
            {query ? "Search results" : filter === "all" ? "Recent" : (FILTERS.find((entry) => entry.id === filter)?.label ?? "Recent")}
          </SidebarGroupLabel>
          <SidebarGroupContent id="sidebar-session-results" role={query ? "listbox" : undefined} className="min-h-0 space-y-0.5 overflow-y-auto">
            {unavailable ? (
              <SidebarEmpty icon={MessageSquareIcon} title="Engine unavailable" detail="Start the local engine, then this list refills itself." />
            ) : projects.length === 0 ? (
              <SidebarEmpty icon={FolderPlusIcon} title="No projects yet" detail="Register a project to start a session." />
            ) : list.sessions.length === 0 && (list.flat || !list.settledCount) ? (
              <SidebarEmpty
                icon={query ? MessageSquareIcon : EMPTY_BY_FILTER[filter].icon}
                title={
                  query
                    ? "No sessions found"
                    : filter !== "all"
                      ? EMPTY_BY_FILTER[filter].title
                      : selectedScope
                        ? "No sessions in this project"
                        : "No sessions yet"
                }
                detail={
                  query
                    ? "Try another title or project name."
                    : filter !== "all"
                      ? EMPTY_BY_FILTER[filter].detail
                      : "Start a new session from the button above."
                }
              />
            ) : (
              list.sessions.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  showProject={showProject}
                  searchSelected={Boolean(query) && index === selectedSearchIndex}
                  searchable={Boolean(query)}
                  renderedAt={renderedAt}
                  onRefresh={() => void loadAll()}
                />
              ))
            )}
            {list.hasMoreSessions && (
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                onClick={() => setSessionLimit((limit) => limit + SESSION_PAGE_SIZE)}
              >
                Show more
              </button>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        {/* The shelf exists only in the banded view. A chip or a search has
            already flattened everything it matched into the list above, so a
            second collapsed place for rows to hide would defeat the filter. */}
        {!list.flat && (
          <SessionShelf
            label="Settled"
            count={list.settledCount}
            rows={list.settled}
            open={settledOpen}
            onToggle={() => setSettledOpen((open) => !open)}
            hasMore={list.hasMoreSettled && settledLimit < list.settledCount}
            onShowMore={() => setSettledLimit((limit) => limit + SESSION_PAGE_SIZE)}
            limit={settledLimit}
            {...(activeSessionId ? { activeSessionId } : {})}
            showProject={showProject}
            renderedAt={renderedAt}
            onRefresh={() => void loadAll()}
          />
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="p-1">
          <SettingsButton onNavigate={onNavigate} />
        </div>
      </SidebarFooter>
    </>
  );
}

function SettingsButton({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname.startsWith("/settings");
  return (
    <Link
      href="/settings"
      title="Settings"
      onClick={onNavigate}
      className={`flex items-center gap-2 rounded-md text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
        active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : ""
      } w-full p-2`}
    >
      <SettingsIcon className="size-4 shrink-0" />
      <span>Settings</span>
    </Link>
  );
}

function AppSidebarRail() {
  const { open } = useSidebar();
  return open ? <SidebarRail /> : null;
}

export function VNextSidebar() {
  return (
    <Sidebar collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE}>
      <SidebarBody />
      <AppSidebarRail />
    </Sidebar>
  );
}
