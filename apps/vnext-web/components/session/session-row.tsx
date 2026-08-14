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
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon, ClockIcon, FolderIcon, GitBranchIcon, UndoIcon } from "lucide-react";
import { fmtAgo, fmtTokens } from "@/lib/format";
import { ACTIVITY_TONE, fmtDuration, rowStatusText, rowSubtitle } from "@/lib/session-activity";
import { bandOf, sessionHref, type SidebarSession } from "@/lib/session-list";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { SessionInboxMenu, patchSession } from "@/components/session/session-inbox-menu";
import { canSettle, canSnooze, snoozePresets } from "@/lib/session-settling";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

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
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-[11px] tabular-nums">{value}</span>
    </div>
  );
}

/** One cell of the stat band. An ABSENT figure renders as an em dash, never a
 *  confident zero — absent is not zero. */
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-popover py-2">
      <span className="text-xs font-semibold tabular-nums">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

/** The detail that used to fight the title for space on the row itself.
 *
 *  LAYOUT: status strip → identity (provider mark + title + state line) →
 *  the figures you scan as a stat band → the long-tail facts as label rows. */
function SessionDetails({ session, renderedAt }: { session: SidebarSession; renderedAt: number }) {
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
          <span className="mt-0.5 flex items-center gap-1 text-[10px]">
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
      <div className="mt-2.5 grid grid-cols-3 gap-px border-y border-border/60 bg-border/60">
        <StatTile label="Context" value={session.contextTokens ? fmtTokens(session.contextTokens) : "—"} />
        {/* Was "Cost". Tokens are the unit this cockpit reports — see
            lib/format.ts for why money left. */}
        <StatTile label="Tokens" value={session.tokens === undefined ? "—" : fmtTokens(session.tokens)} />
        <StatTile label="Workspace" value={session.worktreeBranch ? "Worktree" : "Local"} />
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
      </div>
    </div>
  );
}

export function SessionRow({
  session,
  active,
  showProject,
  variant = "card",
  searchable = false,
  searchSelected = false,
  renderedAt,
  onRefresh,
}: {
  session: SidebarSession;
  active: boolean;
  showProject: boolean;
  /**
   * HOW MUCH ROOM THIS ROW HAS EARNED. `card` for the live list, `slim` for the
   * settled shelf and for search results — a result list is answering a
   * question you already asked, so every row in it is equally relevant and
   * density beats detail.
   */
  variant?: "card" | "slim";
  searchable?: boolean;
  searchSelected?: boolean;
  renderedAt: number;
  onRefresh: () => void;
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
  const settled = bandOf(session, renderedAt) === "settled";
  /**
   * The settling module's view of this session, WHICH IS NO LONGER EMPTY.
   *
   * Both `canSettle` and `canSnooze` were being handed `{}` — a truthful
   * "nothing is known" when the engine sent no live state, and stale the moment
   * it did. It says "you cannot snooze a session that is asking you something"
   * and "you cannot settle one mid-turn", and with a real `activity` those
   * rules finally apply instead of always passing.
   */
  const sessionActivity = {
    working: session.activity === "working" || session.activity === "queued",
    waitingOnYou: session.activity === "blocked",
  };
  /**
   * SHELVED BY A DECISION, not by neglect — which is the only case the row's
   * own button can UNDO. A session that drifted onto the shelf because nobody
   * touched it for three days has nothing to un-press; offering it an undo
   * would promise a state change that does not exist, and pressing it would
   * appear to do nothing.
   */
  const settledByDecision = session.settledOverride === "settled";

  // Archiving the session you are currently VIEWING must not maroon you on it:
  // the survivor rule in deriveSessionList keeps this row visible for as long as
  // the URL names it, which is right for every other case and exactly wrong
  // here. Hand the reader back to the project's session list instead.
  const leaveIfActive = () => {
    // `/projects`, not `/`: `/` is a composer now, and archiving the session you
    // were reading should hand you the list you came from rather than a blank
    // message box you did not ask for.
    if (active) router.push("/projects");
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
    await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next.slice(0, 120) }),
    });
    onRefresh();
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
  const statusSlot = badge ? (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${ACTIVITY_TONE[badge.tone]} ${yieldOnHover}`}>
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
    <span className={`shrink-0 text-[11px] tabular-nums text-sidebar-foreground/45 ${yieldOnHover}`}>{time}</span>
  );

  /**
   * THE CARD: three lines, and each answers a different question.
   *   project + status  — whose is this, and what is it doing
   *   title             — the only thing anyone scans for
   *   branch + provider — where the work lands, and who is doing it
   */
  const cardBody = (
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {showProject && session.projectName ? (
          <>
            <FolderIcon className="size-3 shrink-0 text-sidebar-foreground/40" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-sidebar-foreground/50">{session.projectName}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {statusSlot}
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
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-foreground/45">
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
      <span className="shrink-0 opacity-40 grayscale transition group-hover/session:opacity-100 group-hover/session:grayscale-0">
        <ProviderIcon provider={session.driver} size={12} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/60 group-hover/session:text-sidebar-foreground">
        {session.title || "Untitled session"}
      </span>
      {statusSlot}
    </>
  );

  const rowBody = variant === "card" ? cardBody : slimBody;

  return (
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
      className={`group/session relative flex items-center rounded-md ${
        active || searchSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      } ${session.archived ? "opacity-60" : ""} ${
        badge && variant === "card"
          ? `before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full ${
              badge.tone === "attention" ? "before:bg-warning" : "before:bg-primary"
            }`
          : ""
      }`}
    >
      {/* NO HOVER CARD IN THE MOBILE SHEET, AND THAT IS THE WHOLE BUG.
          Under 768px <Sidebar> stops being a docked panel and renders the mobile
          <Sheet> — a MODAL dialog. HoverCardContent portals to <body>, i.e.
          outside that dialog, so the modal treats the card as an outside element
          and dismisses it the instant it appears. A hover affordance in a modal
          sheet at phone width has nothing to offer anyway. */}
      {isMobile ? (
        <Link
          id={`sidebar-session-${session.id}`}
          href={href}
          prefetch={false}
          role={searchable ? "option" : undefined}
          aria-selected={searchable ? searchSelected : undefined}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                role={searchable ? "option" : undefined}
                aria-selected={searchable ? searchSelected : undefined}
                aria-current={active ? "page" : undefined}
                onDoubleClick={(event: React.MouseEvent) => {
                  event.preventDefault();
                  beginRename();
                }}
                className={`flex min-w-0 flex-1 items-center gap-2 px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  variant === "card" ? "py-2.5" : "py-1"
                }`}
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
        THE CONTROLS OVERLAY THE ROW; THEY DO NOT SIT IN IT.
        This was `opacity-0` alone, which hides a thing without unreserving its
        space — so three buttons' worth of width was subtracted from every
        title, on every row, permanently. Titles truncated as though the
        controls were showing, because as far as layout was concerned they
        were. Reported as "the controls feel always present", which is exactly
        right and is a description of the layout rather than of the opacity.

        Positioned absolutely so a resting row is all title, with a background
        so the buttons are legible over whatever they cover on hover. The
        status/time slot beneath fades as they arrive (`group-hover` in the
        card and slim bodies), which is t3's own swap: the read-only label
        yields to the actions rather than being crowded by them.
      */}
      {!searchable && (
        <span
          className={`absolute right-1 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 has-data-popup-open:opacity-100 ${
            // TOP-ALIGNED ON A CARD, as t3 has them: the actions belong to the
            // header line, where they take the status label's place rather than
            // floating over the title. A slim row has only one line, so they
            // centre on it.
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
              aria-label={settledByDecision ? "Return to the list" : "Settle session"}
              title={settledByDecision ? "Return to the list" : "Settle"}
              disabled={!settledByDecision && !canSettle(sessionActivity)}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                void patchSession(session.id, { settledOverride: settledByDecision ? null : "settled" }).then(onRefresh);
              }}
            >
              {settledByDecision ? <UndoIcon /> : <CircleCheckIcon />}
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
          {!settled && (
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
                    onClick={() => void patchSession(session.id, { snoozedUntil: preset.until }).then(onRefresh)}
                  >
                    <span className="flex-1">{preset.label}</span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">{preset.when}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <SessionInboxMenu
            session={session}
            active={active}
            // No longer the default `{}`: the engine reports what this session
            // is doing, so the menu's own guards can finally apply.
            activity={sessionActivity}
            now={renderedAt}
            onRename={beginRename}
            onDone={onRefresh}
            onLeave={leaveIfActive}
          />
        </span>
      )}
    </div>
  );
}
