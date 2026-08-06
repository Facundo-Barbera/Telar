"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ActivityIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import type { Loom } from "@telar/core/looms";
import {
  activeSessionFromPathname,
  deriveSessionList,
  isUnread,
  SESSION_PAGE_SIZE,
  type SessionFilter,
  type SidebarSession,
} from "@/lib/session-list";
import { patchChat } from "@/lib/chat-actions";
import {
  refreshIncludes,
  TELAR_SESSION_RUN_EVENT,
  type TelarRefreshDomain,
} from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
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
import { isLoomRunning } from "@/lib/project-signal";
import { useCommandKeys } from "@/lib/use-command-keys";
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
import {
  APP_SIDEBAR_MAIN_MIN_WIDTH,
  APP_SIDEBAR_STORAGE_KEY,
  keepsRoomForMain,
  SIDEBAR_RESIZE_MIN_WIDTH,
} from "@/lib/sidebar-width";

const APP_SIDEBAR_RESIZABLE = {
  minWidth: SIDEBAR_RESIZE_MIN_WIDTH,
  storageKey: APP_SIDEBAR_STORAGE_KEY,
  shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }: SidebarWidthProposal) =>
    keepsRoomForMain(
      currentWidth,
      nextWidth,
      wrapper.getBoundingClientRect().width,
      APP_SIDEBAR_MAIN_MIN_WIDTH,
    ),
} satisfies SidebarResizableOptions;

// Chats feed the nested session list and per-project recency ordering. These
// client-safe shapes avoid importing the filesystem-backed store.
type ChatMeta = SidebarSession;
type ProjectMeta = {
  entry: { name: string; addedAt: number };
  manifest?: unknown | null;
};

export type AppSidebarInitialData = {
  looms: Loom[];
  chats: ChatMeta[];
  projects: ProjectMeta[];
  renderedAt: number;
};


// ── nav ────────────────────────────────────────────────────────────────────
const NAV = [
  { href: "/?overview=1", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/looms", label: "Looms", icon: ActivityIcon },
  { href: "/workspace", label: "Workspace", icon: ListTodoIcon },
] as const;

function TelarSidebarHeader({ activeLooms }: { activeLooms: number }) {
  const pathname = usePathname();
  // A session is the workspace itself, not the Projects index. Keeping the
  // Projects glyph selected on /sessions/new made the new-session canvas look
  // like a nested project-management screen; real resumed sessions had the
  // same false state. Project overview/settings pages remain selected.
  const inSessionWorkspace = /^\/projects\/[^/]+\/sessions\/[^/]+(?:\/|$)/.test(pathname);
  return (
    <SidebarHeader className="h-14 justify-center border-b border-sidebar-border/60 px-2">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger
          aria-label="Hide main sidebar"
          title="Hide main sidebar"
          className="shrink-0"
        />
        <Link
          href="/"
          title="New session"
          className="mr-auto flex min-w-0 items-center rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
        </Link>
        <nav aria-label="Workspace" className="flex shrink-0 items-center gap-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href.startsWith("/?")
              ? pathname === "/"
              : pathname.startsWith(href) && !(href === "/projects" && inSessionWorkspace);
            const isLooms = href === "/looms";
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={isLooms && activeLooms > 0 ? `${label} · ${activeLooms} weaving` : label}
                className={`relative flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/55 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {isLooms && activeLooms > 0 ? (
                  <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary ring-2 ring-sidebar" />
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </SidebarHeader>
  );
}

// The inbox's slice selector. A chip is a view over the same list, never a
// different screen — picking one flattens the shelves away (see
// deriveSessionList's `flat`) because a filtered list that still hides rows
// behind a collapsed shelf is the thing the filter was meant to stop.
const FILTERS: readonly {
  id: SessionFilter;
  label: string;
  count?: "unread" | "snoozed";
}[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread", count: "unread" },
  { id: "snoozed", label: "Snoozed", count: "snoozed" },
  { id: "settled", label: "Settled" },
];

function FilterChips({
  value,
  onChange,
  unreadCount,
  snoozedCount,
}: {
  value: SessionFilter;
  onChange: (next: SessionFilter) => void;
  unreadCount: number;
  snoozedCount: number;
}) {
  return (
    <div role="tablist" aria-label="Session filter" className="flex items-center gap-1">
      {FILTERS.map(({ id, label, count }) => {
        const badge =
          count === "unread" ? unreadCount : count === "snoozed" ? snoozedCount : 0;
        // An empty Snoozed chip is noise — nothing is deferred, so there is
        // nothing to switch to. Unread stays put: it is the count you scan for.
        if (count === "snoozed" && badge === 0 && value !== id) return null;
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
            {count && badge > 0 ? (
              <span className="font-mono text-[9px] text-sidebar-foreground/45">{badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// An empty chip view means "you are done with this slice", not "something is
// missing" — each one says so in its own terms rather than reusing the
// no-sessions-yet copy, which would read as if the filter had broken.
const EMPTY_BY_FILTER: Record<
  SessionFilter,
  { icon: React.ComponentType<{ className?: string }>; title: string; detail: string }
> = {
  all: {
    icon: MessageSquareIcon,
    title: "No sessions yet",
    detail: "Start a new session from the button above.",
  },
  unread: {
    icon: CheckIcon,
    title: "Nothing unread",
    detail: "Every session here has been read.",
  },
  snoozed: {
    icon: ClockIcon,
    title: "Nothing snoozed",
    detail: "Snooze a session to have it come back later.",
  },
  settled: {
    icon: MessageSquareIcon,
    title: "Nothing settled",
    detail: "Settle a session when you are done with it.",
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

// A collapsed band of rows below the live list — Snoozed and Settled are the
// same shape and differ only in what put a row there, so they share one
// component rather than two near-identical blocks that drift apart.
// Renders nothing at all when empty: an always-present "Snoozed (0)" header
// would cost a row of chrome to say nothing.
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
  rows: ChatMeta[];
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
        <ChevronRightIcon
          className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
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

function SidebarBody({ initialData }: { initialData?: AppSidebarInitialData }) {
  const pathname = usePathname();
  const router = useRouter();

  const [looms, setLooms] = useState<Loom[]>(initialData?.looms ?? []);
  const [chats, setChats] = useState<ChatMeta[]>(initialData?.chats ?? []);
  const [projects, setProjects] = useState<ProjectMeta[]>(initialData?.projects ?? []);
  // The server and first client render must use the same clock. Calling
  // Date.now() independently on each side crosses minute boundaries often
  // enough to produce a hydration mismatch and force React to regenerate the
  // entire persistent sidebar. Refresh this clock only when sidebar data does.
  const [renderedAt, setRenderedAt] = useState(initialData?.renderedAt ?? Date.now());
  const [scope, setScope] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  // Deliberately NOT persisted, for the same reason scope is not: a filter you
  // forget you set is a bug report about missing sessions (docs/phase-2-
  // sidebar-design.md, open question on remembered scope).
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(SESSION_PAGE_SIZE);
  const [snoozedLimit, setSnoozedLimit] = useState(SESSION_PAGE_SIZE);
  const searchInput = useRef<HTMLInputElement>(null);
  const markedRead = useRef<Set<string>>(new Set());
  const loadInFlight = useRef(false);
  const pendingLoads = useRef<Set<TelarRefreshDomain>>(new Set());
  const pendingForce = useRef(false);
  const composing = useRef(false);

  const loadAll = useCallback(async (
    requested: readonly TelarRefreshDomain[] = ["looms", "chats", "projects"],
    force = true,
  ) => {
    for (const domain of requested) pendingLoads.current.add(domain);
    pendingForce.current ||= force;
    // Coalesce mount, mutation-event, and active-work polling. Before this
    // guard, two triggers landing together launched duplicate filesystem scans
    // and each response replaced every sidebar collection with a fresh object.
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      while (pendingLoads.current.size > 0) {
        const domains = new Set(pendingLoads.current);
        pendingLoads.current.clear();
        const forceBatch = pendingForce.current;
        pendingForce.current = false;
        const [loomsBody, chatsBody, projectsBody] = await Promise.all([
          domains.has("looms")
            ? cachedJson<{ looms?: Loom[] }>("/api/looms", { force: forceBatch })
            : null,
          domains.has("chats")
            ? cachedJson<{ chats?: ChatMeta[] }>("/api/chats?archived=include", { force: forceBatch })
            : null,
          domains.has("projects")
            ? cachedJson<{ projects?: ProjectMeta[] }>("/api/projects", { force: forceBatch })
            : null,
        ]);
        if (loomsBody || chatsBody || projectsBody) setRenderedAt(Date.now());

        if (loomsBody) {
          const next: Loom[] = Array.isArray(loomsBody.looms) ? loomsBody.looms : [];
          setLooms((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
        }
        if (chatsBody) {
          const list: ChatMeta[] = Array.isArray(chatsBody.chats) ? chatsBody.chats : [];
          const next = list.filter((chat) => chat.project);
          setChats((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
        }
        if (projectsBody) {
          const next: ProjectMeta[] = Array.isArray(projectsBody.projects)
            ? projectsBody.projects.filter((project) => project.manifest !== null)
            : [];
          setProjects((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
        }
      }
    } catch {
      // Best-effort sidebar data; the next mutation or active-work tick retries.
    } finally {
      loadInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!initialData) queueMicrotask(() => void loadAll(undefined, false));
    const onRefresh = (event: Event) => {
      const domains = (["looms", "chats", "projects"] as const).filter(
        (domain) => refreshIncludes(event, domain),
      );
      if (domains.length > 0) void loadAll(domains);
    };
    // A turn STARTING has no mutation to broadcast — nothing is written until
    // it ends — so telar:refresh alone would leave the running dot dark for the
    // whole turn and light it only once the turn was already over. This event
    // is the start edge; the end edge is the ordinary chats refresh that
    // appendTurn's callers already fire.
    const onRun = () => void loadAll(["chats"]);
    window.addEventListener("telar:refresh", onRefresh);
    window.addEventListener(TELAR_SESSION_RUN_EVENT, onRun);
    return () => {
      window.removeEventListener("telar:refresh", onRefresh);
      window.removeEventListener(TELAR_SESSION_RUN_EVENT, onRun);
    };
  }, [initialData, loadAll]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // Issue #16 — new session / new tab / jump-to-conversation / settings.
  // Delegated to a hook (lib/use-command-keys.ts) rather than inlined here:
  // this is the one component already holding the session list cmd+1..9
  // needs, but the binding table, focus rule, and desktop-menu wiring it
  // depends on are shared with apps/desktop and belong in their own module.
  // `pathname` is already read at the top of this component (line above the
  // state declarations) purely to derive `activeSessionId` below it too —
  // hoisted no further than needed, just read here a second time, so cmd+1..9
  // pins the currently-open session the exact same way the main list does.
  useCommandKeys(chats, activeSessionFromPathname(pathname));

  // Idle workspaces are event-driven. Poll only while a loom is genuinely in
  // flight; mutations already broadcast telar:refresh and a running loom is the
  // sole state that can legitimately advance without a local user action.
  const hasActiveLoom = looms.some((loom) => isLoomRunning(loom.state));
  useEffect(() => {
    if (!hasActiveLoom) return;
    const timer = setInterval(() => void loadAll(["looms"]), 10_000);
    return () => clearInterval(timer);
  }, [hasActiveLoom, loadAll]);

  const projectNames = projects.map((project) => project.entry.name);
  const selectedScope = scope && projectNames.includes(scope) ? scope : undefined;
  // With ONE registered project every row would carry the same project name,
  // which is not information — it is the same word repeated down the list,
  // wearing the space the title needs. Scoping to a project does the same
  // thing, since the header already says which one you are in.
  const showProject = !selectedScope && projectNames.length > 1;

  const activeSessionId = activeSessionFromPathname(pathname);
  const list = deriveSessionList({
    sessions: chats,
    project: selectedScope,
    query,
    filter,
    activeSessionId,
    now: renderedAt,
    limit: sessionLimit,
    settledLimit,
    snoozedLimit,
  });
  // The chip badges are counted over the scope ALONE — no query, no active
  // chip — so they stay still while you type and keep saying how much is
  // actually there rather than how much the current view happens to show.
  // limit 0 makes this a counting pass: no rows are materialized.
  const totals = deriveSessionList({
    sessions: chats,
    project: selectedScope,
    now: renderedAt,
    limit: 0,
  });
  // Opening a session reads it — the inbox's defining gesture, and the only
  // thing that makes an unread count mean anything. Keyed by id+updatedAt so a
  // NEW turn on a session you already have open re-marks it unread and is then
  // read again on the next tick, rather than being permanently pre-read.
  // The ref guard is what keeps the write from re-entering: patchChat
  // broadcasts telar:refresh, which reloads chats, which re-runs this effect.
  // It also makes "mark as unread" on the session you are LOOKING AT stick,
  // which is the point of that action — the row stays unread until a new turn
  // moves updatedAt and mints a key this guard has not seen.
  const activeChat = activeSessionId
    ? chats.find((chat) => chat.id === activeSessionId)
    : undefined;
  const activeUnread = activeChat ? isUnread(activeChat) : false;
  useEffect(() => {
    if (!activeChat || !activeUnread) return;
    const key = `${activeChat.id}:${activeChat.updatedAt}`;
    if (markedRead.current.has(key)) return;
    markedRead.current.add(key);
    void patchChat(activeChat.id, { read: true });
  }, [activeChat, activeUnread]);

  const activeLoomCount = looms.filter((loom) => isLoomRunning(loom.state)).length;
  const selectedSearchIndex = list.sessions.length
    ? Math.min(searchIndex, list.sessions.length - 1)
    : -1;

  const resetPaging = () => {
    setSessionLimit(SESSION_PAGE_SIZE);
    setSettledLimit(SESSION_PAGE_SIZE);
    setSnoozedLimit(SESSION_PAGE_SIZE);
  };

  const selectScope = (next?: string) => {
    setScope(next);
    resetPaging();
  };

  const selectFilter = (next: SessionFilter) => {
    setFilter(next);
    resetPaging();
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
      setSearchIndex(
        (index) => (index + delta + list.sessions.length) % list.sessions.length,
      );
    } else if (event.key === "Enter" && selectedSearchIndex >= 0) {
      event.preventDefault();
      const selected = list.sessions[selectedSearchIndex];
      if (selected?.project) {
        router.push(
          `/projects/${encodeURIComponent(selected.project)}/sessions/${encodeURIComponent(selected.id)}`,
        );
      }
    }
  };

  return (
    <>
      <TelarSidebarHeader activeLooms={activeLoomCount} />
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
                aria-activedescendant={
                  query && selectedSearchIndex >= 0
                    ? `sidebar-session-${list.sessions[selectedSearchIndex]?.id}`
                    : undefined
                }
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
                <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[10px] text-sidebar-foreground/35">
                  ⌘K
                </kbd>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New session"
              title="New session"
              render={<Link href="/" />}
            >
              <MessageSquarePlusIcon />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 min-w-0 flex-1 justify-start px-2 text-sm font-normal"
                  />
                }
              >
                <FolderGit2Icon />
                <span className="truncate">{selectedScope ?? "All projects"}</span>
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
                  {projectNames.map((project) => (
                    <div key={project} className="flex items-center">
                      <DropdownMenuItem
                        className="min-w-0 flex-1"
                        onClick={() => selectScope(project)}
                      >
                        <span className="w-4">{selectedScope === project ? <CheckIcon /> : null}</span>
                        <span className="truncate">{project}</span>
                      </DropdownMenuItem>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Open ${project}`}
                        title={`Open ${project}`}
                        onClick={() => router.push(`/projects/${encodeURIComponent(project)}`)}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </div>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RegisterProjectDialog onRegistered={loadAll} compact />
          </div>

          <FilterChips
            value={filter}
            onChange={selectFilter}
            unreadCount={totals.unreadCount}
            snoozedCount={totals.snoozedCount}
          />
        </div>

        {/* Looms are not chats: they carry no read/settle/snooze state, and a
            non-ready loom has no terminal action a person can take, so a
            "Needs you" group here could only accumulate. The signal lives on
            the /looms page and the dashboard, which can act on it. */}
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>
            {query
              ? "Search results"
              : filter === "all"
                ? "Recent"
                : (FILTERS.find((entry) => entry.id === filter)?.label ?? "Recent")}
          </SidebarGroupLabel>
          <SidebarGroupContent
            id="sidebar-session-results"
            role={query ? "listbox" : undefined}
            className="space-y-0.5"
          >
            {projectNames.length === 0 ? (
              <SidebarEmpty
                icon={FolderPlusIcon}
                title="No projects yet"
                detail="Register a project to start a session."
              />
            ) : list.sessions.length === 0 &&
              (list.flat || (!list.settledCount && !list.snoozedCount)) ? (
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
                  onRefresh={loadAll}
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

        {/* Shelves exist only in the banded view. A chip or a search has
            already flattened everything it matched into the list above, so a
            second collapsed place for rows to hide would defeat the filter. */}
        {!list.flat && (
          <>
            <SessionShelf
              label="Snoozed"
              count={list.snoozedCount}
              rows={list.snoozed}
              open={snoozedOpen}
              onToggle={() => setSnoozedOpen((open) => !open)}
              hasMore={list.hasMoreSnoozed && snoozedLimit < list.snoozedCount}
              onShowMore={() => setSnoozedLimit((limit) => limit + SESSION_PAGE_SIZE)}
              limit={snoozedLimit}
              activeSessionId={activeSessionId}
              showProject={showProject}
              renderedAt={renderedAt}
              onRefresh={loadAll}
            />
            <SessionShelf
              label="Settled"
              count={list.settledCount}
              rows={list.settled}
              open={settledOpen}
              onToggle={() => setSettledOpen((open) => !open)}
              hasMore={list.hasMoreSettled && settledLimit < list.settledCount}
              onShowMore={() => setSettledLimit((limit) => limit + SESSION_PAGE_SIZE)}
              limit={settledLimit}
              activeSessionId={activeSessionId}
              showProject={showProject}
              renderedAt={renderedAt}
              onRefresh={loadAll}
            />
          </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="p-1">
          <SettingsButton />
        </div>
      </SidebarFooter>
    </>
  );
}

function SettingsButton() {
  const pathname = usePathname();
  const active = pathname.startsWith("/settings");
  return (
    <Link
      href="/settings"
      title="Settings"
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

export function AppSidebar({ initialData }: { initialData?: AppSidebarInitialData }) {
  return (
    <Sidebar collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE}>
      <SidebarBody initialData={initialData} />
      <AppSidebarRail />
    </Sidebar>
  );
}
