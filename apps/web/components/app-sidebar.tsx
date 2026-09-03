"use client";

// The app sidebar, ported from the frozen app's components/app-sidebar.tsx.
//
// STRUCTURE, TOP TO BOTTOM: a 56px header with the collapse trigger and the
// wordmark; a search field wearing its ⌘K hint and a new-session button beside
// it; a project scope dropdown with a register button; then the five bands —
//
//   drafts    above everything, unheaded, and DELIBERATELY THE SMALLEST ROWS
//             in the rail: a conversation you started writing and did not send
//             has no session behind it, so it is one line wearing a pencil.
//             Same rule-underneath treatment as pinned, for the same reason
//   pinned    above the scroll, so it stays where you left it, and unheaded:
//             a rule UNDER it divides it from the list, and each row wears a
//             pin rather than the band wearing a word
//   the list  no heading either — it is the list
//   SNOOZED   collapsed; work you deferred, soonest wake first
//   SETTLED   collapsed; work behind you
//
// — and Settings in the footer. The two shelves are RULES rather than rows (see
// `BandRule`), which is what stops a heading reading as another entry in the
// list it introduces. Their rules sit ON TOP because what they divide is above
// them; the pinned rule sits underneath for the same reason.
//
// WHAT IS NOT HERE, AND WHY. The donor's header also carried four nav glyphs —
// Overview, Projects, Looms, Workspace. Three are still out of scope, and a
// glyph that navigates nowhere is worse than a header without one. The Unread
// chip is gone because `readAt` is unmodelled, and a chip with an unbackable
// count is a lie with a number on it.
//
// THE FOURTH ARRIVED, AND THEN MOVED AGAIN. The donor's Workspace is this
// app's Spool. It first got a footer button beside Settings, because it read
// as a place rather than a filter over the list — but a place lived beside
// the wordmark all along without anyone naming it: "telar" WAS a place, the
// one this rail already showed. `docs/spool-loops.md` §11 names the two
// places and turns the wordmark into the switcher between them (see
// `PlaceSwitcher`), so the footer button retires — the switcher is chrome,
// not routing, and it occupies the switcher's OWN slot rather than adding a
// second door beside the one it replaces.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { configStateRoot, ensureConfigProject } from "@/lib/config-session";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  MoreHorizontalIcon,
  ChartNoAxesColumnIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SpoolIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { SpoolWarehouseNav } from "@/components/spool/warehouse-nav";
import { LoomsNav } from "@/components/loom/looms-nav";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { useCommandKeys } from "@/lib/use-command-keys";
import { DraftRow } from "@/components/session/draft-row";
import { DRAFTS_CHANGED_EVENT, listCanvasDrafts, writeDraft, type CanvasDraft } from "@/lib/composer-draft";
import {
  activeSessionFromPathname,
  bandOf,
  canvasHref,
  canvasProjectFromPathname,
  deriveSessionList,
  SESSION_PAGE_SIZE,
  SETTLED_PAGE_SIZE,
  sessionHref,
  sessionKey,
  toSidebarSession,
  type SidebarSession,
} from "@/lib/session-list";
import { hostFetcher } from "@/lib/hosts/client";
import type { PublicHost } from "@/lib/hosts/store";
import { readSidebarCache, rememberRows, staleRows, writeSidebarCache } from "@/lib/sidebar-cache";
import { LOCAL_HOST } from "@/lib/snapshot-cache";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
  type SidebarResizableOptions,
  type SidebarWidthProposal,
  useSidebar,
} from "@/components/ui/sidebar";
import { SessionRow } from "@/components/session/session-row";
import { ProjectAvatar } from "@/components/projects/project-avatar";
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
import { APP_SIDEBAR_MAIN_MIN_WIDTH, APP_SIDEBAR_STORAGE_KEY, keepsRoomForMain, SIDEBAR_RESIZE_MIN_WIDTH } from "@/lib/sidebar-width";
import { cn } from "@/lib/utils";

const api = createEngineApi();

const APP_SIDEBAR_RESIZABLE = {
  minWidth: SIDEBAR_RESIZE_MIN_WIDTH,
  storageKey: APP_SIDEBAR_STORAGE_KEY,
  shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }: SidebarWidthProposal) =>
    keepsRoomForMain(currentWidth, nextWidth, wrapper.getBoundingClientRect().width, APP_SIDEBAR_MAIN_MIN_WIDTH),
} satisfies SidebarResizableOptions;

/**
 * THIS ROW IS THE TITLEBAR on the macOS desktop shell.
 *
 * `app-drag` makes it move the window; `--titlebar-inset` reserves the width
 * the traffic lights float over, so the collapse trigger begins to their RIGHT
 * rather than underneath them. Both resolve to nothing in a browser tab (see
 * globals.css), which is why the same markup serves both.
 *
 * THE TWO CONTROLS OPT BACK OUT. A button inside a drag region does not get
 * clicked — it drags the window — and nothing about it looks broken while it
 * happens, which is the whole reason `app-no-drag` is spelled on each one
 * rather than assumed.
 */
function TelarSidebarHeader() {
  return (
    <SidebarHeader className="app-drag h-[var(--titlebar-height)] justify-center border-b border-sidebar-border/60 py-0 pr-2 pl-[calc(var(--titlebar-inset)+0.5rem)]">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger aria-label="Hide sidebar" title="Hide sidebar" className="app-no-drag shrink-0" />
        <PlaceSwitcher />
      </div>
    </SidebarHeader>
  );
}

/**
 * THE BRAND IS STATIC, THE SWITCHER IS A BUTTON BESIDE IT.
 *
 * This band sits under the macOS traffic lights — it is window decoration by
 * adjacency — and window decoration does not change with the route. The first
 * cut made the wordmark ITSELF the switcher, so the top-left of the window
 * read "telar" or "spool" or "looms" depending on where you were: the one
 * region that should never move, mutating on every navigation. Now the
 * wordmark is the app's name, capitalised, always "Telar" — and the places
 * live behind one small square button beside it, whose glyph never changes
 * either.
 *
 * THE MAIN AREA HAS A NAME OF ITS OWN NOW: "Sessions". It used to borrow
 * "Telar" in the switcher, which stopped working the moment "Telar" became
 * the static brand above it — an app cannot be one of its own places.
 *
 * Switching is CHROME, NOT ROUTING: picking a place navigates (`/`, `/looms`,
 * `/spool`), but a deep link still lands correctly on its own; the menu only
 * reads the pathname to decide which entry to check.
 */
function PlaceSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const inSpool = pathname.startsWith("/spool");
  // Looms is the third place — the milestone-shaped entry (objective →
  // threads → verify → human accept), per the default-path invariant in
  // docs/vision-2026-08.md.
  const inLooms = pathname.startsWith("/looms");

  return (
    <div className="mr-auto flex min-w-0 items-center gap-1 px-1.5">
      <span className="font-heading text-lg font-semibold tracking-tight">Telar</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Switch place"
              title="Switch place"
              className="app-no-drag flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/55 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <LayoutGridIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Place</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => router.push("/")}>
              <span className="w-4">{inSpool || inLooms ? null : <CheckIcon />}</span>
              <MessageSquareIcon className="size-4 shrink-0" />
              <span>Sessions</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/looms")}>
              <span className="w-4">{inLooms ? <CheckIcon /> : null}</span>
              <WorkflowIcon className="size-4 shrink-0" />
              <span>Looms</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/spool")}>
              <span className="w-4">{inSpool ? <CheckIcon /> : null}</span>
              <SpoolIcon className="size-4 shrink-0 text-spool" />
              <span>Spool</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * THE FILTER CHIPS ARE GONE, and with them the third place a session could
 * hide.
 *
 * All / Active / Archived cost a permanent row of chrome at the top of the rail
 * to offer three views of one list — and two of them were views the shelf
 * already gives you. "Archived" in particular was a slice of a lifecycle that
 * is itself being folded into settling: a session you are done with is settled,
 * and one you want gone is deleted. Two words for "off my list" is one too
 * many, and the chip was the surface that kept insisting they were different.
 *
 * What is left is the banded view that was always the default. Search still
 * flattens every band, which is the one thing the chips were genuinely for.
 */
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
      <p className="mt-1 text-[0.6875rem] leading-4">{detail}</p>
    </div>
  );
}

/**
 * A RULE, NOT A ROW.
 *
 * A shelf header used to look like the rows under it — same box, same hover — so
 * the boundary between "live" and "history" was carried entirely by a chevron.
 * t3 draws a line across the sidebar instead, which is why its Settled group
 * reads as the end of the list rather than as another entry in it.
 *
 * ONLY THE COLLAPSIBLE SHELVES USE THIS. The pinned band drew its own labelled
 * rule for one release and it was wrong twice over: the line sat ABOVE a block
 * that was already the top of the rail, so it divided nothing, and the word
 * "Pinned" named a state the rows can wear themselves. Both went; what is left
 * here is a control, so it is unconditionally a <button>.
 *
 * THE LABEL'S SCALE MATCHES THE SPOOL'S CAPTION — the web pass that shared
 * the two rails' grammar. `warehouse-nav.tsx`'s `CAPTION` (10px, semibold,
 * uppercase, tracking-wider) is the newer of the two section-caption
 * treatments this app has; this label used to sit at 11px, regular weight,
 * sentence case — a difference between two "small grey word beside a rule"
 * treatments with no reason beyond having been written on different days.
 * Everything else about the rule (the rule itself, the chevron, the count)
 * is unchanged — only the label's type scale moved.
 */
const CAPTION = "text-[0.625rem] font-semibold uppercase tracking-wider text-sidebar-foreground/45";

function BandRule({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-2 py-1.5 text-sidebar-foreground/45 hover:text-sidebar-foreground"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRightIcon className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      <span className={cn("shrink-0", CAPTION)}>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
      <span className="shrink-0 tabular-nums text-[0.6875rem]">{count}</span>
    </button>
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
  autoSettleAfterHours,
  onRefresh,
}: {
  label: string;
  count: number;
  rows: SidebarSession[];
  open: boolean;
  onToggle: () => void;
  hasMore?: boolean;
  onShowMore?: () => void;
  limit?: number;
  activeSessionId?: string;
  showProject: boolean;
  renderedAt: number;
  autoSettleAfterHours: number | null;
  onRefresh: () => void;
}) {
  if (count === 0) return null;
  return (
    <SidebarGroup className="pt-0">
      <BandRule label={label} count={count} open={open} onToggle={onToggle} />
      {open && (
        <SidebarGroupContent className="space-y-0.5">
          {(limit === undefined ? rows : rows.slice(0, limit)).map((session) => (
            <SessionRow
              key={sessionKey(session)}
              session={session}
              active={sessionKey(session) === activeSessionId}
              showProject={showProject}
              // A SHELF IS OFF THE LIST — history behind you or work deferred
              // ahead of you — so its rows give their space back, one dim line
              // each. See session-row.tsx for the two volumes.
              variant="slim"
              band={bandOf(session, { now: renderedAt, autoSettleAfterHours })}
              renderedAt={renderedAt}
              onRefresh={onRefresh}
            />
          ))}
          {hasMore && onShowMore && (
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
  // THE PLACE THIS RAIL'S BODY SHOWS — §11's warehouse nav on `/spool`, the
  // looms floor plan on `/looms`, Telar's own session list everywhere else.
  // The header above it (trigger, switcher) is common to all; only what is
  // below it changes.
  const inSpool = pathname.startsWith("/spool");
  const inLooms = pathname.startsWith("/looms");
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  /**
   * Started conversations with no session behind them yet.
   *
   * SEEDED EMPTY, LIKE `renderedAt` IS ZERO, and for the same reason: these live
   * in localStorage, which does not exist during the server render, so reading
   * them into the initial state would make the two renders disagree about what
   * is in the rail. The effect below fills them a tick later.
   */
  const [drafts, setDrafts] = useState<CanvasDraft[]>([]);
  /**
   * How long a quiet session stays in the list, from the ENGINE rather than
   * from this browser — so the desktop shell and a browser tab band the same
   * sessions the same way. See lib/inbox-policy.ts.
   */
  const { policy } = useInboxPolicy();
  const autoSettleAfterHours = policy.autoSettleAfterHours;
  // The server and first client render must use the same clock. Reading
  // Date.now() independently on each side crosses minute boundaries often
  // enough to produce a hydration mismatch and force React to regenerate the
  // whole persistent sidebar. Refresh this clock only when sidebar data does.
  const [renderedAt, setRenderedAt] = useState(0);
  const [scope, setScope] = useState<string>();
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  // Collapsed by default, like t3's: out of the way, never gone. The whole
  // point of snoozing is not to see these until they come back on their own.
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [settledLimit, setSettledLimit] = useState(SETTLED_PAGE_SIZE);
  const [unavailable, setUnavailable] = useState(false);
  /**
   * THE OTHER MACS, and which of them did not answer on the last read. The
   * book is re-read on every poll (it is one small local file) so a Mac
   * paired from Settings shows up on the next tick without a reload. A host
   * that is away keeps its name in the rail — a line under its last rows —
   * rather than vanishing, which would read as "those conversations are
   * gone" when they are merely out of reach.
   */
  const [hosts, setHosts] = useState<PublicHost[]>([]);
  const [unreachable, setUnreachable] = useState<Set<string>>(() => new Set());
  /** An away Mac's remembered rows, dimmed under its retry line. Filled by
   *  `loadAll` from the sidebar cache; empty for a host never read. */
  const [staleByHost, setStaleByHost] = useState<Map<string, SidebarSession[]>>(() => new Map());
  const searchInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  // On a phone the rail is a sheet OVER the content, so following a link has to
  // close it — otherwise the destination is behind the thing you just used.
  const onNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  /**
   * One Mac's rows: its projects, then one session read per project, in
   * parallel, because the engine lists sessions per project and this rail's
   * default scope is "all of them". `allSettled`, not `all`: one unreachable
   * project must not blank the whole list — the sessions that did answer are
   * still worth showing. Local and remote go through the same function; the
   * only difference is the fetcher, which decides which Mac answers.
   */
  const loadHost = useCallback(async (host: { id: string; name: string } | undefined) => {
    const hostApi = host ? createEngineApi(hostFetcher(host.id)) : api;
    const result = await hostApi.projects();
    const names = new Map(result.projects.map((project) => [project.id, project.name]));
    // The checkout's current branch, for the local sessions that share it —
    // they have no branch of their own. Derived per project by the engine.
    const branches = new Map(result.projects.map((project) => [project.id, project.branch]));
    const icons = new Map(result.projects.map((project) => [project.id, project.icon]));
    const pages = await Promise.allSettled(result.projects.map((project) => hostApi.sessions(project.id)));
    const sessions = pages.flatMap((page) =>
      page.status === "fulfilled"
        ? page.value.sessions.map((session) =>
            // A PROJECT-LESS SESSION IS NOT A ROW HERE. The rail is a
            // project-scoped list and the Spool's master chat is a
            // destination, not a conversation in it — the engine's reads
            // already exclude it, and this keeps that true if one ever
            // arrives by another path.
            toSidebarSession(
              session,
              session.projectId ? names.get(session.projectId) : undefined,
              session.projectId ? branches.get(session.projectId) : undefined,
              session.projectId ? icons.get(session.projectId) : undefined,
              host,
            ),
          )
        : [],
    );
    return { projects: result.projects, sessions };
  }, []);

  const loadAll = useCallback(async () => {
    // localStorage is synchronous and this runs off the render path, so the
    // cache is read fresh per pass rather than held in state — nothing else
    // writes it, and a stale copy here would be the one bug this feature has.
    const cache = typeof window === "undefined" ? {} : readSidebarCache();
    // The book first, and never fatal: a cockpit with no remotes (or one whose
    // pairing store is unreadable) is the ordinary local cockpit.
    const book = await api.hosts().then((answer) => answer.hosts).catch(() => [] as PublicHost[]);
    setHosts(book);
    const [local, ...remotes] = await Promise.allSettled([loadHost(undefined), ...book.map((host) => loadHost({ id: host.id, name: host.name }))]);
    if (local.status !== "fulfilled") {
      setUnavailable(true);
      // WHAT WAS THERE A MOMENT AGO, dimmed, rather than an empty rail. The
      // empty state below still speaks for a browser that never got a read in.
      const remembered = staleRows(cache, LOCAL_HOST);
      if (remembered.length > 0) {
        setSessions(remembered);
        // The bands need a clock; without one every remembered row would date
        // from the epoch and land on the settled shelf.
        setRenderedAt(Date.now());
      }
      return;
    }
    setUnavailable(false);
    setProjects(local.value.projects);
    const away = new Set<string>();
    const remoteSessions: SidebarSession[] = [];
    // Each Mac's last read, kept so a host going away dims its rows instead
    // of vanishing them. The local engine writes under LOCAL_HOST; every
    // remote writes under its own id — one host's rows never touch another's.
    let next = rememberRows(cache, LOCAL_HOST, local.value.sessions);
    remotes.forEach((page, index) => {
      const host = book[index]!;
      if (page.status === "fulfilled") {
        next = rememberRows(next, host.id, page.value.sessions);
        remoteSessions.push(...page.value.sessions);
      } else {
        away.add(host.id);
      }
    });
    writeSidebarCache(next);
    // A host that did not answer keeps its LAST rows, dimmed under its retry
    // line — read out of the cache on the pass that noticed it was away.
    const remembered = new Map<string, SidebarSession[]>();
    for (const id of away) {
      const rows = staleRows(cache, id);
      if (rows.length > 0) remembered.set(id, rows);
    }
    setStaleByHost(remembered);
    setUnreachable(away);
    setSessions([...local.value.sessions, ...remoteSessions]);
    setRenderedAt(Date.now());
  }, [loadHost]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadAll(), 0);
    // A registration from ANOTHER surface (first-run, the greeting's flow)
    // reaches this rail immediately rather than on the next poll tick.
    const onProjectsChanged = () => void loadAll();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onProjectsChanged);
    };
  }, [loadAll]);

  /**
   * Drafts, which are NOT POLLED — they are this browser's own, and the only
   * things that change them are in this document or another tab of it.
   *
   * `writeDraft` announces on every save, so a draft row appears while you are
   * still typing the first sentence and disappears the instant the message is
   * sent. `storage` covers the second tab, which never fires in the tab that
   * wrote and so cannot replace the announcement.
   */
  useEffect(() => {
    const reread = () => setDrafts(listCanvasDrafts());
    const task = window.setTimeout(reread, 0);
    window.addEventListener(DRAFTS_CHANGED_EVENT, reread);
    window.addEventListener("storage", reread);
    return () => {
      window.clearTimeout(task);
      window.removeEventListener(DRAFTS_CHANGED_EVENT, reread);
      window.removeEventListener("storage", reread);
    };
  }, []);

  /**
   * Sessions advance without a local action — a detached turn finishes, a title
   * is derived — and there is no cross-session event stream to subscribe to, so
   * the rail re-reads on a timer.
   *
   * IT CANNOT BE SLOWER THAN THE THING IT REPORTS. This was a flat 10s, chosen
   * when a row said nothing but a title and an age: a minute of staleness on
   * "1d ago" is invisible. A row that says "Working 3m" is a claim about right
   * now, and at 10s a turn that ran for fifteen seconds could start and finish
   * between two reads — the badge never appeared at all. Watched happen while
   * trying to photograph it.
   *
   * SO THE CADENCE FOLLOWS WHAT IS ON SCREEN. Anything live and it tightens to
   * 3s; an entirely quiet list goes back to 10s, because then it is a list of
   * titles again and this is N+1 requests over the project list.
   */
  const anyLive = sessions.some((session) => session.activity !== "idle");
  useEffect(() => {
    const timer = window.setInterval(() => void loadAll(), anyLive ? 3_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [loadAll, anyLive]);

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
  // The unscoped rail ALWAYS names each row's project — even with one project
  // registered. A previous cut hid it for a single project ("the same word
  // repeated is not information"), and it read as a bug every time: a row with
  // no project line looks unfiled, and the human checking "did this land in the
  // right project" gets no answer. Scoping to a project is the one state where
  // the name is genuinely redundant — the header already says it.
  const showProject = !selectedScope;

  const activeSessionId = activeSessionFromPathname(pathname);
  const list = deriveSessionList({
    sessions,
    ...(selectedScope ? { projectId: selectedScope } : {}),
    query,
    ...(activeSessionId ? { activeSessionId } : {}),
    now: renderedAt,
    autoSettleAfterHours,
    limit: sessionLimit,
    settledLimit,
  });
  // The engine is not answering AND the rail kept its last read — so the list
  // renders dimmed under a line saying so, and "Engine unavailable" is left for
  // the browser that has nothing cached to show instead.
  const showingStale = unavailable && sessions.length > 0;
  // The counting pass that badged the chips went with them: nothing displays a
  // total any more, and `deriveSessionList` was being run twice per render to
  // produce two numbers.
  const bandFor = (session: SidebarSession) => bandOf(session, { now: renderedAt, autoSettleAfterHours });

  /**
   * The draft rows, joined to the registry and narrowed the same way the list is.
   *
   * DROPPED WHEN THE PROJECT IS GONE. A draft outlives deregistration — nothing
   * cleans localStorage when a project leaves — and a row for a project the rail
   * cannot name would link to a canvas that 404s.
   *
   * SEARCHED RATHER THAN HIDDEN. The pinned band folds away under a query
   * because its rows reappear inside the flat result list; a draft is in no
   * result list, so hiding it would make the one thing you cannot find by title
   * also unfindable by text. Its text IS its title, so matching on that is the
   * same promise the session rows make.
   */
  const openCanvasProject = canvasProjectFromPathname(pathname);
  const needle = query.trim().toLocaleLowerCase();
  const draftRows = drafts
    .filter((draft) => (selectedScope ? draft.projectId === selectedScope : true))
    .filter((draft) => (needle ? draft.text.toLocaleLowerCase().includes(needle) : true))
    .map((draft) => ({ ...draft, projectName: projects.find((project) => project.id === draft.projectId)?.name }))
    .filter((draft) => draft.projectName !== undefined);
  const discardDraft = (projectId: string) => {
    // Straight to storage: the write announces, and this component re-reads its
    // own announcement like every other listener. One path in, one path out.
    writeDraft(undefined, projectId, "");
  };

  /**
   * ⌘N, ⌘T, ⌘1..⌘9 and ⌘, — mounted HERE because this is the one component
   * alive on every route that already holds both the session list and the
   * active session id, so the keys and the rows they index cannot disagree.
   *
   * The desktop menu has carried these accelerators the whole time; nothing in
   * this cockpit was listening for them, so they did nothing.
   */
  useCommandKeys(sessions, activeSessionId, autoSettleAfterHours);

  const selectedSearchIndex = list.sessions.length ? Math.min(searchIndex, list.sessions.length - 1) : -1;

  const resetPaging = () => {
    setSessionLimit(SESSION_PAGE_SIZE);
    setSettledLimit(SETTLED_PAGE_SIZE);
  };

  const selectScope = (next?: string) => {
    setScope(next);
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
    sessions.find((session) => sessionKey(session) === activeSessionId)?.projectId ??
    [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.projectId ??
    projects[0]?.id;

  const startSession = () => {
    onNavigate();
    router.push(composerProjectId ? canvasHref(composerProjectId) : "/");
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
      {/* THE WAY TO A SETTINGS SESSION, at the top where the other "start
          something" affordances are. It was buried as a tab inside Settings →
          Appearance, which put the general act — configure this Telar — inside
          one of the things it configures. */}
      <div className="px-2 pt-2">
        <SettingsSessionButton onNavigate={onNavigate} />
      </div>
      <SidebarContent>
        {/* THE SPOOL'S PLACE REPLACES THIS BODY, NOT THE SWITCHER ABOVE IT.
            §11's warehouse nav is what the rail shows on `/spool` — search,
            apertures, the Areas tree, lanes, tags — instead of the sessions
            list, which is Telar's own inbox and has no meaning inside the
            Spool's place. The header (trigger, switcher) stays common. */}
        {inSpool ? (
          <SpoolWarehouseNav />
        ) : inLooms ? (
          <LoomsNav />
        ) : (
        <>
        {/* THE SEARCH FIELD'S CHROME IS SHARED WITH THE SPOOL'S RAIL — see
            `sidebar-search-field.tsx`. This inset (px-2, matching the p-2
            every `SidebarGroup` below already carries) used to be px-3, one
            step wider than everything under it for no reason beyond the two
            areas having been built separately; the web pass that shared the
            search chrome brought the inset in line too. */}
        <div className="space-y-1 px-2 pb-2 pt-3">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <SidebarSearchField
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
                end={
                  query ? (
                    <button
                      type="button"
                      aria-label="Clear session search"
                      onClick={() => {
                        setQuery("");
                        setSearchIndex(0);
                      }}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : (
                    <kbd className="pointer-events-none font-sans text-[0.625rem] text-sidebar-foreground/35">⌘K</kbd>
                  )
                }
              />
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
                {selectedProject ? (
                  <ProjectAvatar
                    name={selectedProject.name}
                    projectId={selectedProject.id}
                    {...(selectedProject.icon ? { icon: selectedProject.icon } : {})}
                    size={14}
                  />
                ) : (
                  <FolderGit2Icon />
                )}
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
                        <ProjectAvatar
                          name={project.name}
                          projectId={project.id}
                          {...(project.icon ? { icon: project.icon } : {})}
                          size={14}
                        />
                        <span className="truncate">{project.name}</span>
                      </DropdownMenuItem>
                      {/* THIS project's settings. It went to the retired
                          `/projects` table — a glyph beside one project's name
                          that showed you all of them. */}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Settings for ${project.name}`}
                        title={project.root}
                        onClick={() => {
                          onNavigate();
                          router.push(`/projects/${encodeURIComponent(project.id)}/settings`);
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
        </div>

        {/*
          DRAFTS SIT ABOVE EVERYTHING, AND COST ONE LINE EACH.

          A conversation you started writing and walked away from used to leave
          no mark anywhere: the canvas mints no session until its first message,
          so the text was remembered — `composer-draft.ts` has always done that
          — and there was nowhere to see that it existed. You had to remember to
          go back to the same project's canvas. These rows are that memory.

          SMALLER THAN EVERY OTHER ROW, WHICH IS THE POINT. A draft is a
          sentence, not a session: no branch, no provider, no activity, nothing
          to report. `DraftRow` gives it a single line wearing a pencil, so a
          rail with three drafts in it still reads as a list of conversations
          with some scraps on top, rather than six sessions of two kinds.

          Unheaded with the rule underneath, exactly like pinned below: the
          boundary that exists is between these and what follows, and the glyph
          on each row says what the band would have said.
        */}
        {draftRows.length > 0 && (
          <SidebarGroup className="shrink-0 pb-0">
            <SidebarGroupContent className="space-y-0.5">
              {draftRows.map((draft) => (
                <DraftRow
                  key={draft.projectId}
                  projectId={draft.projectId}
                  projectName={draft.projectName}
                  text={draft.text}
                  active={draft.projectId === openCanvasProject}
                  showProject={showProject}
                  onNavigate={onNavigate}
                  onDiscard={() => discardDraft(draft.projectId)}
                />
              ))}
            </SidebarGroupContent>
            <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
          </SidebarGroup>
        )}

        {/*
          PINNED SITS ABOVE THE SCROLL, NOT INSIDE IT — which is what makes it
          stay put. `settledOverride: "active"` is the pin, and the point of
          pinning is that the row is where you left it: inside the scrolling
          list it would still be first, but "first" scrolls away.

          NOT COLLAPSIBLE, and not paged. Both shelves below hide rows you have
          finished with or deferred; this band holds the ones you said to keep
          in front of you, and a control that hides them would be arguing.
        */}
        {!list.flat && list.pinned.length > 0 && (
          <SidebarGroup className="shrink-0 pb-0">
            <SidebarGroupContent className="space-y-0.5">
              {list.pinned.map((session) => (
                <SessionRow
                  key={sessionKey(session)}
                  session={session}
                  active={sessionKey(session) === activeSessionId}
                  showProject={showProject}
                  variant="card"
                  band="pinned"
                  renderedAt={renderedAt}
                  onRefresh={() => void loadAll()}
                />
              ))}
            </SidebarGroupContent>
            {/*
              THE RULE GOES UNDER THE BAND, NOT OVER IT, AND CARRIES NO WORD.
              A line above a block that is already the top of the rail separates
              it from nothing — the boundary that exists is the one between these
              rows and the list below, so that is where the line belongs. The
              two shelves at the bottom are the opposite case: their rule sits on
              top because what it divides is above it.

              The "Pinned" heading went with it. The rows say so themselves now,
              with a glyph (see `session-row.tsx`), which also works in search
              results where this band does not exist.
            */}
            <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
          </SidebarGroup>
        )}

        {/*
          NO "RECENT" HEADING. It labelled the only unlabelled thing on the
          screen — the list itself — with a word that describes the sort order
          rather than naming a band, and it sat directly under a search field
          whose results it then had to relabel. The ruled headers below carry
          the structure; the list needs no title to be the list.
        */}
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupContent id="sidebar-session-results" role={query ? "listbox" : undefined} className="min-h-0 space-y-0.5 overflow-y-auto">
            {showingStale ? (
              <p className="px-2 pb-1 pt-0.5 text-[0.6875rem] leading-4 text-sidebar-foreground/55">
                The engine did not answer — retrying. Showing the last read.
              </p>
            ) : null}
            {unavailable && !showingStale ? (
              <SidebarEmpty icon={MessageSquareIcon} title="Engine unavailable" detail="Start the local engine, then this list refills itself." />
            ) : // A rail showing a remembered list has projects; it just could not
            // ask for them this pass, and the registry is the engine's to answer.
            !showingStale && projects.length === 0 ? (
              <SidebarEmpty icon={FolderPlusIcon} title="No projects yet" detail="Register a project to start a session." />
            ) : list.sessions.length === 0 &&
              // Empty only when nothing is anywhere. A rail whose every row is
              // pinned, snoozed or settled has plenty on it, and telling that
              // reader they have "No sessions yet" contradicts the four rows
              // they can see.
              (list.flat || !(list.settledCount || list.snoozedCount || list.pinned.length)) ? (
              <SidebarEmpty
                icon={MessageSquareIcon}
                title={query ? "No sessions found" : selectedScope ? "No sessions in this project" : "No sessions yet"}
                detail={query ? "Try another title or project." : "Start one from the button above."}
              />
            ) : (
              list.sessions.map((session, index) => (
                <SessionRow
                  key={sessionKey(session)}
                  session={session}
                  active={sessionKey(session) === activeSessionId}
                  showProject={showProject}
                  // A SEARCH RESULT IS ALREADY THE ANSWER to a question you
                  // asked, so every row in it is equally relevant and density
                  // beats detail — cards would make ten matches a scroll.
                  variant={query ? "slim" : "card"}
                  // Per row rather than per band, because this list is not one
                  // band: the survivor rule pulls the session you are READING
                  // out of a shelf and into it, and that row still needs the
                  // shelf's affordance — a snoozed one you are looking at
                  // offers Wake, not Snooze.
                  band={bandFor(session)}
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
            {/* A MAC THAT DID NOT ANSWER IS NAMED, NOT DROPPED. Its rows are
                simply absent from this read (the next tick retries), and a
                list that silently shrank would read as "those conversations
                are gone". One quiet line per away Mac says what happened. */}
            {hosts
              .filter((host) => unreachable.has(host.id))
              .map((host) => (
                <div key={host.id}>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[0.6875rem] text-muted-foreground" role="status">
                    <MonitorIcon className="size-3 shrink-0" />
                    <span className="min-w-0 truncate">{host.name} did not answer — retrying</span>
                  </div>
                  {/* THE LAST ROWS THAT MAC ANSWERED WITH, dimmed (each is
                      stamped `stale`, see sidebar-cache.ts) — under the line
                      that says why, rather than mixed into the live list with
                      a clock they cannot honour. */}
                  {(staleByHost.get(host.id) ?? []).map((session) => (
                    <SessionRow
                      key={sessionKey(session)}
                      session={session}
                      active={sessionKey(session) === activeSessionId}
                      showProject={showProject}
                      variant="slim"
                      band={bandFor(session)}
                      renderedAt={renderedAt}
                      onRefresh={() => void loadAll()}
                    />
                  ))}
                </div>
              ))}
          </SidebarGroupContent>
        </SidebarGroup>

        {/* The shelves exist only in the banded view. A search has already
            flattened everything it matched into the list above, so a second
            collapsed place for rows to hide would defeat it. */}
        {!list.flat && (
          <>
            {/* SNOOZED ABOVE SETTLED, because the two shelves face opposite
                directions: settled is behind you and snoozed is ahead of you,
                and the one that is coming back belongs nearer the live list. */}
            <SessionShelf
              label="Snoozed"
              count={list.snoozedCount}
              rows={list.snoozed}
              open={snoozedOpen}
              onToggle={() => setSnoozedOpen((open) => !open)}
              {...(activeSessionId ? { activeSessionId } : {})}
              showProject={showProject}
              renderedAt={renderedAt}
              autoSettleAfterHours={autoSettleAfterHours}
              onRefresh={() => void loadAll()}
            />
            <SessionShelf
              label="Settled"
              count={list.settledCount}
              rows={list.settled}
              // NOT forced open while it holds the session you are reading.
              // It used to be, so the open row stayed visible in the rail —
              // but that meant settling the conversation you were in sprang
              // the shelf open, which read as the settle bouncing back. The
              // cockpit's own settled banner (see composer.tsx) is what says
              // "you are inside settled history" now; the shelf opens only
              // when asked.
              open={settledOpen}
              onToggle={() => setSettledOpen((open) => !open)}
              hasMore={list.hasMoreSettled && settledLimit < list.settledCount}
              onShowMore={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)}
              limit={settledLimit}
              {...(activeSessionId ? { activeSessionId } : {})}
              showProject={showProject}
              renderedAt={renderedAt}
              autoSettleAfterHours={autoSettleAfterHours}
              onRefresh={() => void loadAll()}
            />
          </>
        )}
        </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <div className="p-1">
          <UsageButton onNavigate={onNavigate} />
          <SettingsButton onNavigate={onNavigate} />
        </div>
      </SidebarFooter>
    </>
  );
}

// `SpoolButton` RETIRED — §11. It lived here, in the footer beside Settings,
// because the Spool read as a place rather than a filter over the list. It
// still is one; the place just moved into `PlaceSwitcher`, at the top of the
// rail, where "telar" already was. See that component's docblock for why
// the switcher is where this button's job — and its "no count on it" law —
// went.

// The same slot the donor keeps it in: the sidebar's meta row, beside
// Settings — a place, not a filter over the session list.
function UsageButton({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname.startsWith("/usage");
  return (
    <Link
      href="/usage"
      title="Usage"
      onClick={onNavigate}
      className={`flex items-center gap-2 rounded-md text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
        active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : ""
      } w-full p-2`}
    >
      <ChartNoAxesColumnIcon className="size-4 shrink-0" />
      <span>Usage</span>
    </Link>
  );
}

/**
 * START A SESSION THAT CONFIGURES THIS TELAR.
 *
 * A normal session, in the engine's own state directory. The knowledge lives
 * in an AGENTS.md the engine writes there, so the agent is oriented by the
 * PLACE rather than by a brief this button would have to keep in sync.
 */
function SettingsSessionButton({ onNavigate }: { onNavigate: () => void }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const start = async () => {
    setBusy(true);
    try {
      const stateRoot = await configStateRoot();
      if (!stateRoot) return;
      const projectId = await ensureConfigProject(stateRoot);
      router.push(`/projects/${encodeURIComponent(projectId)}`);
      onNavigate();
    } catch {
      // No engine, no session; the button simply does not take.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy}
      title="Start a session that configures this Telar"
      className="flex w-full items-center gap-2 rounded-md p-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-60"
    >
      <SlidersHorizontalIcon className="size-4 shrink-0" />
      <span>{busy ? "Starting…" : "Settings session"}</span>
    </button>
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

export function AppSidebar() {
  return (
    <Sidebar collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE}>
      <SidebarBody />
      <AppSidebarRail />
    </Sidebar>
  );
}
