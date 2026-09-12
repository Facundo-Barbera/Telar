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
//   pinned    FIRST INSIDE THE SCROLL, and unheaded: a rule UNDER it divides
//             it from the rest of the list, and each row wears a pin rather
//             than the band wearing a word
//   the list  no heading either — it is the list
//   SNOOZED   collapsed; work you deferred, soonest wake first
//   SETTLED   collapsed; work behind you
//
// — and Settings in the footer. The two shelves are RULES rather than rows (see
// `BandRule`), which is what stops a heading reading as another entry in the
// list it introduces. Their rules sit ON TOP because what they divide is above
// them; the pinned rule sits underneath for the same reason.
//
// PINNED USED TO SIT ABOVE THE SCROLL and no longer does. Holding it out of the
// scrolling box kept it on screen, which sounds like what pinning is for — but
// it also meant a rail with six pinned conversations spent six rows of fixed
// height on them and scrolled everything else through what was left. Pinning
// says "keep these together at the top", not "nail these to the window", so
// the band is now the first thing INSIDE the scroll: still first, and it
// travels with the list. No sticky — a row that detaches from its own band
// while you scroll past it is a third behaviour nobody asked for.
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
import { usePathname, useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  FoldVerticalIcon,
  SlidersHorizontalIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import { AppSidebarFooterRow } from "@/components/app-sidebar-footer";
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
  relatedWork,
  SESSION_PAGE_SIZE,
  SETTLED_PAGE_SIZE,
  sessionHref,
  sessionKey,
  toSidebarSession,
  windowFor,
  type SessionBand,
  type SidebarSession,
} from "@/lib/session-list";
import { hostFetcher } from "@/lib/hosts/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { createFollowingController, emptyFollowing, lockKey, type FollowingController, type FollowingState } from "@/lib/following";
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
import { followedSessions, RelatedWork } from "@/components/session/related-work";
import { ProjectGroupSection } from "@/components/session/project-group";
import {
  dedupeAcrossHosts,
  groupSessions,
  moveProjectGroup,
  moveProjectGroupStep,
  PROJECT_GROUP_MIME,
  railRowsForCommandKeys,
  useCollapsedGroups,
  withholdFollowedRows,
} from "@/lib/session-groups";
import { useSidebarLayout } from "@/lib/sidebar-layout";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
    // The inset is measured from the island's edge, never less than the 8px
    // this header had before. Vertically: the lights are centred at
    // --titlebar-height/2 from the WINDOW top (window-chrome.js), and
    // --titlebar-band-height is what puts this band's centre back on theirs
    // once the island has pushed it down.
    <SidebarHeader className="app-drag h-[var(--titlebar-height)] justify-center rounded-t-lg border-b border-sidebar-border/60 py-0 pr-2 pl-[max(8px,var(--titlebar-inset))] md:h-[var(--titlebar-band-height)]">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarTrigger aria-label="Hide sidebar" title="Hide sidebar" className="app-no-drag shrink-0" />
        {/* NO PLACE SWITCHER. Sessions are the product; Spool and Looms keep
            their routes and data but are not offered from the main rail. */}
        <span className="px-1.5 font-heading text-lg font-semibold tracking-tight">Telar</span>
      </div>
    </SidebarHeader>
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
  bandFor,
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
  /** The list's own banding — one function, so a shelf cannot band a row
   *  differently from the list that put it there (a paired Mac's row is
   *  banded by that Mac's clock; see `windowFor`). */
  bandFor: (session: SidebarSession) => SessionBand;
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
              band={bandFor(session)}
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

/** A paired Mac's project, with the Mac it lives on — what the New menu lists. */
type RemoteProject = Pick<Project, "id" | "name" | "icon"> & { hostId: string; hostName: string };

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
  /** The register dialog, when something OTHER than its own button asked for it
   *  — the rail's empty-space menu. Its trigger still works on its own. */
  const [registeringProject, setRegisteringProject] = useState(false);
  const { collapsed: collapsedGroups, toggle: toggleGroup, collapseOthers, collapseAll, expandAll } = useCollapsedGroups();
  /**
   * WHERE EACH PROJECT GROUP SITS, from the engine — so the desktop shell, a
   * browser tab and a paired phone draw the same arrangement. The fold state
   * above stays per window; the order is about the work. See lib/sidebar-layout.ts.
   */
  const { order: projectOrder, setOrder: setProjectOrder } = useSidebarLayout();
  /** The group being carried, and where it would land. Owned here rather than
   *  by the group, because a drop lands on a DIFFERENT group than the one that
   *  started the drag. */
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupInsert, setGroupInsert] = useState<{ key: string; position: "above" | "below" } | null>(null);
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
  /**
   * THE OTHER MACS' PROJECTS, so a conversation can be STARTED over there.
   * Their sessions have always sat in this rail; their canvases did not —
   * the New button only ever opened a local project's, which left "start
   * something on the mini" with no button at all. Read on every pass beside
   * the sessions; a Mac that is this Mac contributes nothing here.
   */
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  /** Each Mac's own settling window, read with its rows — keyed like the
   *  sidebar cache (LOCAL_HOST for this engine). See `loadHost`. */
  const [hostWindows, setHostWindows] = useState<Map<string, number | null>>(() => new Map());
  /** An away Mac's remembered rows, dimmed under its retry line. Filled by
   *  `loadAll` from the sidebar cache; empty for a host never read. */
  const [staleByHost, setStaleByHost] = useState<Map<string, SidebarSession[]>>(() => new Map());
  const searchInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const loadAllRunning = useRef(false);

  // On a phone the rail is a sheet OVER the content, so following a link has to
  // close it — otherwise the destination is behind the thing you just used.
  const onNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  /**
   * One Mac's rows: the aggregate live-session read plus the project registry.
   * This used to ask for sessions once per project on every poll; on a machine
   * with several projects or a remote host, the rail itself became background
   * traffic. The aggregate route keeps the list one read per Mac.
   */
  const loadHost = useCallback(async (host: { id: string; name: string } | undefined) => {
    /**
     * ALWAYS AN EXPLICIT HOST, INCLUDING THE LOCAL ONE.
     *
     * The fallback used to be the pathname-following `api`, which reaches
     * whichever engine the current URL names. So while a person was VIEWING a
     * remote Mac, the read meant to fetch local rows went to the remote engine —
     * and its answers were then cached and deduplicated under the local host's
     * identity. Naming `LOCAL_HOST_ID` makes the destination a property of the
     * host being loaded rather than of the page being looked at.
     */
    const hostApi = createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID));
    // The engine's identity rides beside its rows, so two reads that reached
    // ONE engine (a Mac paired with itself, or under two addresses) can be
    // folded into one — see `dedupeAcrossHosts`. Best-effort: a health that
    // fails leaves the rows undeduplicated rather than dropped.
    //
    // ITS SETTLING WINDOW COMES WITH IT. A row is banded by the clock of the
    // engine it lives on — the inbox policy is that engine's document — so a
    // paired Mac's "72 hours" cannot shelve a row this Mac's "off" would keep,
    // which is how a conversation read as settled here and live over there.
    const [result, daemonId, policy] = await Promise.all([
      hostApi.liveSessions(),
      hostApi.health().then((health) => health.daemonId, () => undefined),
      hostApi.inbox().then((answer) => answer.inbox, () => undefined),
    ]);
    const names = new Map(result.projects.map((project) => [project.id, project.name]));
    // The checkout's current branch, for the local sessions that share it —
    // they have no branch of their own. Derived per project by the engine.
    const branches = new Map(result.projects.map((project) => [project.id, project.branch]));
    const icons = new Map(result.projects.map((project) => [project.id, project.icon]));
    const sessions = result.sessions.map((session) =>
      // A PROJECT-LESS SESSION IS NOT A ROW HERE. The rail is a
      // project-scoped list and the Spool's master chat is a destination, not a
      // conversation in it — the aggregate route already excludes it, and this
      // keeps that true if one ever arrives by another path.
      toSidebarSession(
        session,
        session.projectId ? names.get(session.projectId) : undefined,
        session.projectId ? branches.get(session.projectId) : undefined,
        session.projectId ? icons.get(session.projectId) : undefined,
        host,
        // Folded by the ENGINE over each session's whole queue and sent on this
        // same list — so Related work costs no extra request, and no per-row
        // history read, on any polling pass.
        result.assignments?.[session.id],
      ),
    );
    return { projects: result.projects, sessions, ...(daemonId ? { daemonId } : {}), ...(policy ? { policy } : {}) };
  }, []);

  const loadAll = useCallback(async () => {
    if (loadAllRunning.current) return;
    loadAllRunning.current = true;
    try {
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
      const reads: { daemonId?: string; sessions: SidebarSession[] }[] = [local.value];
      const remoteProjects: RemoteProject[] = [];
      const windows = new Map<string, number | null>();
      if (local.value.policy) windows.set(LOCAL_HOST, local.value.policy.autoSettleAfterHours);
      // Each Mac's last read, kept so a host going away dims its rows instead
      // of vanishing them. The local engine writes under LOCAL_HOST; every
      // remote writes under its own id — one host's rows never touch another's.
      let next = rememberRows(cache, LOCAL_HOST, local.value.sessions);
      remotes.forEach((page, index) => {
        const host = book[index]!;
        if (page.status === "fulfilled") {
          next = rememberRows(next, host.id, page.value.sessions);
          reads.push(page.value);
          if (page.value.policy) windows.set(host.id, page.value.policy.autoSettleAfterHours);
          // A paired Mac that is THIS Mac offers nothing the local list does
          // not; its projects are the local ones, reachable without the hop.
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
      // A host that did not answer keeps its LAST rows, dimmed under its retry
      // line — read out of the cache on the pass that noticed it was away.
      const remembered = new Map<string, SidebarSession[]>();
      for (const id of away) {
        const rows = staleRows(cache, id);
        if (rows.length > 0) remembered.set(id, rows);
      }
      setStaleByHost(remembered);
      setUnreachable(away);
      setSessions(dedupeAcrossHosts(reads));
      setRenderedAt(Date.now());
    } finally {
      loadAllRunning.current = false;
    }
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
    windowsByHost: hostWindows,
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
  const bandFor = (session: SidebarSession) => bandOf(session, { now: renderedAt, autoSettleAfterHours: windowFor(session, autoSettleAfterHours, hostWindows) });
  // The Work surface's arrangement of the same page: a pure regrouping of
  // `list`, so paging, search and scope are untouched. Only in the banded view;
  // a search stays flat. The groups sit in the reader's own order — nothing a
  // conversation does moves its project.
  const grouped = list.flat ? undefined : groupSessions(list, projectOrder);
  /**
   * Every row the rail currently holds — the candidate pool `relatedWork`
   * searches. Built from the bands the list already produced, so finding a
   * coordinator's delegates costs no request.
   */
  const relatedPool = [...list.pinned, ...list.sessions, ...list.snoozed, ...list.settled];

  /**
   * WHO EACH PINNED SESSION FOLLOWS, keyed by `sessionKey`.
   *
   * READ FOR PINNED SESSIONS ONLY, and only when that set changes — not on
   * every polling tick and never per row of the list. Pinned is the handful a
   * person keeps in view, so this is a bounded read rather than an N+1 over
   * every session the rail holds.
   *
   * HOST-PINNED: each read goes to the Mac that session lives on, so viewing a
   * remote rail never asks the local engine about a remote session.
   */
  const [followState, setFollowState] = useState<FollowingState>(emptyFollowing);
  const [unfollowing, setUnfollowing] = useState<ReadonlySet<string>>(() => new Set());
  const [unfollowFailed, setUnfollowFailed] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Owns generations, locks and the read epoch — outside React.
   *
   * A LAZY `useState` INITIALISER, not a ref written during render: it runs once
   * for the component's life and the value is never reassigned, which is what
   * makes reading it during render legitimate rather than a rule waived.
   */
  const [follow] = useState<FollowingController>(() => createFollowingController(setFollowState));
  const pinnedForFollow = grouped ? grouped.pinned : list.pinned;
  const pinnedKeys = pinnedForFollow.map((session) => sessionKey(session)).join("|");

  useEffect(() => {
    const controller = follow;
    // The pinned set changed: any read still in flight describes the old one.
    controller.bump();
    const sessions = pinnedForFollow.map((session) => ({
      id: session.id,
      ...(session.hostId ? { hostId: session.hostId } : {}),
      key: sessionKey(session),
    }));
    const tick = () =>
      void controller.read(sessions, async (session) => {
        const hostApi = createEngineApi(hostFetcher(session.hostId ?? LOCAL_HOST_ID));
        return (await hostApi.sessionSubscriptions(session.id)).subscriptions;
      });
    tick();
    // An agent can add, remove or consume a `once` subscription while the same
    // coordinators stay pinned, which a set-keyed read alone never notices.
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearInterval(timer);
      controller.bump();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the pinned SET
  }, [pinnedKeys]);

  /**
   * THE PROJECT GROUPS WITH THE FOLLOWED ROWS TAKEN OUT — issue #278.
   *
   * A pinned coordinator's "Following" block and the project groups were built
   * from the same pool with nothing reconciling them, so a followed session was
   * drawn twice. `withholdFollowedRows` is the rule; this is where it is applied,
   * and `followedSessions` is the SAME resolution the block itself renders from,
   * so the set that is hidden here is exactly the set that is shown there.
   *
   * SEARCH IS UNTOUCHED. A query flattens the rail — there are no groups and no
   * pinned band — and a result list that quietly dropped a match because
   * something follows it would break the one promise search makes.
   */
  const pinnedFollowing = pinnedForFollow.map((coordinator) => ({
    key: sessionKey(coordinator),
    title: coordinator.title,
    following: followedSessions(
      followState.byCoordinator.get(sessionKey(coordinator)),
      relatedPool,
      coordinator.hostId,
    ).map(({ session }) => sessionKey(session)),
  }));
  const drawnGroups = grouped ? withholdFollowedRows(grouped.groups, pinnedFollowing) : [];

  const [followFailed, setFollowFailed] = useState<ReadonlySet<string>>(() => new Set());

  /** Start following, through the controller: sync lock, visible failure. */
  const startFollow = useCallback(async (coordinator: SidebarSession, target: SidebarSession) => {
    const lock = lockKey(coordinator.hostId, coordinator.id, sessionKey(target));
    if (follow.locked(lock)) return;
    setUnfollowing((current) => new Set(current).add(lock));
    const outcome = await follow.follow(
      { id: coordinator.id, ...(coordinator.hostId ? { hostId: coordinator.hostId } : {}), key: sessionKey(coordinator) },
      { id: target.id, key: sessionKey(target) },
      async (session, targetSessionId) => {
        const hostApi = createEngineApi(hostFetcher(session.hostId ?? LOCAL_HOST_ID));
        await hostApi.follow(session.id, { targetSessionId });
      },
      async (session) => {
        const hostApi = createEngineApi(hostFetcher(session.hostId ?? LOCAL_HOST_ID));
        return (await hostApi.sessionSubscriptions(session.id)).subscriptions;
      },
    );
    setFollowFailed((current) => {
      const next = new Set(current);
      if (outcome.failed) next.add(lock);
      else next.delete(lock);
      return next;
    });
    setUnfollowing((current) => {
      const next = new Set(current);
      next.delete(lock);
      return next;
    });
  }, [follow]);

  const unfollow = useCallback(async (coordinator: SidebarSession, targetKey: string, subscriptionIds: readonly string[]) => {
    const lock = lockKey(coordinator.hostId, coordinator.id, targetKey);
    if (follow.locked(lock)) return;
    setUnfollowing((current) => new Set(current).add(lock));
    const outcome = await follow.unfollow(
      { id: coordinator.id, ...(coordinator.hostId ? { hostId: coordinator.hostId } : {}), key: sessionKey(coordinator) },
      targetKey,
      subscriptionIds,
      async (session, subscriptionId) => {
        const hostApi = createEngineApi(hostFetcher(session.hostId ?? LOCAL_HOST_ID));
        await hostApi.unfollow(subscriptionId, session.id);
      },
    );
    setUnfollowFailed((current) => {
      const next = new Set(current);
      if (outcome.failed) next.add(lock);
      else next.delete(lock);
      return next;
    });
    setUnfollowing((current) => {
      const next = new Set(current);
      next.delete(lock);
      return next;
    });
  }, [follow]);

  /**
   * DRAGGING A GROUP TO WHERE IT BELONGS. The header is the handle; a drop on
   * another group lands above or below it by which half the pointer was in.
   * The platform's own drag, no library (see `lib/drag-reference.ts`), and the
   * handlers are curried once here so each group receives bare references.
   */
  const onGroupDragStart = (key: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData(PROJECT_GROUP_MIME, key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingGroup(key);
  };
  const onGroupDragEnd = () => {
    setDraggingGroup(null);
    setGroupInsert(null);
  };
  const onGroupDragOver = (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PROJECT_GROUP_MIME)) return;
    if (draggingGroup === key) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setGroupInsert((current) => (current?.key === key && current.position === position ? current : { key, position }));
  };
  const onGroupDragLeave = (key: string) => () => setGroupInsert((current) => (current?.key === key ? null : current));
  const onGroupDrop = (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PROJECT_GROUP_MIME)) return;
    event.preventDefault();
    const dragged = event.dataTransfer.getData(PROJECT_GROUP_MIME) || draggingGroup;
    const position = groupInsert?.key === key ? groupInsert.position : "below";
    setDraggingGroup(null);
    setGroupInsert(null);
    if (!dragged || dragged === key || !grouped) return;
    // THE WHOLE DRAWN ORDER IS WRITTEN, not just the moved group: every group on
    // screen keeps the place it had, and a group nobody had placed yet is
    // placed by this drop rather than left to drift.
    void setProjectOrder(moveProjectGroup(projectOrder, drawnGroupKeys, dragged, key, position));
  };

  /**
   * THE GROUPS AS DRAWN, which is what every group gesture is measured against
   * — the fold-all verbs, "collapse others" and the menu's one-step reorder
   * alike. Spelled once here so a menu row and a drop cannot disagree about
   * which keys are on screen; see `foldedAfter` and `moveProjectGroupStep` for
   * why neither takes the stored list instead.
   */
  const drawnGroupKeys = drawnGroups.map((group) => group.key);
  /** The same write the drag makes, one place at a time. `undefined` at either
   *  end of the list, which is what disables the menu row. */
  const moveGroup = (key: string, direction: "up" | "down") => {
    const next = moveProjectGroupStep(projectOrder, drawnGroupKeys, key, direction);
    return next && (() => void setProjectOrder(next));
  };

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
   * alive on every route that already draws the rows the number keys count.
   *
   * THE KEYS COUNT WHAT IS ON SCREEN, top to bottom: the "Needs you" band,
   * pinned, then each project group in the reader's own order, folded groups
   * skipped. They used to count the flat list by creation time, which stopped
   * being the order on screen the day the groups landed. A search flattens the
   * rail, so under a query they count the results instead.
   *
   * The desktop menu has carried these accelerators the whole time; nothing in
   * this cockpit was listening for them, so they did nothing.
   */
  // THE GROUPS AS DRAWN, withheld rows and all: a number key that selected a row
  // its project group is no longer showing would count something invisible.
  useCommandKeys(grouped ? railRowsForCommandKeys({ ...grouped, groups: drawnGroups }, collapsedGroups) : list.sessions.slice(0, 9));

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
  /**
   * ON WHICHEVER MAC THAT PROJECT IS. The guess used to drop the host, so a
   * reader looking at a conversation on the mini pressed New and landed on a
   * canvas for a project of the same id on THIS Mac — or, when the id did not
   * exist here, on a canvas that could never send. The session you are reading
   * carries its host; the guess carries it too.
   */
  const composerTarget: { projectId: string; hostId?: string } | undefined = (() => {
    if (selectedScope) return { projectId: selectedScope };
    const active = sessions.find((session) => sessionKey(session) === activeSessionId);
    if (active?.projectId) return { projectId: active.projectId, ...(active.hostId ? { hostId: active.hostId } : {}) };
    const recent = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt).find((session) => session.projectId);
    if (recent?.projectId) return { projectId: recent.projectId, ...(recent.hostId ? { hostId: recent.hostId } : {}) };
    if (projects[0]) return { projectId: projects[0].id };
    const remote = remoteProjects[0];
    return remote ? { projectId: remote.id, hostId: remote.hostId } : undefined;
  })();
  const composerProjectId = composerTarget?.projectId;

  const startSession = (target = composerTarget) => {
    onNavigate();
    router.push(target ? canvasHref(target.projectId, target.hostId) : "/");
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
      {/* The "Settings session" entry was removed from the product UI: it did
          not work reliably and duplicated the real Settings (in the footer). */}
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
            {/* A PRESS OPENS THE GUESS; A LONG PRESS (or right-click) PICKS THE
                MAC. One paired Mac and the whole choice is "here or there",
                which is exactly what was missing: there was no way to say
                "start this on the mini" without first finding one of its
                conversations. No paired Mac and the menu never appears — the
                button is the button it always was. */}
            {remoteProjects.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label="New conversation"
                      title="New conversation — choose where"
                    />
                  }
                >
                  <MessageSquarePlusIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-64">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>On this Mac</DropdownMenuLabel>
                    {projects.map((project) => (
                      <DropdownMenuItem key={project.id} onClick={() => startSession({ projectId: project.id })}>
                        <ProjectAvatar name={project.name} projectId={project.id} {...(project.icon ? { icon: project.icon } : {})} size={14} />
                        <span className="truncate">{project.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {projects.length === 0 && <DropdownMenuItem disabled>No projects here yet</DropdownMenuItem>}
                  </DropdownMenuGroup>
                  {hosts
                    .filter((host) => remoteProjects.some((project) => project.hostId === host.id))
                    .map((host) => (
                      <DropdownMenuGroup key={host.id}>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="flex items-center gap-1.5">
                          <MonitorIcon className="size-3" /> On {host.name}
                        </DropdownMenuLabel>
                        {remoteProjects
                          .filter((project) => project.hostId === host.id)
                          .map((project) => (
                            <DropdownMenuItem key={`${host.id}:${project.id}`} onClick={() => startSession({ projectId: project.id, hostId: host.id })}>
                              <ProjectAvatar name={project.name} size={14} />
                              <span className="truncate">{project.name}</span>
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuGroup>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="New conversation"
                title={composerProjectId ? "New conversation" : "Register a project first"}
                onClick={() => startSession()}
              >
                <MessageSquarePlusIcon />
              </Button>
            )}
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
                        title={`Project settings for ${project.name}`}
                        onClick={() => {
                          onNavigate();
                          router.push(`/projects/${encodeURIComponent(project.id)}/settings`);
                        }}
                      >
                        <SlidersHorizontalIcon />
                      </Button>
                    </div>
                  ))}
                  {selectedProject && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => {
                          onNavigate();
                          router.push(`/projects/${encodeURIComponent(selectedProject.id)}/settings`);
                        }}
                      >
                        <SlidersHorizontalIcon />
                        Project settings
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RegisterProjectDialog
              onRegistered={() => void loadAll()}
              compact
              open={registeringProject}
              onOpenChange={setRegisteringProject}
            />
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
          "NEEDS YOU" IS THE ONE BAND THAT STAYS ABOVE THE SCROLL — pinned used
          to keep it company and no longer does (see the note at the top of this
          file). The difference is who chose: you pin a conversation, so pinning
          can mean "first" and let it travel with the list, but nobody asks to be
          blocked. A blocked row is the engine saying it cannot continue without
          you, and scrolling that out of sight is how it gets missed.

          NOT COLLAPSIBLE, and not paged, for the same reason.
        */}
        {grouped && grouped.attention.length > 0 && (
          <SidebarGroup className="shrink-0 pb-0">
            <div className={cn("flex items-center gap-2 px-2 pb-1", CAPTION)}>
              <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
              <span>Needs you</span>
              <span className="ml-auto tabular-nums">{grouped.attention.length}</span>
            </div>
            <SidebarGroupContent className="space-y-0.5" role="group" aria-label="Needs you">
              {grouped.attention.map((session) => (
                <SessionRow
                  key={sessionKey(session)}
                  session={session}
                  active={sessionKey(session) === activeSessionId}
                  showProject={showProject}
                  variant="card"
                  band={bandFor(session)}
                  renderedAt={renderedAt}
                  onRefresh={() => void loadAll()}
                />
              ))}
            </SidebarGroupContent>
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
          {/*
            THE RAIL'S OWN MENU, ON THE SPACE BELOW THE LAST GROUP.

            The two verbs at the top of the rail — start a conversation, register
            a project — are a scroll away once the list is long, and the fold-all
            pair had no control anywhere. Right-clicking the list is where a
            person looks for exactly these.

            IT WRAPS THE WHOLE SCROLL AREA AND STILL ONLY FIRES ON THE EMPTY
            PART. Base UI's trigger stops the `contextmenu` event it handles
            (`stopEvent`), so a right-press on a session row or a project header
            is claimed by that row's own trigger and never reaches this one —
            the innermost menu wins, which is the platform's own rule and the
            reason this needs no hit-testing of its own.

            THE TRIGGER IS THE FLEX-FILLING BOX, NOT A `contents` WRAPPER, AND
            THE DIFFERENCE IS THE ENTIRE FEATURE. The rows only reach as far as
            the last group; the space BELOW them — the part this menu exists for
            — belongs to this group's own box. A `contents` trigger paints
            nothing, is never an event target, and so covered exactly the strip
            that already had menus of its own and none of the strip that had
            none. Taking the group's `min-h-0 flex-1` gives the trigger the
            empty space itself.
          */}
          <ContextMenu>
            <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
          <SidebarGroupContent id="sidebar-session-results" role={query ? "listbox" : undefined} className="min-h-0 space-y-0.5 overflow-y-auto">
            {showingStale ? (
              <p className="px-2 pb-1 pt-0.5 text-[0.6875rem] leading-4 text-sidebar-foreground/55">
                The engine did not answer — retrying. Showing the last read.
              </p>
            ) : null}

            {/*
              PINNED, FIRST INSIDE THE SCROLL AND TRAVELLING WITH IT.

              `settledOverride: "active"` is the pin. It sits above every project
              group and below nothing but the line that explains a stale read —
              that line is chrome about the whole list rather than an entry in
              it, so putting rows above it would leave it captioning the wrong
              thing.

              OUTSIDE THE CONDITIONAL CHAIN BELOW, deliberately: that chain
              chooses between the empty states and the groups, and pinned rows
              are none of those. The "No sessions yet" arm already counts
              `list.pinned` before claiming the rail is empty, so a rail whose
              every row is pinned says nothing of the kind.

              NOT COLLAPSIBLE, and not paged. Both shelves at the bottom hide
              rows you have finished with or deferred; this band holds the ones
              you said to keep in front of you, and a control that hides them
              would be arguing.
            */}
            {!list.flat && (grouped ? grouped.pinned : list.pinned).length > 0 && (
              <div className="space-y-0.5" role="group" aria-label="Pinned">
                {/* One fragment per coordinator: its row, then what it delegated.
                    Two maps would put every related block after every row. */}
                {(grouped ? grouped.pinned : list.pinned).map((session) => (
                  <div key={sessionKey(session)} className="space-y-0.5">
                    <SessionRow
                      session={session}
                      active={sessionKey(session) === activeSessionId}
                      showProject={showProject}
                      variant="card"
                      band="pinned"
                      renderedAt={renderedAt}
                      onRefresh={() => void loadAll()}
                    />
                    <RelatedWork
                      groups={relatedWork(relatedPool, session)}
                      coordinatorId={session.id}
                      {...(session.hostId ? { coordinatorHostId: session.hostId } : {})}
                      {...(followState.byCoordinator.get(sessionKey(session))
                        ? { following: followState.byCoordinator.get(sessionKey(session)) }
                        : {})}
                      followed={relatedPool}
                      onUnfollow={(targetKey, subscriptionIds) => void unfollow(session, targetKey, subscriptionIds)}
                      onFollow={(target) => void startFollow(session, target)}
                      followFailed={followFailed}
                      lockFor={(targetKey) => lockKey(session.hostId, session.id, targetKey)}
                      unfollowing={unfollowing}
                      unfollowFailed={unfollowFailed}
                    />
                  </div>
                ))}
                {/*
                  THE RULE GOES UNDER THE BAND, NOT OVER IT, AND CARRIES NO WORD.
                  A line above a block that is already the top of the list
                  separates it from nothing — the boundary that exists is the one
                  between these rows and the groups below, so that is where the
                  line belongs. The two shelves at the bottom are the opposite
                  case: their rule sits on top because what it divides is above it.

                  The "Pinned" heading went with it. The rows say so themselves
                  now, with a glyph (see `session-row.tsx`), which also works in
                  search results where this band does not exist.
                */}
                <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
              </div>
            )}

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
            ) : grouped ? (
              drawnGroups.map((group) => {
                /**
                 * THE REGISTRY'S PATH, AND ONLY THIS MAC'S. A paired Mac's
                 * project is read as an id and a name; its checkout is over
                 * there, and handing this Mac's same-named folder to Finder
                 * would reveal the wrong one. `workspaceOpenBlocker` refuses it
                 * a second time inside the group, on the host id.
                 */
                const root = group.hostId ? undefined : projects.find((project) => project.id === group.projectId)?.root;
                const moveUp = moveGroup(group.key, "up");
                const moveDown = moveGroup(group.key, "down");
                return (
                  <ProjectGroupSection
                    key={group.key}
                    group={group}
                    open={!collapsedGroups.has(group.key)}
                    onToggle={() => toggleGroup(group.key)}
                    onNavigate={onNavigate}
                    {...(activeSessionId ? { activeSessionId } : {})}
                    renderedAt={renderedAt}
                    bandFor={bandFor}
                    onRefresh={() => void loadAll()}
                    dragging={draggingGroup === group.key}
                    insert={groupInsert?.key === group.key ? groupInsert.position : null}
                    onDragStart={onGroupDragStart(group.key)}
                    onDragEnd={onGroupDragEnd}
                    onDragOver={onGroupDragOver(group.key)}
                    onDragLeave={onGroupDragLeave(group.key)}
                    onDrop={onGroupDrop(group.key)}
                    {...(root ? { root } : {})}
                    // The `+` beside the header, as a menu row: one canvas
                    // route, reached two ways.
                    onNewConversation={() => startSession({ projectId: group.projectId, ...(group.hostId ? { hostId: group.hostId } : {}) })}
                    {...(group.hostId
                      ? {}
                      : {
                          onProjectSettings: () => {
                            onNavigate();
                            router.push(`/projects/${encodeURIComponent(group.projectId)}/settings`);
                          },
                        })}
                    onCollapseOthers={() => collapseOthers(group.key, drawnGroupKeys)}
                    {...(moveUp ? { onMoveUp: moveUp } : {})}
                    {...(moveDown ? { onMoveDown: moveDown } : {})}
                  />
                );
              })
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
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              {/* The same canvas the New button above opens, with the same
                  project guess behind it — `startSession` and `composerTarget`,
                  unchanged. */}
              <ContextMenuItem disabled={!composerTarget} onClick={() => startSession()}>
                <MessageSquarePlusIcon />
                New conversation
              </ContextMenuItem>
              {/* The `+` beside the project picker, as a row: the SAME dialog,
                  so there is still exactly one registration path and one
                  `chooseDirectory` call in the app. */}
              <ContextMenuItem onClick={() => setRegisteringProject(true)}>
                <FolderPlusIcon />
                New project
              </ContextMenuItem>
              {/* Folds only the groups ON SCREEN — see `foldedAfter`. A rail
                  showing search results has none, so both rows stand down
                  rather than writing a fold nobody can see undone. */}
              <ContextMenuSeparator />
              <ContextMenuItem disabled={drawnGroupKeys.length === 0} onClick={() => collapseAll(drawnGroupKeys)}>
                <FoldVerticalIcon />
                Collapse all projects
              </ContextMenuItem>
              <ContextMenuItem disabled={drawnGroupKeys.length === 0} onClick={() => expandAll(drawnGroupKeys)}>
                <UnfoldVerticalIcon />
                Expand all
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
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
              bandFor={bandFor}
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
              bandFor={bandFor}
              onRefresh={() => void loadAll()}
            />
          </>
        )}
        </>
        )}
      </SidebarContent>

      <SidebarFooter>
        {/* The compact icon footer — Usage and Settings left, the app-update
            control right. Its whole implementation, including the updater
            state machine, lives in components/app-sidebar-footer.tsx. */}
        <AppSidebarFooterRow onNavigate={onNavigate} />
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

// `UsageButton` / `SettingsButton` moved into app-sidebar-footer.tsx as icon
// buttons (the words live on in tooltips and aria-labels), joined on the
// right by the shell's update control.

function AppSidebarRail() {
  const { open } = useSidebar();
  // THE IDLE LINE GOES. The primitive draws a faint 2px hairline down the rail
  // at rest (`after:bg-sidebar-border/25`) — the old rail/content divider,
  // which now sits in the gutter between two ringed islands and reads as a
  // leftover. Transparent until hovered or focused; the 16px hit target and
  // the hover/focus stroke are untouched.
  return open ? <SidebarRail className="after:bg-transparent" /> : null;
}

/** The rail's body without its `<Sidebar>` frame — for the dev workspace
 *  preview, which mounts it inside a static column under its own titlebar. */
export { SidebarBody as AppSidebarBody };

export function AppSidebar() {
  return (
    // `floating`: the rail is an island (see app-shell.tsx). The primitive pads
    // the fixed container 8px and rounds/rings the inner card.
    // The primitive's `floating` padding is `p-2` — rem, and this gutter is
    // where the lights float, so it holds in px. Desktop only by construction:
    // the mobile Sheet branch drops `className` and hardcodes `p-0`.
    <Sidebar variant="floating" collapsible="offcanvas" resizable={APP_SIDEBAR_RESIZABLE} className="p-[var(--app-island-inset)]">
      <SidebarBody />
      <AppSidebarRail />
    </Sidebar>
  );
}
