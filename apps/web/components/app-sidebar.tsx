"use client";

// The app sidebar, ported from the frozen app's components/app-sidebar.tsx.
//
// STRUCTURE, TOP TO BOTTOM: a 56px header with the collapse trigger and the
// wordmark; a search field wearing a project filter at its head and its ⌘K hint
// at its tail, with add-project / new-conversation in one pill beside it; then
// the five bands —
//
// THE FILTER IS A SET, AND THAT IS WHY IT IS BACK (#470). A scope dropdown on a
// row of its own became a single-select chip in the field (#395) and then went
// altogether (#400), on the argument that the collapsible project groups below
// already answer "fewer rows". They do — one project at a time. "These three
// and not the other eleven" is the thing they cannot say, and it is what this
// control is for: nothing checked is every project, n checked is those n.
//
// AND IT NARROWS WHAT IS DRAWN, NOTHING ELSE. The old chip was a scope, so the
// rail could read "the project at hand" off it and point New conversation and
// Reveal at it. A set of three has no such answer, so every guess in this file
// is exactly the one it makes with no filter set.
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
// Overview, Projects, Looms, Workspace. None of the four arrived, and a glyph
// that navigates nowhere is worse than a header without one. The Unread chip is
// gone because `readAt` is unmodelled, and a chip with an unbackable count is a
// lie with a number on it.
//
// SESSIONS ARE THE ONLY PLACE THIS RAIL SHOWS, so the wordmark is a wordmark
// rather than a switcher between places. Two other places did exist and were
// decommissioned (#501); nothing replaced them here, because the list this rail
// already drew was what people opened Telar for.

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";

/**
 * THE PALETTE IS A CHUNK, AND THE PROJECT PALETTE COMES WITH IT (#492).
 *
 * `command-palette.tsx` imports `project-palette.tsx`, so a static import here
 * put 68 kB of two dialogs into the rail — which is mounted on every route in
 * the cockpit — for a surface that opens on ⌘K and nothing else. See the
 * palette state's `asked` field below: the split only pays if the rail also
 * stops mounting it on sight.
 *
 * NO `ssr: false`: the latch below already keeps this out of every server
 * render, and `dynamic({ ssr: false })` renders permanently nothing under this
 * suite's environment — a spelling that buys nothing here and costs any future
 * test of the palette.
 */
const CommandPalette = dynamic(() => import("@/components/command-palette").then((mod) => mod.CommandPalette));
import {
  ChevronRightIcon,
  FolderPlusIcon,
  FoldVerticalIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MonitorIcon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import { AppSidebarFooterRow } from "@/components/app-sidebar-footer";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import { SidebarProjectFilter } from "@/components/sidebar-project-filter";
import type { InboxPolicy, Project, SidebarLayout } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { projectSettingsHref } from "@/lib/project-settings-link";
import { PROJECTS_CHANGED_EVENT } from "@/lib/projects";
import { useCommandHandlers, useCommandKeys } from "@/lib/use-command-keys";
import {
  appliedProjectFilter,
  filterSessionsToProjects,
  projectFilterKey,
  useProjectFilter,
} from "@/lib/project-filter";
import { DraftRow } from "@/components/session/draft-row";
import { AgentEntry, agentEntryActive, agentEntryShown } from "@/components/session/agent-entry";
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
import { applyRowChange, type SessionRowChange, type SessionRowChanged } from "@/lib/session-mutations";
import { hostFetcher, hostFromPathname } from "@/lib/hosts/client";
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
import type { CommandPalettePage } from "@/components/command-palette";
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
 * ⌘B ON THE COLLAPSE TRIGGER while ⌘ is held — issue #401. The hint sits beside
 * the glyph rather than inside `SidebarTrigger`: the primitive is shared with
 * the panel, and only THIS one is what `toggle-rail` binds.
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
        {/* A WORDMARK, NOT A SWITCHER. Sessions are the product and the only
            place this rail shows, so there is nothing to switch between. */}
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
      <p className="mt-1 text-2xs leading-4">{detail}</p>
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
 * THE LABEL'S SCALE IS THE SHARED SECTION CAPTION — the web pass that gave
 * every rail one grammar. `CAPTION` (10px, semibold, uppercase,
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
      <span className="shrink-0 tabular-nums text-2xs">{count}</span>
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
  onRowChanged,
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
  onRowChanged: SessionRowChanged;
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
              onRowChanged={onRowChanged}
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

/** One Mac's pass, composed — what `loadHost` returns and what an UNCHANGED
 *  answer hands back untouched. Named so it can be held in a ref. */
type HostPage = {
  projects: Project[];
  sessions: SidebarSession[];
  daemonId?: string;
  policy?: InboxPolicy;
  layout?: SidebarLayout;
  /** How many SETTLED rows this Mac did not send (#457). The rows above are the
   *  unsettled ones unless the shelf is open; this is what draws the header that
   *  opens it. Absent from an engine that predates the filter — which means "you
   *  have everything", so the count is taken from the rows instead. */
  settledCount?: number;
  /** Whether THIS Mac has a built-in Agent (#531). Rides the same read for
   *  `policy`'s reason, and absent from an engine older than the feature —
   *  which reads as off, exactly as a `false` does. */
  agent?: { enabled: boolean };
};

function SidebarBody() {
  const pathname = usePathname();
  const router = useRouter();
  // `open` is here for the palette's Quick settings row, which reports which
  // way Toggle Rail would go — the rail is what knows, so the rail says.
  const { isMobile, open: railOpen, setOpenMobile, toggleSidebar } = useSidebar();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  /**
   * WHICH MACS HAVE AN AGENT — one boolean per host, and `undefined` for a Mac
   * that has not answered yet (#531).
   *
   * A MAP RATHER THAN ONE FLAG, which is the difference from the Main entry
   * this replaces. That row was the LOCAL Mac's coordinator and only ever
   * that, so one value served. The Agent's row is the VIEWED Mac's: walking
   * into
   * `/hosts/<id>/…` must swap which Agent it opens, and a single flag would have
   * drawn this cockpit's own answer over somebody else's machine.
   *
   * FILLED BY THE FAN-OUT THAT WAS HAPPENING ANYWAY. Every paired Mac is
   * already read once per pass; this takes one field off each answer. A Mac
   * that did not answer is simply absent, and an absent Mac draws no row —
   * see `agentEntryShown`.
   */
  const [agentHosts, setAgentHosts] = useState<ReadonlyMap<string, boolean>>(new Map());
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
  /** WHICH PROJECTS THE RAIL IS NARROWED TO — the head of the search field.
   *  Per client, like the fold state above and for the same reason; see
   *  lib/project-filter.ts. */
  const projectFilter = useProjectFilter();
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
   * HOW MANY SETTLED ROWS THE ENGINES ARE HOLDING BACK (#457), across every Mac
   * in the rail. State rather than a ref because the shelf header draws it.
   *
   * Zero from an engine that predates the filter, which sent every row — so the
   * shelf is counted off the rows in hand, exactly as it always was, and this
   * adds nothing to it.
   */
  const [shelvedOnEngines, setShelvedOnEngines] = useState(0);
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
  /**
   * `asked` IS THE LATCH THAT KEEPS THE PALETTE OUT OF THE RAIL'S BUNDLE (#492).
   *
   * The palette used to render unconditionally, closed, on every route — 26 kB
   * of it plus the 42 kB project palette behind it, in a rail that is mounted
   * everywhere, for a dialog most sessions never open. It is a chunk of its own
   * now (see the `dynamic` call at the top of this file), and that only pays if
   * the rail also stops mounting it on sight.
   *
   * ONCE TRUE IT STAYS TRUE, rather than rendering on `open`: the dialog
   * animates on close, and a component that vanishes the instant `open` goes
   * false has nothing left to animate with. So the chunk is fetched once, by
   * whoever first presses ⌘K, and never again for the life of the tab.
   *
   * IN THE STATE ITSELF, not a ref read during render and not an effect. Both
   * of those are lint errors here and both deserve to be — one reads mutable
   * state mid-render, the other spends a whole extra render on a value the
   * updater already knew. Every path that can open the palette sets it.
   */
  const [palette, setPalette] = useState<{ open: boolean; asked: boolean; page: CommandPalettePage; query: string }>({
    open: false,
    asked: false,
    page: "root",
    query: "",
  });
  const openPalette = (page: CommandPalettePage, seed = "") => setPalette({ open: true, asked: true, page, query: seed });
  /** Each Mac's own settling window, read with its rows — keyed like the
   *  sidebar cache (LOCAL_HOST for this engine). See `loadHost`. */
  const [hostWindows, setHostWindows] = useState<Map<string, number | null>>(() => new Map());
  /** An away Mac's remembered rows, dimmed under its retry line. Filled by
   *  `loadAll` from the sidebar cache; empty for a host never read. */
  const [staleByHost, setStaleByHost] = useState<Map<string, SidebarSession[]>>(() => new Map());
  const composing = useRef(false);
  const loadAllRunning = useRef(false);
  /**
   * THE CONDITIONAL READ'S TWO HALVES, per host (#459, #457): the `ETag` that
   * was handed back last time, and the page it described.
   *
   * AN ETAG RATHER THAN THE REVISION CURSOR, because the tag carries the MODE as
   * well as the revision. The cursor is a number about the store, so one earned
   * against the unsettled list and spent against `?all=1` is answered
   * "unchanged" — and the Settled shelf a reader has just opened stays empty
   * until something else happens on the machine. The cursor is still served, for
   * anything that sends one; this rail sends a tag.
   *
   * REFS RATHER THAN STATE, because neither is rendered and both are written
   * inside the read: putting them in state would re-render the rail once a tick
   * to store a string nothing draws — which is most of what this issue is about.
   * Keyed like the sidebar cache (`LOCAL_HOST` for this engine), so one Mac's
   * tag can never be spent against another's revision.
   *
   * A HOST THAT ANSWERS NO ETAG KEEPS NO ENTRY, so an engine too old to mint one
   * simply goes on making full reads.
   */
  const tags = useRef(new Map<string, string>());
  /** The older spelling of the same cursor (#459), kept as the floor for a Mac
   *  whose engine mints no tag — that pair loses nothing it had. */
  const revisions = useRef(new Map<string, number>());
  const pages = useRef(new Map<string, HostPage>());
  /**
   * WHETHER THIS RAIL IS ASKING FOR THE SHELF'S ROWS (#457) — `settledOpen`, in
   * a ref because `loadHost` reads it.
   *
   * A REF AND NOT A DEP, for the reason the two above are refs: `loadAll` is
   * held by an interval, and making it depend on this would tear the timer down
   * and build it again every time somebody opened a shelf. The ref is written in
   * `toggleSettled` BEFORE the read it triggers, so the pass that opens the
   * shelf is already the wide one.
   */
  const wantsSettled = useRef(false);

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
    /**
     * ONE READ PER HOST PER PASS (#459) — and it used to be three.
     *
     * The engine's identity rides beside its rows, so two reads that reached ONE
     * engine (a Mac paired with itself, or under two addresses) can be folded
     * into one; see `dedupeAcrossHosts`. Its settling window comes with it, so a
     * row is banded by the clock of the engine it lives on and a paired Mac's
     * "72 hours" cannot shelve what this Mac's "off" would keep.
     *
     * BOTH USED TO BE THEIR OWN REQUEST, issued concurrently with the list. That
     * is three sockets per host per tick — six with one paired Mac, against a
     * browser's six-connection cap (#82) — to learn two fields that change when
     * somebody opens Settings. The engine now stamps them on the list, which is
     * the one read this rail was making anyway.
     *
     * STILL BEST-EFFORT, and it has to be: an engine older than the fields sends
     * neither, and absent must read as "no answer" rather than an answer. No
     * daemon id leaves that host's rows undeduplicated; no policy falls back to
     * the default window. Neither costs a row.
     */
    /**
     * AND THE READ IS CONDITIONAL (#459) — the half that actually took the
     * engine off the floor.
     *
     * A rail cannot be pushed to. There is no global event feed on the engine,
     * and #82 is the issue about NOT opening this cockpit's first long-lived
     * connection — six per origin is all a browser has, and navigation needs
     * them. So the timer below stays, and what changes is what a tick COSTS:
     * hand back the revision from last time, and an engine with nothing new
     * answers sixty bytes instead of folding over every session's queue,
     * requests and tasks and sending back several hundred kilobytes of rows the
     * rail is already drawing. On an idle cockpit that is every tick, forever.
     *
     * UNCHANGED MEANS "KEEP WHAT YOU HAVE", so the held page is returned
     * verbatim and nothing re-renders. The fallback below is for the case that
     * should not happen — a cursor with no page behind it — because answering
     * an unchanged read with no rows would empty the rail.
     */
    /**
     * AND ONLY THE ROWS A RAIL DRAWS (#457), UNLESS THE SHELF IS OPEN.
     *
     * The engine answers the unsettled rows by default — 7 of 291 on the owner's
     * store — and `settledCount` beside them is what lets this rail draw
     * "Settled (284)" without holding 284 rows. Opening that shelf is what asks
     * for them, and the wide read is deliberately NOT conditional on either side:
     * the revision counts writes, so it does not move when a reader opens a
     * shelf, and a cursor spent across the two lists would answer the wide ask
     * with "unchanged" and leave the shelf empty until something else happened.
     */
    /**
     * AND IT IS CONDITIONAL ON AN ETAG (#457) RATHER THAN ON `?since=`.
     *
     * The cursor came first (#459) and still answers for anything that sends
     * one; this rail sends a tag because the tag carries the MODE. A cursor is
     * a number about the store, so one earned against the unsettled list and
     * spent against `?all=1` is answered "unchanged" — and the Settled shelf
     * this rail has just opened stays empty until somebody happens to write
     * something on the machine. With the mode inside the tag, both reads are
     * conditional and neither can be answered with the other's list. A 304 also
     * carries no body at all, where the cursor's cheapest answer is sixty bytes.
     *
     * UNCHANGED STILL MEANS "KEEP WHAT YOU HAVE", so the held page is returned
     * verbatim and nothing re-renders. The fallback below is for the case that
     * should not happen — a tag with no page behind it — because answering a
     * not-modified read with no rows would empty the rail.
     */
    const key = host?.id ?? LOCAL_HOST;
    const wide = wantsSettled.current;
    const known = tags.current.get(key);
    /**
     * THE CURSOR IS THE FLOOR, NOT THE DEAD PATH. A Mac too old to mint a tag
     * answers 200 with none, and this rail then falls back to `?since=` — which
     * is exactly what it did before, so a mixed-version pair loses nothing. Only
     * the NARROW read may use a cursor; the wide one is refused one for the
     * reason above and simply pays.
     */
    const cursor = revisions.current.get(key);
    const answer = known === undefined && !wide && cursor !== undefined
      ? await hostApi.liveSessionsSince(cursor).then((page) => (page.unchanged ? { notModified: true as const, etag: "" } : { ...page, notModified: false as const, etag: undefined }))
      : await hostApi.liveSessionsMatching({
        ...(known === undefined ? {} : { etag: known }),
        ...(wide ? { all: true } : {}),
      });
    if (answer.notModified) {
      const held = pages.current.get(key);
      if (held) return held;
    }
    const result = answer.notModified ? await hostApi.liveSessions({ all: wide }) : answer;
    // THE TAG IS WHAT THE NEXT TICK ASKS WITH. An engine too old to mint one
    // leaves no entry, and the cursor above carries the tick instead.
    if (answer.etag) tags.current.set(key, answer.etag);
    else tags.current.delete(key);
    if (result.revision === undefined) revisions.current.delete(key);
    else revisions.current.set(key, result.revision);
    const daemonId = result.daemonId;
    const policy = result.inbox;
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
      // A PROJECT-LESS SESSION IS NOT A ROW HERE. The rail is a project-scoped
      // list — the aggregate route already excludes one, and this keeps that
      // true if one ever arrives by another path.
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
    const page: HostPage = {
      projects: result.projects,
      sessions,
      ...(daemonId ? { daemonId } : {}),
      ...(policy ? { policy } : {}),
      // WHERE THINGS SIT, straight off the read that was happening anyway —
      // only meaningful for THIS Mac, whose document holds the keys this rail
      // mints. A remote Mac's own arrangement is of ITS rail, not of ours.
      ...(result.layout ? { layout: result.layout } : {}),
      // HOW MANY THIS MAC HELD BACK (#457). Absent from an engine that predates
      // the filter, and absent must read as "it sent everything" — the shelf is
      // then counted off the rows, exactly as it always was.
      ...(result.settledCount === undefined ? {} : { settledCount: result.settledCount }),
      // WHETHER THIS MAC HAS AN AGENT (#531), off the same read — the entry
      // costs the rail no request of its own, per host, per tick.
      ...(result.agent === undefined ? {} : { agent: result.agent }),
    };
    // Held so the next not-modified answer has something to BE. Only alongside
    // a tag or a cursor: with neither, every read is a full one and nothing
    // reads this.
    if (tags.current.has(key) || revisions.current.has(key)) pages.current.set(key, page);
    return page;
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
      /**
       * THE LOCAL MAC'S DESIGNATION, AND ONLY IT (#522).
       *
       * A paired Mac may have a Main session of its own, and its rows are in
       * this list — but the entry above the bands says "the conversation I
       * coordinate FROM", which is a fact about the cockpit you are sitting in.
       * One entry, as the issue asks; a remote Mac's coordinator is still an
       * ordinary row inside its project group, exactly where it always was.
       */
      // THE ARRANGEMENT ANOTHER DEVICE MADE. It rides this Mac's live read, so
      // a drag on the phone or in another tab reaches this rail on the poll it
      // was making anyway — and `observeSidebarLayout` drops it while a drag of
      // our own is still being written, so a poll in flight across a drop
      // cannot put the group back under the pointer.
      observeSidebarLayout(local.value.layout);
      const away = new Set<string>();
      const reads: { daemonId?: string; sessions: SidebarSession[]; settledCount?: number }[] = [local.value];
      const remoteProjects: RemoteProject[] = [];
      const windows = new Map<string, number | null>();
      // WHICH MACS HAVE AN AGENT, gathered on the pass that was reading them
      // anyway (#531). Only Macs that ANSWERED go in: a host that is away is
      // absent rather than `false`, so its row does not blink off and back on
      // across one failed poll — it is simply not the Mac being viewed, or it
      // is and the rail is already saying it cannot be reached.
      const agents = new Map<string, boolean>();
      if (local.value.agent) agents.set(LOCAL_HOST_ID, local.value.agent.enabled);
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
          if (page.value.agent) agents.set(host.id, page.value.agent.enabled);
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
      setAgentHosts(agents);
      // WHAT THE ENGINES KEPT (#457), summed over the Macs that answered. Not
      // deduplicated the way the rows are: two addresses onto one engine would
      // double it, which is the same caveat the closed shelf's count carries and
      // for the same reason — it is an affordance, not a figure.
      setShelvedOnEngines(reads.reduce((total, read) => total + (read.settledCount ?? 0), 0));
      setSessions(dedupeAcrossHosts(reads));
      setRenderedAt(Date.now());
    } finally {
      loadAllRunning.current = false;
    }
  }, [loadHost]);

  /**
   * ONE ROW CHANGED — THE RAIL'S HALF OF #495, and what `onRefresh` used to be.
   *
   * WHAT IT REPLACED. Every mutation on every row called `onRefresh`, and this
   * rail answered it with `loadAll()`: `hosts()`, then one live read PER PAIRED
   * MAC, to learn one field of one session the mutation's own response already
   * carried. Pin, settle, snooze, rename and delete each cost that fan-out,
   * which is the whole of "pin/settle take a while for the app to react".
   *
   * BOTH COPIES, AND THE SECOND ONE IS NOT OPTIONAL. `sessions` is what the
   * list derives from; `pages.current` is what a NOT-MODIFIED answer hands back
   * verbatim (#457/#459). Patching only the first would leave the held page
   * carrying the row as it was — so a poll already in flight when the mutation
   * landed, answered 304 against a tag minted before the write, would put the
   * stale row straight back and the settle would appear to bounce.
   *
   * THE LIST IS THE POLL'S BUSINESS, STILL. This changes what a row LOOKS like
   * and nothing about what the rail CONTAINS: no row is inserted, the bands are
   * re-derived from the patched row on the next render, and anything else that
   * moved on the machine arrives on the tick that was happening anyway.
   */
  const onRowChanged = useCallback((change: SessionRowChange) => {
    setSessions((rows) => applyRowChange(rows, change));
    for (const [key, page] of pages.current) {
      const next = applyRowChange(page.sessions, change);
      if (next.length !== page.sessions.length || next.some((row, index) => row !== page.sessions[index])) {
        pages.current.set(key, { ...page, sessions: next });
      }
    }
  }, []);

  /**
   * OPEN OR CLOSE THE SHELF, AND FETCH WHAT IT NEEDS.
   *
   * The engine sends the settled rows only when asked (#457), so opening the
   * shelf has to ASK — and has to ask now rather than on the next tick, or the
   * reader clicks "Settled (284)" and watches an empty shelf for three seconds.
   * The ref is set before the read so that read is already the wide one.
   *
   * CLOSING KEEPS THE ROWS IT ALREADY HAS. They cost nothing to hold, they band
   * to a shelf that is now shut, and dropping them would mean re-fetching all of
   * them the next time the reader glanced at the list.
   */
  const toggleSettled = useCallback(() => {
    // Off the REF rather than through a state updater: the updater is called
    // twice under StrictMode, and a fetch fired from inside one is a side
    // effect in a place React is allowed to re-run.
    const next = !wantsSettled.current;
    wantsSettled.current = next;
    setSettledOpen(next);
    if (next) void loadAll();
  }, [loadAll]);

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
   *
   * AND THE TICK IS NOW NEARLY FREE (#459). The reason this stayed a timer is
   * unchanged and worth restating: there is no global event feed on the engine
   * to subscribe to, and #82 is the issue about NOT opening this cockpit's first
   * long-lived connection — a browser has six per origin and navigation needs
   * them. What changed is the cost. `loadHost` hands back the revision it was
   * given, so a tick that finds nothing written costs sixty bytes and no fold,
   * where it used to cost 318 KB and a pass over every session's queue. The
   * cadence is therefore about LATENCY now — how soon a badge appears — rather
   * than about how much the rail is willing to spend.
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
   * IT USED TO BE CONDITIONAL, on the single-project scope chip (#400). Scoped
   * to one project the name was genuinely redundant — the chip said it — and
   * #470's filter is a SET, which never makes it redundant: three projects
   * selected is three names worth saying. A row inside a project GROUP still
   * passes `false`: that header names the project one line above, which is the
   * same argument and the reason `SessionRow` keeps the prop.
   */
  const activeSessionId = activeSessionFromPathname(pathname);
  /**
   * THE FILTER, APPLIED ONCE, HERE — over the rows rather than over the groups.
   *
   * Hiding whole groups is what the reader asked for and filtering the ROWS is
   * how it is delivered: a group with nothing left in it is not drawn, and the
   * same pass narrows Needs-you and Pinned, which sit outside the groups and
   * would otherwise go on showing a project the reader had just hidden.
   *
   * `sessions` ITSELF IS UNTOUCHED, and every other reader of it stays whole on
   * purpose: the palette searches every conversation (a filter over the rail is
   * not an instruction about what ⌘K may find), and the poll's cadence follows
   * what is live on this Mac rather than what is on screen.
   */
  const knownProjectKeys = [
    ...projects.map((project) => projectFilterKey(project.id)),
    ...remoteProjects.map((project) => projectFilterKey(project.id, project.hostId)),
  ];
  const projectsShown = appliedProjectFilter(projectFilter.selected, knownProjectKeys);
  const list = deriveSessionList({
    sessions: filterSessionsToProjects(sessions, projectsShown),
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
  /**
   * THE AGENT'S ROW — the VIEWED Mac's, or none (#531).
   *
   * NOTHING IS LOOKED UP IN `sessions`, which is the whole difference from the
   * line above: the Agent is not a session, so there is no id to find and no
   * title to read. One flag off the live answer decides, and the rule lives
   * beside the component that draws it so a test can hold it.
   */
  const viewedHost = hostFromPathname(pathname);
  const showAgentEntry = agentEntryShown(agentHosts, viewedHost);
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
    // A DRAFT IS A ROW IN THE RAIL, so the project filter reaches it too — a
    // band of scraps from a project the reader has just hidden is the same
    // contradiction as a session from it. Drafts are this Mac's only, hence the
    // bare key.
    .filter((draft) => projectsShown.size === 0 || projectsShown.has(projectFilterKey(draft.projectId)))
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
      setPalette((current) => (current.open ? { ...current, open: false } : { open: true, asked: true, page: "root", query })),
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
   * THE RAIL NO LONGER ANSWERS "REVEAL IN FINDER" — issue #470.
   *
   * It used to, from the bottom of the command stack: a guess at "the project
   * at hand" behind a button in the header pill. The verb is not gone — it is on
   * every project group's own menu (`project-group.tsx`) and on the session's
   * Reveal button (`session/open-workspace-button.tsx`), both of which name the
   * folder they will open instead of guessing at one. What went with the button
   * is the guess: a rail-wide ⌘O whose target the reader had to infer from a
   * tooltip, and which was wrong exactly when they had several projects open.
   *
   * THE CHORD FOLLOWS THE BINDING, which is the point. The palette lists a
   * command only when a mounted component can run it, and the held-⌘ hints read
   * the same registry — so outside a conversation, ⌘O now promises nothing
   * rather than promising a folder nobody chose.
   *
   * `project-settings` stays: it is the same guess, but it navigates inside the
   * app rather than opening something on the machine, and it is the rail's only
   * answer to that command.
   */
  const localProjectId = composerTarget && !composerTarget.hostId ? composerTarget.projectId : undefined;
  useCommandHandlers(
    {
      ...(localProjectId
        ? {
            "project-settings": () => {
              onNavigate();
              router.push(projectSettingsHref(localProjectId));
            },
          }
        : {}),
    },
    [localProjectId],
  );

  /**
   * THE FILTER AT THE HEAD OF THE FIELD — issue #470, and see
   * `sidebar-project-filter.tsx` for what it is and is not.
   *
   * ABSENT ON A COCKPIT WITH ONE PROJECT, unchanged from the chip it replaces:
   * "every project" and "that one project" select the same rows, so the control
   * would be furniture eating the width of the field. A selection stored from a
   * time when there were more is harmless — `appliedProjectFilter` narrows it to
   * the projects this cockpit can see, and one known key selects the one group
   * there is.
   *
   * ITS PER-PROJECT VERBS STAYED WHERE #400 PUT THEM. The old chip's menu
   * carried a gear beside each project; that row lives on the group header's own
   * menu, which is where a per-project verb belongs, and this popover is a
   * filter and only a filter.
   */
  const projectFilterControl =
    pickerTargets.length > 1 ? (
      <SidebarProjectFilter
        targets={pickerTargets}
        selected={projectsShown}
        onToggle={projectFilter.toggle}
        onClear={projectFilter.clear}
      />
    ) : undefined;

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
      {palette.asked && <CommandPalette
        open={palette.open}
        page={palette.page}
        query={palette.query}
        onOpenChange={(open) => setPalette((current) => ({ ...current, open, asked: current.asked || open }))}
        targets={pickerTargets}
        sessions={sessions}
        railOpen={railOpen}
        onRun={run}
        onChooseProject={(target) => startSession({ projectId: target.id, ...(target.hostId ? { hostId: target.hostId } : {}) })}
        onOpenSession={(session) => {
          onNavigate();
          router.push(sessionHref(session));
        }}
        onRegistered={() => void loadAll()}
      />}
      <TelarSidebarHeader />
      {/* The "Settings session" entry was removed from the product UI: it did
          not work reliably and duplicated the real Settings (in the footer). */}
      <SidebarContent>
        {/* THE SEARCH FIELD'S INSET IS px-2, matching the p-2 every
            `SidebarGroup` below already carries. It used to be px-3, one step
            wider than everything under it for no reason beyond this rail and
            the one that shared its chrome having been built separately. */}
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
              {...(projectFilterControl ? { start: projectFilterControl } : {})}
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
              TWO VERBS IN ONE PILL, at the field's right — T3's header, and the
              reason the rail is a line shorter than it was.

              WHAT WENT, TWICE OVER. First a second row under the field holding
              "All projects ▾" and a lone `+`: it spent a whole line of a narrow
              rail, and it put the two things you press most (add a project,
              start a conversation) on different rows at opposite ends. The
              filter is back at the HEAD of the field (#470), where it narrows
              the same list the field narrows. Then Reveal in Finder, which was a
              third button here (#470 again): it acted on a guess at "the project
              at hand", and the two places that can name the folder instead of
              guessing — a project group's menu, a session's own Reveal — both
              still carry it.

              THE PILL IS ONE BORDER AROUND ITS BUTTONS rather than loose glyphs,
              because they are one cluster of verbs about the rail and the space
              beside the field is not theirs to float in.
            */}
            {/* EACH VERB IS A COMMAND, PRESSED (#402). The buttons used to do
                the work themselves — reach for the bridge, set the palette's
                state — which is how a button and its chord come to mean two
                slightly different things. They ask the dispatcher now, exactly
                as the keyboard and the palette's own rows do. */}
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-sidebar-border/60 p-0.5">
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
          THE AGENT, ABOVE EVERYTHING INCLUDING DRAFTS (#531).

          It is not a band and not an entry in the list: it is the row that is
          always in the same place, which is the whole of what a built-in
          coordinator buys. The bands under it are untouched.

          A LINK AND A GLYPH, THE SIZE OF A DRAFT ROW. No status, no branch, no
          activity — those are questions about work in progress, and this row
          answers "where do I go to coordinate". Its rule sits underneath,
          exactly like drafts and pinned, because the boundary that exists is
          between this and what follows.

          IT IS THE VIEWED MAC'S AGENT, not this cockpit's — see `agentHosts`.
        */}
        {showAgentEntry && (
          <SidebarGroup className="shrink-0 pb-0">
            <SidebarGroupContent>
              <AgentEntry
                {...(viewedHost === LOCAL_HOST_ID ? {} : { hostId: viewedHost })}
                active={agentEntryActive(pathname, viewedHost)}
                onNavigate={onNavigate}
              />
            </SidebarGroupContent>
            <div aria-hidden className="mx-2 mt-1.5 h-px bg-sidebar-border" />
          </SidebarGroup>
        )}

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
                  onRowChanged={onRowChanged}
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
              <p className="px-2 pb-1 pt-0.5 text-2xs leading-4 text-sidebar-foreground/55">
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
                    onRowChanged={onRowChanged}
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
              /* THREE ANSWERS, AND THE FILTERED ONE IS BACK (#470). A rail
                 emptied by a filter is not a rail with nothing in it, and
                 "No sessions yet" over a cockpit full of work is the sentence
                 that makes a reader think they lost something. The arm is
                 reachable again exactly because a filter can now produce it. */
              <SidebarEmpty
                icon={MessageSquareIcon}
                title={query ? "No sessions found" : projectsShown.size ? "No sessions in the selected projects" : "No sessions yet"}
                detail={
                  query
                    ? "Try another title or project."
                    : projectsShown.size
                      ? "Clear the filter at the head of the field to see the rest."
                      : "Start one from the button above."
                }
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
                    onRowChanged={onRowChanged}
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
                  onRowChanged={onRowChanged}
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
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-2xs text-muted-foreground" role="status">
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
                      onRowChanged={onRowChanged}
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
              onRowChanged={onRowChanged}
            />
            <SessionShelf
              label="Settled"
              // THE ENGINE'S COUNT WHEN THE ROWS ARE NOT HERE (#457). The live
              // read holds the settled rows back until this shelf is open, so
              // banding what is in hand would say "0" and the header would not
              // be drawn at all — a shelf with no way to open it. `Math.max` so
              // the local band still wins when it is larger, which is what an
              // engine too old to send the count leaves us with.
              //
              // THE CLOSED COUNT IS THE WHOLE MACHINE'S, and under a project
              // filter that is more than this rail would list. It is an
              // affordance rather than a figure — it says "there are settled
              // conversations behind this" — and the moment the shelf opens the
              // rows are here and the number is the filtered one.
              count={settledOpen ? list.settledCount : Math.max(list.settledCount, shelvedOnEngines)}
              rows={list.settled}
              // NOT forced open while it holds the session you are reading.
              // It used to be, so the open row stayed visible in the rail —
              // but that meant settling the conversation you were in sprang
              // the shelf open, which read as the settle bouncing back. The
              // cockpit's own settled banner (see composer.tsx) is what says
              // "you are inside settled history" now; the shelf opens only
              // when asked.
              open={settledOpen}
              onToggle={toggleSettled}
              hasMore={list.hasMoreSettled && settledLimit < list.settledCount}
              onShowMore={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)}
              limit={settledLimit}
              {...(activeSessionId ? { activeSessionId } : {})}
                            renderedAt={renderedAt}
              bandFor={bandFor}
              onRowChanged={onRowChanged}
            />
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
