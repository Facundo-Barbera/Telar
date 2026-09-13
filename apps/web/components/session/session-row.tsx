"use client";

// One session in the sidebar inbox, at one of TWO VOLUMES.
//
// THE SPLIT IS THE WHOLE IDEA, and it is t3 code's (`src/components/Sidebar.tsx`,
// `variant: "card" | "slim"`): a row should cost as much space as it wants from
// you. A live session gets a card — project, status, title, branch, provider —
// and a settled one collapses to a single dim line that gives its space back.
// Scanning the list then means scanning the cards, which are exactly the rows
// with something happening in them.
//
// WHAT THIS REPLACED, AND WHY IT HAD TO GO. Every row used to be the same two
// lines: title, then "8h ago · project". True of everything and therefore
// useful about nothing — the only fact on offer was recency, which is also the
// sort order, so the second line restated the row's position. Twenty rows of
// that read as a wall.
//
// THE COMMENT ABOVE THIS ONE USED TO SAY THE LIVE STATES WERE UNREACHABLE:
// "Rather than paint a dot nothing can turn on, the row shows what the engine
// actually knows". That was true and is not any more — `Session.activity` is
// derived from the queue and the open requests (apps/engine/src/state.ts), so
// "Waiting on you" and "Working 3m" are measured rather than painted.
//
// LAYOUT DOCTRINE (unchanged): the title is the only thing you scan for, so it
// leads. SPEND IS DELIBERATELY ABSENT from the row — a number you audit, not
// one you scan — and lives in the hover card, in TOKENS: see lib/format.ts.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlarmClockIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ClockIcon,
  GitBranchIcon,
  MonitorIcon,
  PinIcon,
  UndoIcon,
} from "lucide-react";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { fmtAgo, fmtTokens } from "@/lib/format";
import { ACTIVITY_TONE, fmtDuration, rowStatusText, rowSubtitle } from "@/lib/session-activity";
import { canvasHref, sessionHref, settledHint, settlingActivity, type SessionBand, type SidebarSession } from "@/lib/session-list";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { SessionInboxMenu, SessionRowContextMenu, patchSession, runSessionPatch, type SessionRowMenuProps } from "@/components/session/session-inbox-menu";
import { canSettle, canSnooze, snoozePresets, wakeLabel } from "@/lib/session-settling";
import type { RailJumpSlot } from "@/lib/session-groups";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { KeyHintOverlay } from "@/components/ui/key-hint";
import { useSidebar } from "@/components/ui/sidebar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

/**
 * A duration that TICKS, because a frozen one is worse than none.
 *
 * "Working 3m" that still says 3m four minutes later is not stale data, it is a
 * wrong claim about the present — and it is the reading a person uses to decide
 * whether something has hung. Its own component so one interval runs per
 * working row rather than one re-render per second for the whole sidebar.
 *
 * The state is set INSIDE the interval callback, never in the effect body: the
 * effect subscribes to the clock, which is the external system the rule about
 * cascading renders exists to permit.
 */
function TickingDuration({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    // Every 5s, not every second: below a minute the label is in seconds and
    // 5s of lag is invisible; above it, the label only changes once a minute.
    const timer = window.setInterval(tick, 5_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="tabular-nums">{fmtDuration(startedAt, now)}</span>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[0.6875rem] tabular-nums">{value}</span>
    </div>
  );
}

/** One cell of the stat band. Only ever built for a figure that EXISTS —
 *  `hasFigures` below is what keeps an absent one out, rather than an em dash
 *  standing in for it. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-popover py-2">
      <span className="text-xs font-semibold tabular-nums">{value}</span>
      <span className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * WHETHER THIS CARD HAS ANYTHING THE ROW DOES NOT.
 *
 * The band used to paint "— CONTEXT / — TOKENS" for every session that has not
 * run a turn yet, and the rest of the card is the row again: the title, the
 * project, the provider mark. A card of three em dashes over facts you can
 * already see is a hover that costs a reader a glance and repays nothing.
 *
 * The usage figures are the one thing here the row deliberately withholds (see
 * the SPEND doctrine at the top of this file), so they are exactly the test:
 * no figures, no card. Absent is `undefined` — `deriveSessionList` omits both
 * keys when the engine reported no usage — so a genuine zero still counts.
 */
export function hasFigures(session: SidebarSession): boolean {
  return session.contextTokens !== undefined || session.tokens !== undefined;
}

/** The detail that used to fight the title for space on the row itself.
 *
 *  LAYOUT: status strip → identity (provider mark + title + state line) →
 *  the figures you scan as a stat band → the long-tail facts as label rows. */
export function SessionDetails({ session, renderedAt }: { session: SidebarSession; renderedAt: number }) {
  /** Built from what is KNOWN, so the band has two cells or three rather than a
   *  fixed three with dashes in the gaps. */
  const tiles = [
    ...(session.contextTokens === undefined ? [] : [{ label: "Context", value: fmtTokens(session.contextTokens) }]),
    // Was "Cost". Tokens are the unit this cockpit reports — see lib/format.ts
    // for why money left.
    ...(session.tokens === undefined ? [] : [{ label: "Tokens", value: fmtTokens(session.tokens) }]),
    { label: "Workspace", value: session.worktreeBranch ? "Worktree" : "Local" },
  ];
  return (
    <div>
      {/* The strip carries the one ambient fact this row can state: whether the
          session is still in play. Tint, not text — the state line says it in
          words right below. */}
      <div
        aria-hidden
        className={`h-0.5 ${
          session.archived
            ? "bg-gradient-to-r from-border to-transparent"
            : "bg-gradient-to-r from-primary/70 via-primary/25 to-transparent"
        }`}
      />
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <ProviderIcon provider={session.driver} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs font-semibold leading-snug">{session.title || "Untitled session"}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[0.625rem]">
            {session.archived ? (
              <span className="flex items-center gap-0.5 text-muted-foreground">
                <CircleCheckIcon className="size-2.5" />
                Archived
              </span>
            ) : (
              <span className="text-muted-foreground">Active {fmtAgo(session.updatedAt, renderedAt)}</span>
            )}
          </span>
        </span>
      </div>
      <div
        className={`mt-2.5 grid gap-px border-y border-border/60 bg-border/60 ${tiles.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
      >
        {tiles.map((tile) => (
          <StatTile key={tile.label} label={tile.label} value={tile.value} />
        ))}
      </div>
      <div className="space-y-0.5 px-3 py-2">
        <DetailRow
          label="Agent"
          value={session.model ? `${PROVIDER_LABEL[session.driver]} · ${session.model}` : PROVIDER_LABEL[session.driver]}
        />
        {session.effort ? <DetailRow label="Effort" value={session.effort} /> : null}
        {session.projectName ? <DetailRow label="Project" value={session.projectName} /> : null}
        {session.worktreeBranch ? <DetailRow label="Branch" value={session.worktreeBranch} /> : null}
        <DetailRow label="Started" value={fmtAgo(session.createdAt, renderedAt)} />
        {/* WHY THE SHELF TOOK IT, when the reader did not decide — #378. The
            one settling fact a person cannot reconstruct by remembering what
            they did, so it earns a row of its own here. */}
        {session.settledBy ? (
          <DetailRow label="Settled" value={session.settledForTitle ? `for ${session.settledForTitle}` : "work delivered"} />
        ) : null}
      </div>
    </div>
  );
}

export function SessionRow({
  session,
  active,
  showProject,
  variant = "card",
  band = "active",
  searchable = false,
  searchSelected = false,
  renderedAt,
  onRefresh,
  drag,
  jumpSlot,
}: {
  session: SidebarSession;
  active: boolean;
  showProject: boolean;
  /**
   * WHICH NUMBER KEY LANDS HERE, 1-9, for the rows that have one — issue #401.
   *
   * Absent is the normal case: the tenth row down, every shelf row, every row
   * in a folded group. It comes from `railJumpSlots` over the SAME array
   * `useCommandKeys` is handed, so a row cannot wear a number that fires
   * somewhere else; a row that is merely tenth wears nothing, which is correct
   * and not a gap.
   */
  jumpSlot?: RailJumpSlot;
  /**
   * HOW MUCH ROOM THIS ROW HAS EARNED. `card` for the live list, `slim` for the
   * shelves and for search results — a result list is answering a question you
   * already asked, so every row in it is equally relevant and density beats
   * detail.
   */
  variant?: "card" | "slim";
  /**
   * WHICH BAND THE LIST PUT THIS ROW IN — decided once by `bandOf` and handed
   * down, rather than recomputed here off a window this component would have to
   * be told anyway. It is what picks between Snooze and Wake, and it is not
   * always the band the row is DRAWN in: the survivor rule renders the session
   * you are reading in the live list even when it is snoozed, and that row
   * still needs the snoozed affordance.
   */
  band?: SessionBand;
  searchable?: boolean;
  searchSelected?: boolean;
  renderedAt: number;
  onRefresh: () => void;
  /**
   * DRAG TO REORDER, WHEN THE BAND AROUND THIS ROW ARRANGES ITSELF. Absent in
   * search results, in the shelves and in "Needs you" — a list that is an
   * answer, a shelf you are not keeping, and a queue the engine fills are none
   * of them places a position means anything.
   *
   * THE STATE IS THE RAIL'S, NOT THE ROW'S, for the same reason the group
   * drag's is: a drop lands on a DIFFERENT row than the one that started it, so
   * no single row can hold both ends of the gesture.
   */
  drag?: {
    /** This row is the one being carried. */
    dragging: boolean;
    /** Where the carried row would land relative to this one, while over it. */
    insert: "above" | "below" | null;
    onDragStart: (event: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (event: React.DragEvent) => void;
  };
}) {
  // Distinguishes the docked desktop sidebar from the mobile <Sheet>, which is
  // a modal and therefore cannot host a body-portaled hover card.
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  // The hover card anchors to the whole row, not to the link inside it.
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  const href = sessionHref(session);
  const snoozing = band === "snoozed";
  /**
   * The settling module's view of this session, WHICH IS NO LONGER EMPTY.
   *
   * Both `canSettle` and `canSnooze` were being handed `{}` — a truthful
   * "nothing is known" when the engine sent no live state, and stale the moment
   * it did. It says "you cannot snooze a session that is asking you something"
   * and "you cannot settle one mid-turn", and with a real `activity` those
   * rules finally apply instead of always passing.
   *
   * FOLDED IN `lib/session-list.ts` rather than here, because the list bands on
   * the same answer: a row offering a Snooze the list would decline to honour
   * is a button that does nothing.
   */
  const sessionActivity = settlingActivity(session);
  /**
   * SHELVED BY A DECISION, not by neglect — which is the only case the row's
   * own button can UNDO. A session that drifted onto the shelf because nobody
   * touched it for three days has nothing to un-press; offering it an undo
   * would promise a state change that does not exist, and pressing it would
   * appear to do nothing.
   */
  const settledByDecision = session.settledOverride === "settled";
  /**
   * EVERY SETTLED ROW CAN COME BACK NOW, not only the decision-settled ones.
   * Settled rows stay settled when merely read (see session-list.ts), so this
   * button is the one road back — and a shelf where some rows have it and some
   * do not reads as broken, not as principled.
   */
  const unsettles = settledByDecision || band === "settled";
  const unsettle = () =>
    // TWO PATCHES, ONE REPORTED OUTCOME. If the first refusal went unreported
    // the second would run against a session that never took the override, and
    // the row would sit there unchanged with nothing said.
    runSessionPatch(async () => {
      // A drift-settled session has no override to clear, and clearing nothing
      // writes nothing — so nothing would change. Setting an override first makes
      // the clearing patch a real change, and a real change stamps `updatedAt`,
      // which is what actually restarts the inactivity clock.
      if (!settledByDecision) await patchSession(session, { settledOverride: "active" });
      await patchSession(session, { settledOverride: null });
    }, onRefresh);

  // Deleting the session you are currently VIEWING must not maroon you on it:
  // the survivor rule in deriveSessionList keeps this row visible for as long as
  // the URL names it, which is right for every other case and exactly wrong
  // here. Hand the reader a fresh canvas in the same project instead.
  //
  // IT USED TO PUSH `/projects`, and that was one of the four routes that kept
  // stranding people on a management table nobody had asked for. A composer in
  // the project you were just working in is where you were going anyway.
  const leaveIfActive = () => {
    // On the row's own Mac: a canvas for the same project id on THIS Mac is a
    // different project, or none at all.
    if (active && session.projectId) router.push(canvasHref(session.projectId, session.hostId));
  };

  const beginRename = () => {
    setDraft(session.title);
    setRenaming(true);
  };

  const commitRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    // An unchanged or empty name is a cancel, not a write — the engine would
    // reject the empty one anyway, and a no-op PATCH writes no event but still
    // costs a round trip and a refresh of every surface.
    if (!next || next === session.title) return;
    await runSessionPatch(() => patchSession(session, { title: next.slice(0, 120) }), onRefresh);
  };

  if (renaming) {
    return (
      <div className="rounded-md bg-sidebar-accent px-2 py-1.5">
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            }
          }}
          aria-label="Rename session"
          className="w-full bg-transparent text-xs font-medium text-sidebar-foreground outline-none"
        />
      </div>
    );
  }

  const { badge, time } = rowStatusText(session, renderedAt);
  // The header line already names the project when `showProject`, so the
  // subtitle must not repeat it one line below — which is what it did.
  const subtitle = rowSubtitle(session, { projectShown: showProject });

  /**
   * THE STATUS SITS WHERE THE TIMESTAMP WOULD, never beside it.
   *
   * t3's choice, and the one that keeps a card readable: a row showing both
   * "Working" and "8h ago" invites the question of which one is now, and the
   * honest answer — "both, about different things" — is not worth the pixel.
   */
  // FADES AS THE ACTIONS ARRIVE. The controls overlay this corner of the row,
  // so a status left underneath them would show through — and t3's rule is
  // that a read-only label yields to an action rather than competing with it.
  const yieldOnHover = "transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0";
  /**
   * A SLEEPING ROW SAYS WHEN IT COMES BACK, NOT HOW OLD IT IS.
   *
   * "4h ago" on a snoozed row is the one fact about it nobody needs — you are
   * looking at this shelf to ask what returns next, and the shelf is sorted by
   * exactly that. The countdown is the same one t3 puts on its snoozed rows,
   * and it takes the timestamp's place rather than sitting beside it.
   */
  const statusSlot = session.draft ? (
    <span className={`shrink-0 text-[0.6875rem] text-sidebar-foreground/45 ${yieldOnHover}`}>Draft</span>
  ) : snoozing && session.snoozedUntil !== undefined ? (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[0.6875rem] tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>
      <AlarmClockIcon className="size-3" />
      {wakeLabel(session.snoozedUntil, renderedAt)}
    </span>
  ) : badge ? (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium ${ACTIVITY_TONE[badge.tone]} ${yieldOnHover}`}>
      {/* A SPINNER FOR "STILL GOING", A DOT FOR "STOPPED AND WAITING". The
          motion is the fastest read in the list — you see that something is
          alive before you read which row it is — and a request that has parked
          is exactly the thing that is NOT moving, so it gets a still mark. */}
      {badge.ticking ? (
        <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
      ) : badge.tone === "attention" ? (
        <CircleDotIcon className="size-3" />
      ) : null}
      {/* `role="status"` on the LABEL alone. Wrapping the ticking duration in
          one would make a screen reader announce every tick. */}
      <span role="status">{badge.label}</span>
      {badge.ticking && session.activityAt !== undefined ? <TickingDuration startedAt={session.activityAt} /> : null}
    </span>
  ) : (
    <span className={`shrink-0 text-[0.6875rem] tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>{time}</span>
  );

  /**
   * …AND ⌘N SITS ON TOP OF IT WHILE ⌘ IS HELD — issue #401.
   *
   * The number goes exactly where the timestamp is rather than beside it, for
   * the reason above turned around: a row cannot show two things at this end,
   * and inserting a tenth element would reflow the list under the pointer at the
   * moment a reader is trying to count rows. `KeyHintOverlay` dims the status
   * and lays the caps over it; see its own note.
   */
  const trailingSlot = jumpSlot ? <KeyHintOverlay command={`jump-${jumpSlot}`}>{statusSlot}</KeyHintOverlay> : statusSlot;

  /**
   * THE MARK REPLACED THE HEADING.
   *
   * The pinned band used to announce itself with the word "Pinned" over a rule.
   * A band of one or two rows does not need a title telling you what you did to
   * them — the rows are already at the top, which is the whole observable effect
   * of pinning. A glyph on the row says the same thing in the space a heading
   * cost, and it keeps saying it in search results, where the band does not
   * exist at all and the word could not follow.
   *
   * `role="img"` WITH A LABEL, not a decorative icon: this is the only thing
   * distinguishing a pinned row now, so it has to be readable by something that
   * cannot see position.
   */
  const pinMark =
    band === "pinned" ? (
      <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-sidebar-foreground/45">
        <PinIcon className="size-3" />
      </span>
    ) : null;

  /**
   * WHICH MAC, when it is not this one. A remote row says so on its header
   * line, after the project, in the same weight — it is an address, not a
   * status. Local rows carry nothing: the local engine is the default, and
   * a chip reading "This Mac" on every row would be the "Claude on every
   * card" failure the third line already learned from.
   */
  const hostMark = session.hostName ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-sidebar-accent px-1 text-[0.625rem] leading-4 text-sidebar-foreground/60" title={`On ${session.hostName}`}>
      <MonitorIcon className="size-2.5" />
      <span className="max-w-24 truncate">{session.hostName}</span>
    </span>
  ) : null;

  /**
   * THE CARD: three lines, and each answers a different question.
   *   project + status  — whose is this, and what is it doing
   *   title             — the only thing anyone scans for
   *   branch + provider — where the work lands, and who is doing it
   */
  const cardBody = (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {pinMark}
        {showProject && session.projectName ? (
          <>
            {/* The project's OWN mark when its checkout carries one — a
                favicon, an app icon — else a tinted initial. The generic
                folder is the final fallback, inside ProjectAvatar. */}
            <ProjectAvatar
              name={session.projectName}
              {...(session.projectId ? { projectId: session.projectId } : {})}
              {...(session.projectIcon ? { icon: session.projectIcon } : {})}
              {...(session.projectIconName ? { iconName: session.projectIconName } : {})}
              size={12}
            />
            <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-sidebar-foreground/50">{session.projectName}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {hostMark}
        {trailingSlot}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {/* THE TITLE CARRIES THE CARD, so it is a size up from everything
            around it. At `text-xs` it weighed the same as the project name
            above and the branch below, and a card whose three lines are all
            the same size is a paragraph rather than a row. */}
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-snug text-sidebar-foreground">
          {session.title || "Untitled session"}
        </span>
        {/* The provider mark is IDENTITY, not status, so it rides at the end at
            reduced opacity rather than competing with the badge above it. It
            sits on the TITLE line so it survives the third line's absence. */}
        {!subtitle && (
          <span className="shrink-0 opacity-50">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        )}
      </span>
      {/*
        NO THIRD LINE UNLESS IT SAYS SOMETHING THIS ROW ALONE WOULD SAY.
        Two versions of this were wrong before it was right. It first fell back
        to the project name, which the header line above already carried — the
        same word twice, one line apart. Then it fell back to the model, which
        is worse in the way that is harder to see: every row read "Claude", so
        a line existed on twenty cards to tell you nothing that distinguished
        any of them. That is the exact failure this whole rebuild was for.

        A branch differs per row and says where the work lands, so it earns the
        space. Nothing else does, and a card with nothing to add is two lines.
      */}
      {subtitle && (
        <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-sidebar-foreground/45">
          {subtitle.kind === "branch" ? <GitBranchIcon className="size-3 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate">{subtitle.text}</span>
          <span className="shrink-0 opacity-60">
            <ProviderIcon provider={session.driver} size={11} />
          </span>
        </span>
      )}
    </span>
  );

  /**
   * THE SLIM ROW: one line, and it gives its space back.
   *
   * A settled session is history — you scan the tail when hunting, not when
   * working — so the mark is dimmed and desaturated at rest and restored on
   * hover, which is t3's "settled history recedes" behaviour. The status still
   * appears if there IS one: a settled row can go back to work.
   */
  const slimBody = (
    <>
      {pinMark}
      {/* A SETTLED ROW WEARS ITS PROJECT, not its provider. Whose work this was
          is what you scan the tail for; the provider is identity that already
          lives in the hover card. Falls back to the provider mark only when the
          session has no project (a rare orphan). */}
      <span className="shrink-0 opacity-50 grayscale transition group-hover/session:opacity-100 group-hover/session:grayscale-0">
        {session.projectName ? (
          <ProjectAvatar
            name={session.projectName}
            {...(session.projectId ? { projectId: session.projectId } : {})}
            {...(session.projectIcon ? { icon: session.projectIcon } : {})}
            {...(session.projectIconName ? { iconName: session.projectIconName } : {})}
            size={14}
          />
        ) : (
          <ProviderIcon provider={session.driver} size={13} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[0.8125rem] text-sidebar-foreground/70 group-hover/session:text-sidebar-foreground">
        {session.title || "Untitled session"}
      </span>
      {trailingSlot}
    </>
  );

  const rowBody = variant === "card" ? cardBody : slimBody;

  /**
   * NO HOVER CARD AT ALL IN TWO CASES, and they are different failures.
   *
   * THE MOBILE SHEET. Under 768px <Sidebar> stops being a docked panel and
   * renders the mobile <Sheet> — a MODAL dialog. HoverCardContent portals to
   * <body>, i.e. outside that dialog, so the modal treats the card as an
   * outside element and dismisses it the instant it appears. A hover
   * affordance in a modal sheet at phone width has nothing to offer anyway.
   *
   * NOTHING TO SAY. See `hasFigures`: a session that has not run a turn has no
   * usage, and without it the card is the row again with a band of em dashes
   * on top.
   */
  const plain = isMobile || !hasFigures(session);

  /**
   * THE TITLE NO LONGER MAKES ROOM FOR THE ACTIONS — they overlay it.
   *
   * This used to grow the link's right padding on hover/focus/menu-open so the
   * title truncated before the buttons rather than running under them. The
   * effect a reader actually got was a title that REWROTE ITSELF under the
   * pointer: "Exoplanets…" became "Exo…" on the way to pressing something, on
   * the one line they were using to find the row. Losing the name of the thing
   * you are pointing at is a worse trade than covering its last few
   * characters, so the cluster below carries its own backdrop and sits on top.
   */
  const linkClass = `flex min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    variant === "card" ? "py-2.5" : "py-1.5"
  }`;

  /**
   * ONE SET OF ANSWERS FOR BOTH MENUS ON THIS ROW. The `⋯` and the right-click
   * menu render the same definition, so giving them the same props is what
   * stops the two disagreeing about, say, whether this row is settled — which
   * would show a "Settle" in one and an "Un-settle" in the other on one row.
   */
  const menuProps: SessionRowMenuProps = {
    session,
    active,
    // No longer the default `{}`: the engine reports what this session is
    // doing, so the menu's own guards can finally apply.
    activity: sessionActivity,
    now: renderedAt,
    // The same fold the settle button beside it uses, drift included.
    settled: unsettles,
    onRename: beginRename,
    onDone: onRefresh,
    onLeave: leaveIfActive,
  };

  const row = (
    /**
     * THREE WEIGHTS, NOT TWO, AND THE THIRD IS THE ONE THAT MATTERS.
     *
     * `card` versus `slim` separates live from history, but inside the live
     * band a session that is WORKING or WAITING ON YOU is not the same as one
     * that merely happens to be recent — and in t3's sidebar those are exactly
     * the rows carrying the emphasis. A hairline in the status colour, drawn on
     * the leading edge, is enough: it reads down a column of twenty rows
     * without adding height, and it uses the colour the badge already
     * established rather than inventing a second language for the same fact.
     */
    <div
      ref={rowRef}
      // A ROW WHOSE HOST STOPPED ANSWERING IS A PHOTOGRAPH, so it recedes the
      // same way an archived one does — the list is still there, it just is not
      // being told anything. The hover title carries the only fact that is
      // actually different about it: when it was last true.
      //
      // AND ON THE SHELF IT CARRIES THE SETTLE'S REASON (#378), which is the
      // one variant-independent place a slim row can say it: a plain row has no
      // hover card, and the mobile sheet cannot host one at all.
      title={
        [
          session.stale === undefined ? undefined : `Last read ${fmtAgo(session.stale, renderedAt)}`,
          settledHint(session),
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      className={`group/session relative flex items-center rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      } ${session.archived || session.stale !== undefined ? "opacity-60" : ""} ${
        badge && variant === "card"
          ? `before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full ${
              badge.tone === "attention" ? "before:bg-warning" : "before:bg-primary"
            }`
          : ""
      }`}
    >
      {plain ? (
        <Link
          id={`sidebar-session-${session.id}`}
          href={href}
          prefetch={false}
          // AN ANCHOR IS DRAGGABLE BY DEFAULT, and that default would win: a
          // grab starting on the title would hand the platform a URL to drag
          // instead of letting the row's own wrapper carry the row. Off here so
          // the gesture belongs to exactly one element.
          draggable={false}
          role={searchable ? "option" : undefined}
          aria-selected={searchable ? searchSelected : undefined}
          aria-current={active ? "page" : undefined}
          onDoubleClick={(event: React.MouseEvent) => {
            event.preventDefault();
            beginRename();
          }}
          className={linkClass}
        >
          {rowBody}
        </Link>
      ) : (
        <HoverCard>
          {/* `id` MUST live on the Trigger, never on the render element. The
              trigger registers itself in the preview-card store under its `id`
              PROP; an id on the render element overrides the DOM id while the
              store still holds the generated one, so the open cannot be
              attributed to this trigger and is rescinded the frame it fires. */}
          <HoverCardTrigger
            id={`sidebar-session-${session.id}`}
            render={
              <Link
                href={href}
                // Session routes are force-dynamic and carry the transcript.
                // They are deliberately fetched only when selected.
                prefetch={false}
                // See the plain branch: an anchor drags its own URL unless
                // told not to, which would beat the row wrapper's drag.
                draggable={false}
                role={searchable ? "option" : undefined}
                aria-selected={searchable ? searchSelected : undefined}
                aria-current={active ? "page" : undefined}
                onDoubleClick={(event: React.MouseEvent) => {
                  event.preventDefault();
                  beginRename();
                }}
                className={linkClass}
              />
            }
          >
            {rowBody}
          </HoverCardTrigger>
          {/* THREE POSITIONING CHOICES, EACH FIXING A DISTINCT FLICKER SOURCE.
              `anchor={rowRef}` — the TRIGGER is only the <Link>, which stops
              where the action buttons begin, so anchoring to it opened the card
              on top of this row's own controls. `positionMethod="fixed"` — with
              "absolute", a card that overflows the viewport GROWS THE DOCUMENT,
              which moves the anchor, re-evaluates hover, and loops.
              `side: "shift"` keeps the card on the right rather than flipping it
              over the row. */}
          <HoverCardContent
            anchor={rowRef}
            side="right"
            align="start"
            sideOffset={8}
            positionMethod="fixed"
            collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
            // p-0 so the status strip and stat band run edge to edge; sections
            // carry their own padding.
            className="w-64 overflow-hidden p-0 duration-150"
          >
            <SessionDetails session={session} renderedAt={renderedAt} />
          </HoverCardContent>
        </HoverCard>
      )}

      {/*
        THE CONTROLS OVERLAY THE ROW; THEY DO NOT SIT IN IT, AND THE ROW NO
        LONGER MOVES OUT OF THEIR WAY.
        This was `opacity-0` alone, which hides a thing without unreserving its
        space — so three buttons' worth of width was subtracted from every
        title, on every row, permanently. Titles truncated as though the
        controls were showing, because as far as layout was concerned they
        were. Reported as "the controls feel always present", which is exactly
        right and is a description of the layout rather than of the opacity.

        THE BACKDROP IS WHAT REPLACED THE RESERVED PADDING. The fix above left
        the link growing its padding on hover, which traded a permanent
        truncation for one that happened under the pointer — the title
        rewriting itself as you reached for it. A small opaque plate behind the
        three glyphs lets them sit on top of the trailing edge and stay
        legible, and the title underneath is left alone.

        The status/time slot beneath still fades as they arrive (`group-hover`
        in the card and slim bodies), which is t3's own swap: the read-only
        label yields to the actions rather than being crowded by them.
      */}
      {!searchable && (
        <span
          className={`absolute right-1 z-10 flex items-center gap-0.5 rounded-md bg-sidebar-accent opacity-0 shadow-sm transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100 ${
            // TOP-ALIGNED ON A CARD, as t3 has them: the actions belong to the
            // header line, where they take the status label's place rather than
            // floating over the title. A slim row has only one line, so they
            // centre on it. The content beside them reserves this width on
            // hover/focus/menu-open, so they no longer overlap the title.
            variant === "card" ? "top-1.5" : "top-1/2 -translate-y-1/2"
          }`}
        >
          {/**
           * SETTLE IS ONE TAP AND ASKS NOTHING, which is the whole difference
           * between it and the archive beside it. Archiving ends the session and
           * removes its worktree, so it earns a confirmation; settling moves a
           * row to the shelf and is undone by pressing the same spot — or by
           * typing at the session, which the engine treats as "not done after
           * all". A reversible action that asks first teaches people to dismiss
           * the question, which is how they end up dismissing the other one.
           */}
          {!session.archived && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={unsettles ? "Return to the list" : "Settle session"}
              title={unsettles ? "Return to the list" : "Settle"}
              disabled={!unsettles && !canSettle(sessionActivity)}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                void (unsettles ? unsettle() : runSessionPatch(() => patchSession(session, { settledOverride: "settled" }), onRefresh));
              }}
            >
              {unsettles ? <UndoIcon /> : <CircleCheckIcon />}
            </Button>
          )}
          {/**
           * SNOOZE, WHERE ARCHIVE USED TO BE — and the swap is about which
           * gesture belongs one click from a row you are skimming.
           *
           * Archiving ENDS a session and removes its worktree. It is the
           * heaviest thing in this menu, it needed a confirm, and it sat
           * between two reversible actions where a mis-click is cheap. Snooze
           * is the opposite in every respect: "not now" rather than "never",
           * undone by the same row, and the thing you actually reach for while
           * clearing a list. t3 puts exactly these two — snooze and settle —
           * on the row and nothing else.
           *
           * Archive is still one layer away, in the ⋯ menu, with its question
           * intact. Nothing was removed; it stopped being a hair-trigger.
           */}
          {/**
           * ONE SPOT, TWO DIRECTIONS. A sleeping row's clock is the way back —
           * pressing the same place that put it to sleep is the whole reason
           * this is undoable without opening a menu. A menu of presets on a
           * row that is already snoozed would be asking you to re-decide a
           * question you have answered.
           */}
          {snoozing ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Wake session now"
              title="Wake now"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void runSessionPatch(() => patchSession(session, { snoozedUntil: null }), onRefresh)}
            >
              <AlarmClockIcon />
            </Button>
          ) : (
            band !== "settled" && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Snooze session"
                      title="Snooze"
                      disabled={!canSnooze(sessionActivity)}
                      className="text-muted-foreground hover:text-foreground"
                    />
                  }
                >
                  <ClockIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {/* Presets resolved AT OPEN, so "In 1 hour" is an hour from the
                      click rather than from whenever this row mounted. */}
                  {snoozePresets(new Date(renderedAt)).map((preset) => (
                    <DropdownMenuItem
                      key={preset.id}
                      onClick={() => void runSessionPatch(() => patchSession(session, { snoozedUntil: preset.until }), onRefresh)}
                    >
                      <span className="flex-1">{preset.label}</span>
                      <span className="font-mono text-[0.625rem] tabular-nums text-muted-foreground/60">{preset.when}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          )}
          <SessionInboxMenu {...menuProps} />
        </span>
      )}
    </div>
  );

  /**
   * RIGHT-CLICK ANYWHERE ON THE ROW IS THE SAME MENU. t3's row has no hover
   * quick-actions at all and treats right-click as the way to act on a thread;
   * Telar keeps its two one-click verbs and adds the gesture, so the long tail
   * is reachable without first finding a 20px glyph that only appears on hover.
   */
  const menu = <SessionRowContextMenu {...menuProps}>{row}</SessionRowContextMenu>;
  if (!drag) return menu;

  /**
   * THE HANDLE IS A BOX AROUND THE MENU, NOT THE ELEMENT INSIDE IT — the same
   * separation the Spool's board card makes (`spool/board.tsx`) and the project
   * header makes one level up.
   *
   * The row's right-click trigger renders `display: contents`, which paints
   * nothing and is therefore never an event target: the row's own <div> is what
   * receives the press. Putting `draggable` on that same <div> would make a
   * right-press and a grab compete for one node. A wrapper is a second node, so
   * they do not.
   *
   * THE INSERT MARK IS A SHADOW, NOT A BORDER, for the reason the group header
   * gives: a border appearing on drag-over changes the row's height on the
   * frame it appears and shoves every row under the pointer.
   */
  return (
    <div
      draggable
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      title="Drag to move this conversation"
      className={cn(
        "cursor-grab rounded-md transition-opacity active:cursor-grabbing",
        drag.dragging && "opacity-40",
        drag.insert === "above" && "shadow-[inset_0_2px_0_0_var(--color-sidebar-primary)]",
        drag.insert === "below" && "shadow-[inset_0_-2px_0_0_var(--color-sidebar-primary)]",
      )}
    >
      {menu}
    </div>
  );
}
