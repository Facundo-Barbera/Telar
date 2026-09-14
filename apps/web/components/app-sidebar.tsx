"use client";

// The app sidebar, ported from the frozen app's components/app-sidebar.tsx.
//
// STRUCTURE, TOP TO BOTTOM: a 56px header with the collapse trigger and the
// wordmark; a search field wearing its ⌘K hint, with reveal / add-project /
// new-conversation in one pill beside it; then the five bands —
//
// NO PROJECT FILTER ANYWHERE IN THAT HEAD (#400). There was a scope dropdown on
// a row of its own, then the same menu as a chip inside the field; both were a
// second way to do what the collapsible project groups below already do, and
// only one of them could be left switched on by accident.
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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronRightIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FoldVerticalIcon,
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
import { projectSettingsHref } from "@/lib/project-settings-link";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { useCommandHandlers, useCommandKeys } from "@/lib/use-command-keys";
import { workspaceOpener } from "@/lib/workspace-open";
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
  windowFor,
  type SessionBand,
  type SidebarSession,
} from "@/lib/session-list";
import { hostFetcher } from "@/lib/hosts/client";
import { projectPlaces } from "@/lib/hosts/project-places";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
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
import { ProjectGroupSection } from "@/components/session/project-group";
import {
  dedupeAcrossHosts,
  groupSessions,
  moveProjectGroup,
  moveProjectGroupStep,
  moveSessionRow,
  PINNED_ROW_SCOPE,
  PROJECT_GROUP_MIME,
  SESSION_ROW_MIME,
  railJumpSlots,
  railRowsForCommandKeys,
  useCollapsedGroups,
} from "@/lib/session-groups";
import { observeSidebarLayout, useSidebarLayout } from "@/lib/sidebar-layout";
import { CommandPalette, type CommandPalettePage } from "@/components/command-palette";
import type { NewConversationTarget } from "@/components/project-palette";
import { Button } from "@/components/ui/button";
import { KeyHint } from "@/components/ui/key-hint";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { APP_SIDEBAR_MAIN_MIN_WIDTH, APP_SIDEBAR_STORAGE_KEY, keepsRoomForMain, SIDEBAR_RESIZE_MIN_WIDTH } from "@/lib/sidebar-width";
import { CAPTION } from "@/lib/idiom";
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
/**
 * The desktop shell never appears or disappears mid-session, so the store this
 * rail reads it through has nothing to subscribe to and nothing to answer on the
 * server. Both are module constants because `useSyncExternalStore` compares them
 * by identity — inline arrows would resubscribe on every render.
 */
const subscribeNothing = () => () => {};
const serverNoBridge = () => undefined;

/**
 * ⌘B ON THE COLLAPSE TRIGGER while ⌘ is held — issue #401. The hint sits beside
 * the glyph rather than inside `SidebarTrigger`: the primitive is shared with
 * the Spool's rail and the panel, and only THIS one is what `toggle-rail` binds.
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
        <KeyHint command="toggle-rail" />
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
 * the two rails' grammar. `CAPTION` (10px, semibold, uppercase,
 * tracking-wider) now lives in `lib/idiom.ts` and this label reads it from
 * there; it used to sit at 11px, regular weight, sentence case — a difference
 * between two "small grey word beside a rule" treatments with no reason
 * beyond having been written on different days. Everything else about the
 * rule (the rule itself, the chevron, the count) is unchanged — only the
 * label's type scale moved.
 */

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
              showProject
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
type RemoteProject = Pick<Project, "id" | "name" | "icon" | "iconName"> & { hostId: string; hostName: string };

function SidebarBody() {
  const pathname = usePathname();
  // THE PLACE THIS RAIL'S BODY SHOWS — §11's warehouse nav on `/spool`, the
  // looms floor plan on `/looms`, Telar's own session list everywhere else.
  // The header above it (trigger, switcher) is common to all; only what is
  // below it changes.
  const inSpool = pathname.startsWith("/spool");
  const inLooms = pathname.startsWith("/looms");
  const router = useRouter();
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();

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
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [settledOpen, setSettledOpen] = useState(false);
  const { collapsed: collapsedGroups, toggle: toggleGroup, collapseOthers, collapseAll, expandAll } = useCollapsedGroups();
  /**
   * WHERE EACH PROJECT GROUP SITS, from the engine — so the desktop shell, a
   * browser tab and a paired phone draw the same arrangement. The fold state
   * above stays per window; the order is about the work. See lib/sidebar-layout.ts.
   */
  const {
    order: projectOrder,
    setOrder: setProjectOrder,
    sessionOrder,
    setSessionOrder,
    pinnedOrder,
    setPinnedOrder,
  } = useSidebarLayout();
  /** The group being carried, and where it would land. Owned here rather than
   *  by the group, because a drop lands on a DIFFERENT group than the one that
   *  started the drag. */
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupInsert, setGroupInsert] = useState<{ key: string; position: "above" | "below" } | null>(null);
  /**
   * The ROW being carried, and the band it came out of. Same ownership argument
   * as the group above, plus one of its own: the scope is what refuses a drop
   * on another group, and `dataTransfer` cannot be READ during a drag-over —
   * only its type list can — so the band has to be held here.
   */
  const [draggingRow, setDraggingRow] = useState<{ scope: string; key: string } | null>(null);
  const [rowInsert, setRowInsert] = useState<{ key: string; position: "above" | "below" } | null>(null);
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
  /**
   * THE COMMAND PALETTE, which page of it is up, and what it opens looking for.
   *
   * ONE PIECE OF STATE FOR ALL THREE PAGES, because they are one surface (#402):
   * ⌘K opens the list, New conversation walks to Projects, Add project walks to
   * Sources, and the palette walks between them. They were two dialogs with two
   * flags once, which is how the rail ended up able to have a register form open
   * behind a project picker.
   *
   * `query` IS THE HANDOFF FROM THE RAIL'S FIELD. The field stays a filter over
   * the rows in front of you; ⌘K carries whatever is in it into the palette, so
   * a search that turned out to be a bigger question than the rail can answer
   * does not have to be typed twice.
   */
  const [palette, setPalette] = useState<{ open: boolean; page: CommandPalettePage; query: string }>({
    open: false,
    page: "root",
    query: "",
  });
  const openPalette = (page: CommandPalettePage, seed = "") => setPalette({ open: true, page, query: seed });
  /** Each Mac's own settling window, read with its rows — keyed like the
   *  sidebar cache (LOCAL_HOST for this engine). See `loadHost`. */
  const [hostWindows, setHostWindows] = useState<Map<string, number | null>>(() => new Map());
  /** An away Mac's remembered rows, dimmed under its retry line. Filled by
   *  `loadAll` from the sidebar cache; empty for a host never read. */
  const [staleByHost, setStaleByHost] = useState<Map<string, SidebarSession[]>>(() => new Map());
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
    // The glyph somebody PICKED, which outranks the file above — carried
    // separately for `ProjectAvatar`'s reason: two questions, two fields.
    const glyphs = new Map(result.projects.map((project) => [project.id, project.iconName]));
    // WHICH REPOSITORY EACH PROJECT IS A CHECKOUT OF — the one fact about a row
    // that is true on more than one Mac, and so the only thing two Macs'
    // registrations of the same work can be recognised by. See `projectGroupKey`.
    const remotes = new Map(result.projects.map((project) => [project.id, project.remoteUrl]));
    // WHO EACH SETTLED DELEGATE DID ITS WORK FOR — issue #378. Resolved once
    // here, off the list already in hand, because `settledBy` carries an id
    // (ids survive renames) and a row that went looking for a title would be a
    // lookup per row per render. A coordinator archived since is simply absent,
    // and the hint says what happened without naming it.
    const titles = new Map(result.sessions.map((session) => [session.id, session.title]));
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
        session.projectId ? remotes.get(session.projectId) : undefined,
        session.projectId ? glyphs.get(session.projectId) : undefined,
        session.settledBy ? titles.get(session.settledBy.coordinatorSessionId) : undefined,
      ),
    );
    return {
      projects: result.projects,
      sessions,
      ...(daemonId ? { daemonId } : {}),
      ...(policy ? { policy } : {}),
      // WHERE THINGS SIT, straight off the read that was happening anyway —
      // only meaningful for THIS Mac, whose document holds the keys this rail
      // mints. A remote Mac's own arrangement is of ITS rail, not of ours.
      ...(result.layout ? { layout: result.layout } : {}),
    };
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
      // THE ARRANGEMENT ANOTHER DEVICE MADE. It rides this Mac's live read, so
      // a drag on the phone or in another tab reaches this rail on the poll it
      // was making anyway — and `observeSidebarLayout` drops it while a drag of
      // our own is still being written, so a poll in flight across a drop
      // cannot put the group back under the pointer.
      observeSidebarLayout(local.value.layout);
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

  /**
   * THE RAIL ALWAYS NAMES EACH ROW'S PROJECT — even with one registered. A
   * previous cut hid it for a single project ("the same word repeated is not
   * information"), and it read as a bug every time: a row with no project line
   * looks unfiled, and the human checking "did this land in the right project"
   * gets no answer.
   *
   * IT USED TO BE CONDITIONAL, on a per-project filter this rail no longer has
   * (#400). Scoped to one project the name was genuinely redundant — the chip
   * said it — and with the chip gone there is no state in which it is, so the
   * flag went with it. A row inside a project GROUP still passes `false`: that
   * header names the project one line above, which is the same argument and
   * the reason `SessionRow` keeps the prop.
   */
  const activeSessionId = activeSessionFromPathname(pathname);
  const list = deriveSessionList({
    sessions,
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
  const grouped = list.flat ? undefined : groupSessions(list, projectOrder, { sessions: sessionOrder, pinned: pinnedOrder });
  /**
   * EVERY GROUP AS IT CAME BACK — issue #381.
   *
   * A pinned coordinator used to claim the rows it followed and this list was
   * `withholdFollowedRows(grouped.groups, …)` with the claimed rows removed. It
   * claims nothing now: a delegated conversation is a conversation, it draws in
   * the project it belongs to, and who asked it for what is described on the
   * panel's Agents surface instead of implied by where the rail put it.
   */
  const drawnGroups = grouped ? grouped.groups : [];

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
   * DRAGGING A ROW INSIDE ITS OWN BAND. The same platform drag as the group
   * above, with one rule added: A ROW LEAVES ITS BAND ONLY BY A DIFFERENT VERB.
   * Carrying a conversation into another project would move a worktree, which
   * is not something a two-pixel drop indicator should be able to promise — so
   * a drop whose scope does not match is not merely ignored, it never lights
   * up in the first place.
   *
   * `scope` is the project group's key, or `PINNED_ROW_SCOPE` for the band.
   * Handlers are curried per row, like the group's, so each row gets bare refs.
   */
  const onRowDragStart = (scope: string, key: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData(SESSION_ROW_MIME, key);
    event.dataTransfer.effectAllowed = "move";
    setDraggingRow({ scope, key });
  };
  const onRowDragEnd = () => {
    setDraggingRow(null);
    setRowInsert(null);
  };
  const onRowDragOver = (scope: string, key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(SESSION_ROW_MIME)) return;
    if (!draggingRow || draggingRow.scope !== scope || draggingRow.key === key) return;
    event.preventDefault();
    // The group around this row is a drop target too. It would decline a row
    // on its own (wrong MIME), but stopping here is what keeps a future drop
    // target from having to know about this one.
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position: "above" | "below" = event.clientY < rect.top + rect.height / 2 ? "above" : "below";
    setRowInsert((current) => (current?.key === key && current.position === position ? current : { key, position }));
  };
  const onRowDragLeave = (key: string) => () => setRowInsert((current) => (current?.key === key ? null : current));
  const onRowDrop = (scope: string, drawn: readonly string[]) => (key: string) => (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(SESSION_ROW_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const dragged = event.dataTransfer.getData(SESSION_ROW_MIME) || draggingRow?.key;
    const sameBand = draggingRow?.scope === scope;
    const position = rowInsert?.key === key ? rowInsert.position : "below";
    setDraggingRow(null);
    setRowInsert(null);
    if (!dragged || dragged === key || !sameBand) return;
    // The whole drawn band is written, for the reason `moveSessionRow` gives:
    // a row nobody had placed is placed by this drop rather than left to drift.
    const next = moveSessionRow(scope === PINNED_ROW_SCOPE ? pinnedOrder : (sessionOrder[scope] ?? []), drawn, dragged, key, position);
    void (scope === PINNED_ROW_SCOPE ? setPinnedOrder(next) : setSessionOrder(scope, next));
  };
  /** What a row needs to be a drag handle, spelled once for both bands. */
  const rowDrag = (scope: string, drawn: readonly string[]) => {
    const drop = onRowDrop(scope, drawn);
    return (key: string) => ({
      dragging: draggingRow?.key === key,
      insert: rowInsert?.key === key ? rowInsert.position : null,
      onDragStart: onRowDragStart(scope, key),
      onDragEnd: onRowDragEnd,
      onDragOver: onRowDragOver(scope, key),
      onDragLeave: onRowDragLeave(key),
      onDrop: drop(key),
    });
  };

  /**
   * THE GROUPS AS DRAWN, which is what every group gesture is measured against
   * — the fold-all verbs, "collapse others" and the menu's one-step reorder
   * alike. Spelled once here so a menu row and a drop cannot disagree about
   * which keys are on screen; see `foldedAfter` and `moveProjectGroupStep` for
   * why neither takes the stored list instead.
   */
  const drawnGroupKeys = drawnGroups.map((group) => group.key);
  /** The pinned band as drawn — what a drop in it is measured against, exactly
   *  as `drawnGroupKeys` is for the groups. */
  const pinnedRowDrag = rowDrag(PINNED_ROW_SCOPE, grouped ? grouped.pinned.map((session) => sessionKey(session)) : []);
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
    .filter((draft) => (needle ? draft.text.toLocaleLowerCase().includes(needle) : true))
    .map((draft) => ({ ...draft, projectName: projects.find((project) => project.id === draft.projectId)?.name }))
    .filter((draft) => draft.projectName !== undefined);
  const discardDraft = (projectId: string) => {
    // Straight to storage: the write announces, and this component re-reads its
    // own announcement like every other listener. One path in, one path out.
    writeDraft(undefined, projectId, "");
  };

  /**
   * THE WHOLE COMMAND REGISTRY — mounted HERE because this is the one component
   * alive on every route that already draws the rows the number keys count.
   * Every other surface (the panel, the composer) binds its own commands through
   * `bindCommands` and this dispatcher looks them up; see lib/commands.ts.
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
  const jumpRows = grouped ? railRowsForCommandKeys({ ...grouped, groups: drawnGroups }, collapsedGroups) : list.sessions.slice(0, 9);
  /**
   * THE SAME ROWS, AS THE NUMBERS THEY WEAR while ⌘ is held — issue #401.
   *
   * Derived from `jumpRows` rather than alongside it, which is the only
   * arrangement in which the hint on a row and the key that fires it cannot
   * disagree: one array, read twice, so a folded group or a shelf is skipped by
   * both or by neither.
   */
  const jumpSlots = railJumpSlots(jumpRows);
  const jumpSlotFor = (key: string) => jumpSlots.get(key);
  /** Spread rather than passed, because most rows have no slot and the prop is
   *  optional — the same shape every other optional prop in this file takes. */
  const jumpProp = (key: string) => {
    const slot = jumpSlots.get(key);
    return slot === undefined ? {} : { jumpSlot: slot };
  };
  const run = useCommandKeys(jumpRows, {
    // ⌘N ASKS RATHER THAN GUESSES — unless there is nothing to ask about. The
    // table's destination for this binding is "/", which resolves a project and
    // opens its canvas; the palette replaced that guess. `newConversation`
    // below is the one place that decides between palette and canvas, so the
    // key and the button cannot disagree about what New conversation means.
    "new-conversation": () => newConversation(),
    // The same verb with the guess taken out: always the list. It is the
    // palette's "New conversation in…" row, and the row and the command are one
    // thing because the row IS the command.
    "new-conversation-in": () => openPalette("projects"),
    "add-project": () => openPalette("sources"),
    /**
     * ⌘K IS THE PALETTE NOW (#402), AND IT TOGGLES. It used to put the cursor
     * in the field beside it, which could find a conversation and nothing else;
     * the field keeps doing exactly that on its own, and this opens the surface
     * that can also find a command or a project — carrying the field's text in
     * so a half-typed search is not lost. Pressing it again closes what it
     * opened, because a key that only opens is a key you have to reach for
     * Escape after.
     */
    "search-sessions": () =>
      setPalette((current) => (current.open ? { ...current, open: false } : { open: true, page: "root", query })),
    // The rail's own collapse. It used to be a hand-rolled listener inside the
    // sidebar primitive, which is precisely why it appeared on no keybindings
    // pane and could not be changed. One registry, one dispatcher.
    "toggle-rail": () => toggleSidebar(),
  });

  const selectedSearchIndex = list.sessions.length ? Math.min(searchIndex, list.sessions.length - 1) : -1;

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
    const active = sessions.find((session) => sessionKey(session) === activeSessionId);
    if (active?.projectId) return { projectId: active.projectId, ...(active.hostId ? { hostId: active.hostId } : {}) };
    const recent = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt).find((session) => session.projectId);
    if (recent?.projectId) return { projectId: recent.projectId, ...(recent.hostId ? { hostId: recent.hostId } : {}) };
    if (projects[0]) return { projectId: projects[0].id };
    const remote = remoteProjects[0];
    return remote ? { projectId: remote.id, hostId: remote.hostId } : undefined;
  })();
  const startSession = (target = composerTarget) => {
    onNavigate();
    router.push(target ? canvasHref(target.projectId, target.hostId) : "/");
  };

  /**
   * EVERY PROJECT THIS COCKPIT CAN REACH, in one list, this Mac's first.
   *
   * The rail already holds both halves — it reads each paired Mac's registry on
   * the same pass it reads its sessions — so the palette costs no request of
   * its own and can never offer a project the rail does not show.
   */
  const pickerTargets: NewConversationTarget[] = [
    ...projects.map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.icon ? { icon: project.icon } : {}),
      ...(project.iconName ? { iconName: project.iconName } : {}),
      ...(project.root ? { root: project.root } : {}),
    })),
    ...remoteProjects.map((project) => ({
      id: project.id,
      name: project.name,
      ...(project.icon ? { icon: project.icon } : {}),
      ...(project.iconName ? { iconName: project.iconName } : {}),
      hostId: project.hostId,
      hostName: project.hostName,
    })),
  ];

  /**
   * A PALETTE OF ONE IS A QUESTION WITH ONE ANSWER.
   *
   * On a cockpit with a single project registered — which is where most people
   * start, and where many stay — pressing New conversation opened a search
   * field over a list of one row, to be told the thing it already knew. The
   * palette earns itself the moment there are two places a conversation could
   * go; until then the button does what the button says.
   *
   * Undefined while the registry is still empty too: `startSession` has its own
   * fallback for a cockpit with no project at all, and the palette's "No
   * projects registered yet." is the better answer there.
   */
  const soleTarget = pickerTargets.length === 1 ? pickerTargets[0] : undefined;
  const newConversation = () => {
    if (soleTarget) startSession({ projectId: soleTarget.id, ...(soleTarget.hostId ? { hostId: soleTarget.hostId } : {}) });
    else openPalette("projects");
  };

  /**
   * THE DESKTOP SHELL, READ THROUGH A STORE rather than during render.
   *
   * `workspaceOpener()` answers `undefined` on the server and an object in the
   * shell, so reading it straight would make the first client render disagree
   * with the markup it hydrates. The store's server snapshot is what keeps them
   * in step — the same arrangement `OpenWorkspaceButton` makes for the opener
   * preference. It never changes after load, so the subscribe is a no-op.
   */
  const revealBridge = useSyncExternalStore(subscribeNothing, workspaceOpener, serverNoBridge);

  /**
   * WHICH FOLDER THE FINDER BUTTON WOULD SHOW.
   *
   * THE RAIL'S OWN GUESS — the project you are reading, then the one you touched
   * last — which is what `New conversation` already acts on. It used to prefer
   * the scoped project ahead of that guess; with the scope chip gone (#400) the
   * guess is the whole answer, and it is named in the button's `title` so the
   * reader never has to infer which folder is about to open.
   *
   * THIS MAC'S PROJECTS ONLY. A paired Mac's checkout is on that Mac; revealing
   * a same-named path here would show somebody the wrong folder, which is the
   * refusal `workspaceOpenBlocker` makes everywhere else.
   */
  const revealProject = (() => {
    const local = composerTarget && !composerTarget.hostId ? projects.find((project) => project.id === composerTarget.projectId) : undefined;
    return local?.root ? { name: local.name, root: local.root } : undefined;
  })();

  /**
   * THE RAIL'S ANSWER TO TWO COMMANDS ABOUT "THE PROJECT YOU ARE IN" — and it
   * is deliberately the BOTTOM of the stack rather than an override.
   *
   * `bindCommands` keeps a stack per command and the newest binder wins, so a
   * session's own Reveal button (session/open-workspace-button.tsx) outranks
   * this one while that session is open and this is what answers everywhere
   * else. Passed as overrides, the rail would have shadowed it — and ⌘O inside
   * a conversation would have opened the rail's guess instead of the workspace
   * you were looking at.
   *
   * NEITHER IS BOUND WHEN THERE IS NOTHING TO OPEN, which is what keeps the
   * palette honest: it lists a command only when something can run it, so
   * "Reveal in Finder" is absent from a browser tab rather than present and
   * inert.
   */
  const reveal = revealBridge && revealProject ? () => void revealBridge.reveal(revealProject.root) : undefined;
  const localProjectId = composerTarget && !composerTarget.hostId ? composerTarget.projectId : undefined;
  useCommandHandlers(
    {
      ...(reveal ? { "reveal-in-finder": reveal } : {}),
      ...(localProjectId
        ? {
            "project-settings": () => {
              onNavigate();
              router.push(projectSettingsHref(localProjectId));
            },
          }
        : {}),
    },
    [Boolean(reveal), localProjectId],
  );

  /**
   * NO PROJECT-SCOPE CHIP — issue #400.
   *
   * #395 folded the old "All projects ▾" row into the search field as a chip,
   * which was a smaller version of a control the rail should not have had at
   * all: the collapsible project groups already answer "fewer rows", and they
   * answer it without hiding the rest of the list behind a menu a reader can
   * leave set and forget. A filter inside a search box is furniture on top of
   * that. Its one non-filter verb — the gear beside each project — lives on the
   * group header's own menu (`project-group.tsx`), which is where a per-project
   * verb belongs.
   *
   * The three verbs at the field's right (reveal, add project, new
   * conversation) stay exactly as #395 built them.
   */

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
      {/* MOUNTED WITH THE RAIL, not inside the button: ⌘K and ⌘N open it from
          anywhere in the cockpit, and the rail is the one component alive on
          every route. It renders into a portal, so its place here is about
          lifetime rather than layout.

          THE RAIL IS WHAT FEEDS IT. The projects and the conversations it
          searches are the ones already in hand — so the palette costs no read of
          its own, and can never offer a row the rail does not have. */}
      <CommandPalette
        open={palette.open}
        page={palette.page}
        query={palette.query}
        onOpenChange={(open) => setPalette((current) => ({ ...current, open }))}
        targets={pickerTargets}
        sessions={sessions}
        onRun={run}
        onChooseProject={(target) => startSession({ projectId: target.id, ...(target.hostId ? { hostId: target.hostId } : {}) })}
        onOpenSession={(session) => {
          onNavigate();
          router.push(sessionHref(session));
        }}
        onRegistered={() => void loadAll()}
      />
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
        <div className="px-2 pb-2 pt-3">
          <div className="flex items-center gap-1.5">
            <SidebarSearchField
              className="min-w-0 flex-1"
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
              placeholder="Search"
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
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                ) : (
                  /* THE ONE HINT THAT IS ALWAYS ON — and it now promises the
                     PALETTE rather than this field (#402). The field filters
                     what is in front of you as you type; ⌘K opens the surface
                     that also searches commands and projects, carrying whatever
                     is in here with it. Same key, a bigger question.

                     It was a hardcoded `⌘K`, which lied the moment somebody
                     rebound the command; #401 makes it read the live keymap like
                     every other hint, and `always` keeps the affordance since
                     the beginning rather than hiding it behind a held key. */
                  <KeyHint command="search-sessions" always />
                )
              }
            />
            {/*
              THREE VERBS IN ONE PILL, at the field's right — T3's header, and
              the reason the rail is a line shorter than it was.

              WHAT WENT: a second row under the field holding "All projects ▾"
              and a lone `+`. It spent a whole line of a narrow rail on a filter
              most cockpits never change, and it put the two things you press
              most (add a project, start a conversation) on different rows at
              opposite ends. The filter moved into the field as a chip and then
              went altogether (#400) — the project groups below already narrow
              the list, and they do it without a mode to leave set.

              THE PILL IS ONE BORDER AROUND THREE BUTTONS rather than three
              loose glyphs, because they are one cluster of verbs about the rail
              and the space beside the field is not theirs to float in.
            */}
            {/* EACH VERB IS A COMMAND, PRESSED (#402). The buttons used to do
                the work themselves — reach for the bridge, set the palette's
                state — which is how a button and its chord come to mean two
                slightly different things. They ask the dispatcher now, exactly
                as the keyboard and the palette's own rows do. */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-sidebar-border/60 p-0.5">
              {/* HIDDEN IN A BROWSER TAB, never disabled: `workspaceOpenBlocker`
                  is the one place that decides whether a folder can be opened
                  from this window, and a greyed Finder button in a tab would be
                  the platform explained forever. Disabled is only for the case
                  the desktop CAN do and there is simply nothing chosen yet. */}
              {revealBridge && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!revealProject}
                  aria-label="Reveal in Finder"
                  title={revealProject ? `Reveal ${revealProject.name} in Finder` : "Reveal in Finder — choose a project first"}
                  onClick={() => run("reveal-in-finder")}
                >
                  <FolderOpenIcon />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add project"
                title="Add project"
                onClick={() => run("add-project")}
              >
                <FolderPlusIcon />
              </Button>
              {/* ONE CONTROL, WHETHER OR NOT A MAC IS PAIRED. This used to be two:
                  a plain button that opened the guess, and — only on a cockpit
                  with a remote — a menu of every project on every Mac. So the one
                  affordance for "start this on the mini" was invisible on the
                  machine most people run, and naming a project at all meant
                  navigating to it first. The palette answers both, and ⌘N opens
                  the same thing the button does. */}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New conversation"
                title={soleTarget ? `New conversation in ${soleTarget.name}` : "New conversation — choose the project"}
                onClick={() => run("new-conversation")}
              >
                <MessageSquarePlusIcon />
              </Button>
            </div>
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
                  showProject
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
                  showProject
                  variant="card"
                  band={bandFor(session)}
                  renderedAt={renderedAt}
                  onRefresh={() => void loadAll()}
                  {...jumpProp(sessionKey(session))}
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
                {/* ONE ROW PER PINNED CONVERSATION, AND NOTHING UNDER IT —
                    issue #381. This band drew a coordinator's delegates as
                    indented children from #199 onwards, which is what made a
                    separate conversation read as a sub-agent of the row above.
                    The relationship is described on the panel's Agents surface
                    now; the band is a band of rows again. */}
                {(grouped ? grouped.pinned : list.pinned).map((session) => (
                  <SessionRow
                    key={sessionKey(session)}
                    session={session}
                    active={sessionKey(session) === activeSessionId}
                    showProject
                    variant="card"
                    band="pinned"
                    renderedAt={renderedAt}
                    onRefresh={() => void loadAll()}
                    // THE BAND IS ITS OWN SCOPE: pinned rows arrange among
                    // themselves, and unpinning is what takes a row out of
                    // here. Only in the banded view — a search flattens the
                    // rail, and a position inside an answer means nothing.
                    {...(grouped ? { drag: pinnedRowDrag(sessionKey(session)) } : {})}
                    {...jumpProp(sessionKey(session))}
                  />
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
                title={query ? "No sessions found" : "No sessions yet"}
                detail={query ? "Try another title or project." : "Start one from the button above."}
              />
            ) : grouped ? (
              drawnGroups.map((group) => {
                /**
                 * EVERY MAC THIS GROUP LIVES ON, and that Mac's own id for the
                 * project. A group can now span two Macs' checkouts of one
                 * repository, and the ids are minted per engine — so a
                 * destination built from `group.projectId` alone would open
                 * nothing on the other. This Mac comes first; see
                 * `projectPlaces`.
                 */
                const places = projectPlaces(group.sessions);
                /**
                 * THE REGISTRY'S PATH, AND ONLY THIS MAC'S. A paired Mac's
                 * project is read as an id and a name; its checkout is over
                 * there, and handing this Mac's same-named folder to Finder
                 * would reveal the wrong one. `workspaceOpenBlocker` refuses it
                 * a second time inside the group, on the host id.
                 */
                const here = places.find((place) => !place.hostId);
                const root = here ? projects.find((project) => project.id === here.projectId)?.root : undefined;
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
                    // The rows inside arrange among themselves, measured
                    // against this group's own drawn keys — which is what makes
                    // a row from another group a drop this one refuses.
                    rowDrag={rowDrag(group.key, group.sessions.map((session) => sessionKey(session)))}
                    // Whose row wears which number, worked out once for the
                    // whole rail — see `jumpSlots`.
                    jumpSlot={jumpSlotFor}
                    {...(root ? { root } : {})}
                    places={places}
                    // The `+` beside the header, as a menu row: one canvas
                    // route, reached two ways. A group that spans two Macs asks
                    // which one — the header cannot answer it for the reader.
                    onNewConversation={(place) => startSession({ projectId: place.projectId, ...(place.hostId ? { hostId: place.hostId } : {}) })}
                    {...(here
                      ? {
                          onProjectSettings: () => {
                            onNavigate();
                            router.push(projectSettingsHref(here.projectId));
                          },
                        }
                      : {})}
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
                  showProject
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
                  // A search flattens the rail and ⌘1..⌘9 count the results, so
                  // the numbers follow them here rather than staying on rows
                  // that are no longer where they were.
                  {...jumpProp(sessionKey(session))}
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
                      showProject
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
              {/* The `+` in the header, as a row: the SAME palette page, so
                  there is still exactly one way a project joins the registry and
                  one `chooseDirectory` call in the app. */}
              <ContextMenuItem onClick={() => openPalette("sources")}>
                <FolderPlusIcon />
                Add project
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
