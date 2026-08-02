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
  FolderGit2Icon,
  FolderPlusIcon,
  LayoutDashboardIcon,
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
  SESSION_PAGE_SIZE,
  type SidebarSession,
} from "@/lib/session-list";
import { fmtAgo, fmtCost } from "@/lib/format";
import {
  refreshIncludes,
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
  type SidebarResizableOptions,
  type SidebarWidthProposal,
} from "@/components/ui/sidebar";
import { StateBadge } from "@/components/common/state-badge";
import { isLoomNeedsYou, isLoomRunning } from "@/lib/project-signal";
import { ArchiveButton } from "@/components/session/archive-button";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
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
};


// ── nav ────────────────────────────────────────────────────────────────────
const NAV = [
  { href: "/?overview=1", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/looms", label: "Looms", icon: ActivityIcon },
] as const;

function TelarSidebarHeader({ activeLooms }: { activeLooms: number }) {
  const pathname = usePathname();
  return (
    <SidebarHeader className="h-14 justify-center border-b border-sidebar-border/60 pl-11 pr-2">
      <div className="flex min-w-0 items-center gap-1">
        <Link
          href="/"
          title="New session"
          className="mr-auto flex min-w-0 items-center rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-heading text-lg font-semibold tracking-tight">telar</span>
        </Link>
        <nav aria-label="Workspace" className="flex shrink-0 items-center gap-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href.startsWith("/?") ? pathname === "/" : pathname.startsWith(href);
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

function SessionRow({
  session,
  active,
  showProject,
  searchable = false,
  searchSelected = false,
  onRefresh,
}: {
  session: ChatMeta;
  active: boolean;
  showProject: boolean;
  searchable?: boolean;
  searchSelected?: boolean;
  onRefresh: () => void;
}) {
  if (!session.project) return null;
  const href = `/projects/${encodeURIComponent(session.project)}/sessions/${encodeURIComponent(session.id)}`;
  return (
    <div
      className={`group/session relative rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      }`}
    >
      <Link
        id={`sidebar-session-${session.id}`}
        href={href}
        role={searchable ? "option" : undefined}
        aria-selected={searchable ? searchSelected : undefined}
        aria-current={active ? "page" : undefined}
        className="block min-w-0 px-2 py-2 pr-8 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {showProject ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-sidebar-foreground/50">
              <FolderGit2Icon className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{session.project}</span>
              <span className="shrink-0">{fmtAgo(session.updatedAt)}</span>
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground">
                {session.title || "Untitled session"}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-sidebar-foreground/35">
                {fmtCost(session.costUsd)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="block truncate text-xs font-medium text-sidebar-foreground">
              {session.title || "Untitled session"}
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[10px] text-sidebar-foreground/45">
              <span className="shrink-0">{fmtAgo(session.updatedAt)}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 font-mono">{fmtCost(session.costUsd)}</span>
            </span>
          </>
        )}
      </Link>
      {!searchable && (
        <ArchiveButton
          id={session.id}
          archived={session.archived}
          onDone={onRefresh}
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100"
        />
      )}
    </div>
  );
}

function SidebarBody({ initialData }: { initialData?: AppSidebarInitialData }) {
  const pathname = usePathname();
  const router = useRouter();

  const [looms, setLooms] = useState<Loom[]>(initialData?.looms ?? []);
  const [chats, setChats] = useState<ChatMeta[]>(initialData?.chats ?? []);
  const [projects, setProjects] = useState<ProjectMeta[]>(initialData?.projects ?? []);
  const [scope, setScope] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(SESSION_PAGE_SIZE);
  const searchInput = useRef<HTMLInputElement>(null);
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
    window.addEventListener("telar:refresh", onRefresh);
    return () => {
      window.removeEventListener("telar:refresh", onRefresh);
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

  const activeSessionId = activeSessionFromPathname(pathname);
  const list = deriveSessionList({
    sessions: chats,
    project: selectedScope,
    query,
    activeSessionId,
    limit: sessionLimit,
    settledLimit,
  });
  const needsYou = looms
    .filter((loom) => isLoomNeedsYou(loom.state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeLoomCount = looms.filter((loom) => isLoomRunning(loom.state)).length;
  const selectedSearchIndex = list.sessions.length
    ? Math.min(searchIndex, list.sessions.length - 1)
    : -1;

  const selectScope = (next?: string) => {
    setScope(next);
    setSessionLimit(SESSION_PAGE_SIZE);
    setSettledLimit(SESSION_PAGE_SIZE);
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
              </DropdownMenuContent>
            </DropdownMenu>
            <RegisterProjectDialog onRegistered={loadAll} compact />
          </div>
        </div>

        {needsYou.length > 0 && !query && (
          <SidebarGroup>
            <SidebarGroupLabel>Needs you</SidebarGroupLabel>
            <SidebarGroupContent className="space-y-0.5">
              {needsYou.map((loom) => (
                <Link
                  key={loom.id}
                  href={`/looms/${encodeURIComponent(loom.id)}`}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
                >
                  <StateBadge
                    state={loom.state}
                    className="shrink-0 gap-1 px-1.5 py-0 text-[9px]"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">{loom.title}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {loom.project}
                  </span>
                </Link>
              ))}
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>{query ? "Search results" : "Recent"}</SidebarGroupLabel>
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
            ) : list.sessions.length === 0 && (!list.settledCount || query) ? (
              <SidebarEmpty
                icon={MessageSquareIcon}
                title={query ? "No sessions found" : selectedScope ? "No sessions in this project" : "No sessions yet"}
                detail={query ? "Try another title or project name." : "Start a new session from the button above."}
              />
            ) : (
              list.sessions.map((session, index) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  showProject={!selectedScope}
                  searchSelected={Boolean(query) && index === selectedSearchIndex}
                  searchable={Boolean(query)}
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

        {!query && list.settledCount > 0 && (
          <SidebarGroup className="pt-0">
            <button
              type="button"
              className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground"
              aria-expanded={settledOpen}
              onClick={() => setSettledOpen((open) => !open)}
            >
              <ChevronRightIcon className={`size-3.5 transition-transform ${settledOpen ? "rotate-90" : ""}`} />
              Settled
              <span className="ml-auto font-mono text-[10px]">{list.settledCount}</span>
            </button>
            {settledOpen && (
              <SidebarGroupContent className="space-y-0.5">
                {list.settled.slice(0, settledLimit).map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    showProject={!selectedScope}
                    onRefresh={loadAll}
                  />
                ))}
                {list.hasMoreSettled && settledLimit < list.settledCount && (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                    onClick={() => setSettledLimit((limit) => limit + SESSION_PAGE_SIZE)}
                  >
                    Show more
                  </button>
                )}
              </SidebarGroupContent>
            )}
          </SidebarGroup>
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

export function AppSidebar({ initialData }: { initialData?: AppSidebarInitialData }) {
  return (
    <Sidebar collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE}>
      <SidebarBody initialData={initialData} />
      <SidebarRail />
    </Sidebar>
  );
}
